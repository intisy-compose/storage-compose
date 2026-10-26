import type { ActivityFilters, ActivityResponse, FolderDetailResponse, NodeKind, NodesResponse, TreeListing } from "./api.js";
import { type ThemeChoice, storedTheme } from "./preferences.js";

export type PageId = "nodes" | "folders" | "attention" | "activity" | "requests" | "settings";
export type ReachFilter = "all" | "online" | "offline" | "attention";
export type KindFilter = "all" | NodeKind;

export interface OpenForm {
  nodeId: string;
  action: "add" | "rebuild" | "remove" | "accept-smart" | "sync-anyway";
  role: string;
  device: string;
  confirm: string;
}

export interface Notice {
  text: string;
  tone: "ok" | "bad";
}

export const allNodesView = "all";

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
  data: NodesResponse | null;
  lastLoaded: number | null;
  loadError: string | null;
  search: string;
  reachFilter: ReachFilter;
  kindFilter: KindFilter;
  openForm: OpenForm | null;
  notice: Notice | null;
  showCandidates: boolean;
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
}

export const activityPageSize = 300;

export const appState: AppState = {
  page: "nodes",
  selectedNodeId: null,
  data: null,
  lastLoaded: null,
  loadError: null,
  search: "",
  reachFilter: "all",
  kindFilter: "all",
  openForm: null,
  notice: null,
  showCandidates: false,
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
};

const pages: PageId[] = ["nodes", "folders", "attention", "activity", "requests", "settings"];

function readExplorerLocation(query: URLSearchParams): void {
  const node = query.get("node") || allNodesView;
  const path = query.get("path") ?? "";
  if (node !== appState.explorer.node || path !== appState.explorer.path) appState.explorer = emptyExplorer(node, path);
  appState.explorer.placeAtFolder = appState.selectedFolderId !== null && !query.has("path");
}

export function readLocation(): void {
  const hash = location.hash.replace(/^#\/?/, "");
  const queryStart = hash.indexOf("?");
  const route = queryStart < 0 ? hash : hash.slice(0, queryStart);
  const query = new URLSearchParams(queryStart < 0 ? "" : hash.slice(queryStart + 1));
  const [page, itemId] = route.split("/");
  appState.page = pages.includes(page as PageId) ? (page as PageId) : "nodes";
  const selected = itemId ? decodeURIComponent(itemId) : null;
  appState.selectedNodeId = appState.page === "nodes" ? selected : null;
  appState.selectedFolderId = appState.page === "folders" ? selected : null;
  if (appState.page === "folders") readExplorerLocation(query);
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

/** The address of a page, or of one node or folder on it. */
export function locationFor(page: PageId, itemId: string | null = null): string {
  return itemId ? `#/${page}/${encodeURIComponent(itemId)}` : `#/${page}`;
}

export function selectedItemId(): string | null {
  return appState.selectedNodeId ?? appState.selectedFolderId ?? (appState.page === "folders" ? appState.explorer.selectedPath : null);
}
