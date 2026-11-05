import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultPriorityBands } from "../src/api/types.js";
import { parseLayout } from "../src/setupRepo.js";

const nodesText = `
[devices.pc]
id   = "PC-ID"
root = 'F:\\'

[devices.pc.paths]
Desktop = 'C:\\Users\\someone\\Desktop'

[nodes.a3f9]
name      = "pc-data"
device    = "pc"
threshold = 50
assigned  = ["Videos/Holiday", "Documents\\\\Notes\\\\"]
access    = "closed"
admitted  = true
apply     = true
enabled   = false

[nodes.a3f9.pins]
"Videos/Clips" = 90
"Pictures/" = 80

[nodes.b001]
name = "stick"
`;

describe("the layout's nodes", () => {
  it("parse every field of [nodes.<id>]", () => {
    const node = parseLayout(nodesText).nodes.find((entry) => entry.id === "a3f9");

    assert.deepEqual(node, {
      id: "a3f9",
      name: "pc-data",
      device: "pc",
      threshold: 50,
      assigned: ["Videos/Holiday", "Documents/Notes"],
      pins: { "Videos/Clips": 90, Pictures: 80 },
      access: "closed",
      admitted: true,
      apply: true,
      enabled: false,
    });
  });

  it("take the defaults for every field left out", () => {
    const node = parseLayout(nodesText).nodes.find((entry) => entry.id === "b001");

    assert.deepEqual(node, {
      id: "b001",
      name: "stick",
      device: "",
      threshold: 0,
      assigned: [],
      pins: {},
      access: "open",
      admitted: false,
      apply: false,
      enabled: true,
    });
  });

  it("are not admitted without admitted = true", () => {
    const layout = parseLayout(`[nodes.c0de]\nname = "drive"\nadmitted = "yes"\n`);

    assert.equal(layout.nodes[0].admitted, false);
  });

  it("read an unknown access as open", () => {
    assert.equal(parseLayout(`[nodes.c0de]\naccess = "sealed"\n`).nodes[0].access, "open");
  });

  it("are empty when the layout has none", () => {
    assert.deepEqual(parseLayout(`[folders.Documents]\ncategory = "synced"\n`).nodes, []);
  });
});

describe("the layout's devices and folders", () => {
  it("keep a device's root, paths and role", () => {
    const layout = parseLayout(`${nodesText}\n[devices.array]\nid = "ARRAY-ID"\nrole = "archive"\nroot = "/mnt/storage/pool"\njoined = false\n`);

    assert.deepEqual(layout.devices, [
      { name: "pc", id: "PC-ID", joined: true, role: "device", root: "F:\\", paths: { Desktop: "C:\\Users\\someone\\Desktop" } },
      { name: "array", id: "ARRAY-ID", joined: false, role: "archive", root: "/mnt/storage/pool", paths: {} },
    ]);
  });

  it("give a device without a root drive-sync's /data", () => {
    assert.equal(parseLayout(`[devices.p53]\nid = "P53-ID"\n`).devices[0].root, "/data");
  });

  it("keep a folder's ignore lines and versions_days, 365 by default", () => {
    const layout = parseLayout(`[folders.Documents]\ncategory = "synced"\nignore = ["/GitHub", "(?d)build"]\n\n[folders."Documents/GitHub"]\npriority = 90\nversions_days = 30\n`);

    assert.deepEqual(layout.folders, [
      { relativePath: "Documents", id: "documents", priority: 80, ignore: ["/GitHub", "(?d)build"], versionsDays: 365 },
      { relativePath: "Documents/GitHub", id: "documents-github", priority: 90, ignore: [], versionsDays: 30 },
    ]);
  });

  it("still convert C-30's categories", () => {
    const layout = parseLayout(`[folders.A]\ncategory = "synced"\n[folders.B]\ncategory = "archive"\n[folders.C]\ncategory = "local"\n`);

    assert.deepEqual(layout.folders.map((folder) => folder.priority), [80, 30, 0]);
  });
});

describe("the layout's bands", () => {
  it("are the design's four when the layout has none", () => {
    assert.deepEqual(defaultPriorityBands, [
      { name: "essential", from: 80 },
      { name: "working", from: 50 },
      { name: "archive", from: 1 },
      { name: "local", from: 0 },
    ]);
    assert.deepEqual(parseLayout(`[folders.Documents]\ncategory = "synced"\n`).bands, defaultPriorityBands);
  });

  it("are the layout's own when it sets them, highest first", () => {
    assert.deepEqual(parseLayout(`[bands]\nlocal = 0\nkeep = 60\n`).bands, [
      { name: "keep", from: 60 },
      { name: "local", from: 0 },
    ]);
  });
});
