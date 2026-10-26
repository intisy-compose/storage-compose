import { readFile, readdir } from "node:fs/promises";
import type { NodeRegistryEntry } from "./api/types.js";
import { agentEntries, readHeartbeat } from "./hostAgent.js";
import { type SyncthingEndpoint, apiKeyFromConfig } from "./syncthing.js";
import { arrayStateDirectory, clusterArrayId, clusterSyncthingUrl, hostAgentHeartbeatFile, registryDirectory } from "./settings.js";

const staleAfterMilliseconds = 5 * 60_000;

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * Drive and folder nodes from the registry and the Windows host agent's heartbeat; an entry its
 * writer stopped confirming counts as absent.
 */
export async function registryEntries(directory = registryDirectory, heartbeatPath = hostAgentHeartbeatFile): Promise<NodeRegistryEntry[]> {
  return [...(await statusRegistryEntries(directory)), ...agentEntries(await readHeartbeat(heartbeatPath))];
}

/** The entries the mounter and the nodes service wrote, without the host agent's. */
export async function statusRegistryEntries(directory = registryDirectory): Promise<NodeRegistryEntry[]> {
  const names = await readdir(directory).catch(() => [] as string[]);
  const entries = await Promise.all(
    names.filter((name) => /^[0-9a-f]{4}\.json$/.test(name)).map((name) => readJson<NodeRegistryEntry>(`${directory}/${name}`)),
  );
  return entries
    .filter((entry): entry is NodeRegistryEntry => entry !== null)
    .map((entry) => ({ ...entry, present: entry.present && Date.now() - Date.parse(entry.updated) < staleAfterMilliseconds }));
}

export async function registryWarnings(): Promise<string[]> {
  const text = await readFile(`${registryDirectory}/warnings`, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean);
}

/**
 * Where a node's own Syncthing answers: the cluster's through the gateway, every other node's as the
 * nodes service (or the host agent) recorded it in the registry or its `<id>.syncthing.json`.
 */
export async function syncthingEndpoint(nodeId: string, entry?: NodeRegistryEntry, directory = registryDirectory): Promise<SyncthingEndpoint | null> {
  if (nodeId === clusterArrayId) {
    const apiKey = await apiKeyFromConfig(`${arrayStateDirectory(clusterArrayId)}/syncthing/config.xml`);
    return apiKey ? { url: clusterSyncthingUrl, apiKey } : null;
  }
  if (entry?.syncthing) return entry.syncthing;
  return readJson<SyncthingEndpoint>(`${directory}/${nodeId}.syncthing.json`);
}
