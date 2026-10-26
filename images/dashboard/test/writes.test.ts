import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type WriteNote, settleWrite } from "../src/routes.js";

function recorder() {
  const recorded: WriteNote[] = [];
  let invalidations = 0;
  return {
    recorded,
    invalidations: () => invalidations,
    effects: { invalidate: () => void (invalidations += 1), record: (note: WriteNote) => void recorded.push(note) },
  };
}

const note: WriteNote = { nodeId: "fb98", folderId: null, text: "pc: renamed device dashboard-test-peer to dashboard-test-renamed" };

describe("a write through the dashboard", () => {
  it("a successful write drops the shared local build and enters its note in Activity", () => {
    const effects = recorder();
    settleWrite("PATCH", 200, note, effects.effects);
    assert.equal(effects.invalidations(), 1);
    assert.deepEqual(effects.recorded, [note]);
  });

  it("a write without a note still drops the shared local build", () => {
    const effects = recorder();
    settleWrite("POST", 202, undefined, effects.effects);
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
