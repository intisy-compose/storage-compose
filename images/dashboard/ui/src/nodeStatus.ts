import type { ArrayMember, MemberSmart, NodesResponse, StorageNode, Warning } from "./api.js";
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
  return !node.online || node.sync.state === "offline";
}

export function transferSymbol(node: StorageNode): string {
  const device = node.syncthing;
  if (!device) return "⇅";
  if (device.outRate > device.inRate * 2) return "↑";
  if (device.inRate > device.outRate * 2) return "↓";
  return "⇅";
}

export function shortSyncState(node: StorageNode): ShortState {
  if (isOffline(node)) return { symbol: "", label: formatAge(node.sync.lastSeen), tone: "muted" };
  if (node.sync.state === "error") return { symbol: "!", label: "error", tone: "bad" };
  if (node.sync.state === "syncing") {
    return { symbol: transferSymbol(node), label: formatPercent(normaliseCompletion(node.sync.completion)), tone: "accent" };
  }
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

function verdictFromSummary(smart: MemberSmart): SmartVerdict {
  if (smart.passed === false) return { label: "failing", tone: "bad" };
  if (smart.state && smart.state !== "ok") return { label: smart.detail ?? smart.state, tone: smart.state === "failing" ? "bad" : "warn" };
  const reallocated = smart.reallocatedSectors ?? 0;
  const pending = smart.pendingSectors ?? 0;
  if (pending > 0) return { label: `${pending} pending`, tone: "bad" };
  if (reallocated > 0) return { label: `${reallocated} realloc.`, tone: "warn" };
  if (smart.percentageUsed !== null && smart.percentageUsed !== undefined && smart.percentageUsed >= 80) {
    return { label: `${smart.percentageUsed}% worn`, tone: "warn" };
  }
  if (smart.passed === null && !smart.state) return { label: "no SMART", tone: "muted" };
  return { label: "ok", tone: "ok" };
}

export function smartVerdict(member: ArrayMember): SmartVerdict {
  if (!member.present) return { label: "missing", tone: "bad" };
  const smart = member.smart;
  if (smart === null || smart === undefined) return { label: "no SMART", tone: "muted" };
  if (typeof smart === "string") {
    const tone: Tone = smart === "ok" || smart === "passed" ? "ok" : smart === "failing" ? "bad" : "warn";
    return { label: smart, tone };
  }
  return verdictFromSummary(smart);
}

export function isSmartWarning(member: ArrayMember): boolean {
  const tone = smartVerdict(member).tone;
  return member.present && (tone === "warn" || tone === "bad");
}

export function warningsFor(response: NodesResponse, node: StorageNode): Warning[] {
  return response.warnings.filter((warning) => warning.nodeId === node.id);
}

export function needsAttention(response: NodesResponse, node: StorageNode): boolean {
  if (warningsFor(response, node).some((warning) => warning.level !== "info")) return true;
  if (node.sync.state === "error") return true;
  if (node.array && node.array.state !== "healthy") return true;
  if (node.array?.members.some(isSmartWarning)) return true;
  const tone = spaceTone(node);
  return tone === "warn" || tone === "bad";
}

export function nodeTone(response: NodesResponse, node: StorageNode): Tone {
  if (isOffline(node)) return "muted";
  if (node.sync.state === "error" || node.array?.state === "frozen") return "bad";
  if (needsAttention(response, node)) return "warn";
  return "ok";
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
};
