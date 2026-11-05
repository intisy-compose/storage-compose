import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type HandoffCandidate, type KeeperReport, type LocalFile, confirmedHandoffs, handoffCandidates, handoffQuietMinutes } from "../src/handoffPlan.js";
import { type NodePlan, nodePlan } from "../src/nodePlan.js";
import { type SetupLayout, parseLayout } from "../src/setupRepo.js";

const layoutText = `
[devices.stick]
id   = "STICK-ID"
root = "/media/stick"

[devices.laptop]
id   = "LAPTOP-ID"
root = "/home/someone"

[devices.array]
id   = "ARRAY-ID"
role = "archive"
root = "/mnt/storage/pool"

[folders.Videos]
priority = 30

[folders.Work]
priority = 80

[nodes.b001]
name      = "stick"
device    = "stick"
threshold = 80
assigned  = ["Videos/Mine"]
admitted  = true
apply     = true

[nodes.b001.pins]
"Videos/Pinned" = 20

[nodes.a002]
name      = "laptop"
device    = "laptop"
threshold = 50
admitted  = true

[nodes.c1c1]
name      = "private-array"
device    = "array"
threshold = 0
admitted  = true
`;

const layout = parseLayout(layoutText);
const now = new Date("2026-11-05T12:00:00Z");
const anHourAgo = "2026-11-05T11:00:00Z";

function file(path: string, overrides: Partial<LocalFile> = {}): LocalFile {
  return { folderId: "videos", path, version: ["STICK:3"], size: 1200, blocksHash: "hash-a", modified: anHourAgo, ...overrides };
}

function planOf(source: SetupLayout = layout): NodePlan {
  return nodePlan(source, "b001", new Set(["Videos", "Work"])) as NodePlan;
}

function candidatesOf(files: LocalFile[], source: SetupLayout = layout): HandoffCandidate[] {
  return handoffCandidates(source, planOf(source), files, now);
}

function keeper(nodeId: string, entry: Partial<KeeperReport["folders"][string]["files"][string]> = {}, overrides: Partial<KeeperReport> = {}): KeeperReport {
  return {
    nodeId,
    online: true,
    state: "ok",
    folders: { videos: { completion: 100, files: { "clip.mp4": { version: ["STICK:3"], size: 1200, blocksHash: "hash-a", deleted: false, ignored: false, invalid: false, ...entry } } } },
    ...overrides,
  };
}

const clip = file("clip.mp4");

function decide(keepers: KeeperReport[], current: LocalFile[] = [clip], source: SetupLayout = layout) {
  return confirmedHandoffs(source, "b001", candidatesOf([clip], source), current, keepers);
}

describe("hand-off candidates", () => {
  it("are the files of a folder the node holds below its threshold", () => {
    const candidates = candidatesOf([clip, file("notes.txt", { folderId: "work" })]);

    assert.deepEqual(candidates, [clip]);
  });

  it("wait while a file changed within the quiet period", () => {
    assert.equal(handoffQuietMinutes, 10);
    assert.deepEqual(candidatesOf([file("new.mp4", { modified: "2026-11-05T11:55:00Z" })]), []);
    assert.equal(candidatesOf([file("settled.mp4", { modified: "2026-11-05T11:49:59Z" })]).length, 1);
  });

  it("never include a pinned or assigned path", () => {
    assert.deepEqual(candidatesOf([file("Pinned/a.mp4"), file("Mine/b.mp4"), file("Mine")]), []);
    assert.equal(candidatesOf([file("Mine-not/c.mp4")]).length, 1);
  });

  it("are none on a node whose apply is not set", () => {
    const reporting = parseLayout(layoutText.replace("apply     = true", "apply     = false"));

    assert.deepEqual(candidatesOf([clip], reporting), []);
    assert.deepEqual(decide([keeper("c1c1")], [clip], reporting), { confirmed: [], waiting: [] });
  });
});

describe("a confirmed hand-off", () => {
  it("needs a keeper reporting the same version, size and block hash", () => {
    assert.deepEqual(decide([keeper("c1c1")]).confirmed, [{ ...clip, keeper: "c1c1" }]);
    assert.equal(decide([keeper("c1c1", { blocksHash: "hash-b" })]).waiting[0].reason, "not-confirmed");
    assert.equal(decide([keeper("c1c1", { size: 1199 })]).waiting[0].reason, "not-confirmed");
    assert.equal(decide([keeper("c1c1", { version: ["STICK:2"] })]).waiting[0].reason, "not-confirmed");
    assert.equal(decide([keeper("c1c1", { deleted: true })]).confirmed.length, 0);
  });

  it("needs the keeper complete in the folder", () => {
    const busy = keeper("c1c1");
    busy.folders.videos.completion = 99.5;

    assert.equal(decide([busy]).waiting[0].reason, "not-confirmed");
  });

  it("does not count a node whose policy does not keep the folder", () => {
    const decision = decide([keeper("a002")]);

    assert.deepEqual(decision.confirmed, []);
    assert.equal(decision.waiting[0].reason, "keeper-offline", "the cluster keeps it and has not reported");
    assert.equal(confirmedHandoffs(layout, "b001", [clip], [clip], [keeper("c1c1", {}, { effectiveThreshold: 40 })]).waiting[0].reason, "no-keeper");
  });

  it("does not count a degraded, stopped or frozen keeper", () => {
    for (const state of ["degraded", "stopped", "frozen"] as const) {
      assert.deepEqual(decide([keeper("c1c1", {}, { state })]).confirmed, [], state);
    }
    const disabled = parseLayout(`${layoutText}\n`.replace('threshold = 0\nadmitted  = true', 'threshold = 0\nadmitted  = true\nenabled   = false'));
    assert.deepEqual(decide([keeper("c1c1")], [clip], disabled).confirmed, []);
  });

  it("waits while every keeper is offline", () => {
    const decision = decide([keeper("c1c1", {}, { online: false })]);

    assert.deepEqual(decision.confirmed, []);
    assert.deepEqual(decision.waiting, [{ ...clip, reason: "keeper-offline" }]);
  });

  it("starts over when the file changed after it was confirmed", () => {
    const [candidate] = candidatesOf([clip]);
    const changed = file("clip.mp4", { version: ["STICK:4"], blocksHash: "hash-c" });

    const decision = confirmedHandoffs(layout, "b001", [candidate], [changed], [keeper("c1c1")]);

    assert.deepEqual(decision.confirmed, []);
    assert.equal(decision.waiting[0].reason, "changed");
    assert.deepEqual(candidatesOf([changed]), [changed]);
  });

  it("starts over when the file is gone from the node", () => {
    assert.equal(decide([keeper("c1c1")], []).waiting[0].reason, "changed");
  });
});
