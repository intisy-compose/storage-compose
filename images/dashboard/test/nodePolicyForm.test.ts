import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatBytes } from "../ui/src/format.js";
import { isApplyConfirmed, pinsText, raiseLines, typedPaths, typedPins } from "../ui/src/nodePolicyForm.js";

describe("the node policy form", () => {
  it("pins are written and read as path = priority per line", () => {
    const text = pinsText({ Videos: 85, "Documents/GitHub": 90 });
    assert.equal(text, "Documents/GitHub = 90\nVideos = 85");
    assert.deepEqual(typedPins(`${text}\n\n`), { pins: { "Documents/GitHub": 90, Videos: 85 } });
    assert.deepEqual(typedPins("Videos = 101"), { problem: `"Videos = 101" is not a path = priority from 0 to 100` });
    assert.deepEqual(typedPins("Videos"), { problem: `"Videos" is not a path = priority from 0 to 100` });
  });

  it("assigned paths are one per line, blank lines dropped", () => {
    assert.deepEqual(typedPaths(" Documents \n\nPictures\n"), ["Documents", "Pictures"]);
  });

  it("a raise names what leaves, how much, and which keeper must confirm it; a folder no node keeps is named apart", () => {
    const lines = raiseLines({
      nodeId: "a1b2",
      threshold: 90,
      files: 12,
      bytes: 4096,
      handoffs: [
        { folderId: "documents", label: "Documents", files: 12, bytes: 4096, keepers: ["private-array"] },
        { folderId: "videos", label: "Videos", files: 3, bytes: 100, keepers: [] },
      ],
      changes: [],
    });
    assert.deepEqual(lines, [
      `Raising the threshold to 90 hands off up to 12 files (${formatBytes(4096)}):`,
      `Documents: up to 12 files (${formatBytes(4096)}) leave this node once private-array confirms each`,
      "Videos: turns send-only, but no node keeps it, so nothing of it leaves",
      "Nothing leaves before a keeper confirms each file, and only while the node acts on its plan.",
    ]);
    assert.deepEqual(raiseLines({ nodeId: "a1b2", threshold: 60, files: 0, bytes: 0, handoffs: [], changes: [] }), ["At 60 nothing more turns send-only, so nothing more is handed off."]);
  });

  it("apply is confirmed only by the node's name typed exactly", () => {
    assert.equal(isApplyConfirmed({ name: "pc" }, "pc"), true);
    for (const typed of ["", "PC", " pc", "pc "]) assert.equal(isApplyConfirmed({ name: "pc" }, typed), false, typed);
  });
});
