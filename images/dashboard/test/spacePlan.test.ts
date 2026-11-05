import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type NodePlan, nodePlan } from "../src/nodePlan.js";
import { parseLayout } from "../src/setupRepo.js";
import { type FolderSizes, effectiveThreshold, spaceHeadroom } from "../src/spacePlan.js";

const layout = parseLayout(`
[devices.stick]
id   = "STICK-ID"
root = "/media/stick"

[folders.Top]
priority = 90

[folders.Work]
priority = 80

[folders.Notes]
priority = 50

[folders.Old]
priority = 30

[folders.Kept]
priority = 10

[nodes.b001]
name      = "stick"
device    = "stick"
threshold = 50
assigned  = ["Kept"]
admitted  = true
`);

const plan = nodePlan(layout, "b001", new Set(["Old", "Notes"])) as NodePlan;

/** Every folder 100 bytes in the network; the stick already holds Old and nothing else. */
const sizes: FolderSizes = {
  top: { globalBytes: 100, localBytes: 0 },
  work: { globalBytes: 100, localBytes: 0 },
  notes: { globalBytes: 100, localBytes: 0 },
  old: { globalBytes: 100, localBytes: 100 },
  kept: { globalBytes: 100, localBytes: 0 },
};

/** A node of `total` bytes with `free` of them free; what it holds of planned folders is part of what is used. */
function space(total: number, free: number) {
  return { totalBytes: total, freeBytes: free };
}

describe("the space a node's threshold needs", () => {
  it("keeps the threshold when everything at it fits", () => {
    const result = effectiveThreshold(plan, sizes, space(1000, 900));

    assert.deepEqual(result, { state: "fits", threshold: 50, neededBytes: 400, availableBytes: 900, handoffAllowed: true });
  });

  it("raises one priority value at a time, the lowest first", () => {
    assert.equal(effectiveThreshold(plan, sizes, space(450, 400)).threshold, 80);
    assert.equal(effectiveThreshold(plan, sizes, space(450, 400)).state, "raised");
    assert.equal(effectiveThreshold(plan, sizes, space(450, 400)).handoffAllowed, true);
    assert.equal(effectiveThreshold(plan, sizes, space(340, 300)).threshold, 90);
  });

  it("keeps 10 % of the node free", () => {
    assert.equal(spaceHeadroom, 0.1);
    assert.equal(effectiveThreshold(plan, sizes, space(500, 500)).threshold, 50, "400 kept of 500 leaves 100 free, 20 %");
    assert.equal(effectiveThreshold(plan, sizes, space(444, 444)).threshold, 80, "400 kept of 444 leaves 44 free, under 10 %");
    assert.equal(effectiveThreshold(plan, sizes, space(4000, 800)).threshold, 50, "400 kept of 800 free leaves exactly 10 % of 4000");
  });

  it("stops when even the top value does not fit, at the committed threshold and with no hand-off", () => {
    const result = effectiveThreshold(plan, sizes, space(220, 220));

    assert.deepEqual(result, { state: "stopped", threshold: 50, neededBytes: 200, availableBytes: 220, handoffAllowed: false });
  });

  it("is back at the threshold once it fits again", () => {
    assert.equal(effectiveThreshold(plan, sizes, space(220, 220)).state, "stopped");

    assert.deepEqual(effectiveThreshold(plan, sizes, space(2200, 2200)), { state: "fits", threshold: 50, neededBytes: 400, availableBytes: 2200, handoffAllowed: true });
  });

  it("counts what the node holds of a kept folder as space it already has", () => {
    const holding = { ...sizes, work: { globalBytes: 100, localBytes: 100 } };

    assert.equal(effectiveThreshold(plan, holding, space(450, 300)).threshold, 80);
    assert.equal(effectiveThreshold(plan, holding, space(450, 300)).availableBytes, 300 + 100);
  });

  it("counts a hand-off folder's bytes as freed only for confirmed hand-offs", () => {
    assert.equal(effectiveThreshold(plan, sizes, space(450, 300)).threshold, 90);
    assert.equal(effectiveThreshold(plan, sizes, space(450, 300), { old: 100 }).threshold, 80);
  });

  it("is unknown while a kept folder has no size, which never fits and allows no hand-off", () => {
    const { kept: _, ...withoutKept } = sizes;

    assert.deepEqual(effectiveThreshold(plan, withoutKept, space(10_000, 10_000)), { state: "unknown", threshold: 50, neededBytes: 300, availableBytes: 10_000, handoffAllowed: false });
    const { old: __, ...withoutOld } = sizes;
    assert.equal(effectiveThreshold(plan, withoutOld, space(10_000, 10_000)).state, "fits", "Old is not kept, so its size decides nothing");
  });

  it("never drops the cluster's folders of other nodes' priority 0 entries", () => {
    const network = parseLayout(`
[devices.pc]
id = "PC-ID"

[devices.array]
id   = "ARRAY-ID"
role = "archive"

[folders.Low]
priority = 10

[folders.High]
priority = 80

[folders.Own]
priority = 0

[nodes.a001]
name     = "pc"
device   = "pc"
admitted = true

[nodes.c1c1]
name     = "private-array"
device   = "array"
admitted = true
`);
    const cluster = nodePlan(network, "c1c1", new Set()) as NodePlan;
    const clusterSizes: FolderSizes = { low: { globalBytes: 100, localBytes: 0 }, high: { globalBytes: 100, localBytes: 0 }, "a001-own": { globalBytes: 100, localBytes: 0 } };

    assert.deepEqual(effectiveThreshold(cluster, clusterSizes, space(300, 300)), { state: "raised", threshold: 80, neededBytes: 200, availableBytes: 300, handoffAllowed: true });
  });
});

describe("a raised threshold as a plan", () => {
  it("is refused as the input of a space decision, which starts from the committed threshold", () => {
    const raised = nodePlan(layout, "b001", new Set(["Old"]), 80) as NodePlan;

    assert.throws(() => effectiveThreshold(raised, sizes, space(1000, 900)), /made at threshold 80, not at its committed 50/);
  });

  it("sends what the raise drops, and keeps what stays", () => {
    const raised = nodePlan(layout, "b001", new Set(["Old", "Notes"]), 80) as NodePlan;

    assert.equal(raised.threshold, 50, "the committed threshold");
    assert.equal(raised.appliedThreshold, 80);
    assert.equal(raised.folders.find((folder) => folder.id === "notes")?.type, "sendonly");
    assert.equal(raised.folders.find((folder) => folder.id === "work")?.type, "sendreceive");
    assert.equal(raised.folders.find((folder) => folder.id === "kept")?.keptBy, "assigned");
  });

  it("never lowers the committed threshold", () => {
    assert.equal((nodePlan(layout, "b001", new Set(["Old"]), 10) as NodePlan).appliedThreshold, 50);
  });
});
