import type { ArrayMember, DriveAttachment, DriveRecord, PresenceWindow, StorageNode } from "./api/types.js";
import { SeenStore } from "./seenStore.js";
import { hostName, seenDirectory, seenWriteIntervalSeconds } from "./settings.js";

const attachmentsKept = 20;

export const driveSeenStore = new SeenStore<DriveRecord>(`${seenDirectory}/drives.json`, seenWriteIntervalSeconds(process.env) * 1000);

export interface DriveIdentity {
  serial: string | null;
  arrayId: string | null;
  role: string | null;
  nodeId: string | null;
}

export function driveKey({ serial, arrayId, role, nodeId }: DriveIdentity): string {
  if (serial) return `serial:${serial}`;
  if (arrayId && role) return `member:${arrayId}-${role}`;
  return `node:${nodeId}`;
}

/** One drive found on a host, as the record it would start and the stay it adds. */
interface Sighting {
  record: DriveRecord;
  /** The member's key from before its serial was known, whose stays move to the serial's record. */
  roleKey: string | null;
  stay: DriveAttachment;
}

function isoTime(time: string): string {
  return new Date(time).toISOString();
}

function stayOf(host: string, as: string, window: PresenceWindow): DriveAttachment {
  return { host, since: isoTime(window.since), lastAt: isoTime(window.at), as };
}

function memberSighting(array: StorageNode, member: ArrayMember, host: string, now: Date): Sighting | null {
  const window = member.present ? { since: now.toISOString(), at: now.toISOString() } : member.lastPresent;
  if (!window) return null;
  const identity = { serial: member.serial, arrayId: array.id, role: member.role, nodeId: null };
  return {
    record: { key: driveKey(identity), label: member.label, kind: "array-member", serial: member.serial, size: member.size, arrayId: array.id, nodeId: null, attachments: [] },
    roleKey: member.serial ? driveKey({ ...identity, serial: null }) : null,
    stay: stayOf(host, `${member.role} of ${array.name}`, window),
  };
}

function nodeSighting(node: StorageNode, host: string, now: Date): Sighting {
  const kind = node.kind === "folder" ? "folder-node" : "drive-node";
  return {
    record: { key: driveKey({ serial: null, arrayId: null, role: null, nodeId: node.id }), label: node.name, kind, serial: null, size: node.space?.size ?? null, arrayId: null, nodeId: node.id, attachments: [] },
    roleKey: null,
    stay: stayOf(host, `${node.kind} node ${node.name}`, { since: now.toISOString(), at: now.toISOString() }),
  };
}

function sightings(nodes: StorageNode[], host: string, now: Date): Sighting[] {
  return nodes.flatMap((node) => {
    if (node.kind === "array") return (node.array?.members ?? []).map((member) => memberSighting(node, member, host, now)).filter((sighting) => sighting !== null);
    return node.online ? [nodeSighting(node, host, now)] : [];
  });
}

function time(text: string): number {
  return Date.parse(text) || 0;
}

/** One stay per host and start, with the latest end any copy has, newest first. */
function mergedStays(stays: DriveAttachment[]): DriveAttachment[] {
  const byStart = new Map<string, DriveAttachment>();
  for (const stay of stays) {
    const id = `${stay.host}\n${stay.since}`;
    const known = byStart.get(id);
    if (!known || time(stay.lastAt) > time(known.lastAt)) byStart.set(id, stay);
  }
  return [...byStart.values()].sort((first, second) => time(second.lastAt) - time(first.lastAt)).slice(0, attachmentsKept);
}

/**
 * @implNote A drive seen again where it was last extends that stay, however long it was away in
 * between: this host only knows where the drive is, not where it went meanwhile.
 */
function withStay(stays: DriveAttachment[], stay: DriveAttachment): DriveAttachment[] {
  const [newest, ...rest] = stays;
  if (newest && newest.host === stay.host && newest.as === stay.as) {
    const since = time(stay.since) < time(newest.since) ? stay.since : newest.since;
    const lastAt = time(stay.lastAt) > time(newest.lastAt) ? stay.lastAt : newest.lastAt;
    return mergedStays([{ ...newest, since, lastAt }, ...rest]);
  }
  return mergedStays([...stays, stay]);
}

function recordSighting(byKey: Map<string, DriveRecord>, { record, roleKey, stay }: Sighting): void {
  const former = roleKey ? byKey.get(roleKey) : undefined;
  if (roleKey) byKey.delete(roleKey);
  const previous = byKey.get(record.key);
  const stays = mergedStays([...(previous?.attachments ?? []), ...(former?.attachments ?? [])]);
  byKey.set(record.key, { ...record, size: record.size ?? previous?.size ?? former?.size ?? null, attachments: withStay(stays, stay) });
}

/** The records with every drive the nodes show on this host now, or last showed, added as a stay. */
export function seenDrives(records: DriveRecord[], nodes: StorageNode[], host: string, now: Date): DriveRecord[] {
  const byKey = new Map(records.map((record) => [record.key, record]));
  for (const sighting of sightings(nodes, host, now)) recordSighting(byKey, sighting);
  return [...byKey.values()];
}

export function recordPresentDrives(nodes: StorageNode[], host = hostName, now = new Date(), store = driveSeenStore): Promise<DriveRecord[]> {
  return store.update((records) => seenDrives(records, nodes, host, now), now.getTime());
}

function lastAt(record: DriveRecord): number {
  return Math.max(0, ...record.attachments.map((stay) => time(stay.lastAt)));
}

/** This host's records and other hosts' in one list: per drive, the record seen last describes it and every stay is kept. */
export function mergeDriveRecords(own: DriveRecord[], others: DriveRecord[][]): DriveRecord[] {
  const byKey = new Map<string, DriveRecord[]>();
  for (const record of [own, ...others].flat()) byKey.set(record.key, [...(byKey.get(record.key) ?? []), record]);
  const merged = [...byKey.values()].map((records) => {
    const newest = records.reduce((best, record) => (lastAt(record) > lastAt(best) ? record : best));
    return { ...newest, attachments: mergedStays(records.flatMap((record) => record.attachments)) };
  });
  return merged.sort((first, second) => first.key.localeCompare(second.key));
}
