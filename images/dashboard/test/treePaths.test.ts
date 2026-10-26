import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseLayout } from "../src/setupRepo.js";
import { directoriesAbove, folderAt, placeFolders, relativeToRoot } from "../src/treePaths.js";

const layout = parseLayout(`
[folders.Desktop]
category = "synced"

[folders.Documents]
category = "synced"

[folders."Documents/GitHub"]
priority = 50

[folders.Music]
category = "archive"
`);

const pcFolders = [
  { id: "desktop", label: "Desktop", path: "F:\\Desktop" },
  { id: "documents", label: "Documents", path: "F:\\Documents" },
  { id: "documents-github", label: "Documents/GitHub", path: "f:/Documents/GitHub" },
  { id: "music", label: "Music", path: "G:\\Elsewhere\\Music" },
  { id: "scratch", label: "Scratch", path: "G:\\tmp\\scratch" },
];

describe("tree paths", () => {
  it("F:\\Documents on root F:\\ is Documents", () => {
    assert.equal(relativeToRoot("F:\\Documents", "F:\\", "windows"), "Documents");
    assert.equal(relativeToRoot("F:\\", "F:\\", "windows"), "");
  });

  it("f:/Documents on root F:\\ is Documents", () => {
    assert.equal(relativeToRoot("f:/Documents", "F:\\", "windows"), "Documents");
  });

  it("G:\\x and F:\\..\\x are outside F:\\", () => {
    assert.equal(relativeToRoot("G:\\x", "F:\\", "windows"), null);
    assert.equal(relativeToRoot("F:\\..\\x", "F:\\", "windows"), null);
  });

  it("linux paths are case-sensitive", () => {
    assert.equal(relativeToRoot("/Mnt/Storage/a", "/mnt/storage", "linux"), null);
    assert.equal(relativeToRoot("/mnt/storage/a/../b", "/mnt/storage", "linux"), "b");
  });

  it("a folder outside its node's root is placed by its layout entry", () => {
    const placements = placeFolders(pcFolders, "F:\\", "windows", layout);
    const music = placements.find((placement) => placement.folderId === "music");
    assert.deepEqual(music, { folderId: "music", label: "Music", relativePath: "Music", placedBy: "layout" });
  });

  it("a folder in neither is under Other folders", () => {
    const placements = placeFolders(pcFolders, "F:\\", "windows", layout);
    const scratch = placements.find((placement) => placement.folderId === "scratch");
    assert.deepEqual(scratch, { folderId: "scratch", label: "Scratch", relativePath: "Other folders/Scratch", placedBy: "other" });
  });

  it("the innermost folder wins: Documents/GitHub/x is documents-github's x", () => {
    const placements = placeFolders(pcFolders, "F:\\", "windows", layout);
    const found = folderAt(placements, "Documents/GitHub/x");
    assert.equal(found?.placement.folderId, "documents-github");
    assert.equal(found?.inside, "x");
    assert.equal(folderAt(placements, "documents/other")?.placement.folderId, "documents");
    assert.equal(folderAt(placements, "Videos"), null);
  });

  it("the top directory lists Desktop, Documents and Other folders", () => {
    const placements = placeFolders(pcFolders, "F:\\", "windows", null);
    assert.deepEqual(directoriesAbove(placements, null, ""), ["Desktop", "Documents", "Other folders"]);
    assert.deepEqual(directoriesAbove(placements, layout, "Documents"), ["GitHub"]);
  });
});
