import { type DeviceSummary, type DevicesResponse, type DriveSummary, type NodesResponse, type StorageNode, type Warning, reachTone } from "./api.js";
import { warningHref } from "./attentionPage.js";
import { type DevicePlacement, arrayMembers, deviceLine, looseDriveRow, matchesDeviceSearch, matchesDriveSearch, memberDrive, placeOnDevices } from "./deviceList.js";
import { element, progressBar } from "./dom.js";
import { formatBytes, plural, usedFraction } from "./format.js";
import { icon } from "./icons.js";
import { actionableWarnings, isArrayAbsent, isOffline, kindChipText, needsAttention, shortSyncState, spaceTone, thresholdChipText } from "./nodeStatus.js";
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

function searchText(): string {
  return appState.search.trim();
}

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

function passesNodeFilters(response: NodesResponse, node: StorageNode): boolean {
  return matchesReach(response, node, appState.reachFilter) && (appState.kindFilter === "all" || node.kind === appState.kindFilter);
}

function visibleNodes(response: NodesResponse, nodes: StorageNode[]): StorageNode[] {
  return nodes.filter((node) => matchesSearch(node, searchText()) && passesNodeFilters(response, node));
}

function passesDriveFilters(drive: DriveSummary): boolean {
  if (appState.kindFilter !== "all" && appState.kindFilter !== "drive") return false;
  if (appState.reachFilter === "online") return drive.present;
  if (appState.reachFilter === "offline") return !drive.present;
  return appState.reachFilter !== "attention";
}

function passesDeviceFilters(device: DeviceSummary): boolean {
  if (appState.kindFilter !== "all") return false;
  if (appState.reachFilter === "online") return device.online;
  if (appState.reachFilter === "offline") return !device.online;
  return appState.reachFilter !== "attention";
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

export function reachText(node: StorageNode): string {
  if (isArrayAbsent(node)) return "not connected";
  return isOffline(node) ? "offline" : "online";
}

/** A separate mark, so a node with warnings still shows by its dot whether it can be reached. */
export function warningMark(response: NodesResponse, node: StorageNode): HTMLElement | null {
  const warnings = actionableWarnings(response, node);
  if (warnings.length === 0) return null;
  const tone = warnings.some((warning) => warning.level === "error") ? "bad" : "warn";
  const text = `${warnings.length} ${warnings.length === 1 ? "warning" : "warnings"}`;
  const title = warnings.map((warning) => warning.text).join("\n");
  return element("span", { className: `warning-mark tone-mark-${tone}`, title, attributes: { role: "img", "aria-label": text } }, `! ${warnings.length}`);
}

function nodeRow(response: NodesResponse, node: StorageNode): HTMLElement {
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
    element("span", { className: `dot tone-${reachTone(node)}`, title: reachText(node) }),
    element(
      "span",
      { className: "node-name" },
      element("span", { className: "node-title" }, element("strong", {}, node.name), warningMark(response, node)),
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

function matchingMembers(node: StorageNode, drives: DriveSummary[], search: string): boolean {
  return (node.array?.members ?? []).some((member) => {
    const drive = memberDrive(node, member, drives);
    return drive ? matchesDriveSearch(drive, search) : `${member.label} ${member.role} ${member.serial ?? ""}`.toLowerCase().includes(search.toLowerCase());
  });
}

interface DeviceRows {
  nodes: StorageNode[];
  drives: DriveSummary[];
}

/** What of a device the search and filters leave; a device that matches the search keeps every row that passes the filters. */
function deviceRows(response: NodesResponse, placement: DevicePlacement, drives: DriveSummary[]): DeviceRows {
  const search = searchText();
  const isDeviceMatch = matchesDeviceSearch(placement.device, search);
  const nodes = placement.nodes.filter(
    (node) => passesNodeFilters(response, node) && (isDeviceMatch || matchesSearch(node, search) || matchingMembers(node, drives, search)),
  );
  const looseDrives = placement.looseDrives.filter((drive) => passesDriveFilters(drive) && (isDeviceMatch || matchesDriveSearch(drive, search)));
  return { nodes, drives: looseDrives };
}

function isDeviceShown(placement: DevicePlacement, rows: DeviceRows): boolean {
  if (rows.nodes.length || rows.drives.length) return true;
  return passesDeviceFilters(placement.device) && matchesDeviceSearch(placement.device, searchText());
}

function memberCount(placement: DevicePlacement): number {
  return placement.nodes.reduce((sum, node) => sum + (node.array?.members.length ?? 0), 0);
}

function deviceBlock(response: NodesResponse, devices: DevicesResponse, placement: DevicePlacement, now: Date): HTMLElement | null {
  const rows = deviceRows(response, placement, devices.drives);
  if (!isDeviceShown(placement, rows)) return null;
  const nodeRows = [...rows.nodes].sort(byReachThenName).flatMap((node) => [nodeRow(response, node), arrayMembers(node, devices.drives, placement.device, now)]);
  const driveRows = rows.drives.map((drive) => looseDriveRow(drive, placement.device, now));
  const listed = [...nodeRows, ...driveRows].filter((row) => row !== null);
  return element(
    "section",
    { className: "device-block", attributes: { "aria-label": placement.device.name } },
    deviceLine(placement, memberCount(placement), now),
    listed.length ? element("div", { className: "node-list" }, ...listed) : null,
  );
}

function deviceBlocks(response: NodesResponse, devices: DevicesResponse | null): HTMLElement[] {
  if (!devices) return [];
  const now = new Date();
  const { placements } = placeOnDevices(response.nodes, devices);
  return placements.map((placement) => deviceBlock(response, devices, placement, now)).filter((block) => block !== null);
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

export function renderNodesPage(response: NodesResponse, devices: DevicesResponse | null): HTMLElement {
  const { unplacedNodes } = placeOnDevices(response.nodes, devices);
  const blocks = deviceBlocks(response, devices);
  const unplacedShown = visibleNodes(response, unplacedNodes);
  const isEverythingFiltered = devices !== null && blocks.length === 0 && unplacedShown.length === 0;
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
  const online = response.nodes.filter((node) => !isOffline(node)).length;
  const nodes = `${plural(response.nodes.length, "node")}, ${online} online`;
  if (!devices) return nodes;
  return `${plural(devices.devices.length, "device")}, ${nodes}, ${plural(devices.drives.length, "drive")}`;
}
