import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { NodePolicyPreview } from "../src/api/types.js";
import { LayoutRound, mountedNodeFiles } from "../src/applyLayout.js";
import { RequestError } from "../src/http.js";
import type { LocalInstance, ResolvedInstance } from "../src/instanceResolver.js";
import { layoutVersion } from "../src/layoutEdit.js";
import { formatNodeFile, nodeFileFromLayout, parseNodeFile } from "../src/nodeFile.js";
import { nodePolicyRoutes } from "../src/routes/nodePolicy.js";
import { type LayoutNode, parseLayout } from "../src/setupRepo.js";
import type { SyncthingClient } from "../src/syncthing.js";
import { FakeSyncthing, clientOf } from "./fakeFolderSyncthing.js";
import { askRoutes, git, layoutRepos } from "./layoutRepos.js";

const folderNode = `[node]
id        = "a1b2"
name      = "pc"
kind      = "folder"
threshold = 50
assigned  = []
access    = "open"
`;

function policy(apply: boolean, admitted = true): LayoutNode {
  return parseLayout(`[nodes.a1b2]\nname = "pc"\nthreshold = 80\nadmitted = ${admitted}\napply = ${apply}\n`).nodes[0];
}

describe("apply in the node file", () => {
  it("is written only while the layout lets an admitted node act, and read back", () => {
    const followed = nodeFileFromLayout(parseNodeFile(folderNode), policy(true));
    assert.match(formatNodeFile(followed), /\napply {5}= true\n/);
    assert.equal(parseNodeFile(formatNodeFile(followed)).node.apply, true);
    assert.doesNotMatch(formatNodeFile(nodeFileFromLayout(followed, policy(false))), /apply/);
    assert.doesNotMatch(formatNodeFile(nodeFileFromLayout(parseNodeFile(folderNode), policy(true, false))), /apply/);
  });

  it("a node file without the line has no apply, as the executors read it", () => {
    assert.equal(parseNodeFile(folderNode).node.apply, undefined);
    assert.equal(formatNodeFile(parseNodeFile(folderNode)), folderNode);
  });
});

describe("the layout round brings mounted node files to the layout", () => {
  let root: string;
  before(() => (root = mkdtempSync(join(tmpdir(), "node-files-"))));
  after(() => rmSync(root, { recursive: true, force: true }));

  function nodeRoot(name: string): string {
    const path = join(root, "nodes", name);
    mkdirSync(join(path, ".storage"), { recursive: true });
    writeFileSync(join(path, ".storage", "node.toml"), folderNode);
    return path;
  }

  function instance(path: string, overrides: Partial<LocalInstance> = {}): LocalInstance {
    return { kind: "local", nodeId: "a1b2", name: "pc", client: {} as SyncthingClient, root: path, os: "linux", threshold: 50, source: "registry", ...overrides };
  }

  it("writes apply and the threshold into a Linux node file under a mounted root, and takes apply out again", async () => {
    const path = nodeRoot("one");
    const follow = mountedNodeFiles([join(root, "nodes")]);
    assert.equal(await follow(instance(path), policy(true)), true);
    assert.match(readFileSync(join(path, ".storage", "node.toml"), "utf8"), /threshold = 80\n[\s\S]*apply {5}= true/);
    assert.equal(await follow(instance(path), policy(true)), false);
    assert.equal(await follow(instance(path), policy(false)), true);
    assert.doesNotMatch(readFileSync(join(path, ".storage", "node.toml"), "utf8"), /apply/);
  });

  it("leaves a Windows node, an array and a root this host does not mount alone", async () => {
    const path = nodeRoot("two");
    const follow = mountedNodeFiles([join(root, "elsewhere")]);
    assert.equal(await follow(instance(path), policy(true)), false);
    const mounted = mountedNodeFiles([join(root, "nodes")]);
    assert.equal(await mounted(instance(path, { os: "windows" }), policy(true)), false);
    assert.equal(await mounted(instance(path, { source: "array" }), policy(true)), false);
    assert.equal(readFileSync(join(path, ".storage", "node.toml"), "utf8"), folderNode);
  });

  it("a round follows with apply only for an admitted node the layout does not block, and says so in Activity", async () => {
    const followed: LayoutNode[] = [];
    const recorded: string[] = [];
    const syncthing = new FakeSyncthing();
    const layout = (apply: boolean, admitted: boolean, name = "pc") => parseLayout(`[devices.pc]\nid = "LAPTOP-ID"\nroot = "/data"\n[nodes.a1b2]\nname = "${name}"\ndevice = "pc"\nthreshold = 80\nadmitted = ${admitted}\napply = ${apply}\n`);
    let current = layout(true, true);
    const round = new LayoutRound({
      layout: async () => current,
      instances: async () => [{ kind: "local", nodeId: "a1b2", name: "pc", client: clientOf(syncthing), root: "/data", os: "linux", threshold: 80, source: "registry" }],
      handoffFiles: { ensure: async () => null },
      nodeFiles: async (_instance, entry) => {
        followed.push(entry);
        return true;
      },
      record: (_nodeId, _folderId, text) => recorded.push(text),
      readBackDelaysMs: [],
    });
    await round.run();
    current = layout(true, false);
    await round.run();
    current = layout(true, true, "Bad Name");
    await round.run();
    assert.deepEqual(followed.map((entry) => entry.apply), [true, false, false]);
    assert.equal(recorded[0], "pc: node file follows the layout, threshold 80, apply on");
  });
});

describe("node policy editing through the setup repo", () => {
  let repos: ReturnType<typeof layoutRepos>;
  const local: LocalInstance = { kind: "local", nodeId: "a1b2", name: "pc", client: {} as SyncthingClient, root: "/data", os: "linux", threshold: 50, source: "registry" };
  const keeperLayout = `[devices.array]
id     = "ARRAY-ID"
role   = "archive"
root   = "/mnt/storage/pool"
joined = true

[nodes.5784]
name     = "private-array"
device   = "array"
admitted = true
`;

  const routes = () =>
    nodePolicyRoutes({
      repository: repos.ours,
      resolve: async (nodeId): Promise<ResolvedInstance> => {
        if (nodeId === "a1b2") return local;
        if (nodeId === "c3d4") return { kind: "remote", nodeId, name: "p53-data", host: "p53", dashboardUrl: "http://127.0.0.1:9" };
        throw new RequestError(404, `no node ${nodeId}`);
      },
      configured: async () => new Set(["documents", "videos"]),
      localSize: async (_instance, folderId) => (folderId === "documents" ? { files: 12, bytes: 4096 } : { files: 3, bytes: 100 }),
    });
  const version = () => layoutVersion(readFileSync(join(repos.ours, "drive-sync.toml"), "utf8"));
  const remoteLayout = () => git(repos.remote, "show", "main:drive-sync.toml");

  before(() => {
    repos = layoutRepos("node-policy-");
    writeFileSync(join(repos.ours, "drive-sync.toml"), `${readFileSync(join(repos.ours, "drive-sync.toml"), "utf8")}\n${keeperLayout}`);
    git(repos.ours, "commit", "-q", "-am", "add the array");
    git(repos.ours, "push", "-q");
  });
  after(() => rmSync(repos.root, { recursive: true, force: true }));

  it("a raise is previewed with what it would hand off, how much, and to which keeper", async () => {
    const answer = await askRoutes(routes(), "GET", "/api/nodes/a1b2/policy/preview?threshold=90");
    const preview = answer.body as NodePolicyPreview;
    assert.equal(answer.status, 200);
    assert.deepEqual(preview.handoffs, [{ folderId: "documents", label: "Documents", files: 12, bytes: 4096, keepers: ["private-array"] }]);
    assert.deepEqual([preview.files, preview.bytes], [12, 4096]);
    assert.ok(preview.changes.some((text) => text.startsWith("Documents (documents) turns send only")));
  });

  it("a lower threshold hands nothing off", async () => {
    const preview = (await askRoutes(routes(), "GET", "/api/nodes/a1b2/policy/preview?threshold=10")).body as NodePolicyPreview;
    assert.deepEqual(preview.handoffs, []);
  });

  it("the threshold, assigned paths, pins and enabled are committed and pushed", async () => {
    const answer = await askRoutes(routes(), "PUT", "/api/nodes/a1b2/policy", { base: version(), threshold: 60, assigned: ["Documents\\GitHub"], pins: { Videos: 85 }, enabled: true });
    assert.equal(answer.status, 200);
    const node = parseLayout(remoteLayout()).nodes.find((entry) => entry.id === "a1b2");
    assert.deepEqual([node?.threshold, node?.assigned, node?.pins], [60, ["Documents/GitHub"], { Videos: 85 }]);
    assert.equal(git(repos.remote, "log", "-1", "--format=%s", "main"), "feat(layout): threshold 50 to 60; assigned Documents/GitHub; pins Videos at 85 for pc");
  });

  it("another host's node is 409 and nothing is written", async () => {
    const head = git(repos.remote, "rev-parse", "main");
    const answer = await askRoutes(routes(), "PUT", "/api/nodes/c3d4/policy", { base: version(), threshold: 10 });
    assert.equal(answer.status, 409);
    assert.match((answer.body as { error: string }).error, /act on p53's dashboard/);
    assert.equal((await askRoutes(routes(), "GET", "/api/nodes/c3d4/policy/preview?threshold=10")).status, 409);
    assert.equal(git(repos.remote, "rev-parse", "main"), head);
  });

  it("apply is never changed with the other fields", async () => {
    const answer = await askRoutes(routes(), "PUT", "/api/nodes/a1b2/policy", { base: version(), threshold: 70, apply: true });
    assert.equal(answer.status, 400);
    const mixed = await askRoutes(routes(), "PUT", "/api/nodes/a1b2/policy/apply", { base: version(), apply: true, confirm: "pc", threshold: 70 });
    assert.equal(mixed.status, 400);
    assert.equal(parseLayout(remoteLayout()).nodes.find((entry) => entry.id === "a1b2")?.apply, false);
  });

  it("turning apply on takes the node's name typed exactly", async () => {
    for (const confirm of [undefined, "PC", "pc "]) {
      const answer = await askRoutes(routes(), "PUT", "/api/nodes/a1b2/policy/apply", { base: version(), apply: true, confirm });
      assert.equal(answer.status, 400, String(confirm));
      assert.match((answer.body as { error: string }).error, /type the node's name pc/);
    }
    assert.equal(parseLayout(remoteLayout()).nodes.find((entry) => entry.id === "a1b2")?.apply, false);
    const answer = await askRoutes(routes(), "PUT", "/api/nodes/a1b2/policy/apply", { base: version(), apply: true, confirm: "pc" });
    assert.equal(answer.status, 200);
    assert.equal(parseLayout(remoteLayout()).nodes.find((entry) => entry.id === "a1b2")?.apply, true);
    assert.equal(git(repos.remote, "log", "-1", "--format=%s", "main"), "feat(layout): turn apply on for pc");
  });

  it("turning apply off needs no name", async () => {
    const answer = await askRoutes(routes(), "PUT", "/api/nodes/a1b2/policy/apply", { base: version(), apply: false });
    assert.equal(answer.status, 200);
    assert.equal(parseLayout(remoteLayout()).nodes.find((entry) => entry.id === "a1b2")?.apply, false);
  });

  it("a node that is not admitted cannot be let act", async () => {
    writeFileSync(join(repos.ours, "drive-sync.toml"), readFileSync(join(repos.ours, "drive-sync.toml"), "utf8").replace("admitted  = true\n", "admitted  = false\n"));
    git(repos.ours, "commit", "-q", "-am", "unadmit");
    git(repos.ours, "push", "-q");
    const answer = await askRoutes(routes(), "PUT", "/api/nodes/a1b2/policy/apply", { base: version(), apply: true, confirm: "pc" });
    assert.equal(answer.status, 409);
    assert.match((answer.body as { error: string }).error, /not admitted/);
  });
});
