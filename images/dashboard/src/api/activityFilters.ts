import { type ActivityEntry, activitySources, changeActivityTypes, changesActivityType, routineActivityTypes } from "./types.js";

/** What the Activity page's events tab shows; kept in its address as `#/activity?node=fb98&folder=documents`. */
export interface ActivityFilters {
  node: string;
  folder: string;
  source: string;
  /** `changes` shows only file changes, whatever `routine` says. */
  kind: "" | typeof changesActivityType;
  /** Scans and file changes are shown only when this is on. */
  routine: boolean;
}

export const defaultActivityFilters: ActivityFilters = { node: "", folder: "", source: "", kind: "", routine: false };

export function activityFiltersOf(query: URLSearchParams): ActivityFilters {
  const source = query.get("source") ?? "";
  return {
    node: query.get("node") ?? "",
    folder: query.get("folder") ?? "",
    source: (activitySources as readonly string[]).includes(source) ? source : "",
    kind: query.get("type") === changesActivityType ? changesActivityType : "",
    routine: query.get("routine") === "true",
  };
}

/** The address query of `filters`, empty for the defaults. */
export function activityFiltersQuery(filters: ActivityFilters): string {
  const query = new URLSearchParams();
  for (const name of ["node", "folder", "source"] as const) if (filters[name]) query.set(name, filters[name]);
  if (filters.kind) query.set("type", filters.kind);
  if (filters.routine) query.set("routine", "true");
  return query.toString();
}

/** The query of `GET /api/activity` for `filters`. */
export function activityRequestQuery(filters: ActivityFilters, limit: number): URLSearchParams {
  const query = new URLSearchParams({ limit: String(limit) });
  for (const name of ["node", "folder", "source"] as const) if (filters[name]) query.set(name, filters[name]);
  if (filters.kind) query.set("type", filters.kind);
  else if (!filters.routine) query.set("routine", "false");
  return query;
}

export function isChangeEntry(entry: ActivityEntry): boolean {
  return (changeActivityTypes as readonly string[]).includes(entry.type);
}

/** The filters applied on the page too, so a changed filter shows at once and the next answer only refreshes it. */
export function matchesActivityFilters(entry: ActivityEntry, filters: ActivityFilters): boolean {
  const isRoutine = (routineActivityTypes as readonly string[]).includes(entry.type);
  const matchesKind = filters.kind ? isChangeEntry(entry) : filters.routine || !isRoutine;
  return (!filters.node || entry.nodeId === filters.node) && (!filters.folder || entry.folderId === filters.folder) && (!filters.source || entry.source === filters.source) && matchesKind;
}

/** How many of its newest file changes a folder's detail shows; Activity, filtered to the folder, shows the rest. */
export const folderChangesShown = 20;
