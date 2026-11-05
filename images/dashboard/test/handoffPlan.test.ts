import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type HandoffCandidate, type KeeperFileEntry, type KeeperReport, type LocalFile, confirmedHandoffs, handoffCandidates, handoffQuietMinutes, keeperReportMaxAgeSeconds } from "../src/handoffPlan.js";
import { type NodePlan, nodePlan } from "../src/nodePlan.js";
import { type SetupLayout, parseLayout } from "../src/setupRepo.js";
import { type SpaceDecision, effectiveThreshold } from "../src/spacePlan.js";

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
const fits: SpaceDecision = { state: "fits", threshold: 80, neededBytes: 0, availableBytes: 1, handoffAllowed: true };

function file(path: string, overrides: Partial<LocalFile> = {}): LocalFile {
  return { folderId: "videos", path, type: "FILE_INFO_TYPE_FILE", version: ["STICK:3"], size: 1200, blocksHash: "hash-a", modified: anHourAgo, ...overrides };
}

function planOf(source: SetupLayout = layout, threshold?: number): NodePlan {
  return nodePlan(source, "b001", new Set(["Videos", "Work"]), threshold) as NodePlan;
}

function candidatesOf(files: LocalFile[], source: SetupLayout = layout, decision: SpaceDecision = fits): HandoffCandidate[] {
  return handoffCandidates(source, planOf(source), files, decision, now);
}

function keeper(nodeId: string, entry: Partial<KeeperFileEntry> = {}, overrides: Partial<KeeperReport> = {}): KeeperReport {
  return {
    nodeId,
    online: true,
    state: "ok",
    observedAt: "2026-11-05T11:59:30Z",
    effectiveThreshold: 0,
    folders: { videos: { completion: 100, files: { "clip.mp4": { type: "FILE_INFO_TYPE_FILE", version: ["STICK:3"], size: 1200, blocksHash: "hash-a", deleted: false, ignored: false, invalid: false, ...entry } } } },
    ...overrides,
  };
}

const clip = file("clip.mp4");

function decide(keepers: KeeperReport[], current: LocalFile[] = [clip], source: SetupLayout = layout, decision: SpaceDecision = fits) {
  return confirmedHandoffs(source, planOf(source), [clip], current, keepers, decision, now);
}

function reasonOf(keepers: KeeperReport[]) {
  return decide(keepers).waiting[0]?.reason;
}

describe("hand-off candidates", () => {
  it("are the files of a folder the node holds below its threshold", () => {
    assert.deepEqual(candidatesOf([clip, file("notes.txt", { folderId: "work" })]), [clip]);
  });

  it("read a path with backslashes as one with slashes", () => {
    assert.deepEqual(candidatesOf([file("sub\\clip.mp4")]).map((candidate) => candidate.path), ["sub/clip.mp4"]);
    assert.deepEqual(candidatesOf([file("Mine\\b.mp4")]), []);
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

  it("never include a file without a finite size, a block hash or a version", () => {
    assert.deepEqual(candidatesOf([file("a", { size: Number.NaN }), file("b", { blocksHash: "" }), file("c", { version: [] })]), []);
  });

  it("are none on a node whose apply is not set, that is not enabled, or whose space decision allows none", () => {
    const reporting = parseLayout(layoutText.replace("apply     = true", "apply     = false"));
    const disabled = parseLayout(layoutText.replace("apply     = true", "apply     = true\nenabled   = false"));
    const stopped: SpaceDecision = { ...fits, state: "stopped", handoffAllowed: false };

    assert.deepEqual(candidatesOf([clip], reporting), []);
    assert.deepEqual(decide([keeper("c1c1")], [clip], reporting), { confirmed: [], waiting: [], notes: [] });
    assert.deepEqual(candidatesOf([clip], disabled), []);
    assert.deepEqual(decide([keeper("c1c1")], [clip], disabled), { confirmed: [], waiting: [], notes: [] });
    assert.deepEqual(candidatesOf([clip], layout, stopped), []);
    assert.deepEqual(decide([keeper("c1c1")], [clip], layout, stopped), { confirmed: [], waiting: [], notes: [] });
  });

  it("are none from a plan made at another threshold than the space decision's", () => {
    const raisedDecision: SpaceDecision = { ...fits, state: "raised", threshold: 90 };

    assert.deepEqual(handoffCandidates(layout, planOf(), [clip], raisedDecision, now), []);
    assert.deepEqual(confirmedHandoffs(layout, planOf(), [clip], [clip], [keeper("c1c1")], raisedDecision, now).confirmed, []);
    assert.equal(handoffCandidates(layout, planOf(layout, 90), [clip], raisedDecision, now).length, 1);
  });

  it("are none from a stopped space decision turned into a plan", () => {
    const committed = planOf();
    const decision = effectiveThreshold(committed, { work: { globalBytes: 100, localBytes: 0 }, videos: { globalBytes: 100, localBytes: 100 } }, { totalBytes: 100, freeBytes: 0 });
    assert.equal(decision.state, "stopped");
    const plan = planOf(layout, decision.threshold);

    assert.deepEqual(handoffCandidates(layout, plan, [clip], decision, now), []);
    assert.deepEqual(confirmedHandoffs(layout, plan, [clip], [clip], [keeper("c1c1")], decision, now), { confirmed: [], waiting: [], notes: [] });
  });
});

describe("the case of a path", () => {
  const windowsStick = parseLayout(layoutText.replace('root = "/media/stick"', "root = 'E:\\'"));

  it("matters on a node with a Linux root, for pins and for the keeper's entry", () => {
    assert.equal(candidatesOf([file("pinned/a.mp4")]).length, 1, "pinned/ is not Pinned/ on Linux");
    const upper = keeper("c1c1");
    upper.folders.videos.files = { "CLIP.mp4": upper.folders.videos.files["clip.mp4"] };

    assert.equal(reasonOf([upper]), "not-confirmed");
  });

  it("does not matter on a node with a drive letter, for pins and for the keeper's entry", () => {
    assert.deepEqual(candidatesOf([file("pinned/a.mp4")], windowsStick), []);
    const upper = keeper("c1c1");
    upper.folders.videos.files = { "CLIP.mp4": upper.folders.videos.files["clip.mp4"] };

    assert.deepEqual(decide([upper], [clip], windowsStick).confirmed, [{ ...clip, keeper: "c1c1" }]);
  });
});

describe("a confirmed hand-off", () => {
  it("needs a keeper reporting the same type, version, size and block hash", () => {
    assert.deepEqual(decide([keeper("c1c1")]).confirmed, [{ ...clip, keeper: "c1c1" }]);
    assert.equal(reasonOf([keeper("c1c1", { blocksHash: "hash-b" })]), "not-confirmed");
    assert.equal(reasonOf([keeper("c1c1", { size: 1199 })]), "not-confirmed");
    assert.equal(reasonOf([keeper("c1c1", { version: ["STICK:2"] })]), "not-confirmed");
    assert.equal(reasonOf([keeper("c1c1", { type: "FILE_INFO_TYPE_SYMLINK" })]), "not-confirmed");
    assert.equal(decide([keeper("c1c1", { deleted: true })]).confirmed.length, 0);
  });

  it("refuses a null or empty block hash and a size that is not finite", () => {
    assert.equal(reasonOf([keeper("c1c1", { blocksHash: null })]), "not-confirmed");
    assert.equal(reasonOf([keeper("c1c1", { blocksHash: "" })]), "not-confirmed");
    assert.equal(reasonOf([keeper("c1c1", { size: Number.POSITIVE_INFINITY })]), "not-confirmed");
    const hashless = { ...clip, blocksHash: "" };
    assert.equal(confirmedHandoffs(layout, planOf(), [hashless], [hashless], [keeper("c1c1", { blocksHash: "" })], fits, now).confirmed.length, 0);
  });

  it("needs the keeper complete in the folder, and refuses a missing or NaN completion", () => {
    for (const completion of [99.5, undefined, Number.NaN]) {
      const report = keeper("c1c1");
      report.folders.videos.completion = completion as number;

      assert.equal(reasonOf([report]), "not-confirmed", String(completion));
    }
  });

  it("does not count a node whose policy does not keep the folder", () => {
    const decision = decide([keeper("a002")]);

    assert.deepEqual(decision.confirmed, []);
    assert.equal(decision.waiting[0].reason, "keeper-offline", "the cluster keeps it and has not reported");
    assert.equal(decide([keeper("c1c1", {}, { effectiveThreshold: 95 })]).confirmed.length, 1, "the cluster keeps every folder whatever its threshold");
  });

  it("never takes a reported threshold below the committed one", () => {
    const withoutCluster = parseLayout(layoutText.replace("threshold = 0\nadmitted  = true", "threshold = 0"));

    assert.equal(decide([keeper("a002", {}, { effectiveThreshold: 0 })], [clip], withoutCluster).waiting[0].reason, "no-keeper");
  });

  it("does not count a degraded, stopped or frozen keeper, or one not enabled", () => {
    for (const state of ["degraded", "stopped", "frozen"] as const) {
      assert.deepEqual(decide([keeper("c1c1", {}, { state })]).confirmed, [], state);
    }
    const disabled = parseLayout(layoutText.replace("threshold = 0\nadmitted  = true", "threshold = 0\nadmitted  = true\nenabled   = false"));
    assert.deepEqual(decide([keeper("c1c1")], [clip], disabled).confirmed, []);
  });

  it("does not count a keeper on the handing node's own device", () => {
    const sameDevice = parseLayout(layoutText.replace('device    = "array"', 'device    = "stick"'));

    assert.equal(decide([keeper("c1c1")], [clip], sameDevice).confirmed.length, 0);
  });

  it("waits while every keeper is offline or its report is older than two minutes", () => {
    assert.equal(keeperReportMaxAgeSeconds, 120);
    assert.deepEqual(decide([keeper("c1c1", {}, { online: false })]).waiting, [{ ...clip, reason: "keeper-offline" }]);
    assert.equal(reasonOf([keeper("c1c1", {}, { observedAt: "2026-11-05T11:57:59Z" })]), "keeper-offline");
    assert.equal(reasonOf([keeper("c1c1", {}, { observedAt: "not a time" })]), "keeper-offline");
    assert.equal(decide([keeper("c1c1", {}, { observedAt: "2026-11-05T11:58:00Z" })]).confirmed.length, 1);
  });

  it("drops both reports of a node reported twice, counts it offline and says so", () => {
    const twice = [keeper("c1c1"), keeper("c1c1", { blocksHash: "hash-b" })];
    const decision = decide(twice);

    assert.deepEqual(decision.confirmed, []);
    assert.equal(decision.waiting[0].reason, "keeper-offline");
    assert.deepEqual(decision.notes, ["two keeper reports for node c1c1; both were dropped, so it counts as offline"]);
  });

  it("still decides by the other keepers when one node is reported twice", () => {
    const laptopKeeps = parseLayout(layoutText.replace("threshold = 50", "threshold = 20"));
    const decision = decide([keeper("c1c1"), keeper("c1c1"), keeper("a002")], [clip], laptopKeeps);

    assert.deepEqual(decision.confirmed, [{ ...clip, keeper: "a002" }]);
    assert.equal(decision.notes.length, 1);
  });

  it("re-checks every candidate against the plan and the node's pins and assigned paths", () => {
    const pinned = file("Pinned/a.mp4");
    const kept = file("notes.txt", { folderId: "work" });

    const decision = confirmedHandoffs(layout, planOf(), [pinned, kept], [pinned, kept], [keeper("c1c1")], fits, now);

    assert.deepEqual(decision.confirmed, []);
    assert.deepEqual(decision.waiting.map((entry) => entry.reason), ["held", "held"]);
  });

  it("starts over when the file changed after it was confirmed", () => {
    const [candidate] = candidatesOf([clip]);
    const changed = file("clip.mp4", { version: ["STICK:4"], blocksHash: "hash-c" });

    const decision = confirmedHandoffs(layout, planOf(), [candidate], [changed], [keeper("c1c1")], fits, now);

    assert.deepEqual(decision.confirmed, []);
    assert.equal(decision.waiting[0].reason, "changed");
    assert.deepEqual(candidatesOf([changed]), [changed]);
  });

  it("starts over when the file is gone from the node", () => {
    assert.equal(decide([keeper("c1c1")], []).waiting[0].reason, "changed");
  });
});
