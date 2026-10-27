import { type ActivityEntry, type ConflictFile, type FailedItem, type FolderItem, type ItemsPage, type NeedItem, type ReadResult, activityFiltersOf, activityFiltersQuery, defaultActivityFilters, defaultItemsPerPage } from "./api.js";
import type { ActivityFilters, ActivityResponse, DebugFacilities, LogLevel, LogMessage, NodeErrors, FileVersion, VersionsPage, AddedDevice, DeviceIdCheck, DiscardCounts, DeviceSettings, DevicesResponse, NearbyDevice, FolderDetailResponse, FolderIgnores, FolderPathCheck, FolderSettings, FolderType, NewFolderDefaults, HostSettings, IgnoredLists, NodeOptionsResponse, NodeRestartState, NodesResponse, RequestsResponse, TreeListing } from "./api.js";
import type { KindFilter, ReachFilter } from "./devicePlacement.js";
import { type ThemeChoice, storedTheme } from "./preferences.js";

export type PageId = "nodes" | "folders" | "attention" | "activity" | "requests" | "settings";

export interface OpenForm {
  nodeId: string;
  action: "add" | "rebuild" | "remove" | "accept-smart" | "sync-anyway";
  role: string;
  device: string;
  confirm: string;
}

export interface Notice {
  text: string;
  tone: "ok" | "warn" | "bad";
}

export const allNodesView = "all";

/**
 * Shares ticked and unticked in a form and not saved yet, keyed by device ID in a folder's form and by folder ID in a device's.
 * `share` holds the encryption password typed for each, "" for none; `revealed` the passwords shown in clear.
 */
export interface SharingDraft {
  share: Map<string, string>;
  unshare: Set<string>;
  revealed: Set<string>;
}

export function emptySharing(): SharingDraft {
  return { share: new Map(), unshare: new Set(), revealed: new Set() };
}

/** The folder's ignore patterns in its edit form, read and saved on their own. */
export interface IgnoresDraft {
  /** As the node answered when the section opened or as the last save answered; a save is refused once the node's file differs from it. */
  opened: FolderIgnores | null;
  text: string;
  loading: boolean;
  loadError: string | null;
  saving: boolean;
  result: Notice | null;
}

export function emptyIgnores(): IgnoresDraft {
  return { opened: null, text: "", loading: false, loadError: null, saving: false, result: null };
}

/** The form of `#/nodes/<nodeId>/devices/<deviceId>`: one device as one node's Syncthing has it. */
export interface DeviceFormState {
  nodeId: string;
  deviceId: string;
  /** As the node answered when the form opened or last saved; changes are measured against it, never against a later read. */
  saved: DeviceSettings | null;
  /** What the form holds, typed or not. */
  draft: DeviceSettings | null;
  loadError: string | null;
  saving: boolean;
  result: Notice | null;
  /** The device's name as typed to confirm its removal. */
  removeConfirm: string;
  removing: boolean;
  removeResult: Notice | null;
  /** Set once the node no longer has the device. */
  removed: boolean;
  /** The node's folders ticked or unticked for the device. */
  sharing: SharingDraft;
  sharingSaving: boolean;
  sharingResult: Notice | null;
}

/** The form of `#/nodes/<nodeId>/devices/new`: a device to add to one node's Syncthing. */
export interface AddDeviceFormState {
  nodeId: string;
  /** The node's Syncthing defaults for a new device; what the form sends is measured against them. */
  defaults: DeviceSettings | null;
  /** What the form holds, the typed device ID included. */
  draft: DeviceSettings | null;
  /** The node's folders ticked to share with the device; none until the person ticks one. */
  shareFolders: Set<string>;
  nearby: NearbyDevice[] | null;
  nearbyError: string | null;
  /** Syncthing's reading of the typed ID, for the ID it was asked about. */
  idCheck: { typed: string; check: DeviceIdCheck } | null;
  showQr: boolean;
  loadError: string | null;
  saving: boolean;
  result: Notice | null;
  added: AddedDevice | null;
}

/** What the add folder form holds, typed or not. */
export interface FolderDraft {
  id: string;
  label: string;
  path: string;
  type: FolderType;
  paused: boolean;
  /** The ignore patterns as typed, one per line. */
  ignores: string;
}

/** The form of `#/folders?node=&path=&add=folder`: a folder to add to one node, placed at the explorer's directory by default. */
export interface AddFolderFormState {
  /** Null until the person chooses one of this host's nodes. */
  nodeId: string | null;
  /** The explorer's view the form was opened from; the form stays open only while the address names the same view and directory. */
  openedFrom: string;
  /** The explorer's directory the form was opened at, which places the default path. */
  under: string;
  /** The chosen node's defaults, which the form's changes are measured against. */
  defaults: NewFolderDefaults | null;
  draft: FolderDraft | null;
  /** How the add would judge the typed path, for the path it was asked about. */
  pathCheck: { typed: string; check: FolderPathCheck } | null;
  /** Directories the node completes the typed path to. */
  suggestions: string[];
  loadError: string | null;
  /** The folder ID as typed to confirm the add on an array. */
  confirm: string;
  saving: boolean;
  result: Notice | null;
  added: FolderSettings | null;
}

/** The form of `#/folders/<folderId>?...&edit=<nodeId>`: one folder's settings as one node's Syncthing has them. */
export interface EditFolderFormState {
  folderId: string;
  nodeId: string;
  /** As the folder detail answered when the form opened or as the last save answered; changes are measured against it, never against a later read. */
  saved: FolderSettings | null;
  draft: FolderSettings | null;
  /** How the node would judge the typed path, for the path it was asked about. */
  pathCheck: { typed: string; check: FolderPathCheck } | null;
  /** The node's devices ticked or unticked for the folder. */
  sharing: SharingDraft;
  /** The folder ID as typed to confirm a share on an array. */
  confirm: string;
  ignores: IgnoresDraft;
  saving: boolean;
  result: Notice | null;
}

/** One node's actions on one folder in the folder detail: what is on its way, what was typed, and how the last one went. */
export interface FolderActionState {
  folderId: string;
  nodeId: string;
  busy: boolean;
  /** The part of the folder a rescan is limited to; empty is the whole folder. */
  sub: string;
  removeOpen: boolean;
  /** The folder's ID as typed to confirm the removal. */
  confirm: string;
  /** The revert or override form is open. */
  discardOpen: boolean;
  /** The folder's ID as typed to confirm a revert or override. */
  discardConfirm: string;
  /** Syncthing's counts read as the revert or override form opened; null until read, or when the read failed. */
  discardCounts: DiscardCounts | null;
  discardCountsReading: boolean;
  result: Notice | null;
}

/** What an item list lists: what is out of sync, the failed items, what was changed on a receive only node, or the conflict copies. */
export type ItemListKind = "need" | "failed" | "local-changed" | "conflicts";

/** Which item list is open: what a node still has to fetch of a folder, or with `deviceId` what that device still needs of it. */
export interface ItemListTarget {
  nodeId: string;
  folderId: string;
  /** Set only for a need list, naming the device whose need is listed. */
  deviceId: string | null;
  kind: ItemListKind;
}

/** The one open item list and the page it shows; it keeps its last answer until the person pages or reads it again. */
export interface ItemListState extends ItemListTarget {
  page: number;
  perPage: number;
  loading: boolean;
  answer: ReadResult<ItemsPage<NeedItem | FolderItem | FailedItem | ConflictFile>> | null;
}

/** The open versions browser of one folder copy: where in the tree it is, the date filter, the versions chosen and the restore's confirmation. */
export interface VersionsState {
  nodeId: string;
  folderId: string;
  /** The directory shown, `/` separated, empty for the folder's root. */
  prefix: string;
  page: number;
  perPage: number;
  /** The date filter as its fields hold it, `YYYY-MM-DD`, empty for no bound. */
  from: string;
  to: string;
  loading: boolean;
  answer: ReadResult<VersionsPage> | null;
  /** Each file chosen for a restore, with the version chosen for it. */
  chosen: Map<string, FileVersion>;
  confirmOpen: boolean;
  /** The folder ID as typed on an array. */
  confirm: string;
  busy: boolean;
  result: Notice | null;
}

/** The Folders page's file explorer: which node's view, which directory, and what the person opened in it. */
export interface ExplorerState {
  node: string;
  path: string;
  /** Pages 1 to `pages` of the directory, merged. */
  listing: TreeListing | null;
  pages: number;
  error: string | null;
  expanded: Set<string>;
  children: Map<string, TreeListing>;
  childErrors: Map<string, string>;
  selectedPath: string | null;
  search: string;
  /** `#/folders/<id>` arrived without a path, so the explorer still has to find that folder's root. */
  placeAtFolder: boolean;
}

export function emptyExplorer(node: string, path: string): ExplorerState {
  return { node, path, listing: null, pages: 1, error: null, expanded: new Set(), children: new Map(), childErrors: new Map(), selectedPath: null, search: "", placeAtFolder: false };
}

export type ActivityTab = "events" | "log";

/** The Log tab: one node's log, its errors and its debug facilities, each with why it could not be read. */
export interface NodeLogState {
  nodeId: string;
  /** The least level shown; the person can change it. */
  minimumLevel: LogLevel;
  messages: LogMessage[] | null;
  logError: string | null;
  errors: NodeErrors | null;
  errorsError: string | null;
  debug: DebugFacilities | null;
  debugError: string | null;
  busy: boolean;
  result: Notice | null;
}

export const defaultLogLevel: LogLevel = "info";

export function emptyNodeLog(nodeId: string, minimumLevel: LogLevel = defaultLogLevel): NodeLogState {
  return { nodeId, minimumLevel, messages: null, logError: null, errors: null, errorsError: null, debug: null, debugError: null, busy: false, result: null };
}

export interface AppState {
  page: PageId;
  selectedNodeId: string | null;
  selectedDeviceKey: string | null;
  selectedDriveKey: string | null;
  deviceForm: DeviceFormState | null;
  addDeviceForm: AddDeviceFormState | null;
  addFolderForm: AddFolderFormState | null;
  editFolderForm: EditFolderFormState | null;
  data: NodesResponse | null;
  devices: DevicesResponse | null;
  devicesError: string | null;
  /** IDs of the arrays whose member drives a person folded away on the Nodes page. */
  foldedArrays: Set<string>;
  lastLoaded: number | null;
  loadError: string | null;
  search: string;
  reachFilter: ReachFilter;
  kindFilter: KindFilter;
  openForm: OpenForm | null;
  notice: Notice | null;
  showCandidates: boolean;
  showNodeDetails: boolean;
  theme: ThemeChoice;
  selectedFolderId: string | null;
  folderDetail: FolderDetailResponse | null;
  folderDetailError: string | null;
  /** The open folder's newest file changes, or why they could not be read. */
  folderChanges: FolderChangesState | null;
  explorer: ExplorerState;
  /** `<folder id>/<node id>` of the settings a person folded away. */
  foldedSettings: Set<string>;
  /** By `<folder id>/<node id>`. */
  folderActions: Map<string, FolderActionState>;
  itemList: ItemListState | null;
  versions: VersionsState | null;
  /** How many items a page of an item list holds; the person can change it in the list. */
  itemsPerPage: number;
  activity: ActivityResponse | null;
  activityError: string | null;
  activityFilters: ActivityFilters;
  /** How many entries the page asks for; "Show older entries" raises it by `activityPageSize`. */
  activityLimit: number;
  activityTab: ActivityTab;
  /** Null until the Log tab has a node to show. */
  nodeLog: NodeLogState | null;
  requests: RequestsResponse | null;
  requestsError: string | null;
  hostSettings: HostSettings | null;
  hostSettingsError: string | null;
  /** Each local node's options by node ID, or why they could not be read. */
  nodeOptions: Map<string, NodeOptionsResponse | { error: string }>;
  /** Whether each local node's Syncthing needs a restart, read with its options. */
  restartStates: Map<string, NodeRestartState | { error: string }>;
  /** What each local node ignores, by node ID, or why it could not be read. */
  ignoredLists: Map<string, IgnoredLists | { error: string }>;
}

export interface FolderChangesState {
  folderId: string;
  entries: ActivityEntry[] | null;
  error: string | null;
}

export const activityPageSize = 300;

export const appState: AppState = {
  page: "nodes",
  selectedNodeId: null,
  selectedDeviceKey: null,
  selectedDriveKey: null,
  deviceForm: null,
  addDeviceForm: null,
  addFolderForm: null,
  editFolderForm: null,
  data: null,
  devices: null,
  devicesError: null,
  foldedArrays: new Set(),
  lastLoaded: null,
  loadError: null,
  search: "",
  reachFilter: "all",
  kindFilter: "all",
  openForm: null,
  notice: null,
  showCandidates: false,
  showNodeDetails: false,
  theme: storedTheme(),
  selectedFolderId: null,
  folderDetail: null,
  folderDetailError: null,
  folderChanges: null,
  explorer: emptyExplorer(allNodesView, ""),
  foldedSettings: new Set(),
  folderActions: new Map(),
  itemList: null,
  versions: null,
  itemsPerPage: defaultItemsPerPage,
  activity: null,
  activityError: null,
  activityFilters: defaultActivityFilters,
  activityLimit: activityPageSize,
  activityTab: "events",
  nodeLog: null,
  requests: null,
  requestsError: null,
  hostSettings: null,
  hostSettingsError: null,
  nodeOptions: new Map(),
  restartStates: new Map(),
  ignoredLists: new Map(),
};

const pages: PageId[] = ["nodes", "folders", "attention", "activity", "requests", "settings"];

/** The value of `add` that opens the add folder form over the explorer. */
const addFolderFlag = "folder";

function emptyAddFolderForm(node: string, under: string): AddFolderFormState {
  return { nodeId: node === allNodesView ? null : node, openedFrom: node, under, defaults: null, draft: null, pathCheck: null, suggestions: [], loadError: null, confirm: "", saving: false, result: null, added: null };
}

/** Keeps the open add form, and what was typed into it, while the address names the same view and directory. */
function readAddFolderForm(adding: boolean, node: string, under: string): void {
  const open = appState.addFolderForm;
  appState.addFolderForm = adding ? (open?.under === under && open.openedFrom === node ? open : emptyAddFolderForm(node, under)) : null;
}

/** Keeps the open edit form, and what was typed into it, while the address names the same folder and node. */
function readEditFolderForm(folderId: string | null, nodeId: string | null): void {
  const open = appState.editFolderForm;
  if (!folderId || !nodeId) appState.editFolderForm = null;
  else if (open?.folderId !== folderId || open.nodeId !== nodeId) appState.editFolderForm = { folderId, nodeId, saved: null, draft: null, pathCheck: null, sharing: emptySharing(), confirm: "", ignores: emptyIgnores(), saving: false, result: null };
}

function readExplorerLocation(query: URLSearchParams): void {
  const node = query.get("node") || allNodesView;
  const path = query.get("path") ?? "";
  if (node !== appState.explorer.node || path !== appState.explorer.path) appState.explorer = emptyExplorer(node, path);
  appState.explorer.placeAtFolder = appState.selectedFolderId !== null && !query.has("path");
  readAddFolderForm(appState.selectedFolderId === null && query.get("add") === addFolderFlag, node, path);
  readEditFolderForm(appState.selectedFolderId, query.get("edit"));
}

function emptyDeviceForm(nodeId: string, deviceId: string): DeviceFormState {
  return { nodeId, deviceId, saved: null, draft: null, loadError: null, saving: false, result: null, removeConfirm: "", removing: false, removeResult: null, removed: false, sharing: emptySharing(), sharingSaving: false, sharingResult: null };
}

/** The device segment of the add form's address; a device ID is upper case, so no device is called this. */
const newDeviceSegment = "new";

function emptyAddDeviceForm(nodeId: string): AddDeviceFormState {
  return { nodeId, defaults: null, draft: null, shareFolders: new Set(), nearby: null, nearbyError: null, idCheck: null, showQr: false, loadError: null, saving: false, result: null, added: null };
}

/** Keeps the open form, and what was typed into it, while the address names the same device, or the same node's add form. */
function readDeviceForm(nodeId: string | null, deviceId: string | null): void {
  const adding = nodeId !== null && deviceId === newDeviceSegment;
  const openAdd = appState.addDeviceForm;
  appState.addDeviceForm = adding ? (openAdd?.nodeId === nodeId ? openAdd : emptyAddDeviceForm(nodeId)) : null;
  const open = appState.deviceForm;
  if (!nodeId || !deviceId || adding) appState.deviceForm = null;
  else if (open?.nodeId !== nodeId || open.deviceId !== deviceId) appState.deviceForm = emptyDeviceForm(nodeId, deviceId);
}

/** `nodes/<nodeId>`, `nodes/<nodeId>/devices/<deviceId>`, `nodes/device/<key>` or `nodes/drive/<key>`. */
function readNodesSelection(itemId: string | null, subItemId: string | null, deviceId: string | null): void {
  const isDevice = itemId === "device" && subItemId !== null;
  const isDrive = itemId === "drive" && subItemId !== null;
  appState.selectedDeviceKey = isDevice ? subItemId : null;
  appState.selectedDriveKey = isDrive ? subItemId : null;
  appState.selectedNodeId = isDevice || isDrive ? null : itemId;
  readDeviceForm(appState.selectedNodeId, subItemId === "devices" ? deviceId : null);
}

/** The address segment of the Activity page's Log tab: `#/activity/log`, with `?node=<id>` for the node it shows. */
export const logTabSegment = "log";

export function logLocation(nodeId: string): string {
  return `${locationFor("activity", logTabSegment)}?node=${encodeURIComponent(nodeId)}`;
}

/** Keeps the Log tab's node, and what was read of it, while the address names the same node. */
function readLogNode(nodeId: string | null): void {
  if (nodeId && appState.nodeLog?.nodeId !== nodeId) appState.nodeLog = emptyNodeLog(nodeId, appState.nodeLog?.minimumLevel);
}

const activityFilterParams = ["node", "folder", "source", "type", "routine"];

/** The events tab's address with its filters, as `#/activity?node=fb98&folder=documents`. */
export function activityLocation(filters: ActivityFilters): string {
  const query = activityFiltersQuery(filters);
  return query ? `${locationFor("activity")}?${query}` : locationFor("activity");
}

/**
 * Takes the filters the address names; an address naming none keeps the filters chosen before.
 * @implNote The menu links to a bare `#/activity`, which must not throw away what a person filtered by; the page then writes the filters back into the address.
 * The filters object is replaced only when a value differs, so a read under way for the same filters is still taken.
 */
function readActivityFilters(query: URLSearchParams): void {
  if (!activityFilterParams.some((name) => query.has(name))) return;
  const filters = activityFiltersOf(query);
  if (activityFiltersQuery(filters) !== activityFiltersQuery(appState.activityFilters)) appState.activityFilters = filters;
}

export function readLocation(): void {
  const hash = location.hash.replace(/^#\/?/, "");
  const queryStart = hash.indexOf("?");
  const route = queryStart < 0 ? hash : hash.slice(0, queryStart);
  const query = new URLSearchParams(queryStart < 0 ? "" : hash.slice(queryStart + 1));
  const [page, itemId, subItemId, deviceId] = route.split("/");
  appState.page = pages.includes(page as PageId) ? (page as PageId) : "nodes";
  const selected = itemId ? decodeURIComponent(itemId) : null;
  readNodesSelection(appState.page === "nodes" ? selected : null, subItemId ? decodeURIComponent(subItemId) : null, deviceId ? decodeURIComponent(deviceId) : null);
  appState.selectedFolderId = appState.page === "folders" ? selected : null;
  appState.activityTab = appState.page === "activity" && itemId === logTabSegment ? "log" : "events";
  if (appState.activityTab === "log") readLogNode(query.get("node"));
  else if (appState.page === "activity") readActivityFilters(query);
  if (appState.page === "folders") readExplorerLocation(query);
  else {
    appState.addFolderForm = null;
    appState.editFolderForm = null;
  }
}

function encodePath(path: string): string {
  return encodeURIComponent(path).replaceAll("%2F", "/");
}

/**
 * The explorer at a node's view of a directory, with a folder's detail open when `folderId` is set.
 * @implNote A folder link always carries `path`, even empty, so it is not taken for a link that still has to be placed.
 */
export function explorerLocation(folderId: string | null, node = appState.explorer.node, path = appState.explorer.path): string {
  const base = locationFor("folders", folderId);
  if (!folderId && node === allNodesView && !path) return base;
  return `${base}?node=${encodeURIComponent(node)}&path=${encodePath(path)}`;
}

/** Whether the node is an array of this host's, where a folder is added, shared, accepted or ignored only with its ID typed. */
export function isArrayNode(nodeId: string): boolean {
  return appState.data?.nodes.find((node) => node.id === nodeId)?.kind === "array";
}

/** The folder's detail with the list of `nodeId`'s failed items of it open. */
export function failedItemsLocation(folderId: string, nodeId: string): string {
  return `${explorerLocation(folderId)}&failed=${encodeURIComponent(nodeId)}`;
}

/** The folder's detail with the list of its conflict copies on `nodeId` open. */
export function conflictsLocation(folderId: string, nodeId: string): string {
  return `${explorerLocation(folderId)}&conflicts=${encodeURIComponent(nodeId)}`;
}

const itemListParams = ["failed", "conflicts"];

/** The address without the list it asks to open; the rest is kept as written, as `path` keeps its slashes unencoded. */
export function withoutItemListInHash(hash: string): string {
  const queryStart = hash.indexOf("?");
  if (queryStart < 0) return hash;
  const kept = hash
    .slice(queryStart + 1)
    .split("&")
    .filter((pair) => !itemListParams.includes(pair.split("=")[0]));
  return kept.length ? `${hash.slice(0, queryStart)}?${kept.join("&")}` : hash.slice(0, queryStart);
}

/** The list the address asks to open (`&failed=<nodeId>` or `&conflicts=<nodeId>` on a folder), or null. */
export function itemListInLocation(): { kind: "failed" | "conflicts"; nodeId: string } | null {
  const hash = location.hash;
  const queryStart = hash.indexOf("?");
  if (queryStart < 0) return null;
  const query = new URLSearchParams(hash.slice(queryStart + 1));
  const failed = query.get("failed");
  if (failed) return { kind: "failed", nodeId: failed };
  const conflicts = query.get("conflicts");
  return conflicts ? { kind: "conflicts", nodeId: conflicts } : null;
}

/** The form that edits the folder's settings on the node `nodeId`, over the explorer where the folder's detail is open. */
export function editFolderLocation(folderId: string, nodeId: string): string {
  return `${explorerLocation(folderId)}&edit=${encodeURIComponent(nodeId)}`;
}

/** The add folder form over the explorer at a node's view of a directory, the folder placed there by default. */
export function addFolderLocation(node: string, path: string): string {
  return `${locationFor("folders")}?node=${encodeURIComponent(node)}&path=${encodePath(path)}&add=${addFolderFlag}`;
}

/** The address of a page, or of one node or folder on it. */
export function locationFor(page: PageId, itemId: string | null = null): string {
  return itemId ? `#/${page}/${encodeURIComponent(itemId)}` : `#/${page}`;
}

export function deviceLocation(key: string): string {
  return `#/nodes/device/${encodeURIComponent(key)}`;
}

/** The form of one device as the node `nodeId` has it configured. */
export function deviceFormLocation(nodeId: string, deviceId: string): string {
  return `#/nodes/${encodeURIComponent(nodeId)}/devices/${encodeURIComponent(deviceId)}`;
}

/** The form that adds a device to the node `nodeId`. */
export function addDeviceLocation(nodeId: string): string {
  return `#/nodes/${encodeURIComponent(nodeId)}/devices/${newDeviceSegment}`;
}

export function driveLocation(key: string): string {
  return `#/nodes/drive/${encodeURIComponent(key)}`;
}

export function selectedItemId(): string | null {
  if (appState.selectedDeviceKey !== null) return `device/${appState.selectedDeviceKey}`;
  if (appState.selectedDriveKey !== null) return `drive/${appState.selectedDriveKey}`;
  if (appState.deviceForm) return `${appState.deviceForm.nodeId}/devices/${appState.deviceForm.deviceId}`;
  if (appState.addDeviceForm) return `${appState.addDeviceForm.nodeId}/devices/${newDeviceSegment}`;
  if (appState.addFolderForm) return `add-folder/${appState.addFolderForm.under}`;
  if (appState.editFolderForm) return `edit-folder/${appState.editFolderForm.folderId}/${appState.editFolderForm.nodeId}`;
  return appState.selectedNodeId ?? appState.selectedFolderId ?? (appState.page === "folders" ? appState.explorer.selectedPath : null);
}
