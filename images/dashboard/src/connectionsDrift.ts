import { addressHost } from "./api/deviceText.js";
import type { ConnectionsState, PeerTable } from "./api/types.js";

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
let clusterDeviceIds: ReadonlySet<string> = new Set();

/** The last round's table, so a relayed connection through a bridge is shown as that bridge and a cluster node's addresses are known as the profile's. */
export function recordPeerTable(table: PeerTable): void {
  bridgeHosts = new Map(table.bridges.flatMap((bridge) => bridge.addresses.map((network): [string, string] => [addressHost(network.address).toLowerCase(), bridge.host])));
  clusterDeviceIds = new Set(table.nodes.map((node) => node.deviceId));
}

export function bridgesByAddress(): ReadonlyMap<string, string> {
  return bridgeHosts;
}

/** Whether the device is a node of the last round's table, whose addresses each round gives every node. */
export function isClusterNodeDevice(deviceId: string): boolean {
  return clusterDeviceIds.has(deviceId);
}
