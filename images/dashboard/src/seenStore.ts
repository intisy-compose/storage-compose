import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ConnectionKind, Peer } from "./api/types.js";
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

function thisHostRecord(previous: DeviceSeen | undefined, localDeviceIds: ReadonlySet<string>, host: string): DeviceSeen {
  const deviceIds = [...new Set([...(previous?.deviceIds ?? []), ...localDeviceIds])].sort();
  return { key: host, name: host, deviceIds, lastSeen: null, lastKind: null, lastAddress: null, seenBy: null };
}

function peerRecord(deviceId: string, previous: DeviceSeen | undefined, sightings: Sighting[], now: Date): DeviceSeen {
  const name = sightings.find((sighting) => sighting.peer.name)?.peer.name || previous?.name || deviceId.slice(0, 7);
  const base = { key: deviceId, name, deviceIds: [deviceId] };
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
 */
export function seenDevices(records: DeviceSeen[], views: InstanceView[], localDeviceIds: ReadonlySet<string>, now: Date, host: string): DeviceSeen[] {
  const byKey = new Map(records.map((record) => [record.key, record]));
  byKey.set(host, thisHostRecord(byKey.get(host), localDeviceIds, host));
  for (const [deviceId, sightings] of sightingsByDevice(views)) byKey.set(deviceId, peerRecord(deviceId, byKey.get(deviceId), sightings, now));
  return [...byKey.values()];
}

export function recordDevices(views: InstanceView[], localDeviceIds: ReadonlySet<string>, now: Date, store = deviceSeenStore, host = hostName): Promise<DeviceSeen[]> {
  return store.update((records) => seenDevices(records, views, localDeviceIds, now, host), now.getTime());
}

/** Every device ID this host's own instances have had, the ones not running now included. */
export function rememberedLocalDeviceIds(records: DeviceSeen[], host = hostName): Set<string> {
  return new Set(records.find((record) => record.key === host)?.deviceIds ?? []);
}
