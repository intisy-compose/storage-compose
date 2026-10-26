import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ArrayMember, DriveRecord, StorageNode } from "../src/api/types.js";
import { driveKey, mergeDriveRecords, recordPresentDrives } from "../src/driveHistory.js";
import { SeenStore } from "../src/seenStore.js";

const minute = 60_000;
const start = new Date("2026-10-21T12:00:00Z");

function at(minutes: number): Date {
  return new Date(start.getTime() + minutes * minute);
}

function member(role: string, overrides: Partial<ArrayMember> = {}): ArrayMember {
  return {
    role,
    label: `5784-${role}`,
    serial: null,
    size: 1000,
    used: 500,
    asset: null,
    present: true,
    smart: null,
    temperature: null,
    condition: "present",
    detail: "",
    lastPresent: null,
    ...overrides,
  };
}

function node(overrides: Partial<StorageNode>): StorageNode {
  return {
    id: "fb98",
    name: "pc",
    kind: "drive",
    threshold: 0,
    assigned: [],
    local: true,
    online: true,
    host: "finn",
    space: { size: 2000, used: 1000 },
    sync: { state: "idle", completion: 100, lastSeen: null },
    offersWaiting: 0,
    syncthing: null,
    instance: null,
    peers: [],
    folders: [],
    dashboardUrl: null,
    ...overrides,
  };
}

function arrayNode(members: ArrayMember[], overrides: Partial<StorageNode> = {}): StorageNode {
  const parity = { job: null, lastSync: null, lastScrub: null, refused: null, lastSyncResult: null, lastScrubResult: null };
  return node({ id: "5784", name: "private-array", kind: "array", space: null, array: { state: "healthy", members, parity, candidates: [], reasons: [] }, ...overrides });
}

function record(key: string, attachments: DriveRecord["attachments"], overrides: Partial<DriveRecord> = {}): DriveRecord {
  return { key, label: "5784-data1", kind: "array-member", serial: "WKD082MD", size: 1000, arrayId: "5784", nodeId: null, attachments, ...overrides };
}

describe("drive history", () => {
  let directory: string;
  let count = 0;

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), "drive-history-"));
  });

  after(() => rm(directory, { recursive: true, force: true }));

  function freshStore(): SeenStore<DriveRecord> {
    count += 1;
    return new SeenStore<DriveRecord>(join(directory, `drives-${count}.json`), 0);
  }

  it("a present member drive records its host and role", async () => {
    const store = freshStore();
    const records = await recordPresentDrives([arrayNode([member("data1", { serial: "WKD082MD" }), member("data2", { present: false, condition: "missing" })])], "finn", start, store);
    assert.deepEqual(records, [
      {
        key: "serial:WKD082MD",
        label: "5784-data1",
        kind: "array-member",
        serial: "WKD082MD",
        size: 1000,
        arrayId: "5784",
        nodeId: null,
        attachments: [{ host: "finn", since: start.toISOString(), lastAt: start.toISOString(), as: "data1 of private-array" }],
      },
    ]);
    assert.deepEqual(JSON.parse(await readFile(store.path, "utf8")), records, "the record is written to the store's file");
  });

  it("a drive or folder node is recorded by its node ID", async () => {
    const store = freshStore();
    const records = await recordPresentDrives([node({}), node({ id: "a3f9", name: "photos", kind: "folder", space: null }), node({ id: "c001", online: false })], "finn", start, store);
    assert.deepEqual(
      records.map((entry) => [entry.key, entry.kind, entry.label, entry.size, entry.nodeId, entry.attachments[0].as]),
      [
        ["node:a3f9", "folder-node", "photos", null, "a3f9", "folder node photos"],
        ["node:fb98", "drive-node", "pc", 2000, "fb98", "drive node pc"],
      ],
    );
  });

  it("seen again on the same host extends the attachment", async () => {
    const store = freshStore();
    const nodes = [arrayNode([member("data1", { serial: "WKD082MD" })])];
    await recordPresentDrives(nodes, "finn", start, store);
    const records = await recordPresentDrives(nodes, "finn", at(5), store);
    assert.deepEqual(records[0].attachments, [{ host: "finn", since: start.toISOString(), lastAt: at(5).toISOString(), as: "data1 of private-array" }]);
  });

  it("a move to another host starts a new attachment", async () => {
    const store = freshStore();
    await recordPresentDrives([arrayNode([member("data1", { serial: "WKD082MD" })])], "finn", start, store);
    const records = await recordPresentDrives([arrayNode([member("data1", { serial: "WKD082MD" })])], "p53", at(30), store);
    assert.deepEqual(records[0].attachments, [
      { host: "p53", since: at(30).toISOString(), lastAt: at(30).toISOString(), as: "data1 of private-array" },
      { host: "finn", since: start.toISOString(), lastAt: start.toISOString(), as: "data1 of private-array" },
    ]);
  });

  it("history keeps 20", async () => {
    const store = freshStore();
    const nodes = [arrayNode([member("data1", { serial: "WKD082MD" })])];
    for (let index = 0; index < 25; index += 1) await recordPresentDrives(nodes, index % 2 ? "p53" : "finn", at(index), store);
    const [only] = await store.load();
    assert.equal(only.attachments.length, 20);
    assert.equal(only.attachments[0].lastAt, at(24).toISOString(), "the newest stays first");
    assert.equal(only.attachments[19].lastAt, at(5).toISOString(), "the oldest five are dropped");
  });

  it("records of two hosts merge newest first", () => {
    const finnStay = { host: "finn", since: start.toISOString(), lastAt: at(10).toISOString(), as: "data1 of private-array" };
    const finnStayOlderView = { ...finnStay, lastAt: at(5).toISOString() };
    const p53Stay = { host: "p53", since: at(20).toISOString(), lastAt: at(40).toISOString(), as: "data3 of private-array" };
    const own = [record("serial:WKD082MD", [finnStay], { label: "5784-data1" }), record("node:fb98", [], { kind: "drive-node", nodeId: "fb98", arrayId: null, serial: null })];
    const fromP53 = [record("serial:WKD082MD", [p53Stay, finnStayOlderView], { label: "5784-data3", size: 2000 })];
    const merged = mergeDriveRecords(own, [fromP53]);
    assert.deepEqual(merged.map((entry) => entry.key), ["node:fb98", "serial:WKD082MD"]);
    const drive = merged[1];
    assert.equal(drive.label, "5784-data3", "the record seen last describes the drive");
    assert.equal(drive.size, 2000);
    assert.deepEqual(drive.attachments, [p53Stay, finnStay], "one stay per host and start, with the later end");
  });

  it("a member keyed by role is re-keyed by its serial", async () => {
    const store = freshStore();
    const before = await recordPresentDrives([arrayNode([member("data1")])], "finn", start, store);
    assert.deepEqual(before.map((entry) => entry.key), ["member:5784-data1"]);
    const after = await recordPresentDrives([arrayNode([member("data1", { serial: "WKD082MD" })])], "finn", at(5), store);
    assert.deepEqual(after.map((entry) => entry.key), ["serial:WKD082MD"]);
    assert.equal(after[0].serial, "WKD082MD");
    assert.deepEqual(after[0].attachments, [{ host: "finn", since: start.toISOString(), lastAt: at(5).toISOString(), as: "data1 of private-array" }]);
  });

  it("a member of an array that is not connected is recorded when the mounter last saw it, once", async () => {
    const store = freshStore();
    const lastPresent = { since: "2026-10-21T00:43:49Z", at: "2026-10-21T12:35:32Z" };
    const detached = [arrayNode([member("data1", { serial: "WKD082MD", present: false, condition: "missing", lastPresent })], { online: false })];
    await recordPresentDrives(detached, "finn", at(4000), store);
    const records = await recordPresentDrives(detached, "finn", at(5000), store);
    assert.deepEqual(records[0].attachments, [{ host: "finn", since: "2026-10-21T00:43:49.000Z", lastAt: "2026-10-21T12:35:32.000Z", as: "data1 of private-array" }]);
  });

  it("an older stay found later goes below the newer one, and only once", async () => {
    const store = freshStore();
    const lastPresent = { since: start.toISOString(), at: at(10).toISOString() };
    await recordPresentDrives([arrayNode([member("data1", { serial: "WKD082MD" })])], "p53", at(60), store);
    await recordPresentDrives([arrayNode([member("data1", { serial: "WKD082MD", present: false, condition: "missing", lastPresent })])], "finn", at(70), store);
    const records = await recordPresentDrives([arrayNode([member("data1", { serial: "WKD082MD", present: false, condition: "missing", lastPresent })])], "finn", at(80), store);
    assert.deepEqual(
      records[0].attachments.map((stay) => [stay.host, stay.lastAt]),
      [
        ["p53", at(60).toISOString()],
        ["finn", at(10).toISOString()],
      ],
    );
  });

  it("the key prefers the serial, then the member, then the node", () => {
    assert.equal(driveKey({ serial: "WKD082MD", arrayId: "5784", role: "data1", nodeId: null }), "serial:WKD082MD");
    assert.equal(driveKey({ serial: null, arrayId: "5784", role: "data1", nodeId: null }), "member:5784-data1");
    assert.equal(driveKey({ serial: null, arrayId: null, role: null, nodeId: "fb98" }), "node:fb98");
  });
});
