import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { arrayStatus } from "./arrayStatus.js";
import { listBlockDevices } from "./blockDevices.js";
import { RequestError, readBody, sendJson } from "./http.js";
import { registryEntries, syncthingEndpoint } from "./instances.js";
import { type JoinDependencies, type JoinInstance, JoinError, handleJoin } from "./join.js";
import { createJoinListener, dockerDnsResolver } from "./joinListener.js";
import type { ProxySource } from "./proxyProtocol.js";
import { handleRequest, joinRecords } from "./routes.js";
import { clusterArrayId, joinAllowedUsers, joinGatewayHost, joinPort, joinTag, port, registryDirectory, setupRepoDirectory, tailnetHost } from "./settings.js";
import { readLayout, recordDevice } from "./setupRepo.js";
import { SyncthingClient } from "./syncthing.js";
import { ownLogin, whois } from "./tailnet.js";

async function syncPortOf(nodeId: string): Promise<number | null> {
  try {
    return (JSON.parse(await readFile(`${registryDirectory}/${nodeId}.syncthing.json`, "utf8")) as { syncPort?: number }).syncPort ?? null;
  } catch {
    return null;
  }
}

function instanceFor(name: string, client: SyncthingClient, syncPort: number | null): JoinInstance {
  const addresses = [...(tailnetHost && syncPort ? [`tcp://${tailnetHost}:${syncPort}`] : []), "dynamic"];
  return {
    name,
    addresses,
    myId: () => client.myId(),
    addDevice: (device) => client.addDevice(device),
    shareFolder: (folderId, deviceId) => client.shareFolder(folderId, deviceId),
  };
}

async function joinInstances(): Promise<JoinInstance[]> {
  const instances: JoinInstance[] = [];
  const cluster = await syncthingEndpoint(clusterArrayId);
  const clusterStatus = await arrayStatus(clusterArrayId);
  if (cluster) instances.push(instanceFor(clusterStatus?.name ?? clusterArrayId, new SyncthingClient(cluster), 22000));
  for (const entry of await registryEntries()) {
    if (!entry.present) continue;
    const endpoint = await syncthingEndpoint(entry.id, entry);
    if (endpoint) instances.push(instanceFor(entry.name, new SyncthingClient(endpoint), await syncPortOf(entry.id)));
  }
  return instances;
}

const joinDependencies: JoinDependencies = {
  whois,
  allowedUsers: async () => {
    const owner = await ownLogin().catch(() => null);
    return owner ? [owner, ...joinAllowedUsers] : joinAllowedUsers;
  },
  requiredTag: joinTag,
  instances: joinInstances,
  layout: readLayout,
  records: joinRecords,
  recordInSetup: setupRepoDirectory ? recordDevice : null,
  now: () => new Date(),
};

async function handleJoinRequest(request: IncomingMessage, response: ServerResponse, caller: ProxySource): Promise<void> {
  try {
    const { response: answer, setup } = await handleJoin(joinDependencies, [caller.address], await readBody(request));
    if (setup) console.log(`join: ${setup.message}`);
    sendJson(response, 200, answer);
  } catch (error) {
    if (error instanceof JoinError || error instanceof RequestError) return sendJson(response, error.status, { error: error.message });
    throw error;
  }
}

createServer((request, response) => void handleRequest(request, response)).listen(port, () => console.log(`dashboard listening on ${port}`));

createJoinListener(handleJoinRequest, dockerDnsResolver(joinGatewayHost)).listen(joinPort, () =>
  console.log(`join API listening on ${joinPort}, behind tailscale's PROXY protocol, for ${joinGatewayHost} only`),
);

void listBlockDevices().catch(() => undefined);
