import type { NodeKind, NodesResponse } from "./api.js";
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
}

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
};

const pages: PageId[] = ["nodes", "folders", "attention", "activity", "requests", "settings"];

export function readLocation(): void {
  const [page, nodeId] = location.hash.replace(/^#\/?/, "").split("/");
  appState.page = pages.includes(page as PageId) ? (page as PageId) : "nodes";
  appState.selectedNodeId = appState.page === "nodes" && nodeId ? decodeURIComponent(nodeId) : null;
}

export function locationFor(page: PageId, nodeId: string | null = null): string {
  return nodeId ? `#/${page}/${encodeURIComponent(nodeId)}` : `#/${page}`;
}
