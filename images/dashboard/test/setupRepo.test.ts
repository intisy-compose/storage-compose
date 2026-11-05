import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultPriorityBands } from "../src/api/types.js";
import { highestPriority, parseLayout } from "../src/setupRepo.js";

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
    assert.equal(parseLayout(`[folders.Documents]\ncategory = "synced"\n`).bandsFromLayout, false);
  });

  it("are the layout's own when it sets them, highest first", () => {
    assert.deepEqual(parseLayout(`[bands]\nlocal = 0\nkeep = 60\n`).bands, [
      { name: "keep", from: 60 },
      { name: "local", from: 0 },
    ]);
    assert.equal(parseLayout(`[bands]\nlocal = 0\n`).bandsFromLayout, true);
  });
});

describe("a malformed node policy", () => {
  function problemsOf(text: string) {
    return parseLayout(text).problems;
  }

  it("keeps a pin with a value that is not a number at the highest priority, and reports it", () => {
    const layout = parseLayout(`[nodes.a3f9]\nname = "pc"\n[nodes.a3f9.pins]\n"Videos/Clips" = "high"\nMusic = 60\n`);

    assert.deepEqual(layout.nodes[0].pins, { "Videos/Clips": highestPriority, Music: 60 });
    assert.equal(highestPriority, 100);
    assert.equal(JSON.parse(JSON.stringify(layout.nodes[0])).pins["Videos/Clips"], 100, "the API shows the pin, never null");
    assert.deepEqual(layout.problems, [{ nodeId: "a3f9", text: "pin Videos/Clips is not a number; it protects the path as the highest pin", blocksNode: false }]);
  });

  it("stops a node whose assigned list holds anything but paths", () => {
    assert.deepEqual(problemsOf(`[nodes.a3f9]\nname = "pc"\nassigned = ["Videos", 3]\n`), [{ nodeId: "a3f9", text: "assigned holds an entry that is not a path", blocksNode: true }]);
    assert.deepEqual(problemsOf(`[nodes.a3f9]\nname = "pc"\nassigned = "Videos"\n`), [{ nodeId: "a3f9", text: "assigned is not a list of paths", blocksNode: true }]);
  });

  it("stops a node whose enabled is not true or false", () => {
    assert.deepEqual(problemsOf(`[nodes.a3f9]\nname = "pc"\nenabled = "no"\n`), [{ nodeId: "a3f9", text: "enabled is not true or false", blocksNode: true }]);
  });

  it("stops a node whose name or ID the node file would refuse", () => {
    assert.deepEqual(problemsOf(`[nodes.a3f9]\nname = "PC Data"\n`), [{ nodeId: "a3f9", text: "name 'PC Data' does not match [a-z0-9-]", blocksNode: true }]);
    assert.deepEqual(problemsOf(`[nodes.A3F9]\nname = "pc"\n`), [{ nodeId: "A3F9", text: "node ID 'A3F9' is not 4 lowercase hex digits", blocksNode: true }]);
  });

  it("stops every node that shares a name with another", () => {
    assert.deepEqual(problemsOf(`[nodes.a001]\nname = "stick"\n[nodes.a002]\nname = "stick"\n[nodes.a003]\nname = "other"\n`), [
      { nodeId: "a001", text: "name 'stick' is used by another node too", blocksNode: true },
      { nodeId: "a002", text: "name 'stick' is used by another node too", blocksNode: true },
    ]);
  });

  it("stops every node on an archive device when there is more than one", () => {
    const text = `[devices.array]\nid = "A"\nrole = "archive"\n[devices.second]\nid = "B"\nrole = "archive"\n[nodes.c001]\nname = "one"\ndevice = "array"\n[nodes.c002]\nname = "two"\ndevice = "second"\n`;

    assert.deepEqual(problemsOf(text).map((problem) => [problem.nodeId, problem.blocksNode]), [["c001", true], ["c002", true]]);
    assert.match(problemsOf(text)[0].text, /more than one node is on an archive device/);
  });

  it("has no problems when the policy is well formed", () => {
    assert.deepEqual(parseLayout(nodesText).problems, []);
  });
});
