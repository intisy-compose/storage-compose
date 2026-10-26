import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { deviceDisplayName } from "./api/deviceText.js";
import type { ConnectionKind, Peer, StorageNode } from "./api/types.js";
import { closestKind } from "./connectionKind.js";
import { hostName, seenDirectory, seenWriteIntervalSeconds } from "./settings.js";
import type { InstanceView } from "./syncthing.js";

/** One device this host's instances have known, with how it was last connected. */
export interface DeviceSeen {
  /** This host's name for this host itself, otherwise the device's Syncthing device ID. */
  key: string;
  name: string;
  deviceIds: string[];
  lastSeen: string | null;
  lastKind: ConnectionKind | null;
  lastAddress: string | null;
  /** The name of the node whose Syncthing saw the last connection. */
  seenBy: string | null;
  /** This host's record only: the node each of its instances' device IDs belongs to; empty for a peer. */
  nodeByDeviceId: Record<string, string>;
}

function serialise(records: unknown[]): string {
  return `${JSON.stringify(records, null, 2)}\n`;
}

function parseRecords<Entry>(text: string | null): Entry[] | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    const isRecordList = Array.isArray(parsed) && parsed.every((entry) => typeof entry?.key === "string");
    return isRecordList ? (parsed as Entry[]) : null;
  } catch {
    return null;
  }
}

/**
 * A list of records kept in memory and in one JSON file, which is replaced atomically.
 * @implNote A change within the interval stays in memory and is written by the first update after
 * it; the Nodes page polls every 5 s, so that update comes soon. A file that does not parse reads as
 * empty and is replaced by the next update.
 */
export class SeenStore<Entry extends { key: string }> {
  private records: Entry[] | null = null;
  private written: string | null = null;
  private lastWriteAt = Number.NEGATIVE_INFINITY;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly path: string,
    private readonly intervalMs: number,
  ) {}

  async load(): Promise<Entry[]> {
    if (this.records) return this.records;
    const parsed = parseRecords<Entry>(await readFile(this.path, "utf8").catch(() => null));
    this.records = parsed ?? [];
    this.written = parsed ? serialise(parsed) : null;
    return this.records;
  }

  update(mutate: (records: Entry[]) => Entry[], now = Date.now()): Promise<Entry[]> {
    const next = this.queue.then(() => this.apply(mutate, now));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async apply(mutate: (records: Entry[]) => Entry[], now: number): Promise<Entry[]> {
    const records = mutate(structuredClone(await this.load())).sort((first, second) => first.key.localeCompare(second.key));
    this.records = records;
    const text = serialise(records);
    if (text !== this.written && now - this.lastWriteAt >= this.intervalMs) {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(`${this.path}.new`, text);
      await rename(`${this.path}.new`, this.path);
      this.written = text;
      this.lastWriteAt = now;
    }
    return records;
  }
}

export const deviceSeenStore = new SeenStore<DeviceSeen>(`${seenDirectory}/devices.json`, seenWriteIntervalSeconds(process.env) * 1000);

interface Sighting {
  peer: Peer;
  nodeName: string;
}

function sightingsByDevice(views: InstanceView[]): Map<string, Sighting[]> {
  const sightings = new Map<string, Sighting[]>();
  for (const view of views) {
    for (const peer of view.peers) sightings.set(peer.deviceId, [...(sightings.get(peer.deviceId) ?? []), { peer, nodeName: view.nodeName }]);
  }
  return sightings;
}

function newest(times: (string | null)[]): string | null {
  const parsed = times.filter((time): time is string => Boolean(time)).map((time) => Date.parse(time)).filter(Number.isFinite);
  return parsed.length ? new Date(Math.max(...parsed)).toISOString() : null;
}

function thisHostRecord(previous: DeviceSeen | undefined, localNodes: ReadonlyMap<string, string>, host: string): DeviceSeen {
  const merged = { ...(previous?.nodeByDeviceId ?? {}), ...Object.fromEntries(localNodes) };
  const nodeByDeviceId = Object.fromEntries(Object.entries(merged).sort(([first], [second]) => first.localeCompare(second)));
  return { key: host, name: host, deviceIds: Object.keys(nodeByDeviceId), lastSeen: null, lastKind: null, lastAddress: null, seenBy: null, nodeByDeviceId };
}

function peerRecord(deviceId: string, previous: DeviceSeen | undefined, sightings: Sighting[], now: Date): DeviceSeen {
  const name = deviceDisplayName(sightings.find((sighting) => sighting.peer.name.trim())?.peer.name || previous?.name, deviceId);
  const base = { key: deviceId, name, deviceIds: [deviceId], nodeByDeviceId: {} };
  const connected = sightings.filter((sighting) => sighting.peer.connected && sighting.peer.connectionKind);
  const kind = closestKind(connected.map((sighting) => sighting.peer.connectionKind!));
  const closest = connected.find((sighting) => sighting.peer.connectionKind === kind);
  if (closest) return { ...base, lastSeen: now.toISOString(), lastKind: kind, lastAddress: closest.peer.address, seenBy: closest.nodeName };
  return {
    ...base,
    lastSeen: newest([previous?.lastSeen ?? null, ...sightings.map((sighting) => sighting.peer.lastSeen)]),
    lastKind: previous?.lastKind ?? null,
    lastAddress: previous?.lastAddress ?? null,
    seenBy: previous?.seenBy ?? null,
  };
}

/**
 * The records with this host's instances and every peer they see brought up to date: a connected
 * peer takes the closest connection any instance has to it, a disconnected one keeps its last.
 * @param localNodes device ID to node ID of the instances this host runs now.
 */
export function seenDevices(records: DeviceSeen[], views: InstanceView[], localNodes: ReadonlyMap<string, string>, now: Date, host: string): DeviceSeen[] {
  const byKey = new Map(records.map((record) => [record.key, record]));
  byKey.set(host, thisHostRecord(byKey.get(host), localNodes, host));
  for (const [deviceId, sightings] of sightingsByDevice(views)) byKey.set(deviceId, peerRecord(deviceId, byKey.get(deviceId), sightings, now));
  return [...byKey.values()];
}

export function recordDevices(views: InstanceView[], localNodes: ReadonlyMap<string, string>, now: Date, store = deviceSeenStore, host = hostName): Promise<DeviceSeen[]> {
  return store.update((records) => seenDevices(records, views, localNodes, now, host), now.getTime());
}

export interface Sightings {
  views: InstanceView[];
  /** Device ID to node ID of the instances this host runs now. */
  running: ReadonlyMap<string, string>;
  nodes: StorageNode[];
}

/** What the seen files may keep: a node whose registry entry says `remember: false` is left out as an instance, as a peer and as a drive. */
export function rememberable({ views, running, nodes }: Sightings, ephemeralNodeIds: ReadonlySet<string>): Sightings {
  const ephemeralDeviceIds = new Set([...running].filter(([, nodeId]) => ephemeralNodeIds.has(nodeId)).map(([deviceId]) => deviceId));
  return {
    views: views.filter((view) => !ephemeralNodeIds.has(view.nodeId)).map((view) => ({ ...view, peers: view.peers.filter((peer) => !ephemeralDeviceIds.has(peer.deviceId)) })),
    running: new Map([...running].filter(([deviceId]) => !ephemeralDeviceIds.has(deviceId))),
    nodes: nodes.filter((node) => !ephemeralNodeIds.has(node.id)),
  };
}

/** Device ID to node ID of every instance this host has run, the ones not running now included. */
export function rememberedLocalNodes(records: DeviceSeen[], host = hostName): Map<string, string> {
  return new Map(Object.entries(records.find((record) => record.key === host)?.nodeByDeviceId ?? {}));
}

export interface LocalDeviceInputs {
  /** Device ID to node ID of the instances this host runs now. */
  running: ReadonlyMap<string, string>;
  remembered: ReadonlyMap<string, string>;
  /** Every node this host lists, present or absent. */
  localNodeIds: ReadonlySet<string>;
  /** The nodes other hosts' dashboards report. */
  otherHostNodes: StorageNode[];
}

/**
 * The device IDs that are this host's: those it runs now, and a remembered one while this host still
 * lists its node and no other dashboard reports that node or that device.
 * @implNote An array's Syncthing identity travels with its drives, so once another host reports the
 * node, the device is that host's and is classified, listed and warned about as any other.
 */
export function localDeviceIds({ running, remembered, localNodeIds, otherHostNodes }: LocalDeviceInputs): Set<string> {
  const reported = otherHostNodes.filter((node) => node.dashboardUrl);
  const elsewhereNodeIds = new Set(reported.map((node) => node.id));
  const elsewhereDeviceIds = new Set(reported.map((node) => node.syncthing?.deviceId));
  const isStillLocal = (deviceId: string, nodeId: string) => localNodeIds.has(nodeId) && !elsewhereNodeIds.has(nodeId) && !elsewhereDeviceIds.has(deviceId);
  const kept = [...remembered].filter(([deviceId, nodeId]) => isStillLocal(deviceId, nodeId)).map(([deviceId]) => deviceId);
  return new Set([...running.keys(), ...kept]);
}
