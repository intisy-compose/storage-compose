import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Bridge, ConnectionOptions, ConnectionProfile, HostNetwork, NodeAddresses, PeerTable } from "./api/types.js";
import { profileOptions } from "./connectionProfile.js";
import { canReach, hasNoTrustedNetwork } from "./reachability.js";

/** What a node's keeper applies: its options, its listen addresses, and the addresses of every peer keyed by device ID. */
export interface NodeConnections {
  options: Partial<ConnectionOptions>;
  listenAddresses: string[];
  deviceAddresses: Record<string, string[]>;
}

const publicRelayPool = "dynamic+https://relays.syncthing.net/endpoint";

function builtAtOrder(table: PeerTable): number {
  const time = Date.parse(table.builtAt);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

/** This host's own nodes and bridges win over every remote table; among the remote ones the newest wins. */
export function buildPeerTable(local: NodeAddresses[], localBridges: Bridge[], remote: PeerTable[], builtAt = new Date().toISOString()): PeerTable {
  const oldestFirst = [...remote].sort((first, second) => builtAtOrder(first) - builtAtOrder(second));
  const nodes = new Map<string, NodeAddresses>();
  const bridges = new Map<string, Bridge>();
  for (const table of [...oldestFirst, { nodes: local, bridges: localBridges }]) {
    for (const node of table.nodes) nodes.set(node.nodeId, node);
    for (const bridge of table.bridges) bridges.set(bridge.host, bridge);
  }
  return {
    nodes: [...nodes.values()].sort((first, second) => first.nodeId.localeCompare(second.nodeId)),
    bridges: [...bridges.values()].sort((first, second) => first.host.localeCompare(second.host)),
    builtAt,
  };
}

function hostPort(address: string, port: number): string {
  return address.includes(":") ? `[${address}]:${port}` : `${address}:${port}`;
}

function relayAddresses(profile: ConnectionProfile, table: PeerTable, own: HostNetwork[]): string[] {
  if (!profile.relays.bridges) return [];
  return table.bridges.flatMap((bridge) =>
    bridge.addresses.filter((network) => canReach(profile, own, network)).map((network) => `relay://${hostPort(network.address, bridge.port)}/?id=${bridge.relayId}`),
  );
}

function directAddresses(profile: ConnectionProfile, own: HostNetwork[], peer: NodeAddresses): string[] {
  return peer.networks
    .filter((network) => canReach(profile, own, network))
    .flatMap((network) => {
      const target = hostPort(network.address, peer.syncPort);
      return network.tcpOnly ? [`tcp://${target}`] : [`tcp://${target}`, `quic://${target}`];
    });
}

/**
 * @implNote On networks the person does not own the node neither broadcasts its device ID nor opens ports through the
 * router; global discovery and relays reach out through the internet, so they stay as the profile says.
 */
function nodeOptions(profile: ConnectionProfile, node: NodeAddresses): Partial<ConnectionOptions> {
  const options = profileOptions(profile, node.nodeId);
  return hasNoTrustedNetwork(node.networks) ? { ...options, localAnnounceEnabled: false, natEnabled: false } : options;
}

export function resolveNode(profile: ConnectionProfile, table: PeerTable, nodeId: string): NodeConnections {
  const node = table.nodes.find((entry) => entry.nodeId === nodeId);
  if (!node) throw new Error(`node ${nodeId} is not in the peer table`);
  const relays = relayAddresses(profile, table, node.networks);
  const peers = table.nodes.filter((peer) => peer.nodeId !== nodeId && peer.deviceId && peer.deviceId !== node.deviceId);
  return {
    options: nodeOptions(profile, node),
    listenAddresses: [
      ...new Set([`tcp://0.0.0.0:${node.syncPort}`, `quic://0.0.0.0:${node.syncPort}`, ...relays, ...(profile.relays.public ? [publicRelayPool] : [])]),
    ],
    deviceAddresses: Object.fromEntries(peers.map((peer) => [peer.deviceId, [...new Set([...directAddresses(profile, node.networks, peer), ...relays, "dynamic"])]])),
  };
}

/** `/status/connections.json`, keyed by node id; replaced in one rename so a keeper never reads half of it. */
export async function writeConnectionsFile(path: string, byNode: Record<string, NodeConnections>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.new`, `${JSON.stringify(byNode, null, 2)}\n`);
  await rename(`${path}.new`, path);
}
