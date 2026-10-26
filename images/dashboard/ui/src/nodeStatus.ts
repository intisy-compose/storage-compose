import { type ArrayMember, type MemberSmart, type NodesResponse, type StorageNode, type Warning, isReachable } from "./api.js";
import { formatAge, formatPercent, normaliseCompletion, usedFraction } from "./format.js";

export type Tone = "ok" | "warn" | "bad" | "muted" | "accent";

export interface ShortState {
  symbol: string;
  label: string;
  tone: Tone;
}

const nearlyFull = 0.9;
const full = 0.98;

export function isOffline(node: StorageNode): boolean {
  return !isReachable(node);
}

export function isArrayAbsent(node: StorageNode): boolean {
  return node.array?.state === "absent";
}

export function transferSymbol(node: StorageNode): string {
  const device = node.syncthing;
  if (!device) return "⇅";
  if (device.outRate > device.inRate * 2) return "↑";
  if (device.inRate > device.outRate * 2) return "↓";
  return "⇅";
}

export function failedItems(node: StorageNode): number {
  return node.folders.reduce((sum, folder) => sum + (folder.errors ?? 0), 0);
}

export function waitingForNames(response: NodesResponse, node: StorageNode): string[] {
  const names = (node.sync.waitingFor ?? []).map((deviceId) => {
    const known = response.nodes.find((candidate) => candidate.syncthing?.deviceId === deviceId);
    return known?.name ?? node.peers.find((peer) => peer.deviceId === deviceId)?.name ?? deviceId.slice(0, 7);
  });
  return [...new Set(names)];
}

function offersWaitingText(count: number): string {
  return `${count} ${count === 1 ? "offer" : "offers"} waiting`;
}

export function shortSyncState(node: StorageNode, response?: NodesResponse): ShortState {
  if (isArrayAbsent(node)) return { symbol: "", label: node.sync.lastSeen ? `not connected, ${formatAge(node.sync.lastSeen)}` : "not connected", tone: "muted" };
  if (isOffline(node)) return { symbol: "", label: formatAge(node.sync.lastSeen), tone: "muted" };
  if (node.sync.state === "error") return { symbol: "!", label: "error", tone: "bad" };
  if (node.sync.state === "unknown") return { symbol: "?", label: "completion unavailable", tone: "muted" };
  if (node.sync.state === "syncing") {
    return { symbol: transferSymbol(node), label: formatPercent(normaliseCompletion(node.sync.completion)), tone: "accent" };
  }
  if (node.sync.state === "waiting") {
    const names = response ? waitingForNames(response, node) : [];
    return { symbol: "…", label: names.length ? `waiting for ${names.join(", ")}` : "waiting for a peer", tone: "warn" };
  }
  const failed = failedItems(node);
  if (failed > 0) return { symbol: "!", label: `${failed} failed ${failed === 1 ? "item" : "items"}`, tone: "bad" };
  if (node.offersWaiting > 0) return { symbol: "…", label: offersWaitingText(node.offersWaiting), tone: "warn" };
  return { symbol: "✓", label: "in sync", tone: "ok" };
}

export function spaceTone(node: StorageNode): Tone {
  const fraction = usedFraction(node.space);
  if (isOffline(node)) return "muted";
  if (fraction === null) return "muted";
  if (fraction >= full) return "bad";
  if (fraction >= nearlyFull) return "warn";
  return "accent";
}

export function memberSpaceTone(member: ArrayMember): Tone {
  if (!member.present) return "muted";
  const fraction = member.size && member.used !== undefined && member.used !== null ? member.used / member.size : null;
  if (fraction === null) return "muted";
  if (fraction >= full) return "bad";
  if (fraction >= nearlyFull) return "warn";
  return "accent";
}

export interface SmartVerdict {
  label: string;
  tone: Tone;
}

function countsVerdict(smart: MemberSmart): SmartVerdict {
  const reallocated = smart.reallocatedSectors ?? 0;
  const pending = smart.pendingSectors ?? 0;
  if (pending > 0) return { label: `${pending} pending`, tone: smart.state === "fail" ? "bad" : "warn" };
  if (reallocated > 0) return { label: `${reallocated} realloc.`, tone: smart.state === "fail" ? "bad" : "warn" };
  return { label: smart.state === "fail" ? "failing" : "ok", tone: smart.state === "fail" ? "bad" : "ok" };
}

export function smartVerdict(member: ArrayMember): SmartVerdict {
  if (!member.present) return { label: "missing", tone: "bad" };
  const smart = member.smart;
  if (smart === null || smart.state === "none") return { label: "no SMART", tone: "muted" };
  if (smart.state === "ok") return { label: "ok", tone: "ok" };
  return countsVerdict(smart);
}

export function isSmartWarning(member: ArrayMember): boolean {
  const tone = smartVerdict(member).tone;
  return member.present && (tone === "warn" || tone === "bad");
}

export function warningsFor(response: NodesResponse, node: StorageNode): Warning[] {
  return response.warnings.filter((warning) => warning.nodeId === node.id);
}

/** The warnings a person should act on; info entries such as an offer or a detached node are left out. */
export function actionableWarnings(response: NodesResponse, node: StorageNode): Warning[] {
  return warningsFor(response, node).filter((warning) => warning.level !== "info");
}

export function needsAttention(response: NodesResponse, node: StorageNode): boolean {
  if (actionableWarnings(response, node).length > 0) return true;
  if (node.sync.state === "error" || node.sync.state === "waiting") return true;
  if (failedItems(node) > 0) return true;
  if (node.array && node.array.state !== "healthy" && node.array.state !== "absent") return true;
  if (node.array?.members.some(isSmartWarning)) return true;
  const tone = spaceTone(node);
  return tone === "warn" || tone === "bad";
}

export function countRoles(members: ArrayMember[]): { data: number; parity: number } {
  const parity = members.filter((member) => member.role.startsWith("parity")).length;
  return { data: members.length - parity, parity };
}

export function kindChipText(node: StorageNode): string {
  if (!node.array) return node.kind;
  const { data, parity } = countRoles(node.array.members);
  return `${data} data + ${parity} parity`;
}

export function thresholdChipText(threshold: number): string {
  return `≥ ${threshold}`;
}

export const arrayStateMeaning: Record<string, string> = {
  healthy: "Every drive is present.",
  degraded: "The share keeps working without the missing files; Kopia and parity syncs wait.",
  frozen: "Frozen: the share is read-only and syncing is paused until the drives are back.",
  absent: "None of its drives is connected to this host; this is how it was last seen.",
};

export const arrayStateLabel: Record<string, string> = { absent: "not connected" };
