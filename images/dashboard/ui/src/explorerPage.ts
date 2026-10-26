import { type EntryStatus, type FolderSummary, type StorageNode, type TreeEntry, type TreeListing, fetchTree, statusPresentation } from "./api.js";
import { element } from "./dom.js";
import { loadedEntries } from "./explorerDetail.js";
import { type DotColumns, explorerNote, explorerRow, notSharedDot, notSharedText, presentationClasses } from "./explorerRow.js";
import { plural } from "./format.js";
import { icon } from "./icons.js";
import { requestRender } from "./renderRequest.js";
import { type ExplorerState, allNodesView, appState, explorerLocation, readLocation } from "./state.js";

let isNodeMenuOpen = false;

/**
 * True while the node selector's list is open, the one moment a poll's render would close it.
 * @implNote A change navigates and renders at once, so the selector is not protected after it.
 */
export function isNodeSelectorOpen(): boolean {
  return isNodeMenuOpen;
}
const listingsInFlight = new Set<string>();

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fetchPages(node: string, path: string, pages: number): Promise<TreeListing> {
  const listings = await Promise.all(Array.from({ length: pages }, (_, index) => fetchTree(node, path, index + 1)));
  const first = listings[0] as TreeListing;
  const last = listings[listings.length - 1] as TreeListing;
  return { ...first, entries: listings.flatMap((listing) => listing.entries), nextPage: last.nextPage, notes: [...new Set(listings.flatMap((listing) => listing.notes))] };
}

function applyChildren(explorer: ExplorerState, paths: string[], results: PromiseSettledResult<TreeListing>[]): void {
  paths.forEach((path, index) => {
    const result = results[index];
    if (!result || !explorer.expanded.has(path)) return;
    if (result.status === "fulfilled") {
      explorer.children.set(path, result.value);
      explorer.childErrors.delete(path);
    } else explorer.childErrors.set(path, messageOf(result.reason));
  });
}

/**
 * Reads the shown directory and every expanded one again.
 * @implNote An all-nodes listing may take 8 s, longer than the poll, so a read already running for the
 * same view is not started twice; a read for a view the person left is dropped when it answers.
 */
export async function loadExplorer(): Promise<void> {
  const explorer = appState.explorer;
  const pages = explorer.pages;
  const key = `${explorer.node}|${explorer.path}|${pages}`;
  if (listingsInFlight.has(key)) return;
  listingsInFlight.add(key);
  try {
    const expandedPaths = [...explorer.expanded];
    const [listing, ...children] = await Promise.allSettled([fetchPages(explorer.node, explorer.path, pages), ...expandedPaths.map((path) => fetchTree(explorer.node, path, 1))]);
    if (appState.explorer !== explorer || explorer.pages !== pages) return;
    if (listing?.status === "fulfilled") {
      explorer.listing = listing.value;
      explorer.error = null;
    } else explorer.error = messageOf(listing?.reason);
    applyChildren(explorer, expandedPaths, children);
  } finally {
    listingsInFlight.delete(key);
  }
}

function toggleExpanded(entry: TreeEntry): void {
  const explorer = appState.explorer;
  if (explorer.expanded.delete(entry.path)) {
    requestRender();
    return;
  }
  explorer.expanded.add(entry.path);
  requestRender();
  void fetchTree(explorer.node, entry.path, 1).then(
    (listing) => applyChildren(explorer, [entry.path], [{ status: "fulfilled", value: listing }]),
    (error: unknown) => applyChildren(explorer, [entry.path], [{ status: "rejected", reason: error }]),
  ).then(() => {
    if (appState.explorer === explorer) requestRender();
  });
}

function selectEntry(entry: TreeEntry): void {
  const isNewRow = appState.explorer.selectedPath !== entry.path;
  appState.explorer.selectedPath = entry.path;
  const target = explorerLocation(entry.folder?.id ?? null);
  if (location.hash !== target) {
    location.hash = target;
    return;
  }
  requestRender();
  if (isNewRow) document.querySelector(".detail")?.scrollTo(0, 0);
}

function showMore(): void {
  const explorer = appState.explorer;
  explorer.pages += 1;
  requestRender();
  void loadExplorer().then(requestRender);
}

const rowActions = { onToggle: toggleExpanded, onSelect: selectEntry };

function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/**
 * Where a folder's root lies, for a `#/folders/<id>` link that does not say: a top directory row with
 * the folder's chip, else the part of a copy's path from the first segment that is a top directory.
 */
function folderRootPath(summary: FolderSummary, top: TreeEntry[]): string | null {
  const row = top.find((entry) => entry.folder?.id === summary.id);
  if (row) return row.path;
  const topNames = new Map(top.map((entry) => [entry.name.toLowerCase(), entry.name]));
  for (const copy of summary.copies) {
    const segments = copy.path.split(/[\\/]+/).filter(Boolean);
    const start = segments.findIndex((segment) => topNames.has(segment.toLowerCase()));
    if (start >= 0) return [topNames.get((segments[start] as string).toLowerCase()), ...segments.slice(start + 1)].join("/");
  }
  return null;
}

/** Opens the explorer at the folder's parent with its root row selected, once both are known. */
export function placeAtFolder(summary: FolderSummary): boolean {
  const explorer = appState.explorer;
  if (!explorer.placeAtFolder || explorer.path || !explorer.listing) return false;
  explorer.placeAtFolder = false;
  const rootPath = folderRootPath(summary, explorer.listing.entries);
  if (rootPath === null) return false;
  history.replaceState(null, "", explorerLocation(summary.id, explorer.node, parentOf(rootPath)));
  readLocation();
  appState.explorer.selectedPath = rootPath;
  return true;
}

function nodeOption(node: StorageNode): HTMLOptionElement {
  const option = element("option", { attributes: { value: node.id } }, node.online ? node.name : `${node.name} (offline)`);
  option.defaultSelected = node.id === appState.explorer.node;
  return option;
}

function nodeGroups(nodes: StorageNode[]): HTMLOptGroupElement[] {
  const hosts = [...new Set(nodes.map((node) => node.host))];
  const thisHost = appState.data?.host.name;
  hosts.sort((left, right) => Number(right === thisHost) - Number(left === thisHost) || left.localeCompare(right));
  return hosts.map((host) => element("optgroup", { attributes: { label: host } }, ...nodes.filter((node) => node.host === host).map(nodeOption)));
}

function nodeSelector(): HTMLElement {
  const nodes = appState.data?.nodes ?? [];
  const all = element("option", { attributes: { value: allNodesView } }, "All nodes");
  all.defaultSelected = appState.explorer.node === allNodesView;
  const select = element("select", { className: "explorer-node", attributes: { id: "explorer-node", "aria-label": "Whose view of the tree" } }, all, ...nodeGroups(nodes));
  if (!nodes.some((node) => node.id === appState.explorer.node) && appState.explorer.node !== allNodesView) {
    const unknown = element("option", { attributes: { value: appState.explorer.node } }, appState.explorer.node);
    unknown.defaultSelected = true;
    select.append(unknown);
  }
  select.value = appState.explorer.node;
  select.addEventListener("mousedown", () => {
    isNodeMenuOpen = !isNodeMenuOpen;
  });
  select.addEventListener("keydown", (event) => {
    if (event.key === " " || event.key === "Enter" || (event.altKey && event.key === "ArrowDown")) isNodeMenuOpen = true;
    if (event.key === "Escape" || event.key === "Tab") isNodeMenuOpen = false;
  });
  select.addEventListener("blur", () => {
    isNodeMenuOpen = false;
  });
  select.addEventListener("change", () => {
    isNodeMenuOpen = false;
    location.hash = explorerLocation(null, select.value, appState.explorer.path);
  });
  return element("div", { className: "explorer-node-form" }, select);
}

function searchBox(): HTMLElement {
  const input = element("input", {
    className: "search-input",
    attributes: { type: "search", placeholder: "Filter this directory by name", "aria-label": "Filter this directory by name", id: "explorer-search" },
  });
  input.value = appState.explorer.search;
  input.defaultValue = appState.explorer.search;
  input.addEventListener("input", () => {
    appState.explorer.search = input.value;
    requestRender();
  });
  return element("label", { className: "search" }, icon("search"), input);
}

function breadcrumb(): HTMLElement {
  const segments = appState.explorer.path ? appState.explorer.path.split("/") : [];
  const crumbs: HTMLElement[] = [element("a", { attributes: { href: explorerLocation(null, appState.explorer.node, "") } }, "All data")];
  segments.forEach((segment, index) => {
    const path = segments.slice(0, index + 1).join("/");
    const isLast = index === segments.length - 1;
    crumbs.push(element("span", { className: "crumb-separator", attributes: { "aria-hidden": "true" } }, "/"));
    crumbs.push(isLast ? element("strong", { attributes: { "aria-current": "page" } }, segment) : element("a", { attributes: { href: explorerLocation(null, appState.explorer.node, path) } }, segment));
  });
  return element("nav", { className: "breadcrumb", attributes: { "aria-label": "Directory" } }, ...crumbs);
}

const legendStates: EntryStatus[] = ["in-sync", "syncing", "failed", "missing", "ignored", "local-only", "below-threshold", "paused", "unknown"];

function legend(): HTMLElement {
  return element(
    "ul",
    { className: "explorer-legend", attributes: { "aria-label": "Colours" } },
    ...legendStates.map((status) => {
      const shown = statusPresentation({ nodeId: "", nodeName: "", host: "", status, detail: null });
      const label = status === "unknown" ? "unknown (offline or not answering)" : shown.label;
      return element("li", {}, element("span", { className: `status-dot ${presentationClasses(shown)}` }, status === "unknown" ? "?" : null), label);
    }),
    element("li", {}, notSharedDot(null), notSharedText),
  );
}

function matchesSearch(entry: TreeEntry): boolean {
  const search = appState.explorer.search.trim().toLowerCase();
  return !search || entry.name.toLowerCase().includes(search);
}

function dotColumns(entries: TreeEntry[]): DotColumns | null {
  if (appState.explorer.node !== allNodesView) return null;
  const columns = new Map<string, string>();
  for (const entry of entries) for (const state of entry.nodes) if (!columns.has(state.nodeId)) columns.set(state.nodeId, state.nodeName);
  return [...columns].map(([nodeId, nodeName]) => ({ nodeId, nodeName }));
}

function childRows(parent: TreeEntry, depth: number, columns: DotColumns | null): HTMLElement[] {
  const explorer = appState.explorer;
  const error = explorer.childErrors.get(parent.path);
  const listing = explorer.children.get(parent.path);
  if (!listing) return [explorerNote(depth, error ? element("span", { className: "tone-text-bad" }, `Could not be read: ${error}`) : "Loading…")];
  const rows = listing.entries.flatMap((entry) => entryRows(entry, depth, columns));
  if (!listing.entries.length) rows.push(explorerNote(depth, element("span", { className: "muted" }, "Empty")));
  if (listing.nextPage) rows.push(explorerNote(depth, element("a", { attributes: { href: explorerLocation(null, explorer.node, parent.path) } }, `More in ${parent.name}: open it`)));
  return rows;
}

function entryRows(entry: TreeEntry, depth: number, columns: DotColumns | null): HTMLElement[] {
  const row = explorerRow(entry, depth, rowActions, columns);
  return appState.explorer.expanded.has(entry.path) ? [row, ...childRows(entry, depth + 1, columns)] : [row];
}

function statusHeading(columns: DotColumns | null): HTMLElement {
  if (!columns) return element("span", {}, "Status");
  return element("span", { className: "explorer-dot-heading", title: `One dot per node: ${columns.map((column) => column.nodeName).join(", ")}` }, "On each node", element("small", {}, columns.map((column) => column.nodeName).join(" · ")));
}

function headerRow(columns: DotColumns | null): HTMLElement {
  return element(
    "div",
    { className: "explorer-row explorer-head", attributes: { role: "row" } },
    element("span", {}, "Name"),
    element("span", {}, "Priority"),
    statusHeading(columns),
    element("span", { className: "explorer-size" }, "Size"),
    element("span", { className: "explorer-modified" }, "Modified"),
  );
}

function entryList(listing: TreeListing): HTMLElement {
  if (!listing.entries.length) return element("p", { className: "empty-line" }, "Nothing in this directory on the nodes viewed.");
  const visible = listing.entries.filter(matchesSearch);
  if (!visible.length) return element("p", { className: "empty-line" }, "No entry here matches the filter.");
  const columns = dotColumns(loadedEntries());
  return element("div", { className: "explorer-list", attributes: { role: "table", "aria-label": "Directory contents" } }, headerRow(columns), ...visible.flatMap((entry) => entryRows(entry, 0, columns)));
}

function viewName(): string {
  const node = appState.explorer.node;
  if (node === allNodesView) return "All nodes";
  const name = appState.data?.nodes.find((candidate) => candidate.id === node)?.name ?? node;
  return `${name}'s view`;
}

function listingSummary(listing: TreeListing | null): string {
  if (!listing) return viewName();
  return `${viewName()}, ${plural(listing.entries.length, "entry", "entries")}${listing.nextPage ? " shown" : ""}`;
}

function statusLines(explorer: ExplorerState): (HTMLElement | null)[] {
  const listing = explorer.listing;
  return [
    explorer.error ? element("div", { className: "warning level-error connection-lost" }, `${listing ? "This directory could not be refreshed" : "This directory could not be read"}: ${explorer.error}`) : null,
    ...(listing?.notes ?? []).map((note) => element("div", { className: "warning level-info connection-lost" }, note)),
  ];
}

export function renderExplorerPage(): HTMLElement {
  const explorer = appState.explorer;
  const listing = explorer.listing;
  return element(
    "div",
    { className: "page folders-page" },
    element("header", { className: "page-header" }, element("h1", {}, "Folders"), element("p", { className: "page-summary" }, listingSummary(listing))),
    element("div", { className: "filter-bar explorer-toolbar" }, nodeSelector(), searchBox()),
    breadcrumb(),
    legend(),
    ...statusLines(explorer),
    listing ? entryList(listing) : explorer.error ? null : element("p", { className: "muted" }, "Reading the directory…"),
    listing?.nextPage ? element("button", { className: "button explorer-more", attributes: { type: "button" }, onClick: showMore }, "Show more") : null,
  );
}
