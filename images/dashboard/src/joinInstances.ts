import { readFile } from "node:fs/promises";
import { type LocalInstance, type LocalNodeInfo, type ResolverSources, defaultResolverSources, localNodeInfos } from "./instanceResolver.js";
import { type JoinInstance, JoinError } from "./join.js";
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

/** A joining device is added to the cluster and the folder and drive nodes, never to another array. */
function admitsJoins(info: LocalNodeInfo): info is LocalNodeInfo & { instance: LocalInstance } {
  return info.instance !== null && (info.source !== "array" || info.nodeId === clusterArrayId);
}

/**
 * This host's Syncthing instances a joining device is added to, the cluster first, each with the address it is dialled at.
 * @implNote A cluster that cannot be addressed refuses the whole join before anything is written, so a device is never recorded as joined without it.
 */
export async function joinInstances(sources: ResolverSources = defaultResolverSources): Promise<JoinInstance[]> {
  const infos = await localNodeInfos(sources);
  const cluster = infos.find((info) => info.source === "array" && info.nodeId === clusterArrayId);
  if (!cluster?.present) throw new JoinError(503, `${cluster?.name ?? clusterArrayId} is not connected, so the device cannot join yet`);
  if (!cluster.instance) throw new JoinError(503, `${cluster.name}'s Syncthing is not answering, so the device cannot join yet`);
  const admitting = infos.filter(admitsJoins);
  return Promise.all(
    admitting.map(async (info) => joinInstance(info.instance, info.nodeId === clusterArrayId ? clusterSyncPort : await registrySyncPort(sources.registryDirectory, info.nodeId))),
  );
}
