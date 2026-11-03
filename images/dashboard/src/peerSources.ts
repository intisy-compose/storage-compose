import { readFile } from "node:fs/promises";
import type { Bridge, HostNetwork, NodeAddresses, PeerTable } from "./api/types.js";
import { type HostAgentHeartbeat, readHeartbeat } from "./hostAgent.js";
import { type LocalNodeInfo, type ResolverSources, defaultResolverSources, localNodeInfos, readDashboard } from "./instanceResolver.js";
import { clusterSyncPort, registrySyncPort } from "./joinInstances.js";
import { buildPeerTable } from "./peerTable.js";
import { clusterArrayId, hostName, peerDashboards, statusDirectory, tailnetHost } from "./settings.js";

/** Where this host's addresses are read from; tests point it at a scratch directory. */
export interface PeerSources {
  resolver: ResolverSources;
  /** @implNote Injected, so a test never asks a live Syncthing for its device ID. */
  dockerNodeInfos: () => Promise<LocalNodeInfo[]>;
  /** `{ relayId, port }` of the Docker bridge, written by the bridge service. */
  dockerBridgeFile: string;
  /** The gateway's own tailnet name, which `serve` forwards the sync ports on. */
  gatewayTailnetName: string;
}

export const defaultPeerSources: PeerSources = {
  resolver: defaultResolverSources,
  dockerNodeInfos: () => localNodeInfos(defaultResolverSources),
  dockerBridgeFile: `${statusDirectory}/bridge.json`,
  gatewayTailnetName: tailnetHost,
};

/**
 * The networks a node in the gateway's namespace is reached on: the host's LAN through the published ports, and the
 * tailnet on the host's address and the gateway's own name.
 * @implNote No public address: NAT traversal from inside the namespace cannot map the router (spec section 4).
 */
export function dockerNetworks(hostNetworks: HostNetwork[], gatewayTailnetName: string): HostNetwork[] {
  const tailnetAddresses = [...hostNetworks.filter((network) => network.kind === "tailnet").map((network) => network.address), ...(gatewayTailnetName ? [gatewayTailnetName] : [])];
  return [
    ...hostNetworks.filter((network) => network.kind === "lan"),
    ...[...new Set(tailnetAddresses)].map((address): HostNetwork => ({ kind: "tailnet", address, tcpOnly: true })),
  ];
}

function agentNodes(heartbeat: HostAgentHeartbeat | null, networks: HostNetwork[]): NodeAddresses[] {
  return (heartbeat?.nodes ?? []).flatMap((node) => {
    const deviceId = node.syncthing?.deviceId;
    const syncPort = node.syncthing?.listenPort;
    return deviceId && syncPort ? [{ nodeId: node.id, name: node.name, deviceId, syncPort, networks }] : [];
  });
}

async function dockerNodes(sources: PeerSources, networks: HostNetwork[]): Promise<NodeAddresses[]> {
  const resolver = sources.resolver;
  const infos = (await sources.dockerNodeInfos()).filter((info) => info.source !== "host-agent" && info.instance !== null);
  const nodes = await Promise.all(
    infos.map(async (info) => {
      const syncPort = info.nodeId === clusterArrayId ? clusterSyncPort : await registrySyncPort(resolver.registryDirectory, info.nodeId);
      const deviceId = await info.instance!.client.myId().catch(() => null);
      return deviceId && syncPort ? [{ nodeId: info.nodeId, name: info.name, deviceId, syncPort, networks }] : [];
    }),
  );
  return nodes.flat();
}

async function dockerBridge(path: string): Promise<{ relayId: string; port: number } | null> {
  try {
    const file = JSON.parse(await readFile(path, "utf8")) as { relayId?: unknown; port?: unknown };
    return typeof file.relayId === "string" && file.relayId && typeof file.port === "number" ? { relayId: file.relayId, port: file.port } : null;
  } catch {
    return null;
  }
}

/** The host's one bridge is the stack's Docker bridge, reached on the Docker nodes' networks. */
async function localBridges(sources: PeerSources, docker: HostNetwork[]): Promise<Bridge[]> {
  const bridge = await dockerBridge(sources.dockerBridgeFile);
  return bridge ? [{ host: hostName, ...bridge, addresses: docker }] : [];
}

/**
 * This host's own nodes and bridges: what `GET /api/connections/addresses?scope=local` answers.
 * @implNote The heartbeat is used whatever its age: a node left out of one round is swapped to tailnet-only by its
 * keeper, so a slow round, a sleep or the agent's reinstall must not drop the host agent's nodes.
 */
export async function localPeerTable(sources: PeerSources = defaultPeerSources): Promise<PeerTable> {
  const heartbeat = await readHeartbeat(sources.resolver.heartbeatPath);
  const hostNetworks = heartbeat?.networks ?? [];
  const docker = dockerNetworks(hostNetworks, sources.gatewayTailnetName);
  const nodes = [...(await dockerNodes(sources, docker)), ...agentNodes(heartbeat, hostNetworks)];
  return buildPeerTable(nodes, await localBridges(sources, docker), []);
}

function isPeerTable(value: unknown): value is PeerTable {
  const table = value as PeerTable | null;
  return typeof table === "object" && table !== null && Array.isArray(table.nodes) && Array.isArray(table.bridges) && typeof table.builtAt === "string";
}

/**
 * Another dashboard's own part of the table (`readDashboard` asks with `scope=local`); null when it cannot be read or
 * answers something else.
 * @implNote Never its whole table: two dashboards reading each other's would hand a node removed on one host back and
 * forth for ever.
 */
export async function readRemoteTable(dashboardUrl: string): Promise<PeerTable | null> {
  try {
    const answer = await readDashboard(dashboardUrl, new URL(dashboardUrl).host, "/api/connections/addresses");
    return isPeerTable(answer) ? answer : null;
  } catch {
    return null;
  }
}

/** The whole cluster's table: this host's part and every other dashboard's. */
export async function collectPeerTable(sources: PeerSources = defaultPeerSources, dashboards: string[] = peerDashboards): Promise<PeerTable> {
  const [local, remote] = await Promise.all([localPeerTable(sources), Promise.all(dashboards.map(readRemoteTable))]);
  return buildPeerTable(local.nodes, local.bridges, remote.filter((table) => table !== null), local.builtAt);
}
