import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keeperRelayAnswer, relayedKeepers, type KeeperRelaySources, type PeerRead, type RelayedReport } from "../src/keeperRelay.js";
import type { LocalInstance } from "../src/instanceResolver.js";
import { parseLayout } from "../src/setupRepo.js";
import type { SyncthingClient } from "../src/syncthing.js";
import type { SpaceDecision } from "../src/spacePlan.js";

const layout = parseLayout(`
[devices.array]
id = "ARRAY-ID"
role = "archive"
root = "/mnt/array"

[folders.Videos]
priority = 30

[nodes.c1c1]
name = "private-array"
device = "array"
threshold = 0
admitted = true
`);

const now = new Date("2026-11-08T12:00:00Z");
const instance = (nodeId: string): LocalInstance => ({ kind: "local", nodeId, name: nodeId, client: {} as SyncthingClient, root: "/", os: "linux", threshold: 0, source: "array" });
const entry = { type: "FILE_INFO_TYPE_FILE", version: ["S:1"], size: 10, numBlocks: 1, blocksHash: "hash", modified: "2026-01-01T00:00:00Z", deleted: false, ignored: false, invalid: false };
const raised: SpaceDecision = { state: "raised", threshold: 50, neededBytes: 1, availableBytes: 1, handoffAllowed: true, pullAllowed: true };

function sources(overrides: Partial<KeeperRelaySources> = {}): KeeperRelaySources {
  return {
    layout: async () => layout,
    instances: async () => [instance("c1c1"), instance("ff00")],
    reads: { entry: async (_i, _f, path) => (path === "missing.txt" ? null : entry), completion: async () => 100, keeperState: async () => "ok" },
    decisionOf: () => null,
    now: () => now,
    ...overrides,
  };
}

describe("a peer's keeper relay answer", () => {
  it("reads its listed keepers now and carries the read's age, leaving out a node the layout does not list", async () => {
    const answer = await keeperRelayAnswer(sources(), "videos", ["a.txt", "missing.txt"]);

    assert.equal(answer.keepers.length, 1);
    assert.equal(answer.keepers[0].nodeId, "c1c1");
    assert.equal(answer.keepers[0].ageSeconds, 0);
    assert.deepEqual(Object.keys(answer.keepers[0].files), ["a.txt"]);
    assert.equal(answer.keepers[0].completion, 100);
  });

  it("carries the age of the space decision it leans on and the keeper's raised threshold", async () => {
    const decided = sources({ decisionOf: () => ({ first: raised, final: raised, at: now.getTime() - 40_000 }) });

    const [keeper] = (await keeperRelayAnswer(decided, "videos", [])).keepers;

    assert.equal(keeper.ageSeconds, 40);
    assert.equal(keeper.effectiveThreshold, 50);
    assert.deepEqual(keeper.decision, { state: "raised", threshold: 50 });
  });

  it("says a keeper the space rule took out is full or stopped", async () => {
    const full: SpaceDecision = { ...raised, state: "full", handoffAllowed: false };
    const stopped = sources({ decisionOf: () => ({ first: full, final: full, at: now.getTime() }) });

    assert.equal((await keeperRelayAnswer(stopped, "videos", [])).keepers[0].state, "full");
  });

  it("leaves out a keeper that cannot be read", async () => {
    const broken = sources({ reads: { entry: async () => entry, completion: async () => { throw new Error("no such folder"); }, keeperState: async () => "ok" } });

    assert.deepEqual((await keeperRelayAnswer(broken, "videos", [])).keepers, []);
  });
});

const peerAnswer = (overrides: object = {}) => ({ folderId: "videos", keepers: [{ nodeId: "c1c1", state: "ok", effectiveThreshold: 0, decision: { state: "fits", threshold: 0 }, ageSeconds: 7, completion: 100, files: { "a.txt": entry }, ...overrides }] });

describe("reading keepers through peer dashboards", () => {
  const ask = (read: PeerRead): Promise<RelayedReport[]> => relayedKeepers(["https://peer"], [{ folderId: "videos", paths: ["a.txt"] }], read, () => now);

  it("stamps this host's own time and keeps the peer's age", async () => {
    const [report] = await ask(async () => peerAnswer());

    assert.equal(report.observedAt, now.toISOString());
    assert.equal(report.ageSeconds, 7);
    assert.equal(report.folders.videos.completion, 100);
    assert.equal(report.online, true);
    assert.deepEqual(report.decision, { state: "fits", threshold: 0 });
  });

  it("reports no one for a peer that does not answer or answers something else", async () => {
    assert.deepEqual(await ask(async () => { throw new Error("offline"); }), []);
    assert.deepEqual(await ask(async () => "not a report"), []);
  });

  it("drops a keeper without a usable age, so a stale relay counts for nothing", async () => {
    assert.deepEqual(await ask(async () => peerAnswer({ ageSeconds: -1 })), []);
    assert.deepEqual(await ask(async () => peerAnswer({ ageSeconds: "soon" })), []);
  });

  it("splits a long list of paths into several requests and merges them", async () => {
    const urls: string[] = [];
    const paths = Array.from({ length: 200 }, (_, index) => `some/longer/path/of/a/file/number-${index}.txt`);
    const reports = await relayedKeepers(["https://peer"], [{ folderId: "videos", paths }], async (_peer, path) => {
      urls.push(path);
      const asked = new URL(`http://x${path}`).searchParams.getAll("path");
      return peerAnswer({ files: Object.fromEntries(asked.map((one) => [one, entry])), ageSeconds: urls.length });
    }, () => now);

    assert.ok(urls.length > 1);
    assert.ok(urls.every((url) => url.length <= 6200));
    assert.equal(Object.keys(reports[0].folders.videos.files).length, 200);
    assert.equal(reports[0].ageSeconds, urls.length);
  });

  it("asks nobody without peers", async () => {
    assert.deepEqual(await relayedKeepers([], [{ folderId: "videos", paths: [] }], async () => { throw new Error("asked"); }, () => now), []);
  });
});
