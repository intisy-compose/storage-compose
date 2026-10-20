import type { NodesResponse, StorageNode, SyncthingDevice } from "./api.js";
import { arraySections } from "./arraySection.js";
import { button, element, keyValueList, progressBar, section } from "./dom.js";
import { formatAge, formatBytes, formatPercent, formatRate, normaliseCompletion, usedFraction } from "./format.js";
import { icon } from "./icons.js";
import { warningBanner } from "./nodesPage.js";
import { countRoles, isOffline, nodeTone, shortSyncState, spaceTone, warningsFor } from "./nodeStatus.js";
import { requestRender } from "./renderRequest.js";
import { appState, locationFor } from "./state.js";

function kindText(node: StorageNode): string {
  if (!node.array) return node.kind === "folder" ? "folder (one directory)" : "drive (one whole drive or partition)";
  const { data, parity } = countRoles(node.array.members);
  return `array, ${data} data + ${parity} parity`;
}

function thresholdText(threshold: number): string {
  return threshold === 0 ? "0 (keeps everything)" : `${threshold} (keeps priority ${threshold} and above)`;
}

function statusLine(node: StorageNode): string {
  if (isOffline(node)) return `offline, last seen ${formatAge(node.sync.lastSeen)}`;
  const state = shortSyncState(node);
  const arrayState = node.array ? `, ${node.array.state}` : "";
  return `online${arrayState}, ${state.label}`;
}

function spaceValue(node: StorageNode): HTMLElement | string {
  if (!node.space) return "unknown";
  const fraction = usedFraction(node.space);
  const label = `${formatBytes(node.space.used)} of ${formatBytes(node.space.size)} used`;
  return element("span", { className: "space-value" }, progressBar(fraction, spaceTone(node), label), element("small", {}, label));
}

function nodeSection(node: StorageNode): HTMLElement {
  return section(
    "Node",
    keyValueList([
      ["Kind", kindText(node)],
      ["Threshold", thresholdText(node.threshold)],
      ["Assigned", node.assigned.length ? node.assigned.join(", ") : "none"],
      ["Space", spaceValue(node)],
      ["Host", node.local ? `${node.host} (this PC)` : node.host],
      ["Node ID", element("code", {}, node.id)],
    ]),
    node.local ? element("p", { className: "muted small" }, "Threshold and assigned directories become editable with the layered sync; they change through the setup repo.") : null,
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

function syncthingSection(device: SyncthingDevice | null): HTMLElement {
  if (!device) return section("Connection (Syncthing)", element("p", { className: "muted" }, "No Syncthing device for this node yet."));
  return section(
    "Connection (Syncthing)",
    keyValueList([
      ["Device ID", [element("code", { className: "device-id", title: device.deviceId }, device.deviceId), copyButton(device.deviceId)]],
      ["Addresses", device.addresses.length ? element("span", { className: "address-list" }, ...device.addresses.map((address) => element("code", {}, address))) : "none known"],
      ["Connection", device.connectionType ?? "not connected"],
      ["Traffic", `↓ ${formatRate(device.inRate)}  ↑ ${formatRate(device.outRate)}`],
      ["Version", device.version ?? "unknown"],
    ]),
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
  return element(
    "div",
    { className: "folder-row", title: `${folder.path} (${folder.type})` },
    element("span", { className: "folder-name" }, element("strong", {}, folder.id), element("small", {}, folder.path)),
    element("span", { className: "chip" }, folder.type),
    element("span", { className: `tone-text-${tone}` }, stateText),
  );
}

function foldersSection(node: StorageNode): HTMLElement {
  return section(
    `Folders on this node (${node.folders.length})`,
    node.folders.length ? element("div", { className: "folder-list" }, ...node.folders.map(folderRow)) : element("p", { className: "muted" }, "No folders shared with this node."),
    node.local
      ? element(
          "div",
          { className: "button-row" },
          ...["Pause node", "Rename", "Remove node…"].map((label) => {
            const disabled = button(label, () => {}, "button");
            disabled.disabled = true;
            disabled.title = "Comes with the layered sync";
            return disabled;
          }),
        )
      : null,
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
  const tone = nodeTone(response, node);
  return element(
    "header",
    { className: "detail-header" },
    element("a", { className: "icon-button close-detail", title: "Close", attributes: { href: locationFor("nodes"), "aria-label": "Close detail" } }, icon("close")),
    element("h2", {}, node.name),
    element("p", { className: "detail-status" }, element("span", { className: `dot tone-${tone}` }), statusLine(node)),
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
    nodeSection(node),
    ...(node.array ? arraySections(node, node.array) : []),
    syncthingSection(node.syncthing),
    foldersSection(node),
  );
}

export function renderEmptyDetail(response: NodesResponse): HTMLElement {
  const local = response.nodes.filter((node) => node.local).length;
  return element(
    "div",
    { className: "detail-inner detail-empty" },
    element("p", {}, "Select a node to see its drives, parity, connection and folders."),
    element("p", { className: "muted small" }, `${local} on this PC, ${response.nodes.length - local} remote.`),
  );
}
