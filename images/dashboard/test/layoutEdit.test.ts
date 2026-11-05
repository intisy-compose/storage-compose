import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { editBands, editFolderPriority, editNodePolicy, headerKeys, layoutVersion, validBands } from "../src/layoutEdit.js";
import { planChanges } from "../src/layoutPreview.js";
import { parseLayout } from "../src/setupRepo.js";

const layoutText = `# the layout
[devices.pc]
id     = "PC-ID"
root   = 'F:\\'
joined = true

[devices.array]
id     = "ARRAY-ID"
role   = "archive"
root   = "/mnt/storage/pool"
joined = true

# documents first
[folders.Documents]
priority = 80
ignore = ["/GitHub"]

[folders."Documents/GitHub"]
category = "synced"

[folders.Videos]
priority = 30

[nodes.a1b2]
name      = "pc"
device    = "pc"
threshold = 50
admitted  = true

[nodes.5784]
name     = "private-array"
device   = "array"
admitted = true
`;

function priorityOf(text: string, path: string): number | undefined {
  return parseLayout(text).folders.find((folder) => folder.relativePath === path)?.priority;
}

describe("layout edits in place", () => {
  it("reads a quoted header key", () => {
    assert.deepEqual(headerKeys(`[folders."Documents/GitHub"]`), ["folders", "Documents/GitHub"]);
    assert.deepEqual(headerKeys("[nodes.a1b2.pins]"), ["nodes", "a1b2", "pins"]);
    assert.equal(headerKeys("priority = 3"), null);
  });

  it("sets an existing entry's priority and keeps every comment and the order", () => {
    const edit = editFolderPriority(layoutText, "Videos", 60);
    assert.equal(edit.boundary, null);
    assert.equal(priorityOf(edit.text, "Videos"), 60);
    assert.equal(edit.text.replace("priority = 60", "priority = 30"), layoutText);
  });

  it("gives a categorised entry a priority beside its category, which drive-sync still reads", () => {
    const edit = editFolderPriority(layoutText, "Documents/GitHub", 50);
    assert.equal(priorityOf(edit.text, "Documents/GitHub"), 50);
    assert.match(edit.text, /\[folders."Documents\/GitHub"\]\ncategory = "synced"\npriority = 50\n/);
  });

  it("a path without an entry becomes a new folder boundary after the last folder", () => {
    const edit = editFolderPriority(layoutText, "Documents\\Backup", 30);
    assert.equal(edit.boundary, "created");
    assert.equal(edit.path, "Documents/Backup");
    assert.equal(edit.folderId, "documents-backup");
    assert.equal(priorityOf(edit.text, "Documents/Backup"), 30);
    assert.ok(edit.text.indexOf(`[folders."Documents/Backup"]`) < edit.text.indexOf("[nodes.a1b2]"));
    assert.ok(edit.text.indexOf(`[folders."Documents/Backup"]`) > edit.text.indexOf("[folders.Videos]"));
  });

  it("clearing removes the entry, so the path inherits again, and is a dropped boundary", () => {
    const edit = editFolderPriority(layoutText, "Videos", null);
    assert.equal(edit.boundary, "removed");
    assert.equal(priorityOf(edit.text, "Videos"), undefined);
    assert.ok(edit.text.includes("[nodes.a1b2]"));
  });

  it("clearing an entry that also sets ignores is refused, and clearing a path without one changes nothing", () => {
    assert.throws(() => editFolderPriority(layoutText, "Documents", null), /also sets ignore/);
    assert.equal(editFolderPriority(layoutText, "Pictures", null).text, layoutText);
  });

  it("the top directory is never a folder boundary", () => {
    const edit = editFolderPriority(layoutText, "", 10);
    assert.equal(edit.boundary, null);
    assert.equal(priorityOf(edit.text, "."), 10);
  });

  it("refuses a priority outside 0 to 100, a fraction and a path leaving the tree", () => {
    assert.throws(() => editFolderPriority(layoutText, "Videos", 101), /0 to 100/);
    assert.throws(() => editFolderPriority(layoutText, "Videos", 2.5), /whole number/);
    assert.throws(() => editFolderPriority(layoutText, "../etc", 3), /leaves the tree/);
  });

  it("a node's policy is edited in its own section, pins as its pins table", () => {
    const text = editNodePolicy(layoutText, "a1b2", { threshold: 80, assigned: ["Documents/GitHub"], pins: { Videos: 90 }, enabled: false });
    const node = parseLayout(text).nodes.find((entry) => entry.id === "a1b2");
    assert.equal(node?.threshold, 80);
    assert.deepEqual(node?.assigned, ["Documents/GitHub"]);
    assert.deepEqual(node?.pins, { Videos: 90 });
    assert.equal(node?.enabled, false);
    assert.equal(parseLayout(text).nodes.find((entry) => entry.id === "5784")?.admitted, true);
    const cleared = editNodePolicy(text, "a1b2", { pins: {} });
    assert.deepEqual(parseLayout(cleared).nodes.find((entry) => entry.id === "a1b2")?.pins, {});
    assert.ok(!cleared.includes("[nodes.a1b2.pins]"));
  });

  it("an admission of a node the layout does not list adds its entry", () => {
    const text = editNodePolicy(layoutText, "c3d4", { threshold: 80, admitted: true }, { name: "stick", device: "stick" });
    const node = parseLayout(text).nodes.find((entry) => entry.id === "c3d4");
    assert.deepEqual([node?.name, node?.device, node?.threshold, node?.admitted, node?.apply], ["stick", "stick", 80, true, false]);
    assert.throws(() => editNodePolicy(layoutText, "c3d4", { admitted: true }), /no node c3d4/);
  });

  it("a refusal is recorded and can be taken back", () => {
    const refused = editNodePolicy(layoutText, "a1b2", { refused: "2026-11-05T10:00:00.000Z" });
    assert.equal(parseLayout(refused).nodes.find((entry) => entry.id === "a1b2")?.refused, "2026-11-05T10:00:00.000Z");
    assert.equal(editNodePolicy(refused, "a1b2", { refused: null }), layoutText);
  });

  it("bands replace the table, or come before the folders when the layout has none", () => {
    const bands = validBands([{ name: "local", from: 0 }, { name: "essential", from: 70 }]);
    assert.deepEqual(bands.map((band) => band.name), ["essential", "local"]);
    const text = editBands(layoutText, bands);
    assert.deepEqual(parseLayout(text).bands, bands);
    assert.ok(text.indexOf("[bands]") < text.indexOf("[folders.Documents]"));
    const again = editBands(text, validBands([{ name: "all", from: 0 }]));
    assert.deepEqual(parseLayout(again).bands, [{ name: "all", from: 0 }]);
    assert.equal(again.match(/\[bands\]/g)?.length, 1);
  });

  it("bands without one from 0, with a shared start or name, or a bad name are refused", () => {
    assert.throws(() => validBands([{ name: "high", from: 50 }]), /start at 0/);
    assert.throws(() => validBands([{ name: "a", from: 0 }, { name: "b", from: 0 }]), /same priority/);
    assert.throws(() => validBands([{ name: "a", from: 0 }, { name: "a", from: 5 }]), /same name/);
    assert.throws(() => validBands([{ name: "High", from: 0 }]), /lowercase/);
  });

  it("the version changes with any byte of the text", () => {
    assert.notEqual(layoutVersion(layoutText), layoutVersion(`${layoutText} `));
    assert.equal(layoutVersion(layoutText), layoutVersion(layoutText));
  });
});

describe("a priority edit's preview", () => {
  it("a new child entry is a new folder on every node that carries it and a new ignore line in its parent", () => {
    const edit = editFolderPriority(layoutText, "Documents/Backup", 80);
    const changes = planChanges(parseLayout(layoutText), parseLayout(edit.text), () => new Set(["documents"]));
    const pc = changes.find((change) => change.nodeId === "a1b2");
    assert.ok(pc?.changes.some((text) => text.startsWith("gains the folder Documents/Backup (documents-backup)")));
    assert.ok(pc?.changes.some((text) => text === "Documents (documents) ignores /Backup"));
    assert.ok(changes.some((change) => change.nodeId === "5784"));
  });

  it("a lower priority turns the folder send-only on a node whose threshold no longer keeps it", () => {
    const edit = editFolderPriority(layoutText, "Documents", 40);
    const pc = planChanges(parseLayout(layoutText), parseLayout(edit.text), () => new Set(["documents"])).find((change) => change.nodeId === "a1b2");
    assert.ok(pc?.changes.some((text) => text.startsWith("Documents (documents) turns send only")));
  });

  it("an edit that changes no plan names no node", () => {
    const edit = editFolderPriority(layoutText, "Videos", 31);
    assert.deepEqual(planChanges(parseLayout(layoutText), parseLayout(edit.text), () => new Set()), []);
  });
});
