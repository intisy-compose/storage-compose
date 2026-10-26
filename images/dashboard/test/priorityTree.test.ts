import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { overridesBelow, priorityAt, topDirectoryDefault } from "../src/priorityTree.js";
import { parseLayout } from "../src/setupRepo.js";

const layoutText = `
[folders.Documents]
category = "synced"

[folders."Documents/GitHub"]
priority = 50

[folders."Documents/Backup"]
category = "archive"

[folders."Documents/Notes"]
category = "synced"

[folders.Videos]
category = "archive"
`;

const layout = parseLayout(layoutText);
const layoutWithTop = parseLayout(`[folders."."]\npriority = 20\n${layoutText}`);

describe("priority tree", () => {
  it("the top directory is 0 without a layout", () => {
    assert.equal(topDirectoryDefault, 0);
    assert.deepEqual(priorityAt(null, ""), { effective: 0, setHere: null, inherited: 0, inheritedFrom: null, source: "default", overridesParent: false });
    assert.equal(priorityAt(layout, "").effective, 0);
    assert.deepEqual(priorityAt(null, "Pictures/Holidays"), { effective: 0, setHere: null, inherited: 0, inheritedFrom: null, source: "default", overridesParent: false });
  });

  it("the top directory takes the layout's . entry", () => {
    assert.deepEqual(priorityAt(layoutWithTop, ""), { effective: 20, setHere: 20, inherited: 0, inheritedFrom: null, source: "setup-repo", overridesParent: false });
    assert.deepEqual(priorityAt(layoutWithTop, "Pictures"), { effective: 20, setHere: null, inherited: 20, inheritedFrom: ".", source: "inherited", overridesParent: false });
  });

  it("a path inherits the nearest ancestor's priority and names it", () => {
    assert.deepEqual(priorityAt(layout, "Documents/GitHub/compose/docs"), { effective: 50, setHere: null, inherited: 50, inheritedFrom: "Documents/GitHub", source: "inherited", overridesParent: false });
    assert.deepEqual(priorityAt(layout, "Documents/Letters"), { effective: 80, setHere: null, inherited: 80, inheritedFrom: "Documents", source: "inherited", overridesParent: false });
  });

  it("an entry that differs from its parent overrides it", () => {
    assert.deepEqual(priorityAt(layout, "Documents/GitHub"), { effective: 50, setHere: 50, inherited: 80, inheritedFrom: "Documents", source: "setup-repo", overridesParent: true });
    assert.deepEqual(priorityAt(layout, "Documents"), { effective: 80, setHere: 80, inherited: 0, inheritedFrom: null, source: "setup-repo", overridesParent: true });
  });

  it("an entry equal to its parent is set here and not an override", () => {
    assert.deepEqual(priorityAt(layout, "Documents/Notes"), { effective: 80, setHere: 80, inherited: 80, inheritedFrom: "Documents", source: "setup-repo", overridesParent: false });
  });

  it("overrides below Documents list Documents/GitHub with its parent's value", () => {
    assert.deepEqual(overridesBelow(layout, "Documents"), [
      { path: "Documents/Backup", priority: 30, parent: 80 },
      { path: "Documents/GitHub", priority: 50, parent: 80 },
    ]);
    assert.deepEqual(overridesBelow(layout, "Documents/GitHub"), []);
    assert.deepEqual(overridesBelow(null, ""), []);
    assert.deepEqual(
      overridesBelow(layout, "").map((override) => override.path),
      ["Documents", "Documents/Backup", "Documents/GitHub", "Videos"],
    );
  });

  it("Documents\\GitHub and documents/github are the same path", () => {
    assert.deepEqual(priorityAt(layout, "Documents\\GitHub"), priorityAt(layout, "documents/github"));
    assert.equal(priorityAt(layout, "documents/github/").setHere, 50);
    assert.deepEqual(overridesBelow(layout, "DOCUMENTS\\"), overridesBelow(layout, "Documents"));
  });

  it("the layout keeps the top directory and writes every path with / and no outer slashes", () => {
    const parsed = parseLayout(`[folders."."]\npriority = 20\n[folders."/Documents\\\\GitHub/"]\npriority = 50\n[folders."./Videos"]\ncategory = "archive"\n`);
    assert.deepEqual(
      parsed.folders.map((folder) => [folder.relativePath, folder.id, folder.priority]),
      [[".", "", 20], ["Documents/GitHub", "documents-github", 50], ["Videos", "videos", 30]],
    );
  });
});
