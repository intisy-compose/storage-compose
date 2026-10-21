import type { NodesResponse, StorageNode, Warning } from "./api.js";
import { warningHref } from "./attentionPage.js";
import { element, progressBar } from "./dom.js";
import { formatBytes, usedFraction } from "./format.js";
import { icon } from "./icons.js";
import { isOffline, kindChipText, needsAttention, nodeTone, shortSyncState, spaceTone, thresholdChipText } from "./nodeStatus.js";
import { requestRender } from "./renderRequest.js";
import { type KindFilter, type ReachFilter, appState, locationFor } from "./state.js";

const filtersShownFrom = 7;
const warningsShownAbove = 3;

const reachFilters: [ReachFilter, string][] = [
  ["all", "All"],
  ["online", "Online"],
  ["offline", "Offline"],
  ["attention", "Needs attention"],
];

const kindFilters: [KindFilter, string][] = [
  ["all", "Any kind"],
  ["array", "Arrays"],
  ["drive", "Drives"],
  ["folder", "Folders"],
];

function matchesSearch(node: StorageNode, search: string): boolean {
  if (!search) return true;
  const haystack = [node.name, node.host, node.kind, ...node.folders.map((folder) => folder.id)].join(" ").toLowerCase();
  return search.toLowerCase().split(/\s+/).every((term) => haystack.includes(term));
}

function matchesReach(response: NodesResponse, node: StorageNode, filter: ReachFilter): boolean {
  if (filter === "online") return !isOffline(node);
  if (filter === "offline") return isOffline(node);
  if (filter === "attention") return needsAttention(response, node);
  return true;
}

function visibleNodes(response: NodesResponse): StorageNode[] {
  return response.nodes.filter(
    (node) =>
      matchesSearch(node, appState.search.trim()) &&
      matchesReach(response, node, appState.reachFilter) &&
      (appState.kindFilter === "all" || node.kind === appState.kindFilter),
  );
}

/** Online nodes first, then by name, so a long remote list leads with what can be acted on. */
function byReachThenName(left: StorageNode, right: StorageNode): number {
  const reach = Number(isOffline(left)) - Number(isOffline(right));
  return reach !== 0 ? reach : left.name.localeCompare(right.name, undefined, { numeric: true });
}

function chip(label: string, className = "chip"): HTMLElement {
  return element("span", { className }, label);
}

function remoteChip(node: StorageNode): HTMLElement | null {
  if (node.local) return null;
  if (isOffline(node)) return chip("offline", "chip chip-muted");
  return node.syncthing?.connectionType ? chip(node.syncthing.connectionType) : null;
}

function nodeRow(response: NodesResponse, node: StorageNode): HTMLElement {
  const tone = nodeTone(response, node);
  const state = shortSyncState(node, response);
  const fraction = usedFraction(node.space);
  const spaceTitle = node.space ? `${formatBytes(node.space.used)} of ${formatBytes(node.space.size)} used` : "space unknown";
  const isSelected = appState.selectedNodeId === node.id;
  const row = element(
    "a",
    {
      className: `node-row${isSelected ? " selected" : ""}${isOffline(node) ? " offline" : ""}`,
      attributes: { href: locationFor("nodes", node.id), "data-node": node.id },
    },
    element("span", { className: `dot tone-${tone}`, title: isOffline(node) ? "offline" : "online" }),
    element(
      "span",
      { className: "node-name" },
      element("strong", {}, node.name),
      node.local || node.host === node.name ? null : element("small", {}, `on ${node.host}`),
    ),
    element("span", { className: "node-chips" }, chip(kindChipText(node)), chip(thresholdChipText(node.threshold)), remoteChip(node)),
    element(
      "span",
      { className: "node-space", title: spaceTitle },
      progressBar(fraction, spaceTone(node), spaceTitle),
      element("small", {}, fraction === null ? "" : `${Math.round(fraction * 100)}%`),
    ),
    element("span", { className: `node-sync tone-text-${state.tone}` }, state.symbol ? `${state.symbol} ${state.label}` : state.label),
  );
  if (isSelected) row.setAttribute("aria-current", "true");
  return row;
}

function groupHeading(title: string, count: number, extra?: string): HTMLElement {
  return element("h2", { className: "group-heading" }, title, element("span", { className: "group-count" }, String(count)), extra ? element("small", {}, extra) : null);
}

function nodeGroup(response: NodesResponse, title: string, nodes: StorageNode[], total: number): HTMLElement | null {
  if (total === 0) return null;
  const hidden = total - nodes.length;
  const offlineCount = nodes.filter(isOffline).length;
  const extra = [offlineCount ? `${offlineCount} offline` : "", hidden ? `${hidden} hidden by filters` : ""].filter(Boolean).join(", ");
  const rows = [...nodes].sort(byReachThenName).map((node) => nodeRow(response, node));
  return element(
    "div",
    { className: "node-group" },
    groupHeading(title, total, extra),
    rows.length ? element("div", { className: "node-list" }, ...rows) : element("p", { className: "empty-line" }, "Nothing matches the filters."),
  );
}

export function warningBanner(warning: Warning): HTMLElement {
  const href = warningHref(warning);
  const banner = element(href ? "a" : "div", { className: `warning level-${warning.level}` }, element("span", { className: "warning-text" }, warning.text));
  if (href) banner.setAttribute("href", href);
  return banner;
}

function warningsArea(response: NodesResponse): HTMLElement | null {
  const shown = response.warnings.filter((warning) => warning.level !== "info");
  if (shown.length === 0) return null;
  const visible = shown.slice(0, warningsShownAbove);
  const more = shown.length - visible.length;
  return element(
    "div",
    { className: "warnings" },
    ...visible.map(warningBanner),
    more > 0 ? element("a", { className: "warnings-more", attributes: { href: locationFor("attention") } }, `${more} more on Attention`) : null,
  );
}

function filterButtons<Value extends string>(options: [Value, string][], current: Value, choose: (value: Value) => void): HTMLElement {
  return element(
    "div",
    { className: "segmented", attributes: { role: "group" } },
    ...options.map(([value, label]) => {
      const option = element("button", { className: value === current ? "segment on" : "segment", attributes: { type: "button", "aria-pressed": String(value === current) } }, label);
      option.addEventListener("click", () => {
        choose(value);
        requestRender();
      });
      return option;
    }),
  );
}

function searchBox(): HTMLElement {
  const input = element("input", {
    className: "search-input",
    attributes: { type: "search", placeholder: "Search nodes", "aria-label": "Search nodes", id: "node-search" },
  });
  input.value = appState.search;
  input.addEventListener("input", () => {
    appState.search = input.value;
    requestRender();
  });
  return element("label", { className: "search" }, icon("search"), input);
}

function filterBar(response: NodesResponse): HTMLElement | null {
  if (response.nodes.length < filtersShownFrom) return null;
  return element(
    "div",
    { className: "filter-bar" },
    searchBox(),
    filterButtons(reachFilters, appState.reachFilter, (value) => (appState.reachFilter = value)),
    filterButtons(kindFilters, appState.kindFilter, (value) => (appState.kindFilter = value)),
  );
}

export function renderNodesPage(response: NodesResponse): HTMLElement {
  const visible = visibleNodes(response);
  const local = response.nodes.filter((node) => node.local);
  const remote = response.nodes.filter((node) => !node.local);
  return element(
    "div",
    { className: "page nodes-page" },
    element("header", { className: "page-header" }, element("h1", {}, "Nodes"), element("p", { className: "page-summary" }, summaryText(response))),
    warningsArea(response),
    filterBar(response),
    nodeGroup(response, "This PC", visible.filter((node) => node.local), local.length),
    nodeGroup(response, "Remote", visible.filter((node) => !node.local), remote.length),
  );
}

function summaryText(response: NodesResponse): string {
  const online = response.nodes.filter((node) => !isOffline(node)).length;
  return `${response.nodes.length} nodes, ${online} online`;
}
