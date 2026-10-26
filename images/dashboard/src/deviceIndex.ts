import { deviceDisplayName } from "./api/deviceText.js";
import type { ConnectionKind, DeviceSource, DeviceSummary, DevicesResponse, DriveRecord, DriveSummary, InstanceConnection, Peer, StorageNode } from "./api/types.js";
import { closestKind } from "./connectionKind.js";
import { mergeDriveRecords } from "./driveHistory.js";
import type { JoinedDevice } from "./join.js";
import type { DeviceSeen } from "./seenStore.js";

/** Another host whose dashboard reports nodes. */
export interface OtherHostView {
  host: string;
  /** Its nodes from the last full `/api/nodes`. */
  nodes: StorageNode[];
  /** Its own `/api/devices?scope=local`; null when it was not read or did not answer. */
  answer: DevicesResponse | null;
}

export interface DeviceIndexSources {
  host: string;
  ownNodes: StorageNode[];
  otherHosts: OtherHostView[];
  /** The nodes no dashboard reported (`device-xxxxxxx`), from the last full `/api/nodes`. */
  syncthingOnlyNodes: StorageNode[];
  seen: DeviceSeen[];
  joins: JoinedDevice[];
  /** This host's drive records. */
  drives: DriveRecord[];
}

interface Reach {
  connection: InstanceConnection;
  type: string | null;
}

interface DeviceDraft {
  key: string;
  name: string | null;
  thisHost: boolean;
  dashboardAnswered: boolean;
  deviceIds: string[];
  nodeIds: string[];
  reach: Reach[];
  peerLastSeen: (string | null)[];
  history: DeviceSeen[];
  driveKeys: string[];
  sources: Set<DeviceSource>;
}

const sourceOrder: DeviceSource[] = ["dashboard", "syncthing", "join", "history"];

function draft(key: string, thisHost = false): DeviceDraft {
  return { key, name: null, thisHost, dashboardAnswered: false, deviceIds: [], nodeIds: [], reach: [], peerLastSeen: [], history: [], driveKeys: [], sources: new Set() };
}

function time(text: string | null): number {
  return text ? Date.parse(text) || 0 : 0;
}

function newest(times: (string | null)[]): string | null {
  const known = times.filter((text): text is string => time(text) > 0);
  return known.length ? known.reduce((best, text) => (time(text) > time(best) ? text : best)) : null;
}

export function driveSummary(record: DriveRecord): DriveSummary {
  const open = record.attachments.find((stay) => stay.endedAt === null);
  const latest = record.attachments.reduce<DriveRecord["attachments"][number] | null>((best, stay) => (!best || time(stay.lastAt) > time(best.lastAt) ? stay : best), null);
  return { ...record, present: Boolean(open), currentHost: open?.host ?? null, lastHost: latest?.host ?? null, lastAt: latest?.lastAt ?? null };
}

function asRecord({ key, label, kind, serial, size, arrayId, nodeId, attachments }: DriveRecord): DriveRecord {
  return { key, label, kind, serial, size, arrayId, nodeId, attachments };
}

/** This host's drive records and every other host's, one per drive, newest wins. */
export function mergedDrives(own: DriveRecord[], otherHosts: OtherHostView[]): DriveSummary[] {
  const others = otherHosts.map((other) => (other.answer?.drives ?? []).map(asRecord));
  return mergeDriveRecords(own, others).map(driveSummary);
}

/**
 * Who each Syncthing device ID belongs to, and the devices found so far.
 * @implNote Dashboards claim their IDs first, so an array that moved to another host is that host's
 * even though this host remembers it; only then do this host's remembered instances and any record
 * last seen as "this device" fold into this host.
 */
class DeviceBook {
  readonly devices = new Map<string, DeviceDraft>();
  private readonly owners = new Map<string, string>();

  device(key: string, thisHost = false): DeviceDraft {
    const known = this.devices.get(key);
    if (known) return known;
    const created = draft(key, thisHost);
    this.devices.set(key, created);
    return created;
  }

  claim(device: DeviceDraft, deviceId: string | null | undefined): void {
    if (!deviceId || this.owners.has(deviceId)) return;
    this.owners.set(deviceId, device.key);
    device.deviceIds.push(deviceId);
  }

  ownerOf(deviceId: string): DeviceDraft {
    return this.devices.get(this.owners.get(deviceId) ?? "") ?? this.byDeviceId(deviceId);
  }

  private byDeviceId(deviceId: string): DeviceDraft {
    const device = this.device(deviceId);
    this.claim(device, deviceId);
    return device;
  }
}

function addNodes(book: DeviceBook, device: DeviceDraft, nodes: StorageNode[]): void {
  for (const node of nodes) {
    if (!device.nodeIds.includes(node.id)) device.nodeIds.push(node.id);
    book.claim(device, node.syncthing?.deviceId);
  }
}

function isThisHostsInstance(record: DeviceSeen, host: string): boolean {
  return record.key !== host && record.lastKind === "this-device";
}

function foldIntoThisHost(book: DeviceBook, thisHost: DeviceDraft, seen: DeviceSeen[], host: string): void {
  const hostRecord = seen.find((record) => record.key === host);
  for (const deviceId of hostRecord?.deviceIds ?? []) book.claim(thisHost, deviceId);
  for (const record of seen.filter((candidate) => isThisHostsInstance(candidate, host))) for (const deviceId of record.deviceIds) book.claim(thisHost, deviceId);
}

function addPeer(book: DeviceBook, node: StorageNode, peer: Peer): void {
  const device = book.ownerOf(peer.deviceId);
  if (device.thisHost) return;
  device.sources.add("syncthing");
  device.name ??= peer.name || null;
  device.peerLastSeen.push(peer.lastSeen);
  device.reach.push({ connection: { nodeId: node.id, nodeName: node.name, connected: peer.connected, kind: peer.connectionKind, address: peer.address }, type: peer.connectionType });
}

function addJoin(book: DeviceBook, joined: JoinedDevice): void {
  const device = book.ownerOf(joined.syncthingDeviceId);
  device.sources.add("join");
  if (!device.thisHost && !device.sources.has("dashboard")) device.name = joined.name;
}

function addHistory(book: DeviceBook, record: DeviceSeen, host: string): void {
  if (record.key === host) return;
  for (const deviceId of record.deviceIds) {
    const device = book.ownerOf(deviceId);
    if (device.thisHost) continue;
    device.sources.add("history");
    device.history.push(record);
    device.name ??= record.name;
  }
}

function placeDrives(book: DeviceBook, drives: DriveSummary[]): void {
  for (const drive of drives) {
    const host = drive.currentHost ?? drive.lastHost;
    if (!host) continue;
    const device = book.device(host);
    device.name ??= host;
    if (device.sources.size === 0) device.sources.add("history");
    device.driveKeys.push(drive.key);
  }
}

function currentConnection(reach: Reach[]): DeviceSummary["connection"] {
  const connected = reach.filter((entry) => entry.connection.connected && entry.connection.kind);
  const kind = closestKind(connected.map((entry) => entry.connection.kind as ConnectionKind));
  const closest = connected.find((entry) => entry.connection.kind === kind);
  if (!closest || !kind) return null;
  return { kind, address: closest.connection.address ?? "", type: closest.type ?? "", nodeId: closest.connection.nodeId };
}

function lastConnection(history: DeviceSeen[]): DeviceSummary["lastConnection"] {
  const withKind = history.filter((record) => record.lastKind && record.lastSeen);
  const latest = withKind.reduce<DeviceSeen | null>((best, record) => (!best || time(record.lastSeen) > time(best.lastSeen) ? record : best), null);
  return latest ? { kind: latest.lastKind!, address: latest.lastAddress, at: latest.lastSeen! } : null;
}

function summary(device: DeviceDraft): DeviceSummary {
  const connection = device.thisHost ? null : currentConnection(device.reach);
  return {
    key: device.key,
    name: deviceDisplayName(device.name, device.key),
    thisHost: device.thisHost,
    online: device.thisHost || device.dashboardAnswered || connection !== null,
    connection,
    perInstance: device.reach.map((entry) => entry.connection),
    lastSeen: device.thisHost ? null : newest([...device.peerLastSeen, ...device.history.map((record) => record.lastSeen)]),
    lastConnection: device.thisHost ? null : lastConnection(device.history),
    deviceIds: device.deviceIds,
    nodeIds: device.nodeIds,
    driveKeys: [...device.driveKeys].sort(),
    sources: sourceOrder.filter((source) => device.sources.has(source)),
  };
}

function byPlace(first: DeviceSummary, second: DeviceSummary): number {
  if (first.thisHost !== second.thisHost) return first.thisHost ? -1 : 1;
  if (first.online !== second.online) return first.online ? -1 : 1;
  return time(second.lastSeen) - time(first.lastSeen) || first.name.localeCompare(second.name);
}

/**
 * Every device this host knows of, with its nodes and the drives on it or last on it: this host, the
 * hosts whose dashboards report nodes, every device a local instance has configured, the join records
 * and the history file.
 */
export function deviceIndex(sources: DeviceIndexSources): DevicesResponse {
  const book = new DeviceBook();
  const thisHost = book.device(sources.host, true);
  thisHost.name = sources.host;
  thisHost.sources.add("dashboard");
  addNodes(book, thisHost, sources.ownNodes);
  for (const other of sources.otherHosts) {
    const device = book.device(other.host);
    device.name = other.host;
    device.sources.add("dashboard");
    device.dashboardAnswered = other.answer !== null;
    addNodes(book, device, other.nodes);
    const reported = other.answer?.devices.find((candidate) => candidate.thisHost);
    for (const deviceId of reported?.deviceIds ?? []) book.claim(device, deviceId);
    for (const nodeId of reported?.nodeIds ?? []) if (!device.nodeIds.includes(nodeId)) device.nodeIds.push(nodeId);
  }
  foldIntoThisHost(book, thisHost, sources.seen, sources.host);
  for (const node of sources.ownNodes) for (const peer of node.peers) addPeer(book, node, peer);
  for (const joined of sources.joins) addJoin(book, joined);
  for (const record of sources.seen) addHistory(book, record, sources.host);
  for (const node of sources.syncthingOnlyNodes) {
    const device = node.syncthing ? book.ownerOf(node.syncthing.deviceId) : null;
    if (device && !device.thisHost && !device.sources.has("dashboard")) device.nodeIds.push(node.id);
  }
  const drives = mergedDrives(sources.drives, sources.otherHosts);
  placeDrives(book, drives);
  return { devices: [...book.devices.values()].map(summary).sort(byPlace), drives };
}
