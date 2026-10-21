import type { ActivityFilters, ActivityResponse, FolderDetailResponse, FoldersResponse, NodeKind, NodesResponse } from "./api.js";
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
  folders: FoldersResponse | null;
  foldersError: string | null;
  folderDetail: FolderDetailResponse | null;
  folderDetailError: string | null;
  folderSearch: string;
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
  folders: null,
  foldersError: null,
  folderDetail: null,
  folderDetailError: null,
  folderSearch: "",
  foldedSettings: new Set(),
  activity: null,
  activityError: null,
  activityFilters: { node: "", folder: "", source: "" },
  activityLimit: activityPageSize,
};

const pages: PageId[] = ["nodes", "folders", "attention", "activity", "requests", "settings"];

export function readLocation(): void {
  const [page, itemId] = location.hash.replace(/^#\/?/, "").split("/");
  appState.page = pages.includes(page as PageId) ? (page as PageId) : "nodes";
  const selected = itemId ? decodeURIComponent(itemId) : null;
  appState.selectedNodeId = appState.page === "nodes" ? selected : null;
  appState.selectedFolderId = appState.page === "folders" ? selected : null;
}

/** The address of a page, or of one node or folder on it. */
export function locationFor(page: PageId, itemId: string | null = null): string {
  return itemId ? `#/${page}/${encodeURIComponent(itemId)}` : `#/${page}`;
}

export function selectedItemId(): string | null {
  return appState.selectedNodeId ?? appState.selectedFolderId;
}
