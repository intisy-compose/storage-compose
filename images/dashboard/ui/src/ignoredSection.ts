import { type IgnoredDeviceEntry, type IgnoredFolderEntry, type IgnoredLists, type SaveResult, type StorageNode, deviceDisplayName, fetchIgnoredLists, seenTimeText, shortDeviceId, unignoreDevice, unignoreFolder } from "./api.js";
import { editFailureNotice, resultLine } from "./deviceForm.js";
import { button, element } from "./dom.js";
import { requestRender } from "./renderRequest.js";
import { appState, type Notice } from "./state.js";

interface IgnoredState {
  open: boolean;
  /** The entry being un-ignored, so its button waits for the answer. */
  busyKey: string | null;
  result: Notice | null;
}

const states = new Map<string, IgnoredState>();

function stateOf(nodeId: string): IgnoredState {
  const known = states.get(nodeId);
  if (known) return known;
  const created: IgnoredState = { open: false, busyKey: null, result: null };
  states.set(nodeId, created);
  return created;
}

/** The local nodes whose Ignored section is open: only those are read, as each read is the node's whole configuration. */
export function openIgnoredNodeIds(): string[] {
  return [...states].filter(([, state]) => state.open).map(([nodeId]) => nodeId);
}

export async function loadIgnoredLists(nodeId: string): Promise<void> {
  try {
    appState.ignoredLists.set(nodeId, await fetchIgnoredLists(nodeId));
  } catch (error) {
    appState.ignoredLists.set(nodeId, { error: (error as Error).message });
  }
}

function deviceKey(entry: IgnoredDeviceEntry): string {
  return `device:${entry.deviceId}`;
}

function folderKey(entry: IgnoredFolderEntry): string {
  return `folder:${entry.offeredBy}:${entry.folderId}`;
}

async function unignore(nodeId: string, key: string, done: string, send: () => Promise<SaveResult<IgnoredLists>>): Promise<void> {
  const state = stateOf(nodeId);
  state.busyKey = key;
  state.result = null;
  requestRender();
  const result = await send();
  state.busyKey = null;
  if (result.ok) {
    appState.ignoredLists.set(nodeId, result.value);
    state.result = { text: done, tone: "ok" };
  } else {
    state.result = editFailureNotice(result);
  }
  requestRender();
}

function unignoreButton(nodeId: string, key: string, done: string, send: () => Promise<SaveResult<IgnoredLists>>): HTMLButtonElement {
  const busy = stateOf(nodeId).busyKey;
  return Object.assign(button(busy === key ? "Un-ignoring…" : "Un-ignore", () => void unignore(nodeId, key, done, send), "button ghost"), { disabled: busy !== null });
}

function when(time: string): string {
  return time ? `ignored ${seenTimeText(time, new Date())}` : "ignored";
}

function deviceRow(node: StorageNode, entry: IgnoredDeviceEntry): HTMLElement {
  const name = deviceDisplayName(entry.name, entry.deviceId);
  const done = `Un-ignored ${name}; it may ask to connect to ${node.name} again.`;
  return element(
    "li",
    { className: "ignored-entry" },
    element("span", {}, element("strong", {}, name), ` ${shortDeviceId(entry.deviceId)}`, element("small", { className: "muted" }, ` ${[entry.address, when(entry.time)].filter(Boolean).join(", ")}`)),
    unignoreButton(node.id, deviceKey(entry), done, () => unignoreDevice(node.id, entry.deviceId)),
  );
}

function folderRow(node: StorageNode, entry: IgnoredFolderEntry): HTMLElement {
  const name = entry.label && entry.label !== entry.folderId ? `${entry.label} (${entry.folderId})` : entry.folderId;
  const done = `Un-ignored ${name} from ${entry.offeredByName}; it may be offered to ${node.name} again.`;
  return element(
    "li",
    { className: "ignored-entry" },
    element("span", {}, element("strong", {}, name), ` offered by ${entry.offeredByName}`, element("small", { className: "muted" }, ` ${when(entry.time)}`)),
    unignoreButton(node.id, folderKey(entry), done, () => unignoreFolder(node.id, entry.folderId, entry.offeredBy)),
  );
}

function listOrEmpty(rows: HTMLElement[], emptyText: string): HTMLElement {
  return rows.length ? element("ul", { className: "ignored-list" }, ...rows) : element("p", { className: "muted" }, emptyText);
}

function ignoredBody(node: StorageNode): HTMLElement[] {
  const lists = appState.ignoredLists.get(node.id);
  if (!lists) return [element("p", { className: "muted" }, "Reading what it ignores…")];
  if ("error" in lists) return [element("p", { className: "warning" }, lists.error)];
  const result = resultLine(stateOf(node.id).result);
  return [
    element("p", { className: "muted" }, "Devices"),
    listOrEmpty(lists.devices.map((entry) => deviceRow(node, entry)), "No device is ignored."),
    element("p", { className: "muted" }, "Folders"),
    listOrEmpty(lists.folders.map((entry) => folderRow(node, entry)), "No folder offer is ignored."),
    ...(result ? [result] : []),
  ];
}

/**
 * What the node ignores: devices that asked to connect and folders offered by a device, each with a way back.
 * @implNote Read when opened and with each poll while open, never while closed: the read is the node's whole configuration.
 */
export function ignoredSection(node: StorageNode): HTMLElement {
  const state = stateOf(node.id);
  const details = element("details", { className: "defaults-section ignored-section" }, element("summary", {}, "Ignored devices and folders"), ...(state.open ? ignoredBody(node) : []));
  details.open = state.open;
  details.addEventListener("toggle", () => {
    if (details.open === state.open) return;
    state.open = details.open;
    if (state.open) appState.ignoredLists.delete(node.id);
    requestRender();
    if (state.open) void loadIgnoredLists(node.id).then(requestRender);
  });
  return details;
}
