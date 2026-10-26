import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type NodeWriteRoute, type WriteNote, settleWrite } from "../src/routes.js";

function recorder() {
  const recorded: WriteNote[] = [];
  let invalidations = 0;
  return {
    recorded,
    invalidations: () => invalidations,
    effects: { invalidate: () => void (invalidations += 1), record: (note: WriteNote) => void recorded.push(note) },
  };
}

const note: WriteNote = { nodeId: "fb98", nodeName: "pc", folderId: null, text: "pc: renamed device dashboard-test-peer to dashboard-test-renamed" };

describe("a write through the dashboard", () => {
  it("a successful write drops the shared local build and enters its note in Activity", () => {
    const effects = recorder();
    settleWrite("PATCH", 200, note, effects.effects);
    assert.equal(effects.invalidations(), 1);
    assert.deepEqual(effects.recorded, [note]);
  });

  it("a node write must answer with its note, so a forgotten one does not compile", () => {
    const forgetful: NodeWriteRoute = {
      method: "PATCH",
      pattern: /^\/api\/nodes\/x$/,
      // @ts-expect-error a node write that names nothing for Activity is a compile error
      write: async () => {},
    };
    assert.equal(forgetful.method, "PATCH");
  });

  it("a node write whose note is empty is still entered, naming the node", () => {
    const effects = recorder();
    settleWrite("PATCH", 200, { ...note, text: " " }, effects.effects);
    assert.deepEqual(effects.recorded.map((entry) => entry.text), ["pc: changed through the dashboard"]);
    assert.equal(effects.invalidations(), 1);
  });

  it("a write that is not a node's, such as an array action, only drops the shared build", () => {
    const effects = recorder();
    settleWrite("POST", 202, null, effects.effects);
    assert.equal(effects.invalidations(), 1);
    assert.deepEqual(effects.recorded, []);
  });

  it("a read or a refused write changes nothing", () => {
    const effects = recorder();
    settleWrite("GET", 200, note, effects.effects);
    settleWrite("PATCH", 409, note, effects.effects);
    assert.equal(effects.invalidations(), 0);
    assert.deepEqual(effects.recorded, []);
  });
});
