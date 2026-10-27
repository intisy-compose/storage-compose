import { deviceDisplayName, isNodePaused, shortDeviceId } from "./api/deviceText.js";
import type { StorageNode, Warning, WarningKind, WarningLevel } from "./api/types.js";
import type { AttentionThresholds } from "./settings.js";
import { shownUnscopedText } from "./shownSyncthingError.js";
import { withoutSecrets } from "./supportBundle.js";
import type { PendingDevices, PendingFolders, SystemError } from "./syncthing.js";

const firstSeen = new Map<string, string>();
const hourMilliseconds = 3_600_000;

interface WarningFields {
  id: string;
  level: WarningLevel;
  kind: WarningKind;
  text: string;
  nodeId: string | null;
  folderId?: string | null;
  /** When the condition began, if its source says; otherwise when this dashboard first saw it. */
  at?: string;
}

export function warning({ id, level, kind, text, nodeId, folderId = null, at }: WarningFields): Warning {
  if (!firstSeen.has(id)) firstSeen.set(id, new Date().toISOString());
  return { id, at: at ?? firstSeen.get(id)!, level, kind, text, nodeId, folderId };
}

/** Forgets when a condition was first seen once it is gone, so a recurrence starts a new entry. */
export function pruneFirstSeen(current: Warning[]): void {
  const ids = new Set(current.map((entry) => entry.id));
  for (const id of firstSeen.keys()) if (!ids.has(id)) firstSeen.delete(id);
}

export function withoutDuplicates(warnings: Warning[]): Warning[] {
  return [...new Map(warnings.map((entry) => [entry.id, entry])).values()];
}

/** Problems of the host itself rather than of one node; the id names the host, so two hosts' entries stay apart. */
export function hostWarnings(host: string, registryTexts: string[], agentProblem: string | null, agentProblems: string[]): Warning[] {
  const warnings = registryTexts.map((text) => warning({ id: `registry:${host}:${text}`, level: "warning", kind: "registry", text, nodeId: null }));
  if (agentProblem) warnings.push(warning({ id: `host-agent:${host}`, level: "error", kind: "agent", text: agentProblem, nodeId: null }));
  for (const text of agentProblems) warnings.push(warning({ id: `host-agent:${host}:${text}`, level: "warning", kind: "agent", text: `host agent: ${text}`, nodeId: null }));
  return warnings;
}

const kindsByIdPrefix: Record<string, WarningKind> = {
  array: "array",
  split: "array",
  serial: "array",
  refused: "array",
  smart: "smart",
  absent: "offline",
  registry: "registry",
  "host-agent": "agent",
  peer: "peer",
};

/**
 * Another host's warning, with that host in its id and text.
 * @implNote A host on an older dashboard sends warnings without a kind or folder; the kind is read
 * from the id's prefix.
 */
export function fromOtherHost(entry: Warning, host: string): Warning {
  const kind = entry.kind ?? kindsByIdPrefix[entry.id.split(":")[0]] ?? "other";
  return { ...entry, id: `${host}:${entry.id}`, text: `${entry.text} (on ${host})`, kind, folderId: entry.folderId ?? null };
}

function plural(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

export function folderErrorWarnings(node: StorageNode): Warning[] {
  return node.folders
    .filter((folder) => folder.errors > 0)
    .map((folder) =>
      warning({
        id: `folder-errors:${node.id}:${folder.id}`,
        level: "warning",
        kind: "folder-errors",
        text: `${folder.label || folder.id} on ${node.name}: ${plural(folder.errors, "failed item")}`,
        nodeId: node.id,
        folderId: folder.id,
      }),
    );
}

/** A folder holding conflict copies stays on Attention until they are kept or removed on the node itself. */
export function conflictWarnings(node: StorageNode): Warning[] {
  return node.folders
    .filter((folder) => (folder.conflicts ?? 0) > 0)
    .map((folder) =>
      warning({
        id: `conflicts:${node.id}:${folder.id}`,
        level: "warning",
        kind: "conflicts",
        text: `${folder.label || folder.id} on ${node.name}: ${folder.conflictsMore ? `more than ${folder.conflicts} sync conflicts` : plural(folder.conflicts!, "sync conflict")}`,
        nodeId: node.id,
        folderId: folder.id,
      }),
    );
}

/** Each error the node's Syncthing reports, with `secrets` (`nodeSecrets.ts`) replaced and Syncthing's text redacted, in its text and its ID. */
export function systemErrorWarnings(node: StorageNode, errors: SystemError[], secrets: readonly string[] = []): Warning[] {
  return errors.map((error) => {
    const message = shownUnscopedText(withoutSecrets(error.message, secrets));
    return warning({
      id: `system-error:${node.id}:${error.when}:${message}`,
      level: "warning",
      kind: "system-error",
      text: `${node.name}'s Syncthing: ${message}`,
      nodeId: node.id,
      at: error.when,
    });
  });
}

/** Each device asking to connect and each folder offered to the node, as info entries for Requests. */
export function pendingWarnings(node: StorageNode, devices: PendingDevices, folders: PendingFolders): Warning[] {
  const nameOf = (deviceId: string) => deviceDisplayName(node.peers.find((peer) => peer.deviceId === deviceId)?.name, deviceId);
  const deviceEntries = Object.entries(devices).map(([deviceId, device]) =>
    warning({
      id: `pending-device:${node.id}:${deviceId}`,
      level: "info",
      kind: "pending-device",
      text: `${deviceDisplayName(device.name, deviceId)} (${shortDeviceId(deviceId)}) asks to connect to ${node.name}`,
      nodeId: node.id,
      at: device.time,
    }),
  );
  const folderEntries = Object.entries(folders).flatMap(([folderId, entry]) =>
    Object.entries(entry.offeredBy).map(([offeredBy, offer]) =>
      warning({
        id: `pending-folder:${node.id}:${folderId}:${offeredBy}`,
        level: "info",
        kind: "pending-folder",
        text: `${nameOf(offeredBy)} offers the folder "${offer.label || folderId}" to ${node.name}`,
        nodeId: node.id,
        at: offer.time,
      }),
    ),
  );
  return [...deviceEntries, ...folderEntries];
}

function percentUsed(size: number | null | undefined, used: number | null | undefined): number | null {
  if (!size || size <= 0 || used === null || used === undefined) return null;
  return (100 * used) / size;
}

/** Rounded down to a tenth, so a drive is never shown fuller than it is. */
function shownPercent(percent: number): number {
  return Math.floor(percent * 10) / 10;
}

export function fullWarnings(node: StorageNode, thresholds: AttentionThresholds): Warning[] {
  const warnings: Warning[] = [];
  const nodePercent = percentUsed(node.space?.size, node.space?.used);
  if (nodePercent !== null && nodePercent > thresholds.fullPercent) {
    warnings.push(warning({ id: `full:${node.id}`, level: "warning", kind: "full", text: `${node.name} is ${shownPercent(nodePercent)}% full`, nodeId: node.id }));
  }
  for (const member of node.array?.members ?? []) {
    const memberPercent = member.present ? percentUsed(member.size, member.used) : null;
    if (memberPercent === null || memberPercent <= thresholds.fullPercent) continue;
    warnings.push(warning({ id: `full:${node.id}:${member.label}`, level: "warning", kind: "full", text: `${member.label} in ${node.name} is ${shownPercent(memberPercent)}% full`, nodeId: node.id }));
  }
  return warnings;
}

/** A paused node stays on Attention until it is resumed, as nothing syncs with it meanwhile. */
export function pausedWarnings(node: StorageNode): Warning[] {
  if (!isNodePaused(node)) return [];
  return [warning({ id: `paused:${node.id}`, level: "warning", kind: "paused", text: `${node.name}: every device paused`, nodeId: node.id })];
}

function offlineDuration(milliseconds: number): string {
  const hours = Math.floor(milliseconds / hourMilliseconds);
  return hours >= 48 ? `${Math.floor(hours / 24)} days` : plural(hours, "hour");
}

function offlineSince(lastSeen: string | null, thresholds: AttentionThresholds, now: number): number | null {
  const elapsed = lastSeen ? now - Date.parse(lastSeen) : Number.NaN;
  return Number.isFinite(elapsed) && elapsed > thresholds.offlineHours * hourMilliseconds ? elapsed : null;
}

function isOffline(node: StorageNode): boolean {
  return !node.online || node.sync.state === "offline";
}

/**
 * This host's nodes, and the devices their Syncthing instances know, that have been away longer than
 * the threshold.
 * @param localDeviceIds the device IDs of this host's instances, those not running now included.
 * @implNote A device that belongs to a node some dashboard reports is left to that node's own entry;
 * one seen by several instances is listed once. A device never seen, or paused on purpose, is not offline.
 */
export function offlineWarnings(nodes: StorageNode[], thresholds: AttentionThresholds, now = Date.now(), localDeviceIds: ReadonlySet<string> = new Set()): Warning[] {
  const local = nodes.filter((node) => node.local);
  const warnings: Warning[] = [];
  for (const node of local.filter((candidate) => candidate.array?.state !== "absent")) {
    const elapsed = isOffline(node) ? offlineSince(node.sync.lastSeen, thresholds, now) : null;
    if (elapsed === null) continue;
    warnings.push(warning({ id: `offline:node:${node.id}`, level: "warning", kind: "offline", text: `${node.name} has been offline for ${offlineDuration(elapsed)}`, nodeId: node.id, at: node.sync.lastSeen! }));
  }
  const reported = new Set([...nodes.filter((node) => node.local || node.dashboardUrl).map((node) => node.syncthing?.deviceId), ...localDeviceIds]);
  const listed = new Set<string>();
  for (const node of local) {
    for (const peer of node.peers) {
      if (peer.connected || peer.paused || reported.has(peer.deviceId) || listed.has(peer.deviceId)) continue;
      const elapsed = offlineSince(peer.lastSeen, thresholds, now);
      if (elapsed === null) continue;
      listed.add(peer.deviceId);
      const ownNode = nodes.find((candidate) => candidate.syncthing?.deviceId === peer.deviceId);
      warnings.push(
        warning({
          id: `offline:device:${peer.deviceId}`,
          level: "warning",
          kind: "offline",
          text: `${deviceDisplayName(peer.name, peer.deviceId)} (seen by ${node.name}) has been offline for ${offlineDuration(elapsed)}`,
          nodeId: ownNode?.id ?? node.id,
          at: peer.lastSeen!,
        }),
      );
    }
  }
  return warnings;
}
