import { type NodesResponse, type StorageNode, type SyncthingDevice, type SyncthingInstance, addressLabel, reachTone } from "./api.js";
import { arraySections } from "./arraySection.js";
import { layoutRows, storageNodes } from "./devicePlacement.js";
import { element, keyValueList, progressBar, section } from "./dom.js";
import { formatAge, formatBytes, formatDate, formatDuration, formatPercent, formatRate, normaliseCompletion, usedFraction } from "./format.js";
import { icon } from "./icons.js";
import { warningBanner } from "./nodesPage.js";
import { arrayStateLabel, countRoles, isArrayAbsent, isNotConnected, isOffline, shortSyncState, spaceTone, warningsFor } from "./nodeStatus.js";
import { peersSection } from "./peersSection.js";
import { requestRender } from "./renderRequest.js";
import { appState, deviceFormLocation, locationFor } from "./state.js";

function kindText(node: StorageNode): string {
  if (node.kind === "device") return "a Syncthing device; no dashboard or join record says what it holds";
  if (!node.array) return node.kind === "folder" ? "folder (one directory)" : "drive (one whole drive or partition)";
  const { data, parity } = countRoles(node.array.members);
  return `array, ${data} data + ${parity} parity`;
}

function statusLine(response: NodesResponse, node: StorageNode): string {
  if (isArrayAbsent(node)) return `not connected, last seen ${formatAge(node.sync.lastSeen)}`;
  if (isOffline(node)) return `offline, last seen ${formatAge(node.sync.lastSeen)}`;
  const state = shortSyncState(node, response);
  const arrayState = node.array ? `, ${arrayStateLabel[node.array.state] ?? node.array.state}` : "";
  return `online${arrayState}, ${state.label}`;
}

function spaceValue(node: StorageNode): HTMLElement | string {
  if (!node.space) return isArrayAbsent(node) ? "unknown while not connected" : "unknown";
  const fraction = usedFraction(node.space);
  const label = `${formatBytes(node.space.used)} of ${formatBytes(node.space.size)} used`;
  return element("span", { className: "space-value" }, progressBar(fraction, spaceTone(node), label), element("small", {}, label));
}

function listeningText(instance: SyncthingInstance): string {
  const working = instance.listeners.filter((listener) => !listener.error).length;
  return `this node, listening on ${working} of ${instance.listeners.length} addresses`;
}

function connectionText(node: StorageNode): string {
  if (isArrayAbsent(node)) return "not connected";
  if (!node.syncthing) return node.local && node.online ? "its Syncthing is not answering" : "no Syncthing device known";
  if (node.instance) return listeningText(node.instance);
  return node.syncthing.connectionType ?? "not connected";
}

function overviewSection(node: StorageNode): HTMLElement {
  const device = node.syncthing;
  return section(
    "Overview",
    keyValueList([
      ["Space", spaceValue(node)],
      ["Connection", connectionText(node)],
      ...(device ? ([["Traffic", `↓ ${formatRate(device.inRate)}  ↑ ${formatRate(device.outRate)}`]] as [string, string][]) : []),
    ]),
  );
}

function copyButton(value: string): HTMLButtonElement {
  const copy = element("button", { className: "icon-button", title: "Copy", attributes: { type: "button", "aria-label": "Copy device ID" } }, icon("copy"));
  copy.addEventListener("click", () => {
    navigator.clipboard?.writeText(value).then(
      () => (appState.notice = { text: "Device ID copied.", tone: "ok" }),
      () => (appState.notice = { text: "Copying needs a secure page; select the ID instead.", tone: "bad" }),
    ).finally(requestRender);
  });
  return copy;
}

function addressList(device: SyncthingDevice): HTMLElement | string {
  if (!device.addresses.length) return "none known";
  return element("span", { className: "address-list" }, ...device.addresses.map((address) => element("code", { title: address }, addressLabel(address))));
}

/** Opens the device form on the node's own device, which shows only its name. */
function renameLink(node: StorageNode, device: SyncthingDevice): HTMLElement | null {
  if (!node.local || isNotConnected(node)) return null;
  const link = element("a", { className: "button", title: "The name other devices are offered for this node", attributes: { href: deviceFormLocation(node.id, device.deviceId) } }, "Rename");
  return element("div", { className: "button-row" }, link);
}

function syncthingSection(node: StorageNode): HTMLElement | null {
  const device = node.syncthing;
  if (!device) return null;
  return section(
    "Connection (Syncthing)",
    keyValueList([
      ["Device ID", [element("code", { className: "device-id", title: device.deviceId }, device.deviceId), copyButton(device.deviceId)]],
      ["Addresses", addressList(device)],
    ]),
    renameLink(node, device),
  );
}

function listenerList(instance: SyncthingInstance): HTMLElement | string {
  if (!instance.listeners.length) return "none";
  return element(
    "span",
    { className: "address-list" },
    ...instance.listeners.map((listener) =>
      element("code", { className: listener.error ? "tone-text-bad" : "", title: listener.error ?? "" }, listener.error ? `${listener.address} (${listener.error})` : listener.address),
    ),
  );
}

function instanceRows(instance: SyncthingInstance): [string, HTMLElement | string][] {
  return [
    ["Listeners", listenerList(instance)],
    ["Discovery", instance.discoveryErrors.length ? element("span", { className: "tone-text-bad" }, instance.discoveryErrors.join("; ")) : "working"],
    ["Uptime", `${formatDuration(instance.uptime * 1000)}, ${instance.cpuPercent.toFixed(1)}% CPU, ${formatBytes(instance.memoryBytes)} memory`],
    ["Totals", `↓ ${formatBytes(instance.inTotal)}  ↑ ${formatBytes(instance.outTotal)}`],
  ];
}

function detailRows(node: StorageNode): [string, HTMLElement | string][] {
  return [
    ["Kind", kindText(node)],
    ...layoutRows(node),
    ["Host", node.local ? `${node.host} (this PC)` : node.host],
    ["Node ID", element("code", {}, node.id)],
    ...(node.instance ? instanceRows(node.instance) : []),
    ...(node.syncthing ? ([["Version", node.syncthing.version ?? "unknown"]] as [string, string][]) : []),
  ];
}

function detailsSection(node: StorageNode): HTMLElement {
  const toggle = element("button", { className: "disclosure", attributes: { type: "button", "aria-expanded": String(appState.showNodeDetails) } }, "Details");
  toggle.addEventListener("click", () => {
    appState.showNodeDetails = !appState.showNodeDetails;
    requestRender();
  });
  return element(
    "section",
    { className: "detail-section node-details" },
    toggle,
    appState.showNodeDetails ? keyValueList(detailRows(node)) : null,
    appState.showNodeDetails && node.local ? element("p", { className: "muted small" }, "Threshold and assigned directories become editable with the layered sync; they change through the setup repo.") : null,
  );
}

function folderStateTone(state: string): string {
  if (state === "idle" || state === "up to date") return "ok";
  if (state.includes("error") || state.includes("fail")) return "bad";
  if (state === "paused" || state === "unknown") return "muted";
  return "accent";
}

function folderRow(folder: StorageNode["folders"][number]): HTMLElement {
  const completion = normaliseCompletion(folder.completion);
  const tone = folderStateTone(folder.state);
  const stateText = folder.state === "idle" && completion >= 1 ? "up to date" : completion < 1 ? `${folder.state}, ${formatPercent(completion)}` : folder.state;
  const failed = folder.errors ? `${folder.errors} failed ${folder.errors === 1 ? "item" : "items"}` : null;
  return element(
    "div",
    { className: "folder-row", title: `${folder.path} (${folder.type})` },
    element("span", { className: "folder-name" }, element("strong", {}, folder.label || folder.id), element("small", {}, folder.path), folder.lastScan ? element("small", {}, `scanned ${formatDate(folder.lastScan)}`) : null),
    element("span", { className: "chip" }, folder.type),
    element("span", { className: "folder-state" }, element("span", { className: `tone-text-${tone}` }, stateText), failed ? element("small", { className: "tone-text-bad" }, failed) : null),
  );
}

function foldersSection(node: StorageNode): HTMLElement {
  return section(
    `Folders on this node (${node.folders.length})`,
    node.folders.length ? element("div", { className: "folder-list" }, ...node.folders.map(folderRow)) : element("p", { className: "muted" }, "No folders shared with this node."),
  );
}

function readOnlyNote(node: StorageNode): HTMLElement | null {
  if (node.local) return null;
  const reach = isOffline(node) ? `${node.host} cannot be reached; this is Syncthing's last view of it.` : `Actions run on ${node.host}'s own dashboard.`;
  return element("p", { className: "read-only-note" }, `Read-only. ${reach}`);
}

function noticeLine(): HTMLElement | null {
  const notice = appState.notice;
  return notice ? element("p", { className: `notice tone-text-${notice.tone}`, attributes: { role: "status" } }, notice.text) : null;
}

function detailHeader(response: NodesResponse, node: StorageNode): HTMLElement {
  return element(
    "header",
    { className: "detail-header" },
    element("a", { className: "icon-button close-detail", title: "Close", attributes: { href: locationFor("nodes"), "aria-label": "Close detail" } }, icon("close")),
    element("h2", {}, node.name),
    element("p", { className: "detail-status" }, element("span", { className: `dot tone-${reachTone(node)}` }), statusLine(response, node)),
  );
}

export function renderNodeDetail(response: NodesResponse, node: StorageNode): HTMLElement {
  const warnings = warningsFor(response, node);
  return element(
    "div",
    { className: "detail-inner" },
    detailHeader(response, node),
    readOnlyNote(node),
    noticeLine(),
    warnings.length ? element("div", { className: "warnings" }, ...warnings.map(warningBanner)) : null,
    overviewSection(node),
    ...(node.array ? arraySections(node, node.array) : []),
    syncthingSection(node),
    peersSection(response, node),
    foldersSection(node),
    detailsSection(node),
  );
}

export function renderEmptyDetail(response: NodesResponse): HTMLElement {
  const nodes = storageNodes(response.nodes);
  const local = nodes.filter((node) => node.local).length;
  return element(
    "div",
    { className: "detail-inner detail-empty" },
    element("p", {}, "Select a device to see how it is connected, a node for its drives, parity and folders, or a drive for where it has been."),
    element("p", { className: "muted small" }, `${local} on this PC, ${nodes.length - local} remote.`),
  );
}
