import { deviceDisplayName } from "../api/deviceText.js";
import { type FolderItem, type FolderPeer, type ItemsPage, type NeedItem, type NeedStage, type RemoteNeedPage, defaultItemsPerPage, maxItemsPerPage } from "../api/types.js";
import { needTotalOf } from "../folderLists.js";
import { RequestError, sendJson } from "../http.js";
import { type LocalInstance, type RemoteInstance, type ResolvedInstance, callSyncthing, forwardRead, forwardedListTimeoutMs, resolveInstance } from "../instanceResolver.js";
import type { Route } from "../routes.js";
import { SharedRead } from "../sharedRead.js";
import type { Completion, IndexItem, SyncthingClient, SyncthingDeviceConfig, SyncthingFolderConfig } from "../syncthing.js";
import { decodedSegment } from "./devices.js";

export interface PageRequest {
  page: number;
  perPage: number;
}

function wholeNumberParam(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new RequestError(400, `${name} must be a whole number of 1 or more, not ${raw}`);
  return value;
}

/** The page asked for; a page size above `maxItemsPerPage` is cut to it. */
export function pageRequestOf(url: URL): PageRequest {
  return { page: wholeNumberParam(url, "page", 1), perPage: Math.min(wholeNumberParam(url, "perPage", defaultItemsPerPage), maxItemsPerPage) };
}

/** @implNote Syncthing names the last changer by the first group of its device ID only. */
function changerName(shortId: string | undefined, devices: SyncthingDeviceConfig[]): string | null {
  if (!shortId) return null;
  const device = devices.find((candidate) => candidate.deviceID.startsWith(shortId));
  return device ? deviceDisplayName(device.name, device.deviceID) : shortId;
}

function folderItem(item: IndexItem, devices: SyncthingDeviceConfig[]): FolderItem {
  return { name: item.name, size: item.size ?? 0, modified: item.modified ?? "", deleted: item.deleted ?? false, modifiedBy: changerName(item.modifiedBy, devices) };
}

interface FolderContext {
  client: SyncthingClient;
  folder: SyncthingFolderConfig;
  devices: SyncthingDeviceConfig[];
}

async function folderContext(instance: LocalInstance, client: SyncthingClient, folderId: string): Promise<FolderContext> {
  const [folders, devices] = await Promise.all([client.folders(), client.devices()]);
  const folder = folders.find((candidate) => candidate.id === folderId);
  if (!folder) throw new RequestError(404, `${instance.name} has no folder ${folderId}`);
  return { client, folder, devices };
}

async function localNeed(instance: LocalInstance, folderId: string, request: PageRequest): Promise<ItemsPage<NeedItem>> {
  return callSyncthing(instance, async (client) => {
    const { devices } = await folderContext(instance, client, folderId);
    const [answer, status] = await Promise.all([client.needPage(folderId, request.page, request.perPage), client.folderStatus(folderId).catch(() => null)]);
    const stages: [NeedStage, IndexItem[] | null][] = [
      ["progress", answer.progress],
      ["queued", answer.queued],
      ["rest", answer.rest],
    ];
    const items = stages.flatMap(([stage, listed]) => (listed ?? []).map((item): NeedItem => ({ ...folderItem(item, devices), stage })));
    return { items, page: request.page, perPage: request.perPage, total: status ? needTotalOf(status) : null };
  });
}

function deviceOf(devices: SyncthingDeviceConfig[], deviceId: string): FolderPeer {
  return { deviceId, name: deviceDisplayName(devices.find((device) => device.deviceID === deviceId)?.name, deviceId) };
}

/**
 * Why the device's need is not known although the folder is shared with it, or null.
 * @implNote Syncthing counts every item as needed by a device that never sent its index of the folder, as one that has not accepted it.
 */
function unknownNeedReason(completion: Completion | null, device: FolderPeer, label: string, instance: LocalInstance): string | null {
  if (completion?.remoteState === "notSharing") return `${device.name} does not share ${label} with ${instance.name}`;
  if (completion?.remoteState === "unknown" && !completion.sequence) return `${device.name} has not accepted ${label} from ${instance.name}, so what it needs is not known`;
  return null;
}

async function localRemoteNeed(instance: LocalInstance, folderId: string, deviceId: string, request: PageRequest): Promise<RemoteNeedPage> {
  return callSyncthing(instance, async (client) => {
    const { folder, devices } = await folderContext(instance, client, folderId);
    const device = deviceOf(devices, deviceId);
    const label = folder.label || folder.id;
    if (!folder.devices.some((entry) => entry.deviceID === deviceId)) throw new RequestError(409, `${label} is not shared with ${device.name} on ${instance.name}`);
    const completion = await client.folderCompletion(folderId, deviceId).catch(() => null);
    const reason = unknownNeedReason(completion, device, label, instance);
    if (reason) throw new RequestError(409, reason);
    const answer = await client.remoteNeedPage(folderId, deviceId, request.page, request.perPage);
    const items = (answer.files ?? []).map((item) => folderItem(item, devices));
    return { items, page: request.page, perPage: request.perPage, total: typeof completion?.needItems === "number" ? completion.needItems : null, device };
  });
}

type Fields = Record<string, unknown>;

function fieldsOf(value: unknown): Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Fields) : {};
}

const needStages: readonly NeedStage[] = ["progress", "queued", "rest"];

function forwardedItem(value: unknown): FolderItem {
  const fields = fieldsOf(value);
  return {
    name: String(fields.name ?? ""),
    size: typeof fields.size === "number" ? fields.size : 0,
    modified: typeof fields.modified === "string" ? fields.modified : "",
    deleted: fields.deleted === true,
    modifiedBy: typeof fields.modifiedBy === "string" ? fields.modifiedBy : null,
  };
}

function forwardedNeedItem(value: unknown): NeedItem {
  const stage = fieldsOf(value).stage;
  return { ...forwardedItem(value), stage: needStages.includes(stage as NeedStage) ? (stage as NeedStage) : "rest" };
}

/** Another dashboard's page, rebuilt field by field, as an older or newer one may send more. */
function forwardedPage<T>(answer: unknown, request: PageRequest, item: (value: unknown) => T): ItemsPage<T> {
  const fields = fieldsOf(answer);
  return {
    items: Array.isArray(fields.items) ? fields.items.map(item) : [],
    page: typeof fields.page === "number" ? fields.page : request.page,
    perPage: typeof fields.perPage === "number" ? fields.perPage : request.perPage,
    total: typeof fields.total === "number" ? fields.total : null,
  };
}

function forwardedDevice(answer: unknown, deviceId: string): FolderPeer {
  const device = fieldsOf(fieldsOf(answer).device);
  return { deviceId, name: typeof device.name === "string" ? device.name : deviceDisplayName(null, deviceId) };
}

function listPath(instance: RemoteInstance, folderId: string, list: string, query: Record<string, string>): string {
  return `/api/nodes/${encodeURIComponent(instance.nodeId)}/folders/${encodeURIComponent(folderId)}/${list}?${new URLSearchParams(query).toString()}`;
}

function pageQuery(request: PageRequest): Record<string, string> {
  return { page: String(request.page), perPage: String(request.perPage) };
}

/** What the node still has to fetch of the folder, one page of it, read from the node's own Syncthing or its host's dashboard. */
export async function needItems(instance: ResolvedInstance, folderId: string, request: PageRequest): Promise<ItemsPage<NeedItem>> {
  if (instance.kind === "local") return localNeed(instance, folderId, request);
  const answer = await forwardRead(instance, listPath(instance, folderId, "need", pageQuery(request)), forwardedListTimeoutMs);
  return forwardedPage(answer, request, forwardedNeedItem);
}

/** What `deviceId` still needs of the node's folder, one page of it; a device the folder is not shared with is refused, naming it. */
export async function remoteNeedItems(instance: ResolvedInstance, folderId: string, deviceId: string, request: PageRequest): Promise<RemoteNeedPage> {
  if (instance.kind === "local") return localRemoteNeed(instance, folderId, deviceId, request);
  const answer = await forwardRead(instance, listPath(instance, folderId, "remote-need", { device: deviceId, ...pageQuery(request) }), forwardedListTimeoutMs);
  return { ...forwardedPage(answer, request, forwardedItem), device: forwardedDevice(answer, deviceId) };
}

const recentReadMs = 2_000;
const sharedReadsKept = 100;

/**
 * @implNote A page of a folder with 900,000 items takes Syncthing seconds, so a page asked for again while it is read, or just after,
 * shares that read instead of starting another.
 */
const sharedReads = new Map<string, SharedRead<unknown>>();

function shared<T>(key: string, read: () => Promise<T>): Promise<T> {
  let entry = sharedReads.get(key);
  if (!entry) {
    entry = new SharedRead<unknown>(recentReadMs);
    sharedReads.set(key, entry);
    if (sharedReads.size > sharedReadsKept) sharedReads.delete(sharedReads.keys().next().value!);
  }
  return entry.read(read) as Promise<T>;
}

export interface ItemRouteSources {
  resolve(nodeId: string): Promise<ResolvedInstance>;
}

const liveSources: ItemRouteSources = { resolve: (nodeId) => resolveInstance(nodeId) };

/** A request another host forwarded names one of this host's nodes; forwarding it on could send it back and forth. */
async function resolveFor(sources: ItemRouteSources, url: URL, nodeId: string): Promise<ResolvedInstance> {
  const instance = await sources.resolve(nodeId);
  if (instance.kind === "remote" && url.searchParams.get("scope") === "local") throw new RequestError(404, `no node ${nodeId} on this host`);
  return instance;
}

export function itemRoutes(sources: ItemRouteSources = liveSources): Route[] {
  return [
    {
      method: "GET",
      pattern: /^\/api\/nodes\/([^/]+)\/folders\/([^/]+)\/need$/,
      handle: async ({ response, url, params: [nodeSegment, folderSegment] }) => {
        const nodeId = decodedSegment(nodeSegment, "node ID");
        const folderId = decodedSegment(folderSegment, "folder ID");
        const request = pageRequestOf(url);
        const instance = await resolveFor(sources, url, nodeId);
        const key = ["need", nodeId, folderId, request.page, request.perPage].join("\u0000");
        sendJson(response, 200, await shared(key, () => needItems(instance, folderId, request)));
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/nodes\/([^/]+)\/folders\/([^/]+)\/remote-need$/,
      handle: async ({ response, url, params: [nodeSegment, folderSegment] }) => {
        const nodeId = decodedSegment(nodeSegment, "node ID");
        const folderId = decodedSegment(folderSegment, "folder ID");
        const deviceId = url.searchParams.get("device")?.trim();
        if (!deviceId) throw new RequestError(400, "name the device with ?device=");
        const request = pageRequestOf(url);
        const instance = await resolveFor(sources, url, nodeId);
        const key = ["remote-need", nodeId, folderId, deviceId, request.page, request.perPage].join("\u0000");
        sendJson(response, 200, await shared(key, () => remoteNeedItems(instance, folderId, deviceId, request)));
      },
    },
  ];
}
