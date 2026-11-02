import type { ConnectionProfile, HostNetwork, NodeAddresses, PeerTable } from "../api/types.js";
import { connectionsRound } from "../applyConnections.js";
import { ProfileError, formatProfile, parseProfile } from "../connectionProfile.js";
import { RequestError, readBody, sendJson } from "../http.js";
import { type JoinRecords, joinedNodeId } from "../join.js";
import { collectPeerTable, localPeerTable } from "../peerSources.js";
import type { NodeConnections } from "../peerTable.js";
import { type AnyRoute, hostWritePattern } from "../routes.js";
import { setupRepoDirectory } from "../settings.js";
import { ProfileConflict, pullDataRepo, readProfile, saveProfile } from "../setupRepo.js";
import type { WhoIs } from "../tailnet.js";

/** @implNote A body that does not survive being written and read back is refused, so only a profile `parseProfile` accepts is ever committed. */
function validProfile(body: unknown): ConnectionProfile {
  try {
    return parseProfile(formatProfile(body as ConnectionProfile));
  } catch (error) {
    throw new RequestError(400, error instanceof ProfileError ? error.message : "the body is not a connection profile");
  }
}

export interface PeerTableReads {
  local: () => Promise<PeerTable>;
  all: () => Promise<PeerTable>;
}

/** @implNote A function, not a constant: `routes.ts` and this module import each other, and a default built at load time is not there yet when `routes.ts` calls `connectionRoutes`. */
function defaultPeerTableReads(): PeerTableReads {
  return { local: () => localPeerTable(), all: async () => connectionsRound.lastTable() ?? collectPeerTable() };
}

export function connectionRoutes(repository = setupRepoDirectory, peerTables = defaultPeerTableReads()): AnyRoute[] {
  return [
    {
      method: "GET",
      pattern: /^\/api\/connections\/addresses$/,
      handle: async ({ response, url }) => sendJson(response, 200, await (url.searchParams.get("scope") === "local" ? peerTables.local() : peerTables.all())),
    },
    {
      method: "GET",
      pattern: /^\/api\/connections\/node\/([^/]+)$/,
      handle: async () => {
        throw new RequestError(404, "a node's connections are answered over the tailnet, to the joined device that owns the node");
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/connections\/profile$/,
      handle: async ({ response }) => sendJson(response, 200, await readProfile(repository)),
    },
    {
      method: "PUT",
      pattern: hostWritePattern(/^\/api\/connections\/profile$/),
      handle: async ({ request, response }) => {
        const profile = validProfile(await readBody(request));
        await saveProfile(profile, "feat(connections): change the connection profile", repository).catch(async (error) => {
          if (error instanceof ProfileConflict) await pullDataRepo(repository);
          throw error;
        });
        sendJson(response, 200, await readProfile(repository));
      },
    },
  ];
}

/** The path the join port answers a joined device's own connections on. */
export const joinedNodePathPattern = /^\/api\/connections\/node\/([^/]+)$/;

/** @implNote The join scripts' default listen port (`STORAGE_JOIN_LISTEN_PORT`); the device's own start step listens on its real one. */
const joinedDeviceSyncPort = 22000;

export interface NodeCallerDependencies {
  /** The join's admission check of the caller's tailnet addresses; throws for a caller it refuses. */
  admit: (addresses: string[]) => Promise<WhoIs>;
  records: JoinRecords;
  /** Null before this host's first round. */
  connectionsOf: (node: NodeAddresses) => NodeConnections | null;
}

function tailnetNetworks(caller: WhoIs): HostNetwork[] {
  return caller.addresses.map((address) => ({ kind: "tailnet", address: address.replace(/\/\d+$/, "") }));
}

/** A joined device's node entry, answered only to that device as tailscale names it; any other caller is told there is no such node. */
export async function joinedNodeConnections(dependencies: NodeCallerDependencies, addresses: string[], nodeId: string): Promise<NodeConnections> {
  const caller = await dependencies.admit(addresses).catch(() => null);
  const owner = caller?.nodeName
    ? Object.values(await dependencies.records.all()).find((device) => device.tailnetName === caller.nodeName && joinedNodeId(device.syncthingDeviceId) === nodeId)
    : undefined;
  if (!caller || !owner) throw new RequestError(404, `no node ${nodeId} of the calling device`);
  const connections = dependencies.connectionsOf({ nodeId, deviceId: owner.syncthingDeviceId, syncPort: joinedDeviceSyncPort, networks: tailnetNetworks(caller) });
  if (!connections) throw new RequestError(503, "this host has not resolved its connections yet; ask again in a minute");
  return connections;
}
