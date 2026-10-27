import { type DeviceSettings, type NodesResponse, type Peer, type RemoteState, type SaveResult, type StorageNode, connectionKindText, deviceDisplayName, pauseDevice, pauseNode } from "./api.js";
import { closeItemList, isItemListOpen, itemListPanel, openItemList } from "./itemList.js";
import { button, element, section } from "./dom.js";
import { formatAge, formatPercent, formatRate, normaliseCompletion } from "./format.js";
import { requestRender } from "./renderRequest.js";
import { addDeviceLocation, appState, deviceFormLocation } from "./state.js";

const remoteStateText: Record<RemoteState, string | null> = {
  valid: null,
  unknown: "has not accepted the folders",
  notSharing: "shares no folder with this node",
  paused: "paused",
  unavailable: "completion unavailable: its Syncthing did not answer",
};

function peerTone(peer: Peer): string {
  if (peer.paused) return "muted";
  return peer.connected ? "ok" : "muted";
}

function connectionText(peer: Peer): string {
  if (!peer.connected) return `offline, last seen ${formatAge(peer.lastSeen)}`;
  return [peer.address, peer.connectionType].filter(Boolean).join(", ");
}

function kindChip(peer: Peer): HTMLElement | null {
  if (!peer.connectionKind) return null;
  return element("span", { className: "chip", title: connectionText(peer) }, connectionKindText(peer.connectionKind));
}

function completionText(peer: Peer): string {
  if (peer.remoteState === "notSharing" || peer.remoteState === "unavailable") return "";
  return formatPercent(normaliseCompletion(peer.completion));
}

function completionTone(peer: Peer): string {
  if (peer.remoteState === "unknown") return "warn";
  return peer.completion >= 100 ? "ok" : "accent";
}

/** A node whose Syncthing answers with folders can list what each of its devices still needs. */
function canListNeed(node: StorageNode): boolean {
  return node.syncthing !== null && node.folders.length > 0;
}

/** The folder a device's need opens on: the first the node shares with it, else the node's first. */
function firstFolderOf(node: StorageNode, peer: Peer): string {
  return node.folders.find((folder) => peer.folders.includes(folder.id))?.id ?? node.folders[0].id;
}

function isNeedOpenFor(node: StorageNode, peer: Peer): boolean {
  const list = appState.itemList;
  return list !== null && list.nodeId === node.id && list.deviceId === peer.deviceId;
}

/** The completion opens what the device still needs; it sits beside the row, as a local node's row is a link to the device's form. */
function completionButton(node: StorageNode, peer: Peer, displayName: string): HTMLButtonElement {
  const isOpen = isNeedOpenFor(node, peer);
  const open = () => openItemList({ nodeId: node.id, folderId: firstFolderOf(node, peer), deviceId: peer.deviceId, kind: "need" });
  const control = button(completionText(peer) || "items", isOpen ? closeItemList : open, `link-button peer-completion tone-text-${completionTone(peer)}`);
  control.title = isOpen ? "Close the list" : `List what ${displayName} still needs of ${node.name}'s folders`;
  control.setAttribute("aria-expanded", String(isOpen));
  return control;
}

/** A local node's row opens the device's form; another host's node is edited on its own dashboard. */
function peerRow(node: StorageNode, peer: Peer, displayName: string): HTMLElement {
  const note = peer.paused ? "paused" : remoteStateText[peer.remoteState];
  const completionBeside = canListNeed(node);
  const rowClass = completionBeside ? "peer-row completion-beside" : "peer-row";
  const link = node.local ? { className: `${rowClass} peer-link`, title: `Edit ${displayName}`, attributes: { href: deviceFormLocation(node.id, peer.deviceId) } } : null;
  return element(
    link ? "a" : "div",
    link ?? { className: rowClass, title: peer.deviceId },
    element("span", { className: `dot tone-${peerTone(peer)}`, title: peer.connected ? "connected" : "not connected" }),
    element(
      "span",
      { className: "peer-name" },
      element("span", { className: "peer-title" }, element("strong", {}, displayName), kindChip(peer)),
      element("small", {}, connectionText(peer)),
      note ? element("small", { className: "tone-text-warn" }, note) : null,
    ),
    element("span", { className: "peer-rates" }, peer.connected ? `↓ ${formatRate(peer.inRate)}  ↑ ${formatRate(peer.outRate)}` : ""),
    completionBeside ? null : element("span", { className: `peer-completion tone-text-${completionTone(peer)}` }, completionText(peer)),
  );
}

/** The pauses on their way, by node and device, so a second click waits for the first answer. */
const pausesSent = new Set<string>();

function pauseKey(node: StorageNode, deviceId: string | null): string {
  return `${node.id}/${deviceId ?? ""}`;
}

/**
 * @implNote The answer is the configuration as it now stands, so the rows show it before the next poll does;
 * the node is looked up again, as a poll may have replaced the one the button was drawn with.
 */
function showPaused(nodeId: string, devices: DeviceSettings[]): void {
  const node = appState.data?.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return;
  for (const device of devices) {
    const peer = node.peers.find((candidate) => candidate.deviceId === device.deviceId);
    if (peer) peer.paused = device.paused;
  }
}

async function sendPause(node: StorageNode, deviceId: string | null, send: () => Promise<SaveResult<DeviceSettings | DeviceSettings[]>>, done: string): Promise<void> {
  const key = pauseKey(node, deviceId);
  pausesSent.add(key);
  requestRender();
  const result = await send();
  pausesSent.delete(key);
  if (result.ok) showPaused(node.id, Array.isArray(result.value) ? result.value : [result.value]);
  appState.notice = result.ok ? { text: done, tone: "ok" } : { text: `Not changed: ${result.message}`, tone: "bad" };
  requestRender();
}

function pauseButton(node: StorageNode, peer: Peer, displayName: string): HTMLButtonElement {
  const paused = !peer.paused;
  const done = `${paused ? "Paused" : "Resumed"} ${displayName} on ${node.name}.`;
  const label = paused ? `Stop syncing with ${displayName}` : `Sync with ${displayName} again`;
  const control = button(paused ? "Stop syncing" : "Sync again", () => void sendPause(node, peer.deviceId, () => pauseDevice(node.id, peer.deviceId, paused), done), "button ghost");
  control.disabled = pausesSent.has(pauseKey(node, peer.deviceId));
  control.title = label;
  control.setAttribute("aria-label", label);
  return control;
}

/** A local node's row carries its pause, and a row that can list the device's need its completion, beside the row rather than inside it. */
function peerItem(node: StorageNode, peer: Peer, displayName: string): HTMLElement {
  const row = peerRow(node, peer, displayName);
  const beside = [canListNeed(node) ? completionButton(node, peer, displayName) : null, node.local ? pauseButton(node, peer, displayName) : null].filter((control) => control !== null);
  return beside.length ? element("div", { className: "peer-item" }, row, ...beside) : row;
}

function folderChoice(node: StorageNode, peer: Peer | undefined, folderId: string, deviceId: string): HTMLSelectElement {
  const select = element("select", { attributes: { id: "remote-need-folder", "aria-label": "Folder" } });
  for (const folder of node.folders) {
    const shared = peer?.folders.includes(folder.id) ?? false;
    const option = element("option", { attributes: { value: folder.id } }, `${folder.label || folder.id}${shared ? "" : ", not shared"}`);
    option.selected = option.defaultSelected = folder.id === folderId;
    select.append(option);
  }
  select.addEventListener("change", () => openItemList({ nodeId: node.id, folderId: select.value, deviceId, kind: "need" }));
  return select;
}

/** What the device whose completion was opened still needs of one of the node's folders, the folder chosen above the list. */
function remoteNeedPanel(response: NodesResponse, node: StorageNode): HTMLElement | null {
  const list = appState.itemList;
  if (!list || list.nodeId !== node.id || list.deviceId === null || !isItemListOpen(list)) return null;
  const peer = node.peers.find((candidate) => candidate.deviceId === list.deviceId);
  const name = peer ? nameOf(response, peer) : deviceDisplayName(null, list.deviceId);
  const choice = element("label", { className: "item-list-choice" }, "Folder ", folderChoice(node, peer, list.folderId, list.deviceId));
  return itemListPanel(list, `What ${name} still needs of ${node.name}`, choice);
}

function nodePauseButton(node: StorageNode, paused: boolean): HTMLButtonElement {
  const done = `${paused ? "Paused" : "Resumed"} every device of ${node.name}.`;
  const control = button(paused ? "Pause node" : "Resume node", () => void sendPause(node, null, () => pauseNode(node.id, paused), done), "button");
  control.disabled = pausesSent.has(pauseKey(node, null));
  control.title = paused ? `Stop ${node.name} syncing with every device` : `Let ${node.name} sync with every device again`;
  return control;
}

/** Pause while any device syncs, resume while any is paused: both when some are and some are not. */
function nodePauseButtons(node: StorageNode): HTMLButtonElement[] {
  if (!node.local || !node.syncthing || !node.peers.length) return [];
  return [
    ...(node.peers.some((peer) => !peer.paused) ? [nodePauseButton(node, true)] : []),
    ...(node.peers.some((peer) => peer.paused) ? [nodePauseButton(node, false)] : []),
  ];
}

function nameOf(response: NodesResponse, peer: Peer): string {
  const node = response.nodes.find((candidate) => candidate.syncthing?.deviceId === peer.deviceId);
  return node ? node.name : deviceDisplayName(peer.name, peer.deviceId);
}

function addDeviceLink(node: StorageNode): HTMLElement | null {
  return node.local && node.syncthing ? element("a", { className: "button add-device", attributes: { href: addDeviceLocation(node.id) } }, "Add a device") : null;
}

/** A local node shows the section even without devices, as the way to add its first one. */
export function peersSection(response: NodesResponse, node: StorageNode): HTMLElement | null {
  const addLink = addDeviceLink(node);
  if (!node.peers.length && !addLink) return null;
  const actions = [addLink, ...nodePauseButtons(node)].filter((action): action is HTMLElement => action !== null);
  return section(
    `Devices (${node.peers.length})`,
    node.peers.length ? element("div", { className: "peer-list" }, ...node.peers.map((peer) => peerItem(node, peer, nameOf(response, peer)))) : null,
    remoteNeedPanel(response, node),
    actions.length ? element("div", { className: "button-row" }, ...actions) : null,
  );
}
