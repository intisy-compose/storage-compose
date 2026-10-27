import { type NodeEntryState, type PriorityInfo, type TreeEntry, type TreeListing, statusPresentation } from "./api.js";
import { element, keyValueList, section } from "./dom.js";
import { presentationClasses, priorityCell, stateParts, statusDot } from "./explorerRow.js";
import { formatBytes, formatDate } from "./format.js";
import { icon } from "./icons.js";
import { requestRender } from "./renderRequest.js";
import { addableNodes } from "./folderForm.js";
import { addFolderLocation, appState } from "./state.js";

type Override = TreeListing["overridesBelow"][number];

export interface FolderRootPriority {
  info: PriorityInfo;
  overridesBelow: Override[];
}

/** Every row read so far: the shown directory and each expanded one. */
export function loadedEntries(): TreeEntry[] {
  const explorer = appState.explorer;
  return [...(explorer.listing?.entries ?? []), ...[...explorer.children.values()].flatMap((listing) => listing.entries)];
}

/** The shown directory's list covers everything below it, so any loaded row's overrides are a filter of it. */
function overridesBelowPath(path: string): Override[] {
  const all = appState.explorer.listing?.overridesBelow ?? [];
  if (!path) return all;
  const prefix = `${path.toLowerCase()}/`;
  return all.filter((override) => override.path.toLowerCase().startsWith(prefix));
}

export function folderRootPriority(folderId: string): FolderRootPriority | null {
  const entry = loadedEntries().find((candidate) => candidate.folder?.id === folderId);
  return entry ? { info: entry.priority, overridesBelow: overridesBelowPath(entry.path) } : null;
}

function overrideList(overrides: Override[]): HTMLElement | string {
  if (!overrides.length) return "none";
  return element(
    "ul",
    { className: "override-list" },
    ...overrides.map((override) => element("li", {}, element("code", {}, override.path), ` ${override.priority} (parent ${override.parent})`)),
  );
}

export function prioritySection(info: PriorityInfo, overrides: Override[], isTopDirectory = false): HTMLElement {
  return section(
    "Priority",
    keyValueList([
      ["Priority", priorityCell(info, isTopDirectory)],
      ["Overrides below", overrideList(overrides)],
    ]),
    element("p", { className: "muted small" }, "Changes through the setup repo."),
  );
}

function nodeStateLine(state: NodeEntryState): HTMLElement {
  const shown = statusPresentation(state);
  return element("li", { className: "node-state-line" }, statusDot(state), element("strong", {}, state.nodeName), element("span", { className: `node-state ${presentationClasses(shown)}` }, ...stateParts(state, true)));
}

function closeButton(): HTMLElement {
  const close = element("button", { className: "icon-button close-detail", title: "Close", attributes: { type: "button", "aria-label": "Close detail" } }, icon("close"));
  close.addEventListener("click", () => {
    appState.explorer.selectedPath = null;
    requestRender();
  });
  return close;
}

/** Offers the directory as a new folder, unless it already is one or no node here can take one. */
function addAsFolderLink(path: string, isFolder: boolean): HTMLElement | null {
  if (isFolder || !addableNodes().length) return null;
  return element("p", {}, element("a", { className: "button", attributes: { href: addFolderLocation(appState.explorer.node, path) } }, "Add as a folder"));
}

function entryDetail(entry: TreeEntry): HTMLElement {
  const facts: [string, HTMLElement | string][] = [["Path", element("code", {}, entry.path)]];
  if (entry.kind === "file") facts.push(["Size", formatBytes(entry.size)]);
  facts.push(["Modified", entry.modified ? formatDate(entry.modified) : "unknown"]);
  return element(
    "div",
    { className: "detail-inner" },
    element("header", { className: "detail-header" }, closeButton(), element("h2", {}, entry.name), element("p", { className: "detail-status muted" }, entry.kind === "directory" ? "Directory" : "File")),
    section("Where", keyValueList(facts)),
    prioritySection(entry.priority, entry.kind === "directory" ? overridesBelowPath(entry.path) : []),
    section("On each node", entry.nodes.length ? element("ul", { className: "node-state-list" }, ...entry.nodes.map(nodeStateLine)) : element("p", { className: "muted" }, "No node viewed has it.")),
    section("Held by", entry.availability.length ? element("p", {}, entry.availability.map((device) => device.name).join(", ")) : element("p", { className: "muted" }, "No connected device reports a copy.")),
    entry.kind === "directory" ? addAsFolderLink(entry.path, entry.folder !== null) : null,
  );
}

function directoryDetail(listing: TreeListing | null): HTMLElement {
  const path = appState.explorer.path;
  const name = path ? (path.split("/").pop() as string) : "All data";
  return element(
    "div",
    { className: "detail-inner" },
    element("header", { className: "detail-header" }, element("h2", {}, name), element("p", { className: "detail-status muted" }, path ? element("code", {}, path) : "The top directory")),
    listing ? prioritySection(listing.priority, listing.overridesBelow, !path) : element("p", { className: "muted" }, "Reading the directory…"),
    path ? addAsFolderLink(path, false) : null,
    element("p", { className: "muted small" }, "Select a row to see each node's state of it; select a row with a folder chip for that folder's copies and settings."),
  );
}

export function renderExplorerDetail(): HTMLElement {
  const selectedPath = appState.explorer.selectedPath;
  const entry = selectedPath === null ? null : loadedEntries().find((candidate) => candidate.path === selectedPath);
  return entry ? entryDetail(entry) : directoryDetail(appState.explorer.listing);
}
