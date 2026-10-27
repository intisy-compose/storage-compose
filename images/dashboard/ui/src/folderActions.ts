import { type FolderCopy, type FolderSettings, type SaveResult, pauseFolder, removeFolder, rescanFolder } from "./api.js";
import { button, element } from "./dom.js";
import { registerForm } from "./forms.js";
import { requestRender } from "./renderRequest.js";
import { type FolderActionState, type Notice, appState } from "./state.js";

function actionKey(folderId: string, nodeId: string): string {
  return `${folderId}/${nodeId}`;
}

function actionState(folderId: string, nodeId: string): FolderActionState {
  const key = actionKey(folderId, nodeId);
  const existing = appState.folderActions.get(key);
  if (existing) return existing;
  const created: FolderActionState = { busy: false, sub: "", removeOpen: false, confirm: "", result: null };
  appState.folderActions.set(key, created);
  return created;
}

function formIdOf(folderId: string, nodeId: string): string {
  const id = `folder-actions-${actionKey(folderId, nodeId).replace(/[^A-Za-z0-9_-]/g, "_")}`;
  registerForm(id);
  return id;
}

function failureNotice(result: Extract<SaveResult<unknown>, { ok: false }>, failed: string): Notice {
  return result.maybeSaved ? { text: `${result.message}.`, tone: "warn" } : { text: `${failed}: ${result.message}`, tone: "bad" };
}

async function run<T>(state: FolderActionState, send: () => Promise<SaveResult<T>>, done: (value: T) => Notice, failed: string): Promise<void> {
  state.busy = true;
  state.result = null;
  requestRender();
  const result = await send();
  state.busy = false;
  state.result = result.ok ? done(result.value) : failureNotice(result, failed);
  requestRender();
}

function folderName(settings: FolderSettings): string {
  return settings.label || settings.id;
}

function pauseButton(copy: FolderCopy, settings: FolderSettings, state: FolderActionState): HTMLButtonElement {
  const paused = !settings.paused;
  const name = folderName(settings);
  const control = button(
    paused ? "Pause" : "Resume",
    () => void run(state, () => pauseFolder(copy.nodeId, settings.id, paused), () => ({ text: `${paused ? "Paused" : "Resumed"} ${name} on ${copy.nodeName}.`, tone: "ok" }), "Not changed"),
    "button",
  );
  control.disabled = state.busy;
  control.title = paused ? `${copy.nodeName} stops scanning and syncing ${name} until it is resumed` : `${copy.nodeName} scans and syncs ${name} again`;
  return control;
}

function rescanDone(name: string, sub: string): Notice {
  return { text: sub.trim() ? `Asked Syncthing to rescan ${sub.trim()} of ${name}.` : `Asked Syncthing to rescan ${name}.`, tone: "ok" };
}

function rescanControls(copy: FolderCopy, settings: FolderSettings, state: FolderActionState, formId: string): HTMLElement {
  const name = folderName(settings);
  const subInput = element("input", { className: "rescan-sub", attributes: { id: `${formId}-sub`, autocomplete: "off", spellcheck: "false", placeholder: "only this subfolder, such as photos/2024", "aria-label": "Subfolder to rescan" } });
  subInput.defaultValue = state.sub;
  subInput.value = state.sub;
  subInput.disabled = state.busy || settings.paused;
  subInput.addEventListener("input", () => (state.sub = subInput.value));
  const rescan = button(
    "Rescan",
    () => {
      const sub = state.sub;
      void run(state, () => rescanFolder(copy.nodeId, settings.id, sub), () => rescanDone(name, sub), "Not rescanned");
    },
    "button",
  );
  rescan.disabled = state.busy || settings.paused;
  rescan.title = settings.paused ? `${name} is paused; resume it to rescan` : `Scan ${name} on ${copy.nodeName} for changes now, the whole folder or only the subfolder typed`;
  return element("div", { className: "rescan-row" }, rescan, subInput);
}

function removeToggle(state: FolderActionState): HTMLButtonElement {
  const control = button(
    state.removeOpen ? "Keep the folder" : "Remove from Syncthing…",
    () => {
      state.removeOpen = !state.removeOpen;
      state.confirm = "";
      requestRender();
    },
    state.removeOpen ? "button ghost" : "button danger",
  );
  control.disabled = state.busy;
  return control;
}

function removedNotice(copy: FolderCopy, settings: FolderSettings): Notice {
  return { text: `Removed ${folderName(settings)} from ${copy.nodeName}'s Syncthing. Nothing was deleted: the files stay on disk at ${settings.path}.`, tone: "ok" };
}

/**
 * Drops the folder's detail as read before the removal, so the next read shows it without this node's copy.
 * @implNote Needed when no node has the folder any more: a failed read keeps the detail last read, which would show the copy still there.
 */
function forgetShownDetail(folderId: string): void {
  if (appState.folderDetail?.summary.id === folderId) appState.folderDetail = null;
}

/** @implNote The folder's ID, typed, is the confirmation the server asks for; the button waits for it so a stray click cannot stop a folder syncing. */
function removeForm(copy: FolderCopy, settings: FolderSettings, state: FolderActionState, formId: string): HTMLElement {
  const name = folderName(settings);
  const confirmInput = element("input", { attributes: { id: `${formId}-confirm`, autocomplete: "off", spellcheck: "false", placeholder: `type ${settings.id} to confirm`, "aria-label": `Type ${settings.id} to confirm` } });
  confirmInput.defaultValue = state.confirm;
  confirmInput.value = state.confirm;
  confirmInput.disabled = state.busy;
  const removeButton = button(
    state.busy ? "Removing…" : `Remove ${settings.id} from Syncthing`,
    () =>
      void run(
        state,
        () => removeFolder(copy.nodeId, settings.id, state.confirm),
        () => {
          state.removeOpen = false;
          forgetShownDetail(settings.id);
          return removedNotice(copy, settings);
        },
        "Not removed",
      ),
    "button danger",
  );
  removeButton.disabled = state.busy || state.confirm !== settings.id;
  confirmInput.addEventListener("input", () => {
    state.confirm = confirmInput.value;
    removeButton.disabled = state.busy || state.confirm !== settings.id;
  });
  return element(
    "div",
    { className: "action-form destructive" },
    element("p", {}, `This removes ${name} from ${copy.nodeName}'s Syncthing only: ${copy.nodeName} stops scanning it and stops syncing it with every device.`),
    element("p", {}, element("strong", {}, "Nothing is deleted. "), `The files stay on disk at `, element("code", {}, settings.path), "."),
    element("p", {}, `Type ${settings.id} to confirm.`),
    element("div", { className: "form-fields" }, confirmInput),
    element("div", { className: "button-row" }, removeButton),
  );
}

function resultLine(result: Notice | null): HTMLElement | null {
  return result ? element("p", { className: `notice tone-text-${result.tone}`, attributes: { role: "status" } }, result.text) : null;
}

/** Pause or resume, rescan and remove one folder on one of this host's nodes, inside that node's settings of the folder. */
export function folderActions(copy: FolderCopy, settings: FolderSettings): HTMLElement {
  const state = actionState(settings.id, copy.nodeId);
  const formId = formIdOf(settings.id, copy.nodeId);
  return element(
    "div",
    { className: "folder-actions", attributes: { id: formId } },
    settings.paused ? element("p", { className: "notice tone-text-warn" }, `Paused on ${copy.nodeName}: Syncthing neither scans nor syncs it here until it is resumed.`) : null,
    element("div", { className: "button-row" }, pauseButton(copy, settings, state), removeToggle(state)),
    rescanControls(copy, settings, state, formId),
    resultLine(state.result),
    state.removeOpen ? removeForm(copy, settings, state, formId) : null,
  );
}

/** The outcome of an action on a node that no longer has the folder, such as its removal, which its settings can no longer show. */
export function orphanedActionResults(folderId: string, nodeIdsWithSettings: string[]): HTMLElement[] {
  const lines: HTMLElement[] = [];
  for (const [key, state] of appState.folderActions) {
    const nodeId = key.slice(folderId.length + 1);
    if (!key.startsWith(`${folderId}/`) || nodeIdsWithSettings.includes(nodeId) || !state.result) continue;
    lines.push(resultLine(state.result) as HTMLElement);
  }
  return lines;
}
