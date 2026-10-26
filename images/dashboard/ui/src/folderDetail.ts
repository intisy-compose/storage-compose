import { type FolderCopy, type FolderDetailResponse, type FolderSettings, type FolderSummary, type PendingFolderOffer, deviceDisplayName, folderTypeTexts } from "./api.js";
import { element, keyValueList, section } from "./dom.js";
import { formatBytes, formatDate, formatDuration, formatPercent, normaliseCompletion, plural } from "./format.js";
import { type FolderRootPriority, prioritySection } from "./explorerDetail.js";
import { copyCondition, placementText, priorityBand, priorityUnsetText, worstCondition } from "./folderCondition.js";
import { icon } from "./icons.js";
import { appState, explorerLocation, locationFor } from "./state.js";

function onOff(value: boolean): string {
  return value ? "on" : "off";
}

function seconds(value: number): string {
  return value > 0 ? formatDuration(value * 1000) : "never";
}

function priorityText(summary: FolderSummary): HTMLElement | string {
  if (summary.priority === null) return priorityUnsetText;
  return element("span", { className: `priority-text band-${priorityBand(summary.priority)}` }, `${summary.priority}, from the setup repo`);
}

function itemsText(copy: FolderCopy): string {
  const items = copy.globalFiles + copy.globalDirectories;
  return `${plural(items, "item")} (${plural(copy.globalFiles, "file")}, ${plural(copy.globalDirectories, "folder")}), ${formatBytes(copy.globalBytes)}`;
}

function outOfSyncText(copy: FolderCopy): string {
  if (!copy.needItems && !copy.needBytes) return "nothing";
  return `${plural(copy.needItems, "item")}, ${formatBytes(copy.needBytes)} (${formatPercent(normaliseCompletion(copy.completion))} done)`;
}

function lastFileText(copy: FolderCopy): string {
  if (!copy.lastFile) return "none yet";
  return `${copy.lastFile.filename}${copy.lastFile.deleted ? " (deleted)" : ""}, ${formatDate(copy.lastFile.at)}`;
}

function copyCard(copy: FolderCopy): HTMLElement {
  const condition = copyCondition(copy);
  const rows: [string, HTMLElement | string][] = [
    ["Path", element("code", {}, copy.path)],
    ["Type", folderTypeTexts[copy.type] ?? copy.type],
    ["State", element("span", { className: `tone-text-${condition.tone}` }, condition.label)],
    ["Global", itemsText(copy)],
    ["Out of sync", outOfSyncText(copy)],
    ["Failed items", copy.errors ? element("span", { className: "tone-text-bad" }, plural(copy.errors, "item")) : "none"],
  ];
  if (copy.type === "receiveonly") rows.push(["Changed here", plural(copy.localChanged, "item")]);
  rows.push(
    ["Last scan", formatDate(copy.lastScan)],
    ["Last file", lastFileText(copy)],
    ["Shared with", copy.sharedWith.length ? copy.sharedWith.map((peer) => peer.name).join(", ") : "no other device"],
  );
  return element(
    "div",
    { className: "copy-card" },
    element(
      "h4",
      {},
      element("a", { attributes: { href: locationFor("nodes", copy.nodeId) } }, copy.nodeName),
      copy.local ? null : element("small", {}, ` on ${copy.host}`),
    ),
    keyValueList(rows),
  );
}

function offerLine(offer: PendingFolderOffer): HTMLElement {
  return element(
    "p",
    { className: "offer-line" },
    `offered by ${offer.offeredByName}, not accepted on ${offer.nodeName}`,
    element("small", {}, `since ${formatDate(offer.time)}${offer.receiveEncrypted ? ", encrypted" : ""}`),
  );
}

function versioningText(settings: FolderSettings): string {
  const versioning = settings.versioning;
  if (!versioning.type) return "none";
  const params = Object.entries(versioning.params).map(([key, value]) => `${key} ${value}`);
  return [versioning.type, ...params, `cleaned every ${seconds(versioning.cleanupIntervalS)}`].join(", ");
}

function settingsRows(settings: FolderSettings, names: Map<string, string>): [string, HTMLElement | string][] {
  return [
    ["Label", settings.label || "none"],
    ["Path", element("code", {}, settings.path)],
    ["Type", folderTypeTexts[settings.type] ?? settings.type],
    ["Paused", settings.paused ? "yes" : "no"],
    ["Full rescan", `every ${seconds(settings.rescanIntervalS)}`],
    ["Watch for changes", settings.fsWatcherEnabled ? `on, ${settings.fsWatcherDelayS} s delay` : "off"],
    ["Ignore permissions", onOff(settings.ignorePerms)],
    ["Pull order", settings.order],
    ["Minimum free disk", `${settings.minDiskFree.value} ${settings.minDiskFree.unit}`],
    ["Conflict copies kept", settings.maxConflicts < 0 ? "unlimited" : String(settings.maxConflicts)],
    ["Sync ownership", onOff(settings.syncOwnership)],
    ["Sync extended attributes", onOff(settings.syncXattrs)],
    ["Versioning", versioningText(settings)],
    ["Devices", settings.devices.map((device) => `${deviceDisplayName(names.get(device.deviceId), device.deviceId)}${device.encrypted ? " (encrypted)" : ""}`).join(", ")],
  ];
}

function deviceNames(summary: FolderSummary): Map<string, string> {
  const names = new Map<string, string>();
  for (const copy of summary.copies) for (const peer of copy.sharedWith) names.set(peer.deviceId, peer.name);
  for (const offer of summary.offers) names.set(offer.offeredBy, offer.offeredByName);
  return names;
}

function settingsBlock(summary: FolderSummary, nodeId: string, settings: FolderSettings): HTMLElement {
  const key = `${summary.id}/${nodeId}`;
  const nodeName = summary.copies.find((copy) => copy.nodeId === nodeId)?.nodeName ?? nodeId;
  const block = element("details", { className: "settings-block" }, element("summary", {}, `On ${nodeName}`), keyValueList(settingsRows(settings, deviceNames(summary))));
  block.open = !appState.foldedSettings.has(key);
  block.addEventListener("toggle", () => {
    if (block.open) appState.foldedSettings.delete(key);
    else appState.foldedSettings.add(key);
  });
  return block;
}

function settingsSection(summary: FolderSummary, detail: FolderDetailResponse | null): HTMLElement | null {
  if (!summary.copies.length) return null;
  if (!detail) {
    const status = appState.folderDetailError ? `Settings could not be read: ${appState.folderDetailError}` : "Loading settings…";
    return section("Settings", element("p", { className: "muted" }, status));
  }
  const entries = Object.entries(detail.settings);
  return section(
    "Settings",
    entries.length ? element("div", { className: "settings-blocks" }, ...entries.map(([nodeId, settings]) => settingsBlock(summary, nodeId, settings))) : element("p", { className: "muted" }, "No node answered with its settings."),
  );
}

function detailHeader(summary: FolderSummary): HTMLElement {
  const condition = worstCondition(summary);
  return element(
    "header",
    { className: "detail-header" },
    element("a", { className: "icon-button close-detail", title: "Close", attributes: { href: explorerLocation(null), "aria-label": "Close detail" } }, icon("close")),
    element("h2", {}, summary.label),
    element("p", { className: "detail-status" }, element("span", { className: `dot tone-${condition.tone}` }), `${placementText(summary)}, ${condition.label}`),
  );
}

/** The explorer's priority of the folder's root when its row is loaded, else the setup repo's number for the folder. */
function folderPrioritySection(summary: FolderSummary, priority: FolderRootPriority | null): HTMLElement {
  if (priority) return prioritySection(priority.info, priority.overridesBelow);
  return section("Priority", keyValueList([["Priority", priorityText(summary)]]));
}

export function renderFolderDetail(summary: FolderSummary, detail: FolderDetailResponse | null, priority: FolderRootPriority | null): HTMLElement {
  return element(
    "div",
    { className: "detail-inner" },
    detailHeader(summary),
    section("Folder", keyValueList([["Folder ID", element("code", {}, summary.id)]])),
    folderPrioritySection(summary, priority),
    section(`Copies (${summary.copies.length})`, summary.copies.length ? element("div", { className: "copy-list" }, ...summary.copies.map(copyCard)) : element("p", { className: "muted" }, "No node keeps this folder yet.")),
    summary.offers.length ? section(`Offers not accepted (${summary.offers.length})`, ...summary.offers.map(offerLine)) : null,
    settingsSection(summary, detail),
  );
}

export function renderFolderNotFound(folderId: string, error: string): HTMLElement {
  return element(
    "div",
    { className: "detail-inner detail-empty" },
    element("p", {}, `Folder ${folderId} could not be shown: ${error}`),
    element("a", { attributes: { href: explorerLocation(null) } }, "Close"),
  );
}

export function renderFolderLoading(folderId: string): HTMLElement {
  return element("div", { className: "detail-inner detail-empty" }, element("p", { className: "muted" }, `Reading folder ${folderId}…`));
}
