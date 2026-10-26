import type { JoinEntry, PendingDevice, PendingFolderOffer, RequestsResponse } from "../api/types.js";
import { offersOf } from "../folderIndex.js";
import { sendJson } from "../http.js";
import { localNodeInfos, readDashboard } from "../instanceResolver.js";
import type { JoinRecords, JoinedDevice } from "../join.js";
import type { Route } from "../routes.js";
import { peerDashboards } from "../settings.js";
import { type PendingDevices, type SyncthingClient, SyncthingUnavailable } from "../syncthing.js";

/** A node of this host; `client` is null while its Syncthing cannot be addressed. */
export interface RequestNode {
  nodeId: string;
  name: string;
  present: boolean;
  client: SyncthingClient | null;
}

/** Where the requests are read from; tests hand in fake nodes and peers. */
export interface RequestSources {
  localNodes: () => Promise<RequestNode[]>;
  peerDashboards: string[];
  joins: () => Promise<Record<string, JoinedDevice>>;
}

function emptyRequests(): RequestsResponse {
  return { devices: [], folders: [], joins: [], unreadable: [] };
}

function unreadable(name: string, reason: string): RequestsResponse {
  return { ...emptyRequests(), unreadable: [{ name, reason }] };
}

function notConnected(name: string): RequestsResponse {
  return { ...emptyRequests(), unreadable: [{ name, reason: "not connected", notConnected: true }] };
}

function devicesOf(node: RequestNode, pending: PendingDevices): PendingDevice[] {
  return Object.entries(pending).map(([deviceId, device]) => ({ nodeId: node.nodeId, nodeName: node.name, deviceId, name: device.name, address: device.address, time: device.time }));
}

async function readNode(node: RequestNode): Promise<RequestsResponse> {
  if (!node.present) return notConnected(node.name);
  if (!node.client) return unreadable(node.name, "its Syncthing is not answering");
  try {
    const [devices, folders, configured] = await Promise.all([node.client.pendingDevices(), node.client.pendingFolders(), node.client.devices()]);
    return { ...emptyRequests(), devices: devicesOf(node, devices), folders: offersOf({ nodeId: node.nodeId, nodeName: node.name }, configured, folders) };
  } catch (error) {
    return unreadable(node.name, error instanceof SyncthingUnavailable ? "its Syncthing is not answering" : (error as Error).message);
  }
}

function isRequestsResponse(answer: unknown): answer is RequestsResponse {
  const response = answer as RequestsResponse | null;
  return Array.isArray(response?.devices) && Array.isArray(response?.folders) && Array.isArray(response?.joins);
}

function hostOf(dashboardUrl: string): string | null {
  try {
    return new URL(dashboardUrl).hostname;
  } catch {
    return null;
  }
}

async function readPeer(peer: string): Promise<RequestsResponse> {
  const dashboardUrl = peer.replace(/\/$/, "");
  const host = hostOf(dashboardUrl);
  if (!host) return unreadable(peer, "not a dashboard address in STORAGE_PEERS");
  try {
    const answer = await readDashboard(dashboardUrl, host, "/api/requests");
    return isRequestsResponse(answer) ? { ...answer, unreadable: answer.unreadable ?? [] } : unreadable(host, "its dashboard does not list requests yet");
  } catch (error) {
    return unreadable(host, (error as Error).message.replace(`${host}'s dashboard`, "its dashboard"));
  }
}

function joinEntries(records: Record<string, JoinedDevice>): JoinEntry[] {
  return Object.values(records).map((record) => ({ name: record.name, joinedAt: record.joinedAt, setup: record.setup?.message ?? "admitted" }));
}

async function readJoins(sources: RequestSources): Promise<RequestsResponse> {
  try {
    return { ...emptyRequests(), joins: joinEntries(await sources.joins()) };
  } catch (error) {
    return unreadable("the join records", (error as Error).message);
  }
}

function newestFirst<Entry>(time: (entry: Entry) => string): (left: Entry, right: Entry) => number {
  return (left, right) => (Date.parse(time(right)) || 0) - (Date.parse(time(left)) || 0);
}

/** Everything waiting for an answer on this host's nodes and, unless `scope` is local, on the other hosts'. */
export async function requestsResponse(scope: "all" | "local", sources: RequestSources): Promise<RequestsResponse> {
  const [local, remote, joins] = await Promise.all([
    sources.localNodes().then((nodes) => Promise.all(nodes.map(readNode))),
    scope === "all" ? Promise.all(sources.peerDashboards.map(readPeer)) : Promise.resolve([]),
    readJoins(sources),
  ]);
  const parts = [...local, ...remote, joins];
  return {
    devices: parts.flatMap((part) => part.devices).sort(newestFirst((device) => device.time)),
    folders: parts.flatMap((part): PendingFolderOffer[] => part.folders).sort(newestFirst((offer) => offer.time)),
    joins: parts.flatMap((part) => part.joins).sort(newestFirst((join) => join.joinedAt)),
    unreadable: parts.flatMap((part) => part.unreadable),
  };
}

function liveSources(joinRecords: JoinRecords): RequestSources {
  return {
    localNodes: async () => (await localNodeInfos()).map((info) => ({ nodeId: info.nodeId, name: info.name, present: info.present, client: info.instance?.client ?? null })),
    peerDashboards,
    joins: () => joinRecords.all(),
  };
}

export function pendingRoutes(joinRecords: JoinRecords): Route[] {
  const sources = liveSources(joinRecords);
  return [
    {
      method: "GET",
      pattern: /^\/api\/requests$/,
      handle: async ({ response, url }) => sendJson(response, 200, await requestsResponse(url.searchParams.get("scope") === "local" ? "local" : "all", sources)),
    },
  ];
}
