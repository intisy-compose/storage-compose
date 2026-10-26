import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ArrayMember, ArrayState, DeviceSummary, DevicesResponse, DriveSummary, NodesResponse, StorageNode } from "../src/api/types.js";
import { type DeviceRow, type NodeFilters, deviceDriveCount, deviceRows, isDeviceShown, layoutRows, placeOnDevices, visibleUnplacedNodes } from "../ui/src/devicePlacement.js";

function member(role: string, serial: string, present: boolean): ArrayMember {
  return {
    role, label: `5784-${role}`, serial, size: 1e12, used: null, asset: null, present, smart: null, temperature: null,
    condition: present ? "present" : "missing", detail: "", lastPresent: null,
  };
}

function storageNode(overrides: Partial<StorageNode>): StorageNode {
  return {
    id: "fb98", name: "pc", kind: "drive", threshold: 50, assigned: [], local: true, online: true, host: "finn", space: null,
    sync: { state: "idle", completion: 100, lastSeen: null }, offersWaiting: 0, syncthing: null, instance: null, peers: [], folders: [], dashboardUrl: null, ...overrides,
  };
}

function array(state: ArrayState, members: ArrayMember[]): StorageNode {
  const online = state !== "absent";
  return storageNode({
    id: "5784", name: "private-array", kind: "array", threshold: 0, online,
    sync: online ? { state: "idle", completion: 100, lastSeen: null } : { state: "offline", completion: 0, lastSeen: null },
    array: { state, members, parity: { job: null, lastSync: null, lastScrub: null, refused: null, lastSyncResult: null, lastScrubResult: null }, candidates: [], reasons: [] },
  });
}

function memberRecord(entry: ArrayMember): DriveSummary {
  const attachments = [{ host: "finn", since: "2026-10-21T00:43:49Z", lastAt: "2026-10-21T12:35:32Z", endedAt: entry.present ? null : "2026-10-21T12:35:32Z", as: `${entry.role} of private-array` }];
  return {
    key: `serial:${entry.serial}`, label: entry.label, kind: "array-member", serial: entry.serial, size: entry.size, arrayId: "5784", nodeId: null, attachments,
    present: entry.present, currentHost: entry.present ? "finn" : null, lastHost: "finn", lastAt: "2026-10-21T12:35:32Z",
  };
}

const pcDrive: DriveSummary = {
  key: "node:fb98", label: "pc", kind: "drive-node", serial: null, size: null, arrayId: null, nodeId: "fb98",
  attachments: [{ host: "finn", since: "2026-10-26T14:00:00Z", lastAt: "2026-10-26T15:00:00Z", endedAt: null, as: "drive node pc" }],
  present: true, currentHost: "finn", lastHost: "finn", lastAt: "2026-10-26T15:00:00Z",
};

function device(overrides: Partial<DeviceSummary>): DeviceSummary {
  return {
    key: "finn", name: "finn", thisHost: true, online: true, connection: null, perInstance: [], lastSeen: null, lastConnection: null,
    deviceIds: [], nodeIds: [], driveKeys: [], sources: ["dashboard"], ...overrides,
  };
}

const syncthingOnly = storageNode({ id: "device-x7kcob7", name: "private-array", kind: "device", threshold: 0, local: false, online: false, host: "private-array", sync: { state: "offline", completion: 0, lastSeen: null } });

function scene(members: ArrayMember[], state: ArrayState) {
  const nodes = [storageNode({}), array(state, members), syncthingOnly];
  const drives = [pcDrive, ...members.map(memberRecord)];
  const devices: DevicesResponse = {
    devices: [
      device({ nodeIds: ["5784", "fb98"], driveKeys: drives.map((drive) => drive.key) }),
      device({ key: "X7KCOB7", name: "private-array", thisHost: false, online: false, nodeIds: ["device-x7kcob7"], sources: ["syncthing"] }),
    ],
    drives,
  };
  const response: NodesResponse = { host: { name: "finn" }, nodes, warnings: [] };
  return { response, devices, placements: placeOnDevices(nodes, devices) };
}

function filters(overrides: Partial<NodeFilters>): NodeFilters {
  return { search: "", reach: "all", kind: "all", ...overrides };
}

function describeRows(rows: DeviceRow[]): string[] {
  return rows.map((row) => {
    if (row.type === "drive") return `drive ${row.drive.key}`;
    const members = row.members.map((entry) => entry.role).join(",");
    return row.type === "node" ? `node ${row.node.id}${members ? ` [${members}]` : ""}` : `members of ${row.array.id} [${members}]`;
  });
}

function finnRows(members: ArrayMember[], state: ArrayState, chosen: Partial<NodeFilters>): string[] {
  const { response, devices, placements } = scene(members, state);
  return describeRows(deviceRows(response, devices.drives, placements.placements[0], filters(chosen)));
}

const detached = [member("data1", "WKD082MD", false), member("data2", "Z1N0D48L", false)];
const halfAttached = [member("data1", "WKD082MD", true), member("data2", "Z1N0D48L", false)];

describe("nodes page by device", () => {
  it("the Drives filter lists an array's member drives without the array", () => {
    assert.deepEqual(finnRows(detached, "absent", { kind: "drive" }), ["node fb98", "members of 5784 [data1,data2]"]);
    assert.deepEqual(finnRows(detached, "absent", {}), ["node fb98", "node 5784 [data1,data2]"]);
    assert.deepEqual(finnRows(detached, "absent", { kind: "folder" }), []);
  });

  it("Online and Offline filter member drives by whether they are attached", () => {
    assert.deepEqual(finnRows(halfAttached, "degraded", { reach: "online" }), ["node fb98", "node 5784 [data1]"]);
    assert.deepEqual(finnRows(halfAttached, "degraded", { reach: "offline" }), ["members of 5784 [data2]"]);
    assert.deepEqual(finnRows(detached, "absent", { reach: "online" }), ["node fb98"]);
    assert.deepEqual(finnRows(halfAttached, "degraded", { reach: "attention" }), ["node 5784 [data2]"]);
  });

  it("a search matches member drives term by term and keeps their array as context", () => {
    assert.deepEqual(finnRows(detached, "absent", { search: "WKD082MD" }), ["node 5784 [data1]"]);
    assert.deepEqual(finnRows(detached, "absent", { search: "data2 5784" }), ["node 5784 [data2]"]);
    assert.deepEqual(finnRows(detached, "absent", { search: "finn" }), ["node fb98", "node 5784 [data1,data2]"]);
  });

  it("a syncthing-only device is no node and no drive", () => {
    const { response, devices, placements } = scene(detached, "absent");
    const [, arrayDevice] = placements.placements;
    assert.deepEqual(arrayDevice.nodes, []);
    assert.deepEqual(placements.unplacedNodes, []);
    assert.equal(isDeviceShown(arrayDevice, deviceRows(response, devices.drives, arrayDevice, filters({})), filters({})), true);
    assert.equal(isDeviceShown(arrayDevice, deviceRows(response, devices.drives, arrayDevice, filters({ kind: "drive" })), filters({ kind: "drive" })), false);
    assert.deepEqual(visibleUnplacedNodes(response, response.nodes, filters({ kind: "drive" })).map((node) => node.id), ["fb98"]);
  });

  it("a device's drive count is every drive listed under it", () => {
    const { devices, placements } = scene(detached, "absent");
    assert.equal(deviceDriveCount(placements.placements[0]), 3);
    assert.equal(placements.placements.reduce((sum, placement) => sum + deviceDriveCount(placement), 0), devices.drives.length);
  });
});

describe("a node's layout rows", () => {
  it("a storage node shows its threshold and assigned directories", () => {
    assert.deepEqual(layoutRows(storageNode({ threshold: 0, assigned: [] })), [
      ["Threshold", "0 (keeps everything)"],
      ["Assigned", "none"],
    ]);
    assert.deepEqual(layoutRows(storageNode({ threshold: 50, assigned: ["Documents", "Music"] })), [
      ["Threshold", "50 (keeps priority 50 and above)"],
      ["Assigned", "Documents, Music"],
    ]);
  });

  it("a Syncthing-only device has no layout, so it shows neither row", () => {
    assert.deepEqual(layoutRows(storageNode({ kind: "device", threshold: 0, assigned: [] })), []);
  });
});
