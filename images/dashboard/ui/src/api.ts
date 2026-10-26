export type {
  AcceptDeviceBody,
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
  FolderCopy,
  FolderDetailResponse,
  FolderFile,
  FolderPathCheck,
  FolderPeer,
  FolderSettings,
  FolderSettingsChange,
  FolderShare,
  FolderSharingChange,
  FolderSummary,
  FoldersResponse,
  FolderType,
  HostSettings,
  IgnoredDevice,
  InstanceConnection,
  InstanceGui,
  InstanceOptions,
  JoinEntry,
  MemberSmart,
  NearbyDevice,
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
  RemoveDeviceBody,
  RequestsResponse,
  Space,
  StorageNode,
  SyncState,
  SyncthingDevice,
  SyncthingInstance,
  SyncthingListener,
  TreeEntry,
  TreeListing,
  Versioning,
  Warning,
  WarningKind,
  WarningLevel,
} from "../../src/api/types.js";
import { requestRefresh } from "./renderRequest.js";
import type { AcceptDeviceBody, AcceptedDevice, ActivityResponse, AddedDevice, ArrayAction, ArrayActionBody, DeviceIdCheck, DeviceSettings, DeviceSettingsChange, DevicesResponse, ErrorAnswer, NearbyDevice, NewDevice, NewFolder, NewFolderDefaults, FolderDetailResponse, FolderPathCheck, FolderSettings, FolderSettingsChange, RemoveDeviceBody, HostSettings, IgnoredDevice, NodeOptionsResponse, NodesResponse, PendingDevice, RequestsResponse, TreeListing } from "../../src/api/types.js";

export { diskFreeUnits, editableFolderTypes, folderSettingLabels, folderTypeTexts, pullOrderTexts, topDirectoryDefault } from "../../src/api/types.js";

export { addressLabel, connectionKindText, deviceDisplayName, deviceStateText, driveLastSeenHereText, driveWhereText, deviceSettingLabels, isNodePaused, isReachable, reachTone, seenTimeText, shareFoldersLabel, shortDeviceId } from "../../src/api/deviceText.js";
export { changedFields } from "../../src/syncthingConfig.js";
export { type StatusPresentation, type StatusTone, priorityBadgeText, statusPresentation } from "../../src/api/explorerText.js";

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

/** A new folder as the node's Syncthing would make it, placed at the explorer's directory `under`. */
export function fetchFolderDefaults(nodeId: string, under: string): Promise<NewFolderDefaults> {
  return getJson(`${nodeApiPath(nodeId, "folder-defaults")}?under=${encodeURIComponent(under)}`);
}

/** The directories the node's Syncthing completes `current` to, inside the node's root only. */
export function browseFolderPaths(nodeId: string, current: string): Promise<string[]> {
  return getJson(`${nodeApiPath(nodeId, "browse")}?current=${encodeURIComponent(current)}`);
}

/** How the node would judge `path` for a new folder, or for the edit of `editedFolderId`, whose own path is then no conflict. */
export function checkFolderPath(nodeId: string, path: string, editedFolderId: string | null = null): Promise<FolderPathCheck> {
  const query = new URLSearchParams({ path, ...(editedFolderId === null ? {} : { folder: editedFolderId }) });
  return getJson(`${nodeApiPath(nodeId, "folder-path-check")}?${query.toString()}`);
}

/** Sends the new folder's ID, path and only the settings that differ from the node's defaults. */
export function addFolder(nodeId: string, folder: NewFolder): Promise<SaveResult<FolderSettings>> {
  return sendWrite(nodeApiPath(nodeId, "folders"), "POST", folder);
}

/** Sends only `change`; the node's answer is the folder as it now stands. */
export function saveFolderSettings(nodeId: string, folderId: string, change: FolderSettingsChange): Promise<SaveResult<FolderSettings>> {
  return sendWrite(nodeApiPath(nodeId, `folders/${encodeURIComponent(folderId)}`), "PATCH", change);
}

export function fetchFolderDetail(folderId: string): Promise<FolderDetailResponse> {
  return getJson(`api/folders/${encodeURIComponent(folderId)}`);
}

export function fetchTree(node: string, path: string, page: number): Promise<TreeListing> {
  const query = new URLSearchParams({ node, path, page: String(page) });
  return getJson(`api/tree?${query.toString()}`);
}

export { routineActivityTypes } from "../../src/api/types.js";

export interface ActivityFilters {
  node: string;
  folder: string;
  source: string;
  /** Scans and file changes are shown only when this is on. */
  routine: boolean;
}

export function fetchActivity(filters: ActivityFilters, limit: number): Promise<ActivityResponse> {
  const query = new URLSearchParams({ limit: String(limit) });
  for (const name of ["node", "folder", "source"] as const) if (filters[name]) query.set(name, filters[name]);
  if (!filters.routine) query.set("routine", "false");
  return getJson(`api/activity?${query.toString()}`);
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
