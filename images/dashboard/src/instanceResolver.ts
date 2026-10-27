import type { StorageNode } from "./api/types.js";
import { arrayIds, arrayStatus } from "./arrayStatus.js";
import { agentEntries, readHeartbeat } from "./hostAgent.js";
import { RequestError, UnconfirmedWrite } from "./http.js";
import { statusRegistryEntries, syncthingEndpoint } from "./instances.js";
import { fileJoinRecords } from "./join.js";
import { otherHostNodes } from "./nodes.js";
import { clusterArrayId, hostAgentHeartbeatFile, joinsFile, poolPath, registryDirectory } from "./settings.js";
import { type SyncthingEndpoint, SyncthingClient, SyncthingUnavailable } from "./syncthing.js";
import { fetchTailnet } from "./tailnet.js";
import { setTimeout as sleep } from "node:timers/promises";

export type LocalInstance = {
  kind: "local";
  nodeId: string;
  name: string;
  client: SyncthingClient;
  root: string | null;
  os: "linux" | "windows";
  threshold: number;
  /** An array takes folders only under the stricter rules of `arrayConfirmProblem` and `acceptFolderDefaults`. */
  source: LocalNodeSource;
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

/** Where this host knows a node from: the mounter's arrays, the registry the mounter and nodes service write, or the Windows host agent. */
export type LocalNodeSource = "array" | "registry" | "host-agent";

interface LocalNode {
  nodeId: string;
  source: LocalNodeSource;
  name: string;
  root: string | null;
  os: LocalInstance["os"];
  threshold: number;
  present: boolean;
  /** False for the cluster while this host has no description of it, so it counts only once its Syncthing answers. */
  described: boolean;
  endpoint: () => Promise<SyncthingEndpoint | null>;
}

async function arrayNode(nodeId: string, sources: ResolverSources): Promise<LocalNode | null> {
  const status = /^[a-z0-9]+$/.test(nodeId) ? await arrayStatus(nodeId) : null;
  if (!status && nodeId !== clusterArrayId) return null;
  return {
    nodeId,
    source: "array",
    name: status?.name ?? nodeId,
    root: poolPath(nodeId),
    os: "linux",
    threshold: status?.description?.node.threshold ?? 0,
    present: status?.present ?? true,
    described: status !== null,
    endpoint: () => syncthingEndpoint(nodeId, undefined, sources.registryDirectory),
  };
}

async function registryNodes(sources: ResolverSources): Promise<LocalNode[]> {
  const fromStatus = (await statusRegistryEntries(sources.registryDirectory)).map((entry) => ({ entry, os: "linux" as const, source: "registry" as const }));
  const fromAgent = agentEntries(await readHeartbeat(sources.heartbeatPath)).map((entry) => ({ entry, os: "windows" as const, source: "host-agent" as const }));
  return [...fromStatus, ...fromAgent].map(({ entry, os, source }) => ({
    nodeId: entry.id,
    source,
    name: entry.name,
    root: entry.root || null,
    os,
    threshold: entry.threshold,
    present: entry.present,
    described: true,
    endpoint: () => syncthingEndpoint(entry.id, entry, sources.registryDirectory),
  }));
}

async function registryNode(nodeId: string, sources: ResolverSources): Promise<LocalNode | null> {
  return (await registryNodes(sources)).find((node) => node.nodeId === nodeId) ?? null;
}

async function toInstance(node: LocalNode): Promise<LocalInstance | null> {
  const endpoint = node.present ? await node.endpoint() : null;
  return endpoint ? { kind: "local", nodeId: node.nodeId, name: node.name, client: new SyncthingClient(endpoint), root: node.root, os: node.os, threshold: node.threshold, source: node.source } : null;
}

/** A node of this host whether or not its Syncthing can be addressed; `instance` is null while it cannot. */
export interface LocalNodeInfo {
  nodeId: string;
  source: LocalNodeSource;
  name: string;
  root: string | null;
  os: LocalInstance["os"];
  threshold: number;
  present: boolean;
  instance: LocalInstance | null;
}

async function toInfo(local: LocalNode): Promise<LocalNodeInfo> {
  return { nodeId: local.nodeId, source: local.source, name: local.name, root: local.root, os: local.os, threshold: local.threshold, present: local.present, instance: await toInstance(local) };
}

/** Every node of this host, the cluster first: each array, the cluster, registry entries and host agent nodes. */
export async function localNodeInfos(sources: ResolverSources = defaultResolverSources): Promise<LocalNodeInfo[]> {
  const arrays = (await Promise.all((await arrayIds()).map((nodeId) => arrayNode(nodeId, sources)))).filter((node): node is LocalNode => node !== null);
  const nodes = [...arrays, ...(await registryNodes(sources))];
  const infos = await Promise.all(nodes.map(toInfo));
  return infos.filter((info, index) => nodes[index].described || info.instance !== null);
}

/** Every node of this host whose Syncthing can be addressed. */
export async function localInstances(sources: ResolverSources = defaultResolverSources): Promise<LocalInstance[]> {
  return (await localNodeInfos(sources)).flatMap((info) => (info.instance ? [info.instance] : []));
}

export async function findLocalNode(nodeId: string, sources: ResolverSources = defaultResolverSources): Promise<LocalNodeInfo | null> {
  const local = (await arrayNode(nodeId, sources)) ?? (await registryNode(nodeId, sources));
  return local && toInfo(local);
}

function notAnswering(name: string): RequestError {
  return new RequestError(503, `${name}'s Syncthing is not answering`);
}

/** A node whose drive or array is not attached: its Syncthing is not expected to answer, so this is no fault. */
function notConnected(name: string): RequestError {
  return new RequestError(409, `${name} is not connected`);
}

/**
 * The Syncthing behind a node ID: this host's own instance for an array, a registry entry or a host
 * agent node, otherwise the other host whose dashboard reported the node.
 */
export async function resolveInstance(nodeId: string, sources: ResolverSources = defaultResolverSources): Promise<ResolvedInstance> {
  const local = await findLocalNode(nodeId, sources);
  if (local) {
    if (!local.present) throw notConnected(local.name);
    if (!local.instance) throw notAnswering(local.name);
    return local.instance;
  }
  return resolveRemote(nodeId, sources);
}

/** A node another host's dashboard reported, for a caller that already knows it is not this host's. */
export async function resolveRemote(nodeId: string, sources: ResolverSources = defaultResolverSources): Promise<RemoteInstance> {
  const remote = (await sources.otherHostNodes()).find((node) => node.id === nodeId);
  if (!remote) throw new RequestError(404, `no node ${nodeId}`);
  return { kind: "remote", nodeId, name: remote.name, host: remote.host, dashboardUrl: remote.dashboardUrl };
}

export function requireLocal(instance: ResolvedInstance): LocalInstance {
  if (instance.kind === "remote") throw new RequestError(409, `act on ${instance.host}'s dashboard`);
  return instance;
}

export function isArrayInstance(instance: LocalInstance): boolean {
  return instance.source === "array";
}

/**
 * The array guard: on an array a folder is added, accepted, shared or ignored only with its ID typed exactly; `doing` names the act (`accept it`).
 * @implNote The PC's folders are offered to the private array and wait there for the human partner's go-ahead (HANDOFF decision 1),
 * so no such act on an array is one click; callers run this before any request to the node.
 */
export function arrayConfirmProblem(instance: LocalInstance, folderId: string, confirm: unknown, doing: string): string | null {
  return isArrayInstance(instance) && confirm !== folderId ? `type the folder ID ${folderId} to ${doing} on ${instance.name}, an array` : null;
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

function isNotAnsweringError(error: unknown): boolean {
  return error instanceof RequestError && error.status === 503;
}

/** The waits between read-backs of a write whose answer was lost: 7.5 s in all, about as long as Syncthing takes to restart. */
export const defaultReadBackDelaysMs: readonly number[] = [500, 1000, 2000, 4000];

type ReadBack = "in-place" | "missing" | "no-answer";

async function readBackOnce(isInPlace: () => Promise<boolean>): Promise<ReadBack> {
  try {
    return (await isInPlace()) ? "in-place" : "missing";
  } catch {
    return "no-answer";
  }
}

/** Reads the change back until it is found in place or the waits run out; a node that answered at least once without it has not saved it. */
async function readBack(isInPlace: () => Promise<boolean>, delaysMs: readonly number[]): Promise<ReadBack> {
  let outcome = await readBackOnce(isInPlace);
  let isAnsweredMissing = outcome === "missing";
  for (const delay of delaysMs) {
    if (outcome === "in-place") return outcome;
    await sleep(delay);
    outcome = await readBackOnce(isInPlace);
    isAnsweredMissing ||= outcome === "missing";
  }
  if (outcome === "in-place") return outcome;
  return isAnsweredMissing ? "missing" : "no-answer";
}

/**
 * Sends one write to the node's Syncthing; when its answer is lost, `isInPlace` reads whether the change took effect.
 * The read-back is retried after each of `delaysMs` while it fails or finds the change missing. A change found in place
 * counts as saved, one found missing is the 503 of a node that does not answer, and one never read back is an `UnconfirmedWrite`.
 * @implNote Syncthing restarts after some config changes and can drop the answer of a write it applied, so a lost answer is never taken for "not saved".
 */
export async function writeConfirmed(
  instance: LocalInstance,
  write: (client: SyncthingClient) => Promise<unknown>,
  isInPlace: () => Promise<boolean>,
  delaysMs: readonly number[] = defaultReadBackDelaysMs,
): Promise<void> {
  try {
    await callSyncthing(instance, write);
  } catch (error) {
    if (!isNotAnsweringError(error)) throw error;
    const outcome = await readBack(isInPlace, delaysMs);
    if (outcome === "missing") throw error;
    if (outcome === "no-answer") throw new UnconfirmedWrite(instance.name);
  }
}

function peerError(body: unknown): string | null {
  const error = (body as { error?: unknown } | null)?.error;
  return typeof error === "string" ? error : null;
}

/**
 * A GET from another host's dashboard with `scope=local` added to the path's own query. A refusal
 * keeps the dashboard's status and `error`; a dashboard that cannot be reached is a 502, one that
 * does not answer within `timeoutMs` a 504.
 */
export async function readDashboard(dashboardUrl: string, host: string, path: string, timeoutMs = 5000): Promise<unknown> {
  const url = new URL(`${dashboardUrl}${path}`);
  url.searchParams.set("scope", "local");
  let answer;
  try {
    answer = await fetchTailnet(url.toString(), timeoutMs);
  } catch (error) {
    if ((error as Error).name === "TimeoutError") throw new RequestError(504, `${host}'s dashboard did not answer within ${timeoutMs / 1000} s`);
    throw new RequestError(502, `${host}'s dashboard: ${(error as Error).message}`);
  }
  if (answer.status >= 200 && answer.status < 300) return answer.body;
  throw new RequestError(answer.status, peerError(answer.body) ?? `${host}'s dashboard answered HTTP ${answer.status}`);
}

/** A GET of a remote node's data from its own host's dashboard, which answers for its local nodes only. */
export async function forwardRead(instance: RemoteInstance, path: string): Promise<unknown> {
  if (!instance.dashboardUrl) throw new RequestError(404, `no dashboard for ${instance.name}`);
  return readDashboard(instance.dashboardUrl, instance.host, path);
}
