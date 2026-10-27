import { deviceDisplayName } from "../api/deviceText.js";
import { type ConflictFile, type ConflictsPage, type DiscardCounts, type FailedItem, type FailedPage, type FolderItem, type FolderPeer, type ItemsPage, type LocalChangedPage, type NeedItem, type NeedStage, type RemoteNeedPage, defaultItemsPerPage, maxItemsPerPage } from "../api/types.js";
import { type ConflictIndexes, conflictFile, conflictIndexes } from "../conflicts.js";
import { errorTotalOf, needTotalOf } from "../folderLists.js";
import { RequestError, sendJson } from "../http.js";
import { type LocalInstance, type RemoteInstance, type ResolvedInstance, callSyncthing, forwardRead, forwardedListTimeoutMs, resolveInstance } from "../instanceResolver.js";
import type { Route } from "../routes.js";
import { KeyedSharedReads } from "../sharedRead.js";
import { reshownForwardedError, shownSyncthingError } from "../shownSyncthingError.js";
import { type Completion, type IndexItem, type SyncthingClient, type SyncthingDeviceConfig, type SyncthingFolderConfig, listTimeoutMs } from "../syncthing.js";
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

/** The folder's own `.stignore` lines, null when they cannot be read, which the error redaction treats as a file with an `#include`. */
async function ownIgnoreLines(client: SyncthingClient, folderId: string): Promise<string[] | null> {
  try {
    const answer = await client.request<{ ignore?: string[] | null }>("GET", `/db/ignores?folder=${encodeURIComponent(folderId)}`);
    return answer?.ignore ?? [];
  } catch {
    return null;
  }
}

async function localErrors(instance: LocalInstance, folderId: string, request: PageRequest): Promise<FailedPage> {
  return callSyncthing(instance, async (client) => {
    await folderContext(instance, client, folderId);
    const [answer, status, ownLines] = await Promise.all([client.errorsPage(folderId, request.page, request.perPage), client.folderStatus(folderId).catch(() => null), ownIgnoreLines(client, folderId)]);
    const items = (answer.errors ?? []).map((item): FailedItem => ({ path: item.path, error: shownSyncthingError(item.error, ownLines) }));
    return { items, page: request.page, perPage: request.perPage, total: status ? errorTotalOf(status) : null };
  });
}

async function localChanged(instance: LocalInstance, folderId: string, request: PageRequest): Promise<LocalChangedPage> {
  return callSyncthing(instance, async (client) => {
    const { devices } = await folderContext(instance, client, folderId);
    const [answer, status] = await Promise.all([client.localChangedPage(folderId, request.page, request.perPage), client.folderStatus(folderId).catch(() => null)]);
    const items = (answer.files ?? []).map((item) => folderItem(item, devices));
    return { items, page: request.page, perPage: request.perPage, total: typeof status?.receiveOnlyTotalItems === "number" ? status.receiveOnlyTotalItems : null };
  });
}

function deviceOf(devices: SyncthingDeviceConfig[], deviceId: string): FolderPeer {
  return { deviceId, name: deviceDisplayName(devices.find((device) => device.deviceID === deviceId)?.name, deviceId) };
}

/**
 * Why the device's need is not known although the folder is shared with it, or null.
 * @implNote Syncthing counts every item as needed by a device it has no index of the folder from, as one that has not accepted it or has not sent it yet.
 */
function unknownNeedReason(completion: Completion | null, device: FolderPeer, label: string, instance: LocalInstance): string | null {
  if (completion?.remoteState === "notSharing") return `${device.name} does not share ${label} with ${instance.name}`;
  if (completion?.remoteState === "unknown" && !completion.sequence) return `${device.name} has sent no index of ${label} to ${instance.name} (not accepted, or nothing received yet), so what it needs is not known`;
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

function forwardedFailedItem(value: unknown): FailedItem {
  const fields = fieldsOf(value);
  return { path: String(fields.path ?? ""), error: reshownForwardedError(String(fields.error ?? "")) };
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

/**
 * How long a forwarded list may take: the other dashboard waits up to `listTimeoutMs` on each of its Syncthing reads, and a remote need reads the
 * device's completion before its page, one after the other.
 */
export const forwardBudgetsMs = { need: forwardedListTimeoutMs, remoteNeed: 2 * listTimeoutMs + 5_000 } as const;

/** What the node still has to fetch of the folder, one page of it, read from the node's own Syncthing or its host's dashboard. */
export async function needItems(instance: ResolvedInstance, folderId: string, request: PageRequest): Promise<ItemsPage<NeedItem>> {
  if (instance.kind === "local") return localNeed(instance, folderId, request);
  const answer = await forwardRead(instance, listPath(instance, folderId, "need", pageQuery(request)), forwardBudgetsMs.need);
  return forwardedPage(answer, request, forwardedNeedItem);
}

/** The items of the node's folder that Syncthing could not sync, one page of them, with its error text. */
export async function failedItems(instance: ResolvedInstance, folderId: string, request: PageRequest): Promise<FailedPage> {
  if (instance.kind === "local") return localErrors(instance, folderId, request);
  const answer = await forwardRead(instance, listPath(instance, folderId, "errors", pageQuery(request)), forwardBudgetsMs.need);
  return forwardedPage(answer, request, forwardedFailedItem);
}

/** What was changed on the node itself in a receive only folder, one page of it, which a revert would delete or replace. */
export async function localChangedItems(instance: ResolvedInstance, folderId: string, request: PageRequest): Promise<LocalChangedPage> {
  if (instance.kind === "local") return localChanged(instance, folderId, request);
  const answer = await forwardRead(instance, listPath(instance, folderId, "local-changed", pageQuery(request)), forwardBudgetsMs.need);
  return forwardedPage(answer, request, forwardedItem);
}

function countOf(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

/** What a revert or override would discard, read from one folder status just now. */
export async function discardCounts(instance: ResolvedInstance, folderId: string): Promise<DiscardCounts> {
  if (instance.kind === "local") {
    const status = await callSyncthing(instance, (client) => client.folderStatus(folderId));
    return { localChanged: countOf(status.receiveOnlyTotalItems), needTotalItems: countOf(status.needTotalItems) };
  }
  const path = `/api/nodes/${encodeURIComponent(instance.nodeId)}/folders/${encodeURIComponent(folderId)}/discard-counts`;
  const fields = fieldsOf(await forwardRead(instance, path, forwardBudgetsMs.need));
  return { localChanged: countOf(fields.localChanged), needTotalItems: countOf(fields.needTotalItems) };
}

/** What `deviceId` still needs of the node's folder, one page of it; a device the folder is not shared with is refused, naming it. */
export async function remoteNeedItems(instance: ResolvedInstance, folderId: string, deviceId: string, request: PageRequest): Promise<RemoteNeedPage> {
  if (instance.kind === "local") return localRemoteNeed(instance, folderId, deviceId, request);
  const answer = await forwardRead(instance, listPath(instance, folderId, "remote-need", { device: deviceId, ...pageQuery(request) }), forwardBudgetsMs.remoteNeed);
  return { ...forwardedPage(answer, request, forwardedItem), device: forwardedDevice(answer, deviceId) };
}

/** @implNote The list comes from the conflict index in memory; the node's Syncthing is asked only for its folders and device names. */
async function localConflicts(instance: LocalInstance, folderId: string, request: PageRequest, indexes: ConflictIndexes): Promise<ConflictsPage> {
  return callSyncthing(instance, async (client) => {
    const { devices } = await folderContext(instance, client, folderId);
    const listed = indexes.list(instance.nodeId, folderId) ?? { conflicts: [], complete: false, more: false };
    const start = (request.page - 1) * request.perPage;
    const items = listed.conflicts.slice(start, start + request.perPage).map((stored) => conflictFile(stored, devices));
    return { items, page: request.page, perPage: request.perPage, total: listed.complete || listed.conflicts.length ? listed.conflicts.length : null, complete: listed.complete, more: listed.more };
  });
}

function forwardedConflict(value: unknown): ConflictFile {
  const fields = fieldsOf(value);
  return {
    path: String(fields.path ?? ""),
    original: String(fields.original ?? fields.path ?? ""),
    size: typeof fields.size === "number" ? fields.size : 0,
    modified: typeof fields.modified === "string" ? fields.modified : "",
    device: typeof fields.device === "string" ? fields.device : null,
  };
}

/** The conflict copies of the node's folder, one page of them, from this host's index or the node's own host's dashboard. */
export async function conflictItems(instance: ResolvedInstance, folderId: string, request: PageRequest, indexes: ConflictIndexes = conflictIndexes): Promise<ConflictsPage> {
  if (instance.kind === "local") return localConflicts(instance, folderId, request, indexes);
  const answer = await forwardRead(instance, listPath(instance, folderId, "conflicts", pageQuery(request)), forwardBudgetsMs.need);
  return { ...forwardedPage(answer, request, forwardedConflict), complete: fieldsOf(answer).complete === true, more: fieldsOf(answer).more === true };
}

const recentReadMs = 2_000;
const sharedReadsKept = 100;

/**
 * @implNote A page of a folder with 900,000 items takes Syncthing seconds, so a page asked for again while it is read, or just after,
 * shares that read instead of starting another.
 */
const sharedReads = new KeyedSharedReads<unknown>(recentReadMs, sharedReadsKept);

function shared<T>(key: string, read: () => Promise<T>): Promise<T> {
  return sharedReads.read(key, read) as Promise<T>;
}

export interface ItemRouteSources {
  resolve(nodeId: string): Promise<ResolvedInstance>;
  conflicts?: ConflictIndexes;
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
      pattern: /^\/api\/nodes\/([^/]+)\/folders\/([^/]+)\/errors$/,
      handle: async ({ response, url, params: [nodeSegment, folderSegment] }) => {
        const nodeId = decodedSegment(nodeSegment, "node ID");
        const folderId = decodedSegment(folderSegment, "folder ID");
        const request = pageRequestOf(url);
        const instance = await resolveFor(sources, url, nodeId);
        const key = ["errors", nodeId, folderId, request.page, request.perPage].join("\u0000");
        sendJson(response, 200, await shared(key, () => failedItems(instance, folderId, request)));
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/nodes\/([^/]+)\/folders\/([^/]+)\/local-changed$/,
      handle: async ({ response, url, params: [nodeSegment, folderSegment] }) => {
        const nodeId = decodedSegment(nodeSegment, "node ID");
        const folderId = decodedSegment(folderSegment, "folder ID");
        const request = pageRequestOf(url);
        const instance = await resolveFor(sources, url, nodeId);
        const key = ["local-changed", nodeId, folderId, request.page, request.perPage].join("\u0000");
        sendJson(response, 200, await shared(key, () => localChangedItems(instance, folderId, request)));
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/nodes\/([^/]+)\/folders\/([^/]+)\/conflicts$/,
      handle: async ({ response, url, params: [nodeSegment, folderSegment] }) => {
        const instance = await resolveFor(sources, url, decodedSegment(nodeSegment, "node ID"));
        sendJson(response, 200, await conflictItems(instance, decodedSegment(folderSegment, "folder ID"), pageRequestOf(url), sources.conflicts));
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/nodes\/([^/]+)\/folders\/([^/]+)\/discard-counts$/,
      handle: async ({ response, url, params: [nodeSegment, folderSegment] }) => {
        const instance = await resolveFor(sources, url, decodedSegment(nodeSegment, "node ID"));
        sendJson(response, 200, await discardCounts(instance, decodedSegment(folderSegment, "folder ID")));
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
