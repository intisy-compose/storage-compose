import type { ConnectionsState } from "./api/types.js";

/** One round over this host's nodes: on the profile after it, not yet on it (no entry or no answering Syncthing), and failed with the reason. */
export interface ApplyReport {
  applied: string[];
  notYet: string[];
  failed: Record<string, string>;
}

let lastReport: ApplyReport | null = null;

export function recordDrift(report: ApplyReport): void {
  lastReport = report;
}

export function connectionsStateOf(nodeId: string): ConnectionsState {
  if (lastReport?.applied.includes(nodeId)) return "on-profile";
  if (lastReport && (lastReport.notYet.includes(nodeId) || Object.hasOwn(lastReport.failed, nodeId))) return "not-yet";
  return "unknown";
}
