import { readFile } from "node:fs/promises";
import type { Bridge, HostNetwork, NodeAddresses, PeerTable } from "./api/types.js";
import { type HostAgentHeartbeat, isAgentAlive, readHeartbeat } from "./hostAgent.js";
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

function liveHeartbeat(heartbeat: HostAgentHeartbeat | null): HostAgentHeartbeat | null {
  return heartbeat && isAgentAlive(heartbeat) ? heartbeat : null;
}

function agentNodes(heartbeat: HostAgentHeartbeat | null, networks: HostNetwork[]): NodeAddresses[] {
  return (heartbeat?.nodes ?? []).flatMap((node) => {
    const deviceId = node.syncthing?.deviceId;
    const syncPort = node.syncthing?.listenPort;
    return deviceId && syncPort ? [{ nodeId: node.id, deviceId, syncPort, networks }] : [];
  });
}

async function dockerNodes(sources: PeerSources, networks: HostNetwork[]): Promise<NodeAddresses[]> {
  const resolver = sources.resolver;
  const infos = (await sources.dockerNodeInfos()).filter((info) => info.source !== "host-agent" && info.instance !== null);
  const nodes = await Promise.all(
    infos.map(async (info) => {
      const syncPort = info.nodeId === clusterArrayId ? clusterSyncPort : await registrySyncPort(resolver.registryDirectory, info.nodeId);
      const deviceId = await info.instance!.client.myId().catch(() => null);
      return deviceId && syncPort ? [{ nodeId: info.nodeId, deviceId, syncPort, networks }] : [];
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

/** This host's own nodes and bridges: what `GET /api/connections/addresses?scope=local` answers. */
export async function localPeerTable(sources: PeerSources = defaultPeerSources): Promise<PeerTable> {
  const heartbeat = liveHeartbeat(await readHeartbeat(sources.resolver.heartbeatPath));
  const hostNetworks = heartbeat?.networks ?? [];
  const docker = dockerNetworks(hostNetworks, sources.gatewayTailnetName);
  const nodes = [...(await dockerNodes(sources, docker)), ...agentNodes(heartbeat, hostNetworks)];
  return buildPeerTable(nodes, await localBridges(sources, docker), []);
}

function isPeerTable(value: unknown): value is PeerTable {
  const table = value as PeerTable | null;
  return typeof table === "object" && table !== null && Array.isArray(table.nodes) && Array.isArray(table.bridges) && typeof table.builtAt === "string";
}

/** @implNote A dashboard that cannot be read leaves its nodes out of this round's table; the next round asks again. */
async function remoteTable(dashboardUrl: string): Promise<PeerTable[]> {
  try {
    const answer = await readDashboard(dashboardUrl, new URL(dashboardUrl).host, "/api/connections/addresses");
    return isPeerTable(answer) ? [answer] : [];
  } catch {
    return [];
  }
}

/** The whole cluster's table: this host's part and every other dashboard's. */
export async function collectPeerTable(sources: PeerSources = defaultPeerSources, dashboards: string[] = peerDashboards): Promise<PeerTable> {
  const [local, remote] = await Promise.all([localPeerTable(sources), Promise.all(dashboards.map(remoteTable))]);
  return buildPeerTable(local.nodes, local.bridges, remote.flat(), local.builtAt);
}
