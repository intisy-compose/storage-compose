import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { LocalNodeInfo } from "../src/instanceResolver.js";
import { layoutVersion } from "../src/layoutEdit.js";
import { isOfferHeldByLayout } from "../src/layoutOffers.js";
import { nodeAdmissionRoutes, waitingAdmissions } from "../src/routes/nodeAdmission.js";
import { type RequestNode, requestsResponse } from "../src/routes/pending.js";
import { parseLayout } from "../src/setupRepo.js";
import type { SyncthingClient } from "../src/syncthing.js";
import { askRoutes, git, layoutRepos } from "./layoutRepos.js";

const layout = parseLayout(`[devices.pc]
id = "PC-ID"
root = "/data"
joined = true

[devices.array]
id = "ARRAY-ID"
role = "archive"
root = "/mnt/storage/pool"
joined = true

[folders.Documents]
priority = 80

[folders.Videos]
priority = 30

[nodes.a1b2]
name = "pc"
device = "pc"
threshold = 50
admitted = true

[nodes.5784]
name = "private-array"
device = "array"
admitted = true

[nodes.b001]
name = "stick"
device = ""
threshold = 80

[nodes.c002]
name = "old-stick"
device = ""
refused = "2026-11-01T00:00:00.000Z"
`);

function info(nodeId: string, name: string): LocalNodeInfo {
  return { nodeId, source: "registry", name, root: `/mnt/nodes/${nodeId}`, os: "linux", threshold: 80, present: true, remember: true, instance: null };
}

describe("nodes waiting for admission", () => {
  it("a node file without an admitted entry waits, listed or not; an admitted or refused one does not", () => {
    const waiting = waitingAdmissions(layout, [info("a1b2", "pc"), info("b001", "stick"), info("c002", "old-stick"), info("d003", "new-stick")], "storage");
    assert.deepEqual(waiting.map((entry) => [entry.nodeId, entry.listed]), [["b001", true], ["d003", false]]);
    assert.deepEqual(waitingAdmissions(null, [info("d003", "new-stick")], "storage"), []);
  });
});

describe("folder offers the layout causes", () => {
  it("an offer of a layout folder the node's plan does not take is no request; one it keeps, or any other offer, is", () => {
    assert.equal(isOfferHeldByLayout(layout, "a1b2", "videos"), true, "pc at 50 only sends Videos, so the keepers' offer is no request");
    assert.equal(isOfferHeldByLayout(layout, "a1b2", "documents"), false, "pc keeps Documents, so it should take it");
    assert.equal(isOfferHeldByLayout(layout, "a1b2", "holiday-photos"), false, "not a layout folder");
    assert.equal(isOfferHeldByLayout(layout, "b001", "videos"), false, "the stick is not admitted");
    assert.equal(isOfferHeldByLayout(null, "a1b2", "videos"), false);
  });

  it("Requests leaves such an offer out and lists the others", async () => {
    const offer = (label: string) => ({ offeredBy: { "ARRAY-ID": { time: "2026-11-05T10:00:00Z", label, receiveEncrypted: false, remoteEncrypted: false } } });
    const client = {
      pendingDevices: async () => ({}),
      pendingFolders: async () => ({ videos: offer("Videos"), documents: offer("Documents") }),
      devices: async () => [{ deviceID: "ARRAY-ID", name: "private-array" }],
    } as unknown as SyncthingClient;
    const node: RequestNode = { nodeId: "a1b2", name: "pc", present: true, client };
    const response = await requestsResponse("local", { localNodes: async () => [node], peerDashboards: [], joins: async () => ({}), layout: async () => layout, admissions: async () => [] });
    assert.deepEqual(response.folders.map((entry) => entry.folderId), ["documents"]);
  });
});

describe("admitting a node through the setup repo", () => {
  let repos: ReturnType<typeof layoutRepos>;
  const nodes = new Map([["d003", info("d003", "new-stick")], ["b001", info("b001", "stick")], ["e004", info("e004", "pc")]]);
  const routes = () =>
    nodeAdmissionRoutes({ repository: repos.ours, findNode: async (nodeId) => nodes.get(nodeId) ?? null, deviceId: async (entry) => `${entry.nodeId.toUpperCase()}-ID`, now: () => new Date("2026-11-05T12:00:00.000Z") });
  const version = () => layoutVersion(readFileSync(join(repos.ours, "drive-sync.toml"), "utf8"));
  const remote = () => parseLayout(git(repos.remote, "show", "main:drive-sync.toml"));

  before(() => {
    repos = layoutRepos("admission-");
    writeFileSync(join(repos.ours, "drive-sync.toml"), `${readFileSync(join(repos.ours, "drive-sync.toml"), "utf8")}\n[nodes.b001]\nname = "stick"\ndevice = "stick"\nthreshold = 50\n`);
    git(repos.ours, "commit", "-q", "-am", "list the stick");
    git(repos.ours, "push", "-q");
  });
  after(() => rmSync(repos.root, { recursive: true, force: true }));

  it("accepting a node the layout does not list adds its device and its entry, admitted, at its node file's threshold", async () => {
    const answer = await askRoutes(routes(), "PUT", "/api/nodes/d003/admission", { base: version(), answer: "accept" });
    assert.equal(answer.status, 200);
    const node = remote().nodes.find((entry) => entry.id === "d003");
    assert.deepEqual([node?.name, node?.device, node?.threshold, node?.admitted, node?.apply], ["new-stick", "new-stick", 80, true, false]);
    assert.deepEqual(remote().devices.find((entry) => entry.name === "new-stick")?.id, "D003-ID");
    assert.equal(git(repos.remote, "log", "-1", "--format=%s", "main"), "feat(layout): admit new-stick to the layered sync");
  });

  it("accepting a listed node only admits it, keeping its threshold", async () => {
    await askRoutes(routes(), "PUT", "/api/nodes/b001/admission", { base: version(), answer: "accept" });
    const node = remote().nodes.find((entry) => entry.id === "b001");
    assert.deepEqual([node?.threshold, node?.admitted], [50, true]);
  });

  it("a device name the layout gives another ID is refused", async () => {
    const answer = await askRoutes(routes(), "PUT", "/api/nodes/e004/admission", { base: version(), answer: "accept" });
    assert.equal(answer.status, 409);
    assert.match((answer.body as { error: string }).error, /a device pc with another Syncthing ID/);
  });

  it("refusing records it, so the node no longer waits", async () => {
    nodes.set("f005", info("f005", "lost-stick"));
    const answer = await askRoutes(routes(), "PUT", "/api/nodes/f005/admission", { base: version(), answer: "refuse" });
    assert.equal(answer.status, 200);
    const node = remote().nodes.find((entry) => entry.id === "f005");
    assert.deepEqual([node?.admitted, node?.refused], [false, "2026-11-05T12:00:00.000Z"]);
    assert.deepEqual(waitingAdmissions(remote(), [info("f005", "lost-stick")], "storage"), []);
  });

  it("a node of another host, or a bad answer, is refused before anything is written", async () => {
    const head = git(repos.remote, "rev-parse", "main");
    assert.equal((await askRoutes(routes(), "PUT", "/api/nodes/9999/admission", { base: version(), answer: "accept" })).status, 404);
    assert.equal((await askRoutes(routes(), "PUT", "/api/nodes/d003/admission", { base: version(), answer: "maybe" })).status, 400);
    assert.equal(git(repos.remote, "rev-parse", "main"), head);
  });
});
