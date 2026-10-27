export type {
  AcceptDeviceBody,
  AcceptFolderBody,
  AcceptFolderDefaults,
  AcceptedDevice,
  ActivityEntry,
  ActivityLevel,
  ActivityResponse,
  ActivitySource,
  AddedDevice,
  ArrayAction,
  ArrayActionBody,
  ArrayMember,
  ArrayState,
  ConnectionKind,
  DebugChange,
  DebugFacilities,
  DebugFacility,
  DeviceCompression,
  DeviceIdCheck,
  DeviceSettings,
  DeviceSettingsChange,
  DeviceSource,
  DeviceSummary,
  DevicesResponse,
  DriveAttachment,
  DriveCandidate,
  DriveRecord,
  DriveRecordKind,
  DiskFreeUnit,
  DriveSummary,
  EntryStatus,
  ErrorAnswer,
  FailedItem,
  FailedPage,
  FolderCopy,
  FolderDetailResponse,
  FolderFile,
  FolderIgnores,
  FolderItem,
  FolderPathCheck,
  FolderPeer,
  FolderRescan,
  FolderSettings,
  FolderEditBody,
  FolderSettingsChange,
  FolderShare,
  FolderSharingChange,
  FolderSummary,
  FoldersResponse,
  FolderType,
  HostSettings,
  IgnoredDevice,
  IgnoredFolderOffer,
  IgnoresChange,
  InstanceConnection,
  InstanceGui,
  InstanceOptions,
  ItemsPage,
  DiscardCounts,
  LocalChangedPage,
  ConflictFile,
  ConflictsPage,
  LocalChangesBody,
  LocalChangesDone,
  JoinEntry,
  MemberSmart,
  NearbyDevice,
  NeedItem,
  NeedStage,
  NewDevice,
  NewFolder,
  NewFolderDefaults,
  NodeArray,
  NodeEntryState,
  NodeFolder,
  NodeKind,
  NodeOptionsResponse,
  NodesResponse,
  NodeSync,
  Parity,
  ParityJob,
  PendingDevice,
  PendingFolderOffer,
  PresenceWindow,
  PriorityBand,
  PriorityInfo,
  PullOrder,
  Peer,
  RemoteState,
  RemoteNeedPage,
  RemoveDeviceBody,
  RemoveFolderBody,
  RemovedFolder,
  RequestsResponse,
  RescanBody,
  Space,
  StorageNode,
  SyncState,
  SyncthingDevice,
  SyncthingInstance,
  SyncthingListener,
  TreeEntry,
  TreeListing,
  FileVersion,
  RestoredVersions,
  RestoreVersionsBody,
  Versioning,
  VersioningType,
  VersionsDirectory,
  VersionsPage,
  Warning,
  WarningKind,
  WarningLevel,
  LogLevel,
  LogMessage,
  NodeError,
  NodeErrors,
  NodeLog,
} from "../../src/api/types.js";
import type { LocalChangesAction } from "../../src/api/localChangesText.js";
import { requestRefresh } from "./renderRequest.js";
import type { AcceptDeviceBody, AcceptFolderBody, AcceptFolderDefaults, AcceptedDevice, ActivityResponse, DebugChange, DebugFacilities, NodeErrors, NodeLog, AddedDevice, ArrayAction, ArrayActionBody, ConflictsPage, DeviceIdCheck, DeviceSettings, DeviceSettingsChange, DevicesResponse, ErrorAnswer, FailedPage, NearbyDevice, NewDevice, NewFolder, NewFolderDefaults, FolderDetailResponse, FolderIgnores, FolderPathCheck, IgnoresChange, FolderEditBody, FolderSettings, FolderRescan, DiscardCounts, LocalChangedPage, LocalChangesBody, LocalChangesDone, RemoveDeviceBody, RemoveFolderBody, RemovedFolder, RescanBody, HostSettings, IgnoredDevice, IgnoredFolderOffer, ItemsPage, NeedItem, NodeOptionsResponse, NodesResponse, PendingDevice, PendingFolderOffer, RemoteNeedPage, RequestsResponse, RestoredVersions, RestoreVersionsBody, TreeListing, VersionsPage } from "../../src/api/types.js";
import { type ActivityFilters, activityRequestQuery, defaultActivityFilters, folderChangesShown } from "../../src/api/activityFilters.js";
import { changesActivityType } from "../../src/api/types.js";

export { defaultItemsPerPage, diskFreeUnits, editableFolderTypes, folderSettingLabels, folderShare, folderTypeTexts, maxItemsPerPage, pullOrderTexts, removalConfirmations, topDirectoryDefault } from "../../src/api/types.js";

export { addressLabel, connectionKindText, deviceDisplayName, deviceStateText, driveLastSeenHereText, driveWhereText, deviceSettingLabels, isNodePaused, isReachable, reachTone, seenTimeText, shareFoldersLabel, shortDeviceId } from "../../src/api/deviceText.js";
export { changedFields } from "../../src/syncthingConfig.js";
export { ignoreLinesOf, ignoreLinesProblem } from "../../src/api/ignorePatterns.js";
export { type VersioningParam, cleanupIntervalLabel, externalVersioningRefusal, isKeptBySyncthing, offeredVersioningTypes, restoreConsequences, secondsPerDay, versioningParamKeys, versioningParamLabels, versioningTypeTexts, versioningWords, versionsPathLabel, versionsReadLongestSeconds } from "../../src/api/versioningText.js";
export { type StatusPresentation, type StatusTone, priorityBadgeText, statusPresentation } from "../../src/api/explorerText.js";
export { type LocalChangesAction, discardedCount, localChangesFolderType, overrideLossText, revertLossText } from "../../src/api/localChangesText.js";

export interface ActionResult {
  ok: boolean;
  message: string;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `${path} answered ${response.status}`);
  }
  return (await response.json()) as T;
}

export function fetchNodes(): Promise<NodesResponse> {
  return getJson("api/nodes");
}

export function fetchDevices(): Promise<DevicesResponse> {
  return getJson("api/devices");
}

export function fetchRequests(): Promise<RequestsResponse> {
  return getJson("api/requests");
}

export function fetchHostSettings(): Promise<HostSettings> {
  return getJson("api/settings");
}

export function fetchNodeOptions(nodeId: string): Promise<NodeOptionsResponse> {
  return getJson(`api/nodes/${encodeURIComponent(nodeId)}/options`);
}

function devicePath(nodeId: string, deviceId: string): string {
  return `api/nodes/${encodeURIComponent(nodeId)}/devices/${encodeURIComponent(deviceId)}`;
}

export function fetchDeviceSettings(nodeId: string, deviceId: string): Promise<DeviceSettings> {
  return getJson(devicePath(nodeId, deviceId));
}

/** `maybeSaved`: the node stopped answering during the write, so it may have taken effect. */
export type SaveResult<T> = { ok: true; value: T } | { ok: false; message: string; maybeSaved: boolean };

let savedWrites = 0;

function noteSavedWrite(): void {
  savedWrites += 1;
  requestRefresh();
}

/** How many writes have been saved; a read that started before one was saved may not show it. */
export function savedWriteCount(): number {
  return savedWrites;
}

/** A write to the dashboard: its answer, or the refusal's reason. */
async function sendWrite<T>(path: string, method: string, body?: unknown): Promise<SaveResult<T>> {
  try {
    const response = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const payload = (await response.json().catch(() => ({}))) as T & Partial<ErrorAnswer>;
    const maybeSaved = payload.maybeSaved === true;
    if (response.ok || maybeSaved) noteSavedWrite();
    return response.ok ? { ok: true, value: payload } : { ok: false, message: payload.error ?? `HTTP ${response.status}`, maybeSaved };
  } catch {
    return { ok: false, message: "The dashboard is not answering.", maybeSaved: false };
  }
}

/** Sends only `change`; the node's answer is the device as it now stands. */
export function saveDeviceSettings(nodeId: string, deviceId: string, change: DeviceSettingsChange): Promise<SaveResult<DeviceSettings>> {
  return sendWrite(devicePath(nodeId, deviceId), "PATCH", change);
}

export function pauseDevice(nodeId: string, deviceId: string, paused: boolean): Promise<SaveResult<DeviceSettings>> {
  return sendWrite(`${devicePath(nodeId, deviceId)}/${paused ? "pause" : "resume"}`, "POST");
}

/** `confirm` is the device's name as the dashboard shows it. */
export function removeDevice(nodeId: string, deviceId: string, confirm: string): Promise<SaveResult<DeviceSettings>> {
  const body: RemoveDeviceBody = { confirm };
  return sendWrite(devicePath(nodeId, deviceId), "DELETE", body);
}

function nodeApiPath(nodeId: string, rest: string): string {
  return `api/nodes/${encodeURIComponent(nodeId)}/${rest}`;
}

/** A new device's settings as the node's Syncthing fills them in. */
export function fetchDeviceDefaults(nodeId: string): Promise<DeviceSettings> {
  return getJson(nodeApiPath(nodeId, "device-defaults"));
}

export function fetchNearbyDevices(nodeId: string): Promise<NearbyDevice[]> {
  return getJson(nodeApiPath(nodeId, "nearby"));
}

export function checkDeviceId(nodeId: string, typed: string): Promise<DeviceIdCheck> {
  return getJson(`${nodeApiPath(nodeId, "device-id-check")}?id=${encodeURIComponent(typed)}`);
}

/** The node's Syncthing's QR code of `text`, as an image address. */
export function qrCodeUrl(nodeId: string, text: string): string {
  return `${nodeApiPath(nodeId, "qr")}?text=${encodeURIComponent(text)}`;
}

/** Sends the new device's ID and only the settings that differ from the node's defaults. */
export function addDevice(nodeId: string, device: NewDevice): Promise<SaveResult<AddedDevice>> {
  return sendWrite(nodeApiPath(nodeId, "devices"), "POST", device);
}

/** Pauses or resumes every device of the node; the answer is each of them, the node's own left out, as it now stands. */
export function pauseNode(nodeId: string, paused: boolean): Promise<SaveResult<DeviceSettings[]>> {
  return sendWrite(nodeApiPath(nodeId, paused ? "pause" : "resume"), "POST");
}

function pendingDevicePath(nodeId: string, deviceId: string, answer: "accept" | "ignore" | "dismiss"): string {
  return nodeApiPath(nodeId, `pending/devices/${encodeURIComponent(deviceId)}/${answer}`);
}

/** Adds the asking device under `name`; the answer is the device as the node now has it and what became of it in the setup repo. */
export function acceptPendingDevice(nodeId: string, deviceId: string, body: AcceptDeviceBody): Promise<SaveResult<AcceptedDevice>> {
  return sendWrite(pendingDevicePath(nodeId, deviceId, "accept"), "POST", body);
}

/** The device is not offered again, as Syncthing's own Ignore. */
export function ignorePendingDevice(nodeId: string, deviceId: string): Promise<SaveResult<IgnoredDevice>> {
  return sendWrite(pendingDevicePath(nodeId, deviceId, "ignore"), "POST");
}

/** Drops the request; the device is listed again when it next asks. */
export function dismissPendingDevice(nodeId: string, deviceId: string): Promise<SaveResult<PendingDevice>> {
  return sendWrite(pendingDevicePath(nodeId, deviceId, "dismiss"), "POST");
}

function pendingFolderPath(offer: Pick<PendingFolderOffer, "nodeId" | "folderId">, answer: "defaults" | "accept" | "ignore" | "dismiss"): string {
  return nodeApiPath(offer.nodeId, `pending/folders/${encodeURIComponent(offer.folderId)}/${answer}`);
}

/** What the accept form opens with for one device's offer. */
export function fetchAcceptFolderDefaults(offer: PendingFolderOffer): Promise<AcceptFolderDefaults> {
  return getJson(`${pendingFolderPath(offer, "defaults")}?offeredBy=${encodeURIComponent(offer.offeredBy)}`);
}

/** Adds the offered folder, shared with the offering device; the answer is the folder as the node now has it. */
export function acceptPendingFolder(offer: PendingFolderOffer, body: AcceptFolderBody): Promise<SaveResult<FolderSettings>> {
  return sendWrite(pendingFolderPath(offer, "accept"), "POST", body);
}

/** The device's offers of the folder are not listed again, as Syncthing's own Ignore; `confirm` is the folder ID typed on an array. */
export function ignorePendingFolder(offer: PendingFolderOffer, confirm: string | null = null): Promise<SaveResult<IgnoredFolderOffer>> {
  return sendWrite(pendingFolderPath(offer, "ignore"), "POST", { offeredBy: offer.offeredBy, ...(confirm === null ? {} : { confirm }) });
}

/** Drops the offer; it is listed again when the device next offers the folder. */
export function dismissPendingFolder(offer: PendingFolderOffer): Promise<SaveResult<PendingFolderOffer>> {
  return sendWrite(pendingFolderPath(offer, "dismiss"), "POST", { offeredBy: offer.offeredBy });
}

/** A new folder as the node's Syncthing would make it, placed at the explorer's directory `under`. */
export function fetchFolderDefaults(nodeId: string, under: string): Promise<NewFolderDefaults> {
  return getJson(`${nodeApiPath(nodeId, "folder-defaults")}?under=${encodeURIComponent(under)}`);
}

/** The directories the node's Syncthing completes `current` to, inside the node's root only. */
export function browseFolderPaths(nodeId: string, current: string): Promise<string[]> {
  return getJson(`${nodeApiPath(nodeId, "browse")}?current=${encodeURIComponent(current)}`);
}

/** How the node would judge `path` for a new folder, or for the edit of `editedFolderId` (that also changes its versioning when `editsVersioning`). */
export function checkFolderPath(nodeId: string, path: string, editedFolderId: string | null = null, editsVersioning = false): Promise<FolderPathCheck> {
  const query = new URLSearchParams({ path, ...(editedFolderId === null ? {} : { folder: editedFolderId }), ...(editsVersioning ? { versioning: "changed" } : {}) });
  return getJson(`${nodeApiPath(nodeId, "folder-path-check")}?${query.toString()}`);
}

/** Sends the new folder's ID, path and only the settings that differ from the node's defaults. */
export function addFolder(nodeId: string, folder: NewFolder): Promise<SaveResult<FolderSettings>> {
  return sendWrite(nodeApiPath(nodeId, "folders"), "POST", folder);
}

/** Sends only `change`; the node's answer is the folder as it now stands. */
export function saveFolderSettings(nodeId: string, folderId: string, change: FolderEditBody): Promise<SaveResult<FolderSettings>> {
  return sendWrite(nodeApiPath(nodeId, `folders/${encodeURIComponent(folderId)}`), "PATCH", change);
}

function ignoresPath(nodeId: string, folderId: string): string {
  return nodeApiPath(nodeId, `folders/${encodeURIComponent(folderId)}/ignores`);
}

export function fetchFolderIgnores(nodeId: string, folderId: string): Promise<FolderIgnores> {
  return getJson(ignoresPath(nodeId, folderId));
}

/** Replaces the folder's patterns with `lines`, refused when the node's file is no longer `opened`; the answer is the file as it now stands. */
export function saveFolderIgnores(nodeId: string, folderId: string, lines: string[], opened: string[]): Promise<SaveResult<FolderIgnores>> {
  const change: IgnoresChange = { lines, opened };
  return sendWrite(ignoresPath(nodeId, folderId), "PUT", change);
}

function folderApiPath(nodeId: string, folderId: string, rest = ""): string {
  return nodeApiPath(nodeId, `folders/${encodeURIComponent(folderId)}${rest}`);
}

/** Sends only the folder's pause; the answer is the folder as it now stands. */
export function pauseFolder(nodeId: string, folderId: string, paused: boolean): Promise<SaveResult<FolderSettings>> {
  return sendWrite(folderApiPath(nodeId, folderId, paused ? "/pause" : "/resume"), "POST");
}

/** Rescans the whole folder, or only `sub` below its path when it is not empty. */
export function rescanFolder(nodeId: string, folderId: string, sub: string): Promise<SaveResult<FolderRescan>> {
  const body: RescanBody = sub.trim() ? { sub: sub.trim() } : {};
  return sendWrite(folderApiPath(nodeId, folderId, "/rescan"), "POST", body);
}

export function rescanAllFolders(nodeId: string): Promise<SaveResult<FolderRescan>> {
  return sendWrite(nodeApiPath(nodeId, "rescan-all"), "POST");
}

/** Removes the folder from the node's Syncthing only, its files stay on disk; `confirm` is the folder's label or ID, typed. */
export function removeFolder(nodeId: string, folderId: string, confirm: string): Promise<SaveResult<RemovedFolder>> {
  const body: RemoveFolderBody = { confirm };
  return sendWrite(folderApiPath(nodeId, folderId), "DELETE", body);
}

/** Reverts a receive only folder's local changes, or overrides what other devices changed in a send only one; `confirm` is the folder ID, typed. */
export function discardChanges(nodeId: string, folderId: string, action: LocalChangesAction, confirm: string): Promise<SaveResult<LocalChangesDone>> {
  const body: LocalChangesBody = { confirm };
  return sendWrite(folderApiPath(nodeId, folderId, `/${action}`), "POST", body);
}

export function fetchFolderDetail(folderId: string): Promise<FolderDetailResponse> {
  return getJson(`api/folders/${encodeURIComponent(folderId)}`);
}

/** A read that tells a refusal (`status` 4xx, such as a folder not shared with the device) from a failure. */
export type ReadResult<T> = { ok: true; value: T } | { ok: false; status: number; message: string };

async function readJson<T>(path: string): Promise<ReadResult<T>> {
  try {
    const response = await fetch(path, { cache: "no-store" });
    const payload = (await response.json().catch(() => ({}))) as T & Partial<ErrorAnswer>;
    return response.ok ? { ok: true, value: payload } : { ok: false, status: response.status, message: payload.error ?? `HTTP ${response.status}` };
  } catch {
    return { ok: false, status: 0, message: "The dashboard is not answering." };
  }
}

function pageQuery(page: number, perPage: number, extra: Record<string, string> = {}): string {
  return new URLSearchParams({ ...extra, page: String(page), perPage: String(perPage) }).toString();
}

/** One page of what the node still has to fetch of the folder. */
export function fetchNeedItems(nodeId: string, folderId: string, page: number, perPage: number): Promise<ReadResult<ItemsPage<NeedItem>>> {
  return readJson(`${folderApiPath(nodeId, folderId, "/need")}?${pageQuery(page, perPage)}`);
}

/** One page of the folder's failed items on the node. */
export function fetchFailedItems(nodeId: string, folderId: string, page: number, perPage: number): Promise<ReadResult<FailedPage>> {
  return readJson(`${folderApiPath(nodeId, folderId, "/errors")}?${pageQuery(page, perPage)}`);
}

/** What a revert or override of the folder would discard, as Syncthing counts it now. */
export function fetchDiscardCounts(nodeId: string, folderId: string): Promise<ReadResult<DiscardCounts>> {
  return readJson(folderApiPath(nodeId, folderId, "/discard-counts"));
}

/** One page of what was changed on the node itself in a receive only folder. */
export function fetchLocalChanged(nodeId: string, folderId: string, page: number, perPage: number): Promise<ReadResult<LocalChangedPage>> {
  return readJson(`${folderApiPath(nodeId, folderId, "/local-changed")}?${pageQuery(page, perPage)}`);
}

/** One page of the folder's conflict copies on the node. */
export function fetchConflicts(nodeId: string, folderId: string, page: number, perPage: number): Promise<ReadResult<ConflictsPage>> {
  return readJson(`${folderApiPath(nodeId, folderId, "/conflicts")}?${pageQuery(page, perPage)}`);
}

/** One page of what `deviceId` still needs of the node's folder. */
export function fetchRemoteNeed(nodeId: string, folderId: string, deviceId: string, page: number, perPage: number): Promise<ReadResult<RemoteNeedPage>> {
  return readJson(`${folderApiPath(nodeId, folderId, "/remote-need")}?${pageQuery(page, perPage, { device: deviceId })}`);
}

/** What the versions tree asks for: the directory `prefix`, and the versions kept between `from` and `to` (instants, empty for no bound). */
export interface VersionsQuery {
  prefix: string;
  from: string;
  to: string;
  page: number;
  perPage: number;
  /** Lists the versions again instead of the list read in the last minute. */
  reread: boolean;
}

/** One level of the folder's versions tree on the node, or `enabled: false` when its versioning is off. */
export function fetchVersions(nodeId: string, folderId: string, query: VersionsQuery): Promise<ReadResult<VersionsPage>> {
  const extra: Record<string, string> = { prefix: query.prefix };
  if (query.from) extra.from = query.from;
  if (query.to) extra.to = query.to;
  if (query.reread) extra.reread = "true";
  return readJson(`${folderApiPath(nodeId, folderId, "/versions")}?${pageQuery(query.page, query.perPage, extra)}`);
}

/** Replaces each named file with its chosen version; `confirm` is the folder ID, typed on an array. */
export function restoreVersions(nodeId: string, folderId: string, files: Record<string, string>, confirm: string): Promise<SaveResult<RestoredVersions>> {
  const body: RestoreVersionsBody = confirm ? { files, confirm } : { files };
  return sendWrite(folderApiPath(nodeId, folderId, "/versions/restore"), "POST", body);
}

export function fetchTree(node: string, path: string, page: number): Promise<TreeListing> {
  const query = new URLSearchParams({ node, path, page: String(page) });
  return getJson(`api/tree?${query.toString()}`);
}

export { type FileChange, changesActivityType, logLevels } from "../../src/api/types.js";
export { keptLogLines } from "../../src/api/logLines.js";
export { type ActivityFilters, activityFiltersOf, activityFiltersQuery, defaultActivityFilters, folderChangesShown, isChangeEntry, matchesActivityFilters } from "../../src/api/activityFilters.js";

export function fetchNodeLog(nodeId: string, since: string | null): Promise<NodeLog> {
  return getJson(`${nodeApiPath(nodeId, "log")}${since ? `?since=${encodeURIComponent(since)}` : ""}`);
}

export function fetchNodeErrors(nodeId: string): Promise<NodeErrors> {
  return getJson(nodeApiPath(nodeId, "errors"));
}

export function fetchDebugFacilities(nodeId: string): Promise<DebugFacilities> {
  return getJson(nodeApiPath(nodeId, "debug"));
}

export function clearNodeErrors(nodeId: string): Promise<SaveResult<NodeErrors>> {
  return sendWrite(nodeApiPath(nodeId, "errors/clear"), "POST");
}

/** Sends only the facilities whose debug logging changes; the answer is every facility as it now stands. */
export function saveDebugFacilities(nodeId: string, change: DebugChange): Promise<SaveResult<DebugFacilities>> {
  return sendWrite(nodeApiPath(nodeId, "debug"), "POST", change);
}

/** The node's support bundle, which the dashboard hands out only once it found no password or API key in it. */
export function supportBundleUrl(nodeId: string): string {
  return nodeApiPath(nodeId, "support-bundle");
}

export function fetchActivity(filters: ActivityFilters, limit: number): Promise<ActivityResponse> {
  return getJson(`api/activity?${activityRequestQuery(filters, limit).toString()}`);
}

/** The folder's newest file changes on every node of this host. */
export function fetchFolderChanges(folderId: string): Promise<ActivityResponse> {
  return fetchActivity({ ...defaultActivityFilters, folder: folderId, kind: changesActivityType }, folderChangesShown);
}

async function postJson(path: string, body: ArrayActionBody): Promise<{ status: number; error: string | null }> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (response.ok) noteSavedWrite();
  return { status: response.status, error: response.ok ? null : (payload.error ?? `HTTP ${response.status}`) };
}

export async function runArrayAction(nodeId: string, action: ArrayAction, body: ArrayActionBody): Promise<ActionResult> {
  try {
    const result = await postJson(`api/arrays/${encodeURIComponent(nodeId)}/${action}`, body);
    return result.error === null ? { ok: true, message: `Started ${action.replace("-", " ")}.` } : { ok: false, message: `Refused: ${result.error}` };
  } catch {
    return { ok: false, message: "The dashboard is not answering." };
  }
}
