import assert from "node:assert/strict";
import { type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import type { NodeFolder, Peer, StorageNode } from "../src/api/types.js";
import { folderErrorWarnings, fullWarnings, offlineWarnings, pendingWarnings, systemErrorWarnings } from "../src/attention.js";
import { attentionThresholds } from "../src/settings.js";
import { SyncthingClient } from "../src/syncthing.js";

const pcId = "PCAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";
const phoneId = "PHONEAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";
const strangerId = "STRAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";
const hour = 3_600_000;
const now = Date.parse("2026-10-21T12:00:00Z");
const defaults = { offlineHours: 24, fullPercent: 90 };

function folder(overrides: Partial<NodeFolder>): NodeFolder {
  return {
    id: "documents",
    label: "documents",
    path: "F:\\Documents",
    type: "sendreceive",
    state: "idle",
    completion: 100,
    errors: 0,
    needItems: 0,
    needBytes: 0,
    globalBytes: 0,
    globalFiles: 0,
    globalDirectories: 0,
    lastScan: null,
    lastFile: null,
    localChanged: 0,
    sharedWith: [],
    ...overrides,
  };
}

function peer(overrides: Partial<Peer>): Peer {
  return {
    deviceId: phoneId,
    name: "phone",
    connected: false,
    paused: false,
    connectionType: null,
    address: null,
    version: null,
    inRate: 0,
    outRate: 0,
    lastSeen: null,
    completion: 100,
    needBytes: 0,
    remoteState: "valid",
    folders: ["documents"],
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
    host: "pc",
    space: null,
    sync: { state: "idle", completion: 100, lastSeen: new Date(now).toISOString() },
    syncthing: null,
    instance: null,
    peers: [],
    folders: [],
    dashboardUrl: null,
    ...overrides,
  };
}

function reply(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function fakeSyncthing(): Server {
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fake");
    if (url.pathname === "/rest/system/error") return reply(response, { errors: [{ when: "2026-10-21T10:00:00Z", message: "folder documents: insufficient space", level: 3 }] });
    if (url.pathname === "/rest/cluster/pending/devices") return reply(response, { [strangerId]: { time: "2026-10-21T09:00:00Z", name: "laptop", address: "10.0.0.9:22000" } });
    if (url.pathname === "/rest/cluster/pending/folders") {
      return reply(response, { music: { offeredBy: { [pcId]: { time: "2026-10-21T08:00:00Z", label: "Music", receiveEncrypted: false, remoteEncrypted: false } } } });
    }
    response.writeHead(404);
    response.end();
  });
}

describe("attention", () => {
  let server: Server;
  let client: SyncthingClient;

  before(async () => {
    server = fakeSyncthing();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    client = new SyncthingClient({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, apiKey: "key" });
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("a folder with failed items is a warning linking to the folder", () => {
    const pc = node({ folders: [folder({ errors: 1 }), folder({ id: "pictures", label: "", errors: 652 }), folder({ id: "music", label: "music" })] });
    const warnings = folderErrorWarnings(pc);
    assert.deepEqual(
      warnings.map((entry) => [entry.level, entry.kind, entry.nodeId, entry.folderId, entry.text]),
      [
        ["warning", "folder-errors", "fb98", "documents", "documents on pc: 1 failed item"],
        ["warning", "folder-errors", "fb98", "pictures", "pictures on pc: 652 failed items"],
      ],
    );
  });

  it("a syncthing system error is a warning", async () => {
    const warnings = systemErrorWarnings(node({}), await client.systemErrors());
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].level, "warning");
    assert.equal(warnings[0].kind, "system-error");
    assert.equal(warnings[0].nodeId, "fb98");
    assert.equal(warnings[0].at, "2026-10-21T10:00:00Z");
    assert.equal(warnings[0].text, "pc's Syncthing: folder documents: insufficient space");
  });

  it("pending offers are info entries", async () => {
    const array = node({ id: "5784", name: "private-array", peers: [peer({ deviceId: pcId, name: "pc" })] });
    const warnings = pendingWarnings(array, await client.pendingDevices(), await client.pendingFolders());
    assert.deepEqual(
      warnings.map((entry) => [entry.level, entry.kind, entry.nodeId, entry.folderId, entry.at, entry.text]),
      [
        ["info", "pending-device", "5784", null, "2026-10-21T09:00:00Z", "laptop (STRAAAA) asks to connect to private-array"],
        ["info", "pending-folder", "5784", null, "2026-10-21T08:00:00Z", 'pc offers the folder "Music" to private-array'],
      ],
    );
  });

  it("a peer offline past the threshold is a warning", () => {
    const pc = node({
      peers: [
        peer({ lastSeen: new Date(now - 30 * hour).toISOString() }),
        peer({ deviceId: strangerId, name: "tablet", lastSeen: new Date(now - 2 * hour).toISOString() }),
        peer({ deviceId: pcId, name: "paused", paused: true, lastSeen: new Date(now - 300 * hour).toISOString() }),
      ],
    });
    const warnings = offlineWarnings([pc], defaults, now);
    assert.deepEqual(
      warnings.map((entry) => [entry.level, entry.kind, entry.nodeId, entry.text]),
      [["warning", "offline", "fb98", "phone (seen by pc) has been offline for 30 hours"]],
    );
  });

  it("a node offline past the threshold is a warning", () => {
    const laptop = node({ id: "0c5b", name: "old-laptop", online: false, sync: { state: "offline", completion: 0, lastSeen: new Date(now - 9 * 24 * hour).toISOString() } });
    const fresh = node({ id: "1a2b", name: "stick", online: false, sync: { state: "offline", completion: 0, lastSeen: new Date(now - hour).toISOString() } });
    const warnings = offlineWarnings([laptop, fresh], defaults, now);
    assert.deepEqual(
      warnings.map((entry) => [entry.kind, entry.nodeId, entry.text]),
      [["offline", "0c5b", "old-laptop has been offline for 9 days"]],
    );
  });

  it("the threshold comes from the setting", () => {
    const thresholds = attentionThresholds({ ATTENTION_OFFLINE_HOURS: "1", ATTENTION_FULL_PERCENT: "50" });
    assert.deepEqual(thresholds, { offlineHours: 1, fullPercent: 50 });
    assert.deepEqual(attentionThresholds({}), defaults);
    assert.deepEqual(attentionThresholds({ ATTENTION_OFFLINE_HOURS: "soon", ATTENTION_FULL_PERCENT: "-3" }), defaults);
    const pc = node({ peers: [peer({ lastSeen: new Date(now - 2 * hour).toISOString() })] });
    assert.equal(offlineWarnings([pc], defaults, now).length, 0);
    assert.equal(offlineWarnings([pc], thresholds, now).length, 1);
  });

  it("a node or drive above the full percent is a warning", () => {
    const array = node({
      id: "5784",
      name: "private-array",
      kind: "array",
      space: { size: 1000, used: 950 },
      array: {
        state: "healthy",
        members: [
          { role: "data1", label: "5784-data1", serial: null, size: 100, used: 93, asset: null, present: true, smart: null, temperature: null, condition: "present", detail: "" },
          { role: "data2", label: "5784-data2", serial: null, size: 100, used: 50, asset: null, present: true, smart: null, temperature: null, condition: "present", detail: "" },
        ],
        parity: { job: null, lastSync: null, lastScrub: null, refused: null, lastSyncResult: null, lastScrubResult: null },
        candidates: [],
        reasons: [],
      },
    });
    assert.deepEqual(
      fullWarnings(array, defaults).map((entry) => [entry.level, entry.kind, entry.nodeId, entry.text]),
      [
        ["warning", "full", "5784", "private-array is 95% full"],
        ["warning", "full", "5784", "5784-data1 in private-array is 93% full"],
      ],
    );
    assert.equal(fullWarnings(array, { ...defaults, fullPercent: 96 }).length, 0);
  });
});
