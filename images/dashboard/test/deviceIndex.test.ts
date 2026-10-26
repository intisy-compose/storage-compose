import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DeviceSummary, DevicesResponse, DriveAttachment, DriveRecord, Peer, StorageNode } from "../src/api/types.js";
import { type DeviceIndexSources, deviceIndex } from "../src/deviceIndex.js";
import type { DeviceSeen } from "../src/seenStore.js";

const pcId = "PBMD2SH-RS3UNJU-L77BP7K-X7VFKHE-73FF74D-RRCUVRY-XNUNII3-WWU53Q6";
const arrayId = "X7KCOB7-4ZJQ2RT-W352REX-D36FWRQ-YSGVXEA-6YA5PZK-PHYIU5M-32WVQQ4";
const testPeerId = "QIXEYHJ-4CIPXRY-2FVAONW-OX6QPBK-M5OCSUU-5HCZY4M-DPELEBU-7UOJ5QI";
const p53Id = "P53AAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";
const stickId = "STICKAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";
const phoneId = "PHONEAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";
const laptopId = "LAPTOPA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";

function peer(deviceId: string, overrides: Partial<Peer> = {}): Peer {
  return {
    deviceId,
    name: "",
    connected: false,
    paused: false,
    connectionType: null,
    connectionKind: null,
    address: null,
    version: null,
    inRate: 0,
    outRate: 0,
    lastSeen: null,
    completion: 100,
    needBytes: 0,
    remoteState: "valid",
    folders: [],
    ...overrides,
  };
}

function node(id: string, name: string, deviceId: string | null, overrides: Partial<StorageNode> = {}): StorageNode {
  return {
    id,
    name,
    kind: "drive",
    threshold: 0,
    assigned: [],
    local: true,
    online: true,
    host: "finn",
    space: null,
    sync: { state: "idle", completion: 100, lastSeen: null },
    offersWaiting: 0,
    syncthing: deviceId ? { deviceId, addresses: [], connectionType: null, inRate: 0, outRate: 0, version: null } : null,
    instance: null,
    peers: [],
    folders: [],
    dashboardUrl: null,
    ...overrides,
  };
}

function seen(key: string, overrides: Partial<DeviceSeen> = {}): DeviceSeen {
  return { key, name: key.slice(0, 7), deviceIds: [key], lastSeen: null, lastKind: null, lastAddress: null, seenBy: null, nodeByDeviceId: {}, ...overrides };
}

function stay(host: string, since: string, lastAt: string, endedAt: string | null, as = "data1 of private-array"): DriveAttachment {
  return { host, since, lastAt, endedAt, as };
}

function drive(key: string, attachments: DriveAttachment[]): DriveRecord {
  return { key, label: "5784-data1", kind: "array-member", serial: key.replace("serial:", ""), size: 8e12, arrayId: "5784", nodeId: null, attachments };
}

function sources(overrides: Partial<DeviceIndexSources>): DeviceIndexSources {
  return { host: "finn", ownNodes: [], otherHosts: [], syncthingOnlyNodes: [], seen: [], joins: [], drives: [], ...overrides };
}

function device(response: DevicesResponse, key: string): DeviceSummary {
  const found = response.devices.find((candidate) => candidate.key === key);
  assert.ok(found, `no device ${key} in ${response.devices.map((candidate) => candidate.key).join(", ")}`);
  return found;
}

const array = node("5784", "private-array", arrayId, { kind: "array", online: false });

describe("device index", () => {
  it("all instances of this host fold into one device", () => {
    const pc = node("fb98", "pc", pcId, { peers: [peer(arrayId, { name: "private-array", lastSeen: "2026-10-21T12:35:28Z" }), peer(testPeerId, { name: "dashboard-test-peer" })] });
    const response = deviceIndex(
      sources({
        ownNodes: [array, pc],
        seen: [
          seen("finn", { deviceIds: [pcId], nodeByDeviceId: { [pcId]: "fb98" } }),
          seen(pcId, { name: "pc", lastKind: "this-device", lastSeen: "2026-10-26T14:13:15Z", seenBy: "dashboard-test-peer" }),
          seen(testPeerId, { name: "dashboard-test-peer", lastKind: "this-device", lastSeen: "2026-10-26T14:13:36Z", seenBy: "pc" }),
          seen(arrayId, { name: "private-array", lastSeen: "2026-10-21T12:35:28Z" }),
        ],
      }),
    );

    assert.deepEqual(
      response.devices.map((entry) => entry.key),
      ["finn"],
    );
    const finn = device(response, "finn");
    assert.equal(finn.thisHost, true);
    assert.equal(finn.online, true);
    assert.deepEqual(finn.nodeIds, ["5784", "fb98"]);
    assert.deepEqual([...finn.deviceIds].sort(), [arrayId, pcId, testPeerId].sort());
    assert.deepEqual(finn.perInstance, [], "an instance's connection to another instance of this host is not a device's connection");
    assert.equal(finn.connection, null);
  });

  it("another host's dashboard gives one device with its nodes and drives", () => {
    const pc = node("fb98", "pc", pcId, {
      peers: [
        peer(p53Id, { name: "p53", connected: true, connectionKind: "tailscale", address: "100.64.0.12:22000", connectionType: "tcp-client" }),
        peer(stickId, { name: "media-stick", connected: false }),
      ],
    });
    const p53Nodes = [node("2b90", "p53", p53Id, { local: false, host: "p53", dashboardUrl: "https://p53.example.ts.net" }), node("81fe", "media-stick", stickId, { kind: "folder", local: false, host: "p53", online: false, dashboardUrl: "https://p53.example.ts.net" })];
    const p53Device: DeviceSummary = {
      key: "p53", name: "p53", thisHost: true, online: true, connection: null, perInstance: [], lastSeen: null, lastConnection: null,
      deviceIds: [p53Id, stickId], nodeIds: ["2b90", "81fe"], driveKeys: ["node:2b90"], sources: ["dashboard"],
    };
    const p53Drive = { ...drive("node:2b90", [stay("p53", "2026-10-25T08:00:00Z", "2026-10-26T15:00:00Z", null, "drive node p53")]), kind: "drive-node" as const, nodeId: "2b90", serial: null, arrayId: null, label: "p53", present: true, currentHost: "p53", lastHost: "p53", lastAt: "2026-10-26T15:00:00Z" };
    const response = deviceIndex(sources({ ownNodes: [pc], otherHosts: [{ host: "p53", nodes: p53Nodes, answer: { devices: [p53Device], drives: [p53Drive] } }] }));

    assert.deepEqual(
      response.devices.map((entry) => entry.key),
      ["finn", "p53"],
    );
    const p53 = device(response, "p53");
    assert.equal(p53.thisHost, false);
    assert.equal(p53.online, true);
    assert.deepEqual(p53.nodeIds, ["2b90", "81fe"]);
    assert.deepEqual(p53.deviceIds, [p53Id, stickId]);
    assert.deepEqual(p53.connection, { kind: "tailscale", address: "100.64.0.12:22000", type: "tcp-client", nodeId: "fb98" });
    assert.deepEqual(p53.perInstance, [
      { nodeId: "fb98", nodeName: "pc", connected: true, kind: "tailscale", address: "100.64.0.12:22000" },
      { nodeId: "fb98", nodeName: "pc", connected: false, kind: null, address: null },
    ]);
    assert.deepEqual(p53.driveKeys, ["node:2b90"]);
    assert.deepEqual(p53.sources, ["dashboard", "syncthing"]);
    const summary = response.drives.find((entry) => entry.key === "node:2b90");
    assert.equal(summary?.present, true);
    assert.equal(summary?.currentHost, "p53");
  });

  it("a syncthing-only device is keyed by its device id", () => {
    const pc = node("fb98", "pc", pcId, { peers: [peer(phoneId, { name: "phone", connected: true, connectionKind: "internet", address: "203.0.113.40:22000", connectionType: "quic-client", lastSeen: "2026-10-26T15:00:00Z" })] });
    const pseudo = node("device-phoneaa", "phone", phoneId, { local: false, host: "phone" });
    const response = deviceIndex(sources({ ownNodes: [pc], syncthingOnlyNodes: [pseudo] }));

    const phone = device(response, phoneId);
    assert.equal(phone.name, "phone");
    assert.equal(phone.online, true);
    assert.deepEqual(phone.deviceIds, [phoneId]);
    assert.deepEqual(phone.nodeIds, ["device-phoneaa"]);
    assert.deepEqual(phone.connection, { kind: "internet", address: "203.0.113.40:22000", type: "quic-client", nodeId: "fb98" });
    assert.deepEqual(phone.sources, ["syncthing"]);
  });

  it("a device known only from history shows its last connection", () => {
    const record = seen(laptopId, { name: "old-laptop", lastSeen: "2026-10-03T18:20:00Z", lastKind: "tailscale", lastAddress: "100.64.0.20:22000", seenBy: "pc" });
    const response = deviceIndex(sources({ ownNodes: [node("fb98", "pc", pcId)], seen: [seen("finn", { deviceIds: [pcId] }), record] }));

    const laptop = device(response, laptopId);
    assert.equal(laptop.name, "old-laptop");
    assert.equal(laptop.online, false);
    assert.equal(laptop.connection, null);
    assert.equal(laptop.lastSeen, "2026-10-03T18:20:00Z");
    assert.deepEqual(laptop.lastConnection, { kind: "tailscale", address: "100.64.0.20:22000", at: "2026-10-03T18:20:00Z" });
    assert.deepEqual(laptop.sources, ["history"]);
  });

  it("a drive attached nowhere sits under the device it was last on", () => {
    const record = drive("serial:WKD082MD", [stay("finn", "2026-10-21T00:43:49Z", "2026-10-21T12:35:32Z", "2026-10-21T12:35:32Z")]);
    const response = deviceIndex(sources({ ownNodes: [array], drives: [record] }));

    const summary = response.drives.find((entry) => entry.key === "serial:WKD082MD");
    assert.deepEqual(
      { present: summary?.present, currentHost: summary?.currentHost, lastHost: summary?.lastHost, lastAt: summary?.lastAt },
      { present: false, currentHost: null, lastHost: "finn", lastAt: "2026-10-21T12:35:32Z" },
    );
    assert.deepEqual(device(response, "finn").driveKeys, ["serial:WKD082MD"]);
  });

  it("a drive present on another host is under that host", () => {
    const left = drive("serial:WKD082MD", [stay("finn", "2026-10-21T00:43:49Z", "2026-10-21T12:35:32Z", "2026-10-21T12:35:32Z")]);
    const arrived = { ...drive("serial:WKD082MD", [stay("p53", "2026-10-25T09:00:00Z", "2026-10-26T15:00:00Z", null)]), present: true, currentHost: "p53", lastHost: "p53", lastAt: "2026-10-26T15:00:00Z" };
    const movedArray = node("5784", "private-array", arrayId, { kind: "array", local: false, host: "p53", dashboardUrl: "https://p53.example.ts.net" });
    const response = deviceIndex(
      sources({
        ownNodes: [node("fb98", "pc", pcId)],
        seen: [seen("finn", { deviceIds: [pcId, arrayId], nodeByDeviceId: { [pcId]: "fb98", [arrayId]: "5784" } })],
        otherHosts: [{ host: "p53", nodes: [movedArray], answer: { devices: [], drives: [arrived] } }],
        drives: [left],
      }),
    );

    const summary = response.drives.find((entry) => entry.key === "serial:WKD082MD");
    assert.equal(summary?.present, true);
    assert.equal(summary?.currentHost, "p53");
    assert.deepEqual(summary?.attachments.map((entry) => entry.host), ["p53", "finn"], "both hosts' stays are kept");
    assert.deepEqual(device(response, "p53").driveKeys, ["serial:WKD082MD"]);
    assert.deepEqual(device(response, "finn").driveKeys, []);
    assert.deepEqual(device(response, "p53").deviceIds, [arrayId], "the moved array's identity is p53's, not this host's remembered one");
    assert.deepEqual(device(response, "finn").deviceIds, [pcId]);
  });
});
