import type { StorageNode } from "./api/types.js";
import { arrayStatus } from "./arrayStatus.js";
import { agentEntries, readHeartbeat } from "./hostAgent.js";
import { RequestError } from "./http.js";
import { statusRegistryEntries, syncthingEndpoint } from "./instances.js";
import { fileJoinRecords } from "./join.js";
import { otherHostNodes } from "./nodes.js";
import { clusterArrayId, hostAgentHeartbeatFile, joinsFile, poolPath, registryDirectory } from "./settings.js";
import { type SyncthingEndpoint, SyncthingClient, SyncthingUnavailable } from "./syncthing.js";
import { fetchTailnetJson } from "./tailnet.js";

export type LocalInstance = {
  kind: "local";
  nodeId: string;
  name: string;
  client: SyncthingClient;
  root: string | null;
  os: "linux" | "windows";
};

/** A node of another host, read through that host's dashboard; `dashboardUrl` is null for a device no dashboard reported. */
export type RemoteInstance = { kind: "remote"; nodeId: string; name: string; host: string; dashboardUrl: string | null };

export type ResolvedInstance = LocalInstance | RemoteInstance;

/** Where the resolver looks; tests point it at a scratch directory instead of `/status`. */
export interface ResolverSources {
  registryDirectory: string;
  heartbeatPath: string;
  otherHostNodes: () => Promise<StorageNode[]>;
}

export const defaultResolverSources: ResolverSources = {
  registryDirectory,
  heartbeatPath: hostAgentHeartbeatFile,
  otherHostNodes: () => otherHostNodes(fileJoinRecords(joinsFile)),
};

interface LocalNode {
  nodeId: string;
  name: string;
  root: string | null;
  os: LocalInstance["os"];
  present: boolean;
  endpoint: () => Promise<SyncthingEndpoint | null>;
}

async function arrayNode(nodeId: string, sources: ResolverSources): Promise<LocalNode | null> {
  const status = /^[a-z0-9]+$/.test(nodeId) ? await arrayStatus(nodeId) : null;
  if (!status && nodeId !== clusterArrayId) return null;
  return {
    nodeId,
    name: status?.name ?? nodeId,
    root: poolPath(nodeId),
    os: "linux",
    present: status?.present ?? true,
    endpoint: () => syncthingEndpoint(nodeId, undefined, sources.registryDirectory),
  };
}

async function registryNode(nodeId: string, sources: ResolverSources): Promise<LocalNode | null> {
  const fromStatus = (await statusRegistryEntries(sources.registryDirectory)).map((entry) => ({ entry, os: "linux" as const }));
  const fromAgent = agentEntries(await readHeartbeat(sources.heartbeatPath)).map((entry) => ({ entry, os: "windows" as const }));
  const found = [...fromStatus, ...fromAgent].find(({ entry }) => entry.id === nodeId);
  if (!found) return null;
  const { entry, os } = found;
  return { nodeId, name: entry.name, root: entry.root || null, os, present: entry.present, endpoint: () => syncthingEndpoint(entry.id, entry, sources.registryDirectory) };
}

function notAnswering(name: string): RequestError {
  return new RequestError(503, `${name}'s Syncthing is not answering`);
}

/**
 * The Syncthing behind a node ID: this host's own instance for an array, a registry entry or a host
 * agent node, otherwise the other host whose dashboard reported the node.
 */
export async function resolveInstance(nodeId: string, sources: ResolverSources = defaultResolverSources): Promise<ResolvedInstance> {
  const local = (await arrayNode(nodeId, sources)) ?? (await registryNode(nodeId, sources));
  if (local) {
    const endpoint = local.present ? await local.endpoint() : null;
    if (!endpoint) throw notAnswering(local.name);
    return { kind: "local", nodeId, name: local.name, client: new SyncthingClient(endpoint), root: local.root, os: local.os };
  }
  const remote = (await sources.otherHostNodes()).find((node) => node.id === nodeId);
  if (!remote) throw new RequestError(404, `no node ${nodeId}`);
  return { kind: "remote", nodeId, name: remote.name, host: remote.host, dashboardUrl: remote.dashboardUrl };
}

export function requireLocal(instance: ResolvedInstance): LocalInstance {
  if (instance.kind === "remote") throw new RequestError(409, `act on ${instance.host}'s dashboard`);
  return instance;
}

/** Runs one exchange with the node's Syncthing; an instance that does not answer becomes a 503 naming the node. */
export async function callSyncthing<T>(instance: LocalInstance, call: (client: SyncthingClient) => Promise<T>): Promise<T> {
  try {
    return await call(instance.client);
  } catch (error) {
    if (error instanceof SyncthingUnavailable) throw notAnswering(instance.name);
    throw error;
  }
}

/** A GET of a remote node's data from its own host's dashboard, which answers for its local nodes only. */
export async function forwardRead(instance: RemoteInstance, path: string): Promise<unknown> {
  if (!instance.dashboardUrl) throw new RequestError(404, `no dashboard for ${instance.name}`);
  const url = new URL(`${instance.dashboardUrl}${path}`);
  url.searchParams.set("scope", "local");
  try {
    return await fetchTailnetJson<unknown>(url.toString());
  } catch (error) {
    throw new RequestError(502, `${instance.host}'s dashboard: ${(error as Error).message}`);
  }
}
