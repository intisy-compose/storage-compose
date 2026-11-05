import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { boundaryLines, savedNotice, typedPriority } from "../ui/src/priorityEditor.js";

describe("the explorer's priority form", () => {
  it("takes a whole number from 0 to 100 and nothing else", () => {
    assert.equal(typedPriority("80"), 80);
    assert.equal(typedPriority(" 0 "), 0);
    for (const text of ["", "101", "-1", "2.5", "eighty"]) assert.equal(typedPriority(text), null, text);
  });

  it("a new folder boundary names the folder and each node's change before it is saved", () => {
    const lines = boundaryLines({ path: "Documents/Backup", folderId: "documents-backup", boundary: "created", nodes: [{ nodeId: "a1b2", nodeName: "pc", changes: ["gains the folder Documents/Backup (documents-backup)", "Documents (documents) ignores /Backup"] }] });
    assert.deepEqual(lines, [
      "Saving makes Documents/Backup its own Syncthing folder, documents-backup, on every node that carries it.",
      "pc: gains the folder Documents/Backup (documents-backup)",
      "pc: Documents (documents) ignores /Backup",
    ]);
  });

  it("a removed entry says no round removes the folder from a node", () => {
    const [heading, only] = boundaryLines({ path: "Videos", folderId: "videos", boundary: "removed", nodes: [] });
    assert.match(heading, /no round removes it from a node/);
    assert.equal(only, "No node's plan changes.");
  });

  it("a save kept on this host is a warning that says so", () => {
    const layout = { version: "v", folders: [], nodes: [], bands: [], bandsFromLayout: false, problems: [], pulledAt: null, pullProblem: null };
    assert.deepEqual(savedNotice("Videos", { saved: { committed: true, pushed: false, message: "committed, not pushed yet: offline" }, layout }), { text: "Videos: saved on this host, committed, not pushed yet: offline.", tone: "warn" });
    assert.equal(savedNotice("Videos", { saved: { committed: true, pushed: true, message: "" }, layout }).tone, "ok");
    assert.equal(savedNotice("Videos", { saved: { committed: false, pushed: true, message: "" }, layout }).text, "Videos: nothing to change.");
  });
});
