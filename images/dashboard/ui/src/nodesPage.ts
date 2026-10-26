import type { DevicesResponse, NodesResponse, StorageNode, Warning } from "./api.js";
import { warningHref } from "./attentionPage.js";
import { deviceBlocks } from "./deviceList.js";
import { type KindFilter, type NodeFilters, type ReachFilter, byReachThenName, placeOnDevices, storageNodes, visibleUnplacedNodes } from "./devicePlacement.js";
import { element } from "./dom.js";
import { plural } from "./format.js";
import { icon } from "./icons.js";
import { nodeRow } from "./nodeRow.js";
import { isOffline } from "./nodeStatus.js";
import { requestRender } from "./renderRequest.js";
import { appState, locationFor } from "./state.js";

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

function devicesStatus(devices: DevicesResponse | null): HTMLElement | null {
  if (devices && !appState.devicesError) return null;
  const text = appState.devicesError ? `Devices could not be read: ${appState.devicesError}` : "Reading devices…";
  return element("p", { className: "muted small devices-status" }, text);
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
    attributes: { type: "search", placeholder: "Search devices, nodes and drives", "aria-label": "Search devices, nodes and drives", id: "node-search" },
  });
  input.value = appState.search;
  input.addEventListener("input", () => {
    appState.search = input.value;
    requestRender();
  });
  return element("label", { className: "search" }, icon("search"), input);
}

function filterBar(response: NodesResponse, devices: DevicesResponse | null): HTMLElement | null {
  const rowCount = response.nodes.length + (devices ? devices.devices.length + devices.drives.length : 0);
  if (rowCount < filtersShownFrom) return null;
  return element(
    "div",
    { className: "filter-bar" },
    searchBox(),
    filterButtons(reachFilters, appState.reachFilter, (value) => (appState.reachFilter = value)),
    filterButtons(kindFilters, appState.kindFilter, (value) => (appState.kindFilter = value)),
  );
}

function currentFilters(): NodeFilters {
  return { search: appState.search.trim(), reach: appState.reachFilter, kind: appState.kindFilter };
}

export function renderNodesPage(response: NodesResponse, devices: DevicesResponse | null): HTMLElement {
  const filters = currentFilters();
  const { placements, unplacedNodes } = placeOnDevices(response.nodes, devices);
  const blocks = devices ? deviceBlocks(response, devices, placements, filters) : [];
  const unplacedShown = visibleUnplacedNodes(response, unplacedNodes, filters);
  const isEverythingFiltered = devices !== null && blocks.length === 0 && unplacedNodes.length === 0;
  return element(
    "div",
    { className: "page nodes-page" },
    element("header", { className: "page-header" }, element("h1", {}, "Nodes"), element("p", { className: "page-summary" }, summaryText(response, devices))),
    warningsArea(response),
    filterBar(response, devices),
    devicesStatus(devices),
    ...blocks,
    nodeGroup(response, devices ? "Other nodes" : "Nodes", unplacedShown, unplacedNodes.length),
    isEverythingFiltered ? element("p", { className: "empty-line" }, "Nothing matches the filters.") : null,
  );
}

function summaryText(response: NodesResponse, devices: DevicesResponse | null): string {
  const nodes = storageNodes(response.nodes);
  const online = nodes.filter((node) => !isOffline(node)).length;
  const nodeText = `${plural(nodes.length, "node")}, ${online} online`;
  if (!devices) return nodeText;
  return `${plural(devices.devices.length, "device")}, ${nodeText}, ${plural(devices.drives.length, "drive")}`;
}
