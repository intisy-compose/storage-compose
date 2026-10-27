import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type SharingChoice, clearSharing, folderSharingChange, hasSharingChanges, isTicked, tick } from "../ui/src/sharingFields.js";
import { emptySharing } from "../ui/src/state.js";

function choice(key: string, isShared: boolean): SharingChoice {
  return { key, label: key, detail: null, isShared, needsPassword: false, receiver: "laptop" };
}

describe("a form's sharing draft", () => {
  it("ticking a device not yet shared marks it for sharing, unticking it forgets it and its password", () => {
    const draft = emptySharing();
    const laptop = choice("LAPTOP", false);
    assert.equal(isTicked(draft, laptop), false);
    tick(draft, laptop, true);
    assert.equal(isTicked(draft, laptop), true);
    draft.share.set("LAPTOP", "secret");
    draft.revealed.add("LAPTOP");
    tick(draft, laptop, false);
    assert.equal(isTicked(draft, laptop), false);
    assert.equal(draft.share.has("LAPTOP"), false);
    assert.equal(draft.revealed.has("LAPTOP"), false);
    assert.equal(hasSharingChanges(draft), false);
  });

  it("unticking a shared device marks it for unsharing, ticking it again takes that back", () => {
    const draft = emptySharing();
    const array = choice("ARRAY", true);
    assert.equal(isTicked(draft, array), true);
    tick(draft, array, false);
    assert.equal(isTicked(draft, array), false);
    assert.deepEqual([...draft.unshare], ["ARRAY"]);
    tick(draft, array, true);
    assert.equal(isTicked(draft, array), true);
    assert.equal(hasSharingChanges(draft), false);
  });

  it("every tick tells the form, so it can drop a result line that no longer fits", () => {
    const draft = emptySharing();
    let edits = 0;
    tick(draft, choice("LAPTOP", false), true, () => (edits += 1));
    tick(draft, choice("ARRAY", true), false, () => (edits += 1));
    assert.equal(edits, 2);
  });

  it("the draft becomes the edit's devices field, a password trimmed and a blank one left out", () => {
    const draft = emptySharing();
    draft.share.set("LAPTOP", "");
    draft.share.set("PHONE", "   ");
    draft.share.set("ARRAY", "  pass word ");
    draft.unshare.add("OLD");
    assert.deepEqual(folderSharingChange(draft), {
      share: [{ deviceId: "LAPTOP" }, { deviceId: "PHONE" }, { deviceId: "ARRAY", encryptionPassword: "pass word" }],
      unshare: ["OLD"],
    });
    clearSharing(draft);
    assert.equal(hasSharingChanges(draft), false);
  });
});
