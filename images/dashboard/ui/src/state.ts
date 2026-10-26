import type { ActivityFilters, ActivityResponse, AddedDevice, DeviceIdCheck, DeviceSettings, DevicesResponse, NearbyDevice, FolderDetailResponse, FolderPathCheck, FolderSettings, FolderType, NewFolderDefaults, HostSettings, NodeOptionsResponse, NodesResponse, RequestsResponse, TreeListing } from "./api.js";
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
  saving: boolean;
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
  explorer: ExplorerState;
  /** `<folder id>/<node id>` of the settings a person folded away. */
  foldedSettings: Set<string>;
  activity: ActivityResponse | null;
  activityError: string | null;
  activityFilters: ActivityFilters;
  /** How many entries the page asks for; "Show older entries" raises it by `activityPageSize`. */
  activityLimit: number;
  requests: RequestsResponse | null;
  requestsError: string | null;
  hostSettings: HostSettings | null;
  hostSettingsError: string | null;
  /** Each local node's options by node ID, or why they could not be read. */
  nodeOptions: Map<string, NodeOptionsResponse | { error: string }>;
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
  explorer: emptyExplorer(allNodesView, ""),
  foldedSettings: new Set(),
  activity: null,
  activityError: null,
  activityFilters: { node: "", folder: "", source: "", routine: false },
  activityLimit: activityPageSize,
  requests: null,
  requestsError: null,
  hostSettings: null,
  hostSettingsError: null,
  nodeOptions: new Map(),
};

const pages: PageId[] = ["nodes", "folders", "attention", "activity", "requests", "settings"];

/** The value of `add` that opens the add folder form over the explorer. */
const addFolderFlag = "folder";

function emptyAddFolderForm(node: string, under: string): AddFolderFormState {
  return { nodeId: node === allNodesView ? null : node, openedFrom: node, under, defaults: null, draft: null, pathCheck: null, suggestions: [], loadError: null, saving: false, result: null, added: null };
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
  else if (open?.folderId !== folderId || open.nodeId !== nodeId) appState.editFolderForm = { folderId, nodeId, saved: null, draft: null, pathCheck: null, saving: false, result: null };
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
  return { nodeId, deviceId, saved: null, draft: null, loadError: null, saving: false, result: null, removeConfirm: "", removing: false, removeResult: null, removed: false };
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
