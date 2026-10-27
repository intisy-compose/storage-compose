import { type IgnoredDeviceEntry, type IgnoredFolderEntry, type IgnoredLists, type SaveResult, type StorageNode, deviceDisplayName, seenTimeText, shortDeviceId, unignoreDevice, unignoreFolder } from "./api.js";
import { editFailureNotice, resultLine } from "./deviceForm.js";
import { button, element } from "./dom.js";
import { requestRender } from "./renderRequest.js";
import { appState, type Notice } from "./state.js";

interface IgnoredState {
  /** The entry being un-ignored, so its button waits for the answer. */
  busyKey: string | null;
  result: Notice | null;
}

const states = new Map<string, IgnoredState>();

function stateOf(nodeId: string): IgnoredState {
  const known = states.get(nodeId);
  if (known) return known;
  const created: IgnoredState = { busyKey: null, result: null };
  states.set(nodeId, created);
  return created;
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

/** What the node ignores: devices that asked to connect and folders offered by a device, each with a way back. */
export function ignoredSection(node: StorageNode): HTMLElement {
  const lists = appState.ignoredLists.get(node.id);
  const heading = element("h3", { className: "settings-subheading" }, "Ignored");
  if (!lists) return element("div", { className: "ignored-section" }, heading, element("p", { className: "muted" }, "Reading what it ignores…"));
  if ("error" in lists) return element("div", { className: "ignored-section" }, heading, element("p", { className: "warning" }, lists.error));
  return element(
    "div",
    { className: "ignored-section" },
    heading,
    element("p", { className: "muted" }, "Devices"),
    listOrEmpty(lists.devices.map((entry) => deviceRow(node, entry)), "No device is ignored."),
    element("p", { className: "muted" }, "Folders"),
    listOrEmpty(lists.folders.map((entry) => folderRow(node, entry)), "No folder offer is ignored."),
    resultLine(stateOf(node.id).result),
  );
}
