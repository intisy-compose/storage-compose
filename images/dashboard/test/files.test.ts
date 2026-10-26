import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NodesResponse } from "../src/api/types.js";
import type { ArrayStatus } from "../src/arrayStatus.js";
import { arrayMembers } from "../src/members.js";
import { formatNodeFile, newestDescription, parseNodeFile } from "../src/nodeFile.js";
import { folderId, parseLayout, upsertDevice } from "../src/setupRepo.js";
import { parseToml } from "../src/toml.js";

const arrayFile = `# the contract's example
[node]
id        = "a3f9"          # 4 lowercase hex
name      = "private-array"
kind      = "array"
threshold = 0
assigned  = []

[array]
revision = 7
[[array.members]]
role   = "data1"
label  = "a3f9-data1"
serial = "ZA2..."
size   = 4_000_787_030_016
asset  = "SAM-0056"
[[array.members]]
role   = "parity1"
label  = "a3f9-parity1"
serial = ""
size   = 12
`;

describe("toml", () => {
  it("reads quoted table names, multi-line arrays, literal strings and comments", () => {
    const toml = parseToml(`a = 'C:\\x' # comment\n[folders."Documents/GitHub"]\nignore = [\n  "!/x", # why\n  "(?d)build",\n]\n[devices.pc.paths]\nDesktop = 'C:\\Users'\n`);
    assert.deepEqual(toml, { a: "C:\\x", folders: { "Documents/GitHub": { ignore: ["!/x", "(?d)build"] } }, devices: { pc: { paths: { Desktop: "C:\\Users" } } } });
  });

  it("refuses a broken line with its number", () => {
    assert.throws(() => parseToml('a = "open\n'), /line 1/);
  });
});

describe("node file", () => {
  it("reads the contract's example", () => {
    const file = parseNodeFile(arrayFile);
    assert.equal(file.node.id, "a3f9");
    assert.equal(file.array?.revision, 7);
    assert.deepEqual(file.array?.members[0], { role: "data1", label: "a3f9-data1", serial: "ZA2...", size: 4000787030016, asset: "SAM-0056" });
    assert.equal(file.array?.members[1].asset, undefined);
  });

  it("writes what it reads", () => {
    const file = parseNodeFile(arrayFile);
    assert.deepEqual(parseNodeFile(formatNodeFile(file)), file);
    assert.match(formatNodeFile(file), /^\[node\]\nid {8}= "a3f9"\n/);
  });

  it("refuses an id that is not 4 lowercase hex", () => {
    assert.throws(() => parseNodeFile(arrayFile.replace('"a3f9"', '"A3F9"')), /4 lowercase hex/);
  });

  it("takes the newest copy of the array's description", () => {
    const older = parseNodeFile(arrayFile);
    const newer = parseNodeFile(arrayFile.replace("revision = 7", "revision = 9"));
    const other = parseNodeFile(arrayFile.replace(/a3f9/g, "b001").replace("revision = 7", "revision = 99"));
    assert.equal(newestDescription("a3f9", [older, null, newer, other])?.array?.revision, 9);
    assert.equal(newestDescription("ffff", [older]), null);
  });
});

describe("setup repo", () => {
  const layout = `[devices.pc]
id     = "OLD"
joined = true

[devices.p53]
id     = "P53-ID-AFTER-INSTALL"
joined = false

# The first three lines are folders of their own
[folders.Documents]
category = "synced"
`;

  it("derives folder IDs as drive-sync does", () => {
    assert.equal(folderId("Documents/GitHub"), "documents-github");
    assert.equal(folderId("Minecraft Server"), "minecraft-server");
  });

  it("sets the ID and joined of a listed device in place", () => {
    const after = upsertDevice(layout, "p53", "NEW-ID", "/data");
    assert.match(after, /\[devices\.p53\]\nid     = "NEW-ID"\njoined = true\n\n# The first three/);
    assert.equal(parseLayout(after).devices.find((device) => device.name === "p53")?.joined, true);
  });

  it("adds a new device after the last one, before the folders' comment", () => {
    const after = upsertDevice(layout, "stick", "STICK-ID", "D:\\files");
    assert.match(after, /joined = false\n\n\[devices\.stick\]\nid     = "STICK-ID"\nroot   = 'D:\\files'\njoined = true\n\n# The first three/);
    assert.deepEqual(parseLayout(after).devices.map((device) => device.name), ["pc", "p53", "stick"]);
  });

  it("changes nothing for a device already recorded", () => {
    const once = upsertDevice(layout, "p53", "NEW-ID", "/data");
    assert.equal(upsertDevice(once, "p53", "NEW-ID", "/data"), once);
  });
});

type NodesResponseHasSettings = "settings" extends keyof NodesResponse ? true : false;
const nodesResponseHasSettings: NodesResponseHasSettings = false;

describe("array members", () => {
  it("a member's asset is a note and nodes carry no inventory link", async () => {
    const description = parseNodeFile(arrayFile);
    const status = { drives: [], description } as unknown as ArrayStatus;
    const members = await arrayMembers(status, [], new Map());
    const data1 = members.find((entry) => entry.role === "data1");
    assert.equal(data1?.asset, "SAM-0056");
    assert.equal("assetUrl" in (data1 ?? {}), false);
    assert.equal(nodesResponseHasSettings, false);
  });
});
