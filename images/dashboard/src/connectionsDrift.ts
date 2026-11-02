import { addressHost } from "./api/deviceText.js";
import type { Bridge, ConnectionsState } from "./api/types.js";

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

let bridgeHosts: ReadonlyMap<string, string> = new Map();

/** The last round's bridges, so a relayed connection through one of them is shown as that bridge. */
export function recordBridges(bridges: readonly Bridge[]): void {
  bridgeHosts = new Map(bridges.flatMap((bridge) => bridge.addresses.map((network): [string, string] => [addressHost(network.address).toLowerCase(), bridge.host])));
}

export function bridgesByAddress(): ReadonlyMap<string, string> {
  return bridgeHosts;
}
