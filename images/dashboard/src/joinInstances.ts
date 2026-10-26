import { readFile } from "node:fs/promises";
import { type LocalInstance, type LocalNodeInfo, type ResolverSources, defaultResolverSources, localNodeInfos } from "./instanceResolver.js";
import type { JoinInstance } from "./join.js";
import { clusterArrayId, tailnetHost } from "./settings.js";

const clusterSyncPort = 22000;

async function registrySyncPort(registryDirectory: string, nodeId: string): Promise<number | null> {
  try {
    return (JSON.parse(await readFile(`${registryDirectory}/${nodeId}.syncthing.json`, "utf8")) as { syncPort?: number }).syncPort ?? null;
  } catch {
    return null;
  }
}

function joinInstance(instance: LocalInstance, syncPort: number | null): JoinInstance {
  const client = instance.client;
  return {
    name: instance.name,
    addresses: [...(tailnetHost && syncPort ? [`tcp://${tailnetHost}:${syncPort}`] : []), "dynamic"],
    myId: () => client.myId(),
    addDevice: (device) => client.addDevice(device),
    shareFolder: (folderId, deviceId) => client.shareFolder(folderId, deviceId),
  };
}

/** @implNote A joining device is added to the cluster and the folder and drive nodes, never to another array, such as a private one. */
function admitsJoins(info: LocalNodeInfo): info is LocalNodeInfo & { instance: LocalInstance } {
  return info.instance !== null && (info.source !== "array" || info.nodeId === clusterArrayId);
}

/** This host's Syncthing instances a joining device is added to, the cluster first, each with the address it is dialled at. */
export async function joinInstances(sources: ResolverSources = defaultResolverSources): Promise<JoinInstance[]> {
  const admitting = (await localNodeInfos(sources)).filter(admitsJoins);
  return Promise.all(
    admitting.map(async (info) => joinInstance(info.instance, info.nodeId === clusterArrayId ? clusterSyncPort : await registrySyncPort(sources.registryDirectory, info.nodeId))),
  );
}
