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

const plan = nodePlan(layout, "b001", new Set(["Old"])) as NodePlan;

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

    assert.deepEqual(result, { state: "fits", threshold: 50, neededBytes: 400, availableBytes: 1000 });
  });

  it("raises one priority value at a time, the lowest first", () => {
    assert.equal(effectiveThreshold(plan, sizes, space(450, 300)).threshold, 80);
    assert.equal(effectiveThreshold(plan, sizes, space(450, 300)).state, "raised");
    assert.equal(effectiveThreshold(plan, sizes, space(340, 190)).threshold, 90);
  });

  it("keeps 10 % of the node free", () => {
    assert.equal(spaceHeadroom, 0.1);
    assert.equal(effectiveThreshold(plan, sizes, space(500, 400)).threshold, 50, "400 kept of 500 leaves 100 free, 20 %");
    assert.equal(effectiveThreshold(plan, sizes, space(444, 344)).threshold, 80, "400 kept of 444 leaves 44 free, under 10 %");
    assert.equal(effectiveThreshold(plan, sizes, space(4000, 700)).threshold, 50, "400 kept of 800 usable leaves exactly 10 % of 4000");
  });

  it("stops when even the top value does not fit, and keeps assigned folders through every raise", () => {
    const result = effectiveThreshold(plan, sizes, space(220, 120));

    assert.equal(result.state, "stopped");
    assert.equal(result.threshold, 90);
    assert.equal(result.neededBytes, 200, "Top and the assigned Kept");
  });

  it("is back at the threshold once it fits again", () => {
    assert.equal(effectiveThreshold(plan, sizes, space(220, 120)).state, "stopped");

    assert.deepEqual(effectiveThreshold(plan, sizes, space(2200, 2100)), { state: "fits", threshold: 50, neededBytes: 400, availableBytes: 2200 });
  });

  it("counts what the node already holds of a folder as space it gets back", () => {
    const holding = { ...sizes, work: { globalBytes: 100, localBytes: 100 } };

    assert.equal(effectiveThreshold(plan, holding, space(450, 200)).threshold, 80);
    assert.equal(effectiveThreshold(plan, holding, space(450, 200)).availableBytes, 200 + 200);
  });

  it("takes a folder the node has no size for as empty", () => {
    assert.equal(effectiveThreshold(plan, {}, space(10, 9)).state, "fits");
  });
});
