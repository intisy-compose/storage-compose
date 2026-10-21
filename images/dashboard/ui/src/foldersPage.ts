import type { FolderCopy, FolderSummary, FoldersResponse } from "./api.js";
import { element } from "./dom.js";
import { formatPercent, normaliseCompletion, plural } from "./format.js";
import { icon } from "./icons.js";
import type { Tone } from "./nodeStatus.js";
import { requestRender } from "./renderRequest.js";
import { appState, locationFor } from "./state.js";

export interface FolderCondition {
  rank: number;
  tone: Tone;
  label: string;
}

/** How one copy stands; a higher rank is worse. */
export function copyCondition(copy: FolderCopy): FolderCondition {
  const completion = normaliseCompletion(copy.completion);
  if (copy.state.includes("error")) return { rank: 6, tone: "bad", label: copy.state };
  if (copy.errors > 0) return { rank: 5, tone: "bad", label: plural(copy.errors, "failed item") };
  if (copy.state === "unknown") return { rank: 4, tone: "muted", label: "not answering" };
  if (completion < 1) return { rank: 3, tone: "accent", label: `${copy.state}, ${formatPercent(completion)}` };
  if (copy.state === "paused") return { rank: 2, tone: "muted", label: "paused" };
  if (copy.state !== "idle") return { rank: 1, tone: "accent", label: copy.state };
  return { rank: 0, tone: "ok", label: "up to date" };
}

export function worstCondition(summary: FolderSummary): FolderCondition {
  if (!summary.copies.length) return { rank: 0, tone: "muted", label: "not accepted anywhere" };
  return summary.copies.map(copyCondition).reduce((worst, next) => (next.rank > worst.rank ? next : worst));
}

function distinct(values: string[]): string[] {
  return [...new Set(values)];
}

export function placementText(summary: FolderSummary): string {
  const kept = summary.copies.length ? `kept on ${plural(summary.copies.length, "node")}` : "kept on no node";
  const offeredTo = distinct(summary.offers.map((offer) => offer.nodeName));
  return offeredTo.length ? `${kept}, offered to ${offeredTo.join(", ")}` : kept;
}

/** The layered sync's categories: synced from 80, archive from 30, local below. */
export function priorityBand(priority: number): "high" | "middle" | "low" {
  if (priority >= 80) return "high";
  if (priority >= 30) return "middle";
  return "low";
}

export const priorityUnsetText = "not set by the layered sync yet";

function priorityChip(summary: FolderSummary): HTMLElement {
  if (summary.priority === null) return element("span", { className: "chip chip-muted", title: `Priority ${priorityUnsetText}` }, "no priority");
  return element("span", { className: `chip priority-chip band-${priorityBand(summary.priority)}`, title: "Priority from the setup repo" }, `priority ${summary.priority}`);
}

function matchesSearch(summary: FolderSummary, search: string): boolean {
  if (!search) return true;
  const haystack = [summary.id, summary.label, ...summary.copies.flatMap((copy) => [copy.nodeName, copy.host, copy.path]), ...summary.offers.map((offer) => offer.nodeName)].join(" ").toLowerCase();
  return search.toLowerCase().split(/\s+/).every((term) => haystack.includes(term));
}

function folderRow(summary: FolderSummary): HTMLElement {
  const condition = worstCondition(summary);
  const isSelected = appState.selectedFolderId === summary.id;
  const row = element(
    "a",
    { className: `folder-index-row${isSelected ? " selected" : ""}`, attributes: { href: locationFor("folders", summary.id), "data-folder": summary.id } },
    element("span", { className: `dot tone-${condition.tone}` }),
    element("span", { className: "node-name" }, element("strong", {}, summary.label), summary.label === summary.id ? null : element("small", {}, summary.id)),
    element("span", { className: "folder-placement" }, placementText(summary)),
    element("span", { className: "folder-priority" }, priorityChip(summary)),
    element("span", { className: `node-sync tone-text-${condition.tone}` }, condition.label),
  );
  if (isSelected) row.setAttribute("aria-current", "true");
  return row;
}

function searchBox(): HTMLElement {
  const input = element("input", {
    className: "search-input",
    attributes: { type: "search", placeholder: "Search folders, nodes or paths", "aria-label": "Search folders", id: "folder-search" },
  });
  input.value = appState.folderSearch;
  input.defaultValue = appState.folderSearch;
  input.addEventListener("input", () => {
    appState.folderSearch = input.value;
    requestRender();
  });
  return element("label", { className: "search" }, icon("search"), input);
}

function summaryText(response: FoldersResponse): string {
  const nodes = distinct(response.folders.flatMap((folder) => folder.copies.map((copy) => copy.nodeId)));
  return `${plural(response.folders.length, "folder")} on ${plural(nodes.length, "node")}`;
}

function folderList(response: FoldersResponse): HTMLElement {
  if (!response.folders.length) return element("p", { className: "empty-line" }, "No node has a folder and none is offered.");
  const visible = response.folders.filter((summary) => matchesSearch(summary, appState.folderSearch.trim()));
  return visible.length ? element("div", { className: "node-list" }, ...visible.map(folderRow)) : element("p", { className: "empty-line" }, "No folder matches the search.");
}

export function renderFoldersPage(): HTMLElement {
  const response = appState.folders;
  const header = element("header", { className: "page-header" }, element("h1", {}, "Folders"), response ? element("p", { className: "page-summary" }, summaryText(response)) : null);
  if (!response) {
    const status = appState.foldersError ? element("div", { className: "warning level-error" }, `Folders could not be read: ${appState.foldersError}`) : element("p", { className: "muted" }, "Loading folders…");
    return element("div", { className: "page folders-page" }, header, status);
  }
  return element(
    "div",
    { className: "page folders-page" },
    header,
    appState.foldersError ? element("div", { className: "warning level-error connection-lost" }, `Folders could not be refreshed: ${appState.foldersError}`) : null,
    element("div", { className: "filter-bar" }, searchBox()),
    folderList(response),
  );
}
