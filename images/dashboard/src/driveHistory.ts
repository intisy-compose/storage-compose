import type { ArrayMember, DriveAttachment, DriveRecord, PresenceWindow, StorageNode } from "./api/types.js";
import { SeenStore } from "./seenStore.js";
import { hostName, seenDirectory, seenWriteIntervalSeconds } from "./settings.js";

const attachmentsKept = 20;

export const driveSeenStore = new SeenStore<DriveRecord>(`${seenDirectory}/drives.json`, seenWriteIntervalSeconds(process.env) * 1000);

export type DriveIdentity = { serial: string | null; arrayId: string; role: string } | { serial: string | null; nodeId: string };

export function driveKey(identity: DriveIdentity): string {
  if (identity.serial) return `serial:${identity.serial}`;
  return "nodeId" in identity ? `node:${identity.nodeId}` : `member:${identity.arrayId}-${identity.role}`;
}

/**
 * One drive found on a host: attached now, or, for a member of an array that is not connected, in
 * the window the mounter's last round had it.
 */
interface Sighting {
  record: DriveRecord;
  /** The member's key from before its serial was known, whose stays move to the serial's record. */
  roleKey: string | null;
  as: string;
  window: PresenceWindow;
  attachedNow: boolean;
}

function memberSighting(array: StorageNode, member: ArrayMember, now: Date): Sighting | null {
  const window = member.present ? { since: now.toISOString(), at: now.toISOString() } : member.lastPresent;
  if (!window) return null;
  const identity = { serial: member.serial, arrayId: array.id, role: member.role };
  return {
    record: { key: driveKey(identity), label: member.label, kind: "array-member", serial: member.serial, size: member.size, arrayId: array.id, nodeId: null, attachments: [] },
    roleKey: member.serial ? driveKey({ ...identity, serial: null }) : null,
    as: `${member.role} of ${array.name}`,
    window,
    attachedNow: member.present,
  };
}

function nodeSighting(node: StorageNode, now: Date): Sighting {
  const kind = node.kind === "folder" ? "folder-node" : "drive-node";
  return {
    record: { key: driveKey({ serial: null, nodeId: node.id }), label: node.name, kind, serial: null, size: node.space?.size ?? null, arrayId: null, nodeId: node.id, attachments: [] },
    roleKey: null,
    as: `${node.kind} node ${node.name}`,
    window: { since: now.toISOString(), at: now.toISOString() },
    attachedNow: true,
  };
}

function sightings(nodes: StorageNode[], now: Date): Sighting[] {
  return nodes.flatMap((node) => {
    if (node.kind === "array") return (node.array?.members ?? []).map((member) => memberSighting(node, member, now)).filter((sighting) => sighting !== null);
    return node.online ? [nodeSighting(node, now)] : [];
  });
}

function time(text: string): number {
  return Date.parse(text) || 0;
}

function later(first: string, second: string): string {
  return time(second) > time(first) ? second : first;
}

function earlier(first: string, second: string): string {
  return time(second) < time(first) ? second : first;
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

function overlaps(stay: DriveAttachment, window: PresenceWindow): boolean {
  return time(window.since) <= time(stay.lastAt) && time(window.at) >= time(stay.since);
}

/**
 * The stays with one sighting added. A drive attached now extends the newest stay only while that
 * stay is open on the same host as the same thing; a window from a detached array joins the stay it
 * overlaps and closes it, because the drive is not here now.
 */
function withSighting(stays: DriveAttachment[], host: string, { as, window, attachedNow }: Sighting): DriveAttachment[] {
  const since = new Date(window.since).toISOString();
  const lastAt = new Date(window.at).toISOString();
  const [newest, ...rest] = stays;
  const isSameStay = newest?.host === host && newest.as === as && (attachedNow ? newest.endedAt === null : overlaps(newest, window));
  const stay = isSameStay ? { ...newest, since: earlier(newest.since, since), lastAt: later(newest.lastAt, lastAt) } : { host, since, lastAt, as, endedAt: null };
  const placed = { ...stay, endedAt: attachedNow ? null : stay.lastAt };
  return mergedStays(isSameStay ? [placed, ...rest] : [...stays, placed]);
}

function closedOn(host: string, stays: DriveAttachment[]): DriveAttachment[] {
  return stays.map((stay) => (stay.host === host && stay.endedAt === null ? { ...stay, endedAt: stay.lastAt } : stay));
}

/**
 * @implNote A member is keyed by its role only while no serial is known; when the serial appears, the
 * role's stays are taken to be this drive's. A different drive that sat in that role unread before
 * would have its stays credited to this one, which is accepted: an unread drive cannot be told apart.
 */
function recordSighting(byKey: Map<string, DriveRecord>, host: string, sighting: Sighting): void {
  const { record, roleKey } = sighting;
  const former = roleKey ? byKey.get(roleKey) : undefined;
  if (roleKey) byKey.delete(roleKey);
  const previous = byKey.get(record.key);
  const stays = mergedStays([...(previous?.attachments ?? []), ...(former?.attachments ?? [])]);
  byKey.set(record.key, { ...record, size: record.size ?? previous?.size ?? former?.size ?? null, attachments: withSighting(stays, host, sighting) });
}

/** @implNote A file written before stays could close has no `endedAt`; those stays are open. */
function withEndKnown(record: DriveRecord): DriveRecord {
  return { ...record, attachments: record.attachments.map((stay) => ({ ...stay, endedAt: stay.endedAt ?? null })) };
}

/**
 * The records brought up to this build of this host's nodes: every drive attached now extends or
 * starts its stay here, and every open stay here of a drive the build does not show attached is closed.
 * @implNote The nodes are every node this host lists, so a drive left out of them, through an absent
 * member, an offline node or one no longer listed, is not here now.
 */
export function seenDrives(records: DriveRecord[], nodes: StorageNode[], host: string, now: Date): DriveRecord[] {
  const byKey = new Map(records.map((record) => [record.key, withEndKnown(record)]));
  const found = sightings(nodes, now);
  for (const sighting of found) recordSighting(byKey, host, sighting);
  const attachedNow = new Set(found.filter((sighting) => sighting.attachedNow).map((sighting) => sighting.record.key));
  for (const [key, record] of byKey) if (!attachedNow.has(key)) byKey.set(key, { ...record, attachments: closedOn(host, record.attachments) });
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
