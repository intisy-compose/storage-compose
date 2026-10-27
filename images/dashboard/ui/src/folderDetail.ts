import { type ActivityEntry, type FolderCopy, type FolderDetailResponse, type FolderSettings, type FolderSummary, type PendingFolderOffer, changesActivityType, defaultActivityFilters, deviceDisplayName, folderChangesShown, folderTypeTexts, versioningWords } from "./api.js";
import { button, element, keyValueList, section } from "./dom.js";
import { formatBytes, formatDate, formatDuration, plural } from "./format.js";
import { type FolderRootPriority, prioritySection } from "./explorerDetail.js";
import { folderActions, orphanedActionResults } from "./folderActions.js";
import { copyCondition, placementText, priorityBand, priorityUnsetText, worstCondition } from "./folderCondition.js";
import { icon } from "./icons.js";
import { outOfSyncCount, outOfSyncText } from "./outOfSync.js";
import { isItemListOpen, itemListPanel, toggleItemList } from "./itemList.js";
import { conflictCopies } from "./itemPages.js";
import { isVersionsOpen, toggleVersions, versionsPanel } from "./versionsPanel.js";
import { type ItemListKind, type ItemListTarget, activityLocation, appState, editFolderLocation, explorerLocation, locationFor } from "./state.js";

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

function copyList(copy: FolderCopy, kind: ItemListKind): ItemListTarget {
  return { nodeId: copy.nodeId, folderId: copy.id, deviceId: null, kind };
}

/** A count that opens one of the copy's item lists, or closes it when it is open. */
function listToggle(copy: FolderCopy, kind: ItemListKind, text: string, opensWhat: string, className = "link-button"): HTMLButtonElement {
  const target = copyList(copy, kind);
  const control = button(text, () => toggleItemList(target), className);
  control.title = isItemListOpen(target) ? "Close the list" : opensWhat;
  control.setAttribute("aria-expanded", String(isItemListOpen(target)));
  return control;
}

function listPanel(copy: FolderCopy, kind: ItemListKind, title: string): HTMLElement | null {
  const list = appState.itemList;
  return list && isItemListOpen(copyList(copy, kind)) ? itemListPanel(list, title) : null;
}

/** The count opens the list of what the copy's node still has to fetch. */
function outOfSyncValue(copy: FolderCopy): HTMLElement | string {
  const text = outOfSyncText(copy);
  return outOfSyncCount(copy) ? listToggle(copy, "need", text, `List what ${copy.nodeName} still has to fetch`) : text;
}

/** The count opens the list of the copy's failed items, each with Syncthing's error text. */
function failedValue(copy: FolderCopy): HTMLElement | string {
  if (!copy.errors) return "none";
  return listToggle(copy, "failed", plural(copy.errors, "item"), `List what Syncthing could not sync on ${copy.nodeName}`, "link-button tone-text-bad");
}

/** The count opens the list of what was changed on the copy's node, which a revert deletes or replaces. */
function changedHereValue(copy: FolderCopy): HTMLElement | string {
  if (!copy.localChanged) return "nothing";
  return listToggle(copy, "local-changed", plural(copy.localChanged, "item"), `List what was changed on ${copy.nodeName}`, "link-button tone-text-warn");
}

/** The count opens the list of the copy's conflict copies; keeping one is done on the node, not here. */
function conflictsValue(copy: FolderCopy): HTMLElement | string {
  const count = copy.conflicts ?? null;
  if (count === null) return copy.local ? "not searched yet" : "not counted";
  if (!count) return "none";
  return listToggle(copy, "conflicts", conflictCopies(count, copy.conflictsMore === true), `List the conflict copies on ${copy.nodeName}`, "link-button tone-text-warn");
}

/** Opens the browser of the copy's kept versions, or closes it when it is open. */
function versionsValue(copy: FolderCopy): HTMLElement {
  const isOpen = isVersionsOpen(copy);
  const control = button(isOpen ? "Close the versions" : copy.local ? "Browse and restore" : "Browse", () => toggleVersions(copy), "link-button");
  control.title = isOpen ? "Close the versions" : `List the versions ${copy.nodeName} keeps of this folder's files`;
  control.setAttribute("aria-expanded", String(isOpen));
  return control;
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
    ["Out of sync", outOfSyncValue(copy)],
    ["Failed items", failedValue(copy)],
  ];
  if (copy.type === "receiveonly") rows.push(["Changed here", changedHereValue(copy)]);
  rows.push(["Conflicts", conflictsValue(copy)], ["Versions", versionsValue(copy)]);
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
    listPanel(copy, "need", `What ${copy.nodeName} still has to fetch`),
    listPanel(copy, "failed", `Failed items on ${copy.nodeName}`),
    listPanel(copy, "local-changed", `Changed on ${copy.nodeName}`),
    listPanel(copy, "conflicts", `Conflict copies on ${copy.nodeName}`),
    versionsPanel(copy),
  );
}

/** An offer to a node of this host is answered on the Requests page; another host's on that host's dashboard. */
function offerLine(offer: PendingFolderOffer): HTMLElement {
  const isLocal = appState.data?.nodes.find((node) => node.id === offer.nodeId)?.local === true;
  return element(
    "p",
    { className: "offer-line" },
    `offered by ${offer.offeredByName}, not accepted on ${offer.nodeName}`,
    element("small", {}, `since ${formatDate(offer.time)}${offer.receiveEncrypted ? ", encrypted" : ""}`),
    isLocal ? element("a", { className: "button ghost", attributes: { href: locationFor("requests") } }, "Accept, ignore or dismiss") : null,
  );
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
    ["Versioning", versioningWords(settings.versioning)],
    ["Devices", settings.devices.map((device) => `${deviceDisplayName(names.get(device.deviceId), device.deviceId)}${device.encrypted ? " (encrypted)" : ""}`).join(", ")],
  ];
}

/** Each copy's node names its own device, which no `sharedWith` lists. */
function deviceNames(summary: FolderSummary): Map<string, string> {
  const names = new Map<string, string>();
  for (const copy of summary.copies) for (const peer of copy.sharedWith) names.set(peer.deviceId, peer.name);
  for (const copy of summary.copies) {
    const ownId = appState.data?.nodes.find((node) => node.id === copy.nodeId)?.syncthing?.deviceId;
    if (ownId) names.set(ownId, copy.nodeName);
  }
  for (const offer of summary.offers) names.set(offer.offeredBy, offer.offeredByName);
  return names;
}

/** Only this host's copies are edited here; another host's are edited on its own dashboard. */
function editLink(summary: FolderSummary, copy: FolderCopy | undefined): HTMLElement | null {
  if (!copy?.local) return null;
  return element("div", { className: "button-row" }, element("a", { className: "button", attributes: { href: editFolderLocation(summary.id, copy.nodeId) } }, "Edit settings"));
}

function settingsBlock(summary: FolderSummary, nodeId: string, settings: FolderSettings): HTMLElement {
  const key = `${summary.id}/${nodeId}`;
  const copy = summary.copies.find((candidate) => candidate.nodeId === nodeId);
  const heading = `On ${copy?.nodeName ?? nodeId}${settings.paused ? ", paused" : ""}`;
  const block = element(
    "details",
    { className: "settings-block" },
    element("summary", {}, heading),
    keyValueList(settingsRows(settings, deviceNames(summary))),
    editLink(summary, copy),
    copy?.local ? folderActions(copy, settings) : null,
  );
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
    ...orphanedActionResults(summary.id, Object.keys(detail.settings)),
    entries.length ? element("div", { className: "settings-blocks" }, ...entries.map(([nodeId, settings]) => settingsBlock(summary, nodeId, settings))) : element("p", { className: "muted" }, "No node answered with its settings."),
  );
}

function nodeNameOf(nodeId: string | null): string {
  return appState.data?.nodes.find((node) => node.id === nodeId)?.name ?? nodeId ?? "";
}

function changeLine(entry: ActivityEntry): HTMLElement {
  const change = entry.change;
  const node = nodeNameOf(entry.nodeId);
  const by = entry.type === "remote-change" && change ? ` by ${change.device}` : "";
  return element(
    "li",
    { className: "change-line" },
    element("code", { className: "change-path" }, change ? `${change.path}${change.item === "dir" ? "/" : ""}` : entry.text),
    element("small", {}, `${change?.action ?? "changed"} on ${node}${by}, ${formatDate(entry.at)}`),
  );
}

/** The folder's newest file changes on this host's nodes, as Syncthing's Recent Changes listed them; Activity lists the rest. */
function changesSection(folderId: string): HTMLElement {
  const changes = appState.folderChanges?.folderId === folderId ? appState.folderChanges : null;
  const all = element("a", { className: "button ghost", attributes: { href: activityLocation({ ...defaultActivityFilters, folder: folderId, kind: changesActivityType }) } }, "All changes in Activity");
  const heading = `Recent changes (last ${folderChangesShown})`;
  if (!changes?.entries) {
    const status = changes?.error ? `Changes could not be read: ${changes.error}` : "Reading the changes…";
    return section(heading, element("p", { className: "muted" }, status));
  }
  const error = changes.error ? element("p", { className: "muted" }, `Could not be read again: ${changes.error}`) : null;
  if (!changes.entries.length) return section(heading, error, element("p", { className: "muted" }, "No change seen since the dashboard or the node's Syncthing started."), all);
  return section(heading, error, element("ol", { className: "change-list" }, ...changes.entries.map(changeLine)), all);
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
    changesSection(summary.id),
    settingsSection(summary, detail),
  );
}

export function renderFolderNotFound(folderId: string, error: string): HTMLElement {
  return element(
    "div",
    { className: "detail-inner detail-empty" },
    ...orphanedActionResults(folderId, []),
    element("p", {}, `Folder ${folderId} could not be shown: ${error}`),
    element("a", { attributes: { href: explorerLocation(null) } }, "Close"),
  );
}

export function renderFolderLoading(folderId: string): HTMLElement {
  return element("div", { className: "detail-inner detail-empty" }, element("p", { className: "muted" }, `Reading folder ${folderId}…`));
}
