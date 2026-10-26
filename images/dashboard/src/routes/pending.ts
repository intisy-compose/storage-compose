import { deviceDisplayName, shortDeviceId } from "../api/deviceText.js";
import type { AcceptDeviceBody, AcceptedDevice, JoinEntry, PendingDevice, PendingFolderOffer, RequestsResponse } from "../api/types.js";
import { offersOf } from "../folderIndex.js";
import { RequestError, readBody, sendJson } from "../http.js";
import { type LocalInstance, type ResolvedInstance, callSyncthing, localNodeInfos, readDashboard, requireLocal, resolveInstance } from "../instanceResolver.js";
import { type JoinRecords, type JoinedDevice, conflictingId, isDeviceName } from "../join.js";
import type { AnyRoute, WriteNote } from "../routes.js";
import { peerDashboards, setupRepoDirectory } from "../settings.js";
import { type SetupLayout, type SetupRecordResult, readLayout, recordDevice } from "../setupRepo.js";
import { type PendingDevices, type SyncthingClient, SyncthingError, SyncthingUnavailable } from "../syncthing.js";
import { addDevice, decodedSegment } from "./devices.js";

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

async function readPeer(dashboardUrl: string): Promise<RequestsResponse> {
  const host = hostOf(dashboardUrl);
  if (!host) return unreadable(dashboardUrl, "not a dashboard address in STORAGE_PEERS");
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

/** Where an accepted device is written down beside the node: the setup repo's layout, and the commit that records it. */
export interface SetupRecorder {
  layout(): Promise<SetupLayout | null>;
  record(name: string, deviceId: string, root: string | null): Promise<SetupRecordResult>;
}

/** The offer a device made to the node, read before anything is written; a device that is not asking is 404. */
async function pendingOffer(instance: LocalInstance, deviceId: string): Promise<PendingDevice> {
  const pending = await callSyncthing(instance, (client) => client.pendingDevices());
  const offer = Object.hasOwn(pending, deviceId) ? pending[deviceId] : undefined;
  if (!offer) throw new RequestError(404, `${shortDeviceId(deviceId)} is not asking to connect to ${instance.name}`);
  return { nodeId: instance.nodeId, nodeName: instance.name, deviceId, name: offer.name, address: offer.address, time: offer.time };
}

function offerName(offer: PendingDevice): string {
  return deviceDisplayName(offer.name, offer.deviceId);
}

function acceptBody(body: unknown): AcceptDeviceBody {
  const request = (typeof body === "object" && body !== null ? body : {}) as Partial<AcceptDeviceBody>;
  if (typeof request.name !== "string" || !request.name.trim()) throw new RequestError(400, "the name to accept the device under is missing");
  if (request.recordInSetup !== undefined && typeof request.recordInSetup !== "boolean") throw new RequestError(400, "recordInSetup must be true or false");
  return { name: request.name.trim(), recordInSetup: request.recordInSetup };
}

/** Why the device is not written into the setup repo, or null when it may be. */
async function setupRefusal(instance: LocalInstance, name: string, deviceId: string, setup: SetupRecorder | null, joins: () => Promise<Record<string, JoinedDevice>>): Promise<string | null> {
  const onlyHere = `so it is recorded on ${instance.name} only`;
  if (!setup) return `no setup repo is configured (SETUP_REPO_DIR), ${onlyHere}`;
  if (!isDeviceName(name)) return `"${name}" is not a setup repo device name (a-z, 0-9 and -), ${onlyHere}`;
  const conflict = conflictingId(name, deviceId, await setup.layout(), await joins().catch(() => ({})));
  return conflict ? `${name} is already admitted as device ${shortDeviceId(conflict)}, ${onlyHere}` : null;
}

/**
 * Writes the accepted device into the setup repo, as a join does.
 * @implNote The device is already added, so a setup repo that fails is reported in the answer rather than undoing the accept.
 */
async function recordAccepted(instance: LocalInstance, request: AcceptDeviceBody, deviceId: string, setup: SetupRecorder | null, joins: () => Promise<Record<string, JoinedDevice>>): Promise<string> {
  if (request.recordInSetup === false) return "not recorded in the setup repo, as asked";
  try {
    const refusal = await setupRefusal(instance, request.name, deviceId, setup, joins);
    if (refusal || !setup) return refusal ?? "";
    return (await setup.record(request.name, deviceId, null)).message;
  } catch (error) {
    return `not recorded in the setup repo: ${(error as Error).message}`;
  }
}

export interface DeviceAcceptance {
  accepted: AcceptedDevice;
  note: WriteNote;
}

/** Adds a device that asked to connect, through the same path as a device added by hand, then records it in the setup repo. */
export async function acceptPendingDevice(instance: ResolvedInstance, deviceId: string, body: unknown, setup: SetupRecorder | null, joins: () => Promise<Record<string, JoinedDevice>> = async () => ({})): Promise<DeviceAcceptance> {
  const local = requireLocal(instance);
  const request = acceptBody(body);
  await pendingOffer(local, deviceId);
  const { added } = await addDevice(local, { deviceId, name: request.name });
  const setupText = await recordAccepted(local, request, deviceId, setup, joins);
  const note: WriteNote = { nodeId: local.nodeId, nodeName: local.name, folderId: null, text: `${local.name}: accepted device ${deviceDisplayName(request.name, deviceId)}; ${setupText}` };
  return { accepted: { device: added.device, setup: setupText }, note };
}

type SyncthingConfig = Record<string, unknown>;

/** A number JSON gave us that is not exactly the one Syncthing wrote, as an int64 above 2^53 is not. */
function hasInexactNumber(value: unknown): boolean {
  if (typeof value === "number") return Number.isInteger(value) && !Number.isSafeInteger(value);
  if (Array.isArray(value)) return value.some(hasInexactNumber);
  return typeof value === "object" && value !== null && Object.values(value).some(hasInexactNumber);
}

async function readWholeConfig(instance: LocalInstance): Promise<SyncthingConfig> {
  const config = await callSyncthing(instance, (client) => client.request<SyncthingConfig>("GET", "/config"));
  if (hasInexactNumber(config)) throw new SyncthingError(`${instance.name}'s configuration holds a number too large to hand back unchanged; nothing was written`);
  return config;
}

function ignoredDevices(config: SyncthingConfig): Record<string, unknown>[] {
  return Array.isArray(config.remoteIgnoredDevices) ? (config.remoteIgnoredDevices as Record<string, unknown>[]) : [];
}

function withIgnored(config: SyncthingConfig, offer: PendingDevice, now: Date): SyncthingConfig {
  const entry = { time: now.toISOString(), deviceID: offer.deviceId, name: offer.name, address: offer.address };
  return { ...config, remoteIgnoredDevices: [...ignoredDevices(config), entry] };
}

const ignoreAttempts = 2;

/**
 * Appends the device to the node's ignored devices, the one write here that replaces Syncthing's whole configuration.
 * @implNote Syncthing has no endpoint for ignored devices and its PUT has no version check, so the config is read
 * again just before the PUT: a change in between (Syncthing or another browser) starts once more from the changed config.
 */
async function writeIgnored(instance: LocalInstance, offer: PendingDevice, now: Date): Promise<void> {
  for (let attempt = 0; attempt < ignoreAttempts; attempt++) {
    const config = await readWholeConfig(instance);
    if (ignoredDevices(config).some((device) => device.deviceID === offer.deviceId)) return;
    const updated = withIgnored(config, offer, now);
    if (JSON.stringify(await readWholeConfig(instance)) !== JSON.stringify(config)) continue;
    await callSyncthing(instance, (client) => client.request("PUT", "/config", updated));
    return;
  }
  throw new RequestError(409, `${instance.name}'s configuration changed twice while ${offerName(offer)} was being ignored; nothing was written, try again`);
}

export interface DeviceIgnore {
  ignored: PendingDevice;
  note: WriteNote;
}

/** Ignores a device that asked to connect, as Syncthing's own Ignore does: it is not offered again. */
export async function ignorePendingDevice(instance: ResolvedInstance, deviceId: string, now: () => Date = () => new Date()): Promise<DeviceIgnore> {
  const local = requireLocal(instance);
  const offer = await pendingOffer(local, deviceId);
  await writeIgnored(local, offer, now());
  return { ignored: offer, note: { nodeId: local.nodeId, nodeName: local.name, folderId: null, text: `${local.name}: ignored device ${offerName(offer)} asking to connect` } };
}

export interface DeviceDismissal {
  dismissed: PendingDevice;
  note: WriteNote;
}

/** Drops the offer only; the device is listed again the next time it asks. */
export async function dismissPendingDevice(instance: ResolvedInstance, deviceId: string): Promise<DeviceDismissal> {
  const local = requireLocal(instance);
  const offer = await pendingOffer(local, deviceId);
  await callSyncthing(local, (client) => client.request("DELETE", `/cluster/pending/devices?device=${encodeURIComponent(deviceId)}`));
  return { dismissed: offer, note: { nodeId: local.nodeId, nodeName: local.name, folderId: null, text: `${local.name}: dismissed device ${offerName(offer)} asking to connect` } };
}

/** How the answers reach a node and the setup repo; tests hand in a fake node and recorder. */
export interface PendingWriteSources {
  resolve(nodeId: string): Promise<ResolvedInstance>;
  setup: SetupRecorder | null;
}

const liveWriteSources: PendingWriteSources = {
  resolve: (nodeId) => resolveInstance(nodeId),
  setup: setupRepoDirectory ? { layout: readLayout, record: recordDevice } : null,
};

export function pendingRoutes(joinRecords: JoinRecords, writeSources: PendingWriteSources = liveWriteSources): AnyRoute[] {
  const sources = liveSources(joinRecords);
  const target = async (nodeId: string, deviceId: string) => ({ instance: await writeSources.resolve(decodedSegment(nodeId, "node ID")), deviceId: decodedSegment(deviceId, "device ID") });
  const pendingDevicePattern = (answer: string) => new RegExp(`^\\/api\\/nodes\\/([^/]+)\\/pending\\/devices\\/([^/]+)\\/${answer}$`);
  return [
    {
      method: "GET",
      pattern: /^\/api\/requests$/,
      handle: async ({ response, url }) => sendJson(response, 200, await requestsResponse(url.searchParams.get("scope") === "local" ? "local" : "all", sources)),
    },
    {
      method: "POST",
      pattern: pendingDevicePattern("accept"),
      write: async ({ request, response, params: [nodeId, deviceSegment] }) => {
        const { instance, deviceId } = await target(nodeId, deviceSegment);
        const acceptance = await acceptPendingDevice(instance, deviceId, await readBody(request), writeSources.setup, () => joinRecords.all());
        sendJson(response, 201, acceptance.accepted);
        return acceptance.note;
      },
    },
    {
      method: "POST",
      pattern: pendingDevicePattern("ignore"),
      write: async ({ response, params: [nodeId, deviceSegment] }) => {
        const { instance, deviceId } = await target(nodeId, deviceSegment);
        const ignore = await ignorePendingDevice(instance, deviceId);
        sendJson(response, 200, ignore.ignored);
        return ignore.note;
      },
    },
    {
      method: "POST",
      pattern: pendingDevicePattern("dismiss"),
      write: async ({ response, params: [nodeId, deviceSegment] }) => {
        const { instance, deviceId } = await target(nodeId, deviceSegment);
        const dismissal = await dismissPendingDevice(instance, deviceId);
        sendJson(response, 200, dismissal.dismissed);
        return dismissal.note;
      },
    },
  ];
}
