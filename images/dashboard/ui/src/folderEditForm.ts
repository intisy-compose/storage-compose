import {
  type DiskFreeUnit,
  type FolderCopy,
  type FolderDetailResponse,
  type FolderSettings,
  type FolderSettingsChange,
  type FolderType,
  type PullOrder,
  type StorageNode,
  changedFields,
  checkFolderPath,
  deviceDisplayName,
  diskFreeUnits,
  editableFolderTypes,
  folderSettingLabels,
  folderTypeTexts,
  pullOrderTexts,
  saveFolderSettings,
} from "./api.js";
import { arrayConfirmField, isArrayConfirmed } from "./arrayConfirm.js";
import { editFailureNotice, resultLine } from "./deviceForm.js";
import { button, element, section } from "./dom.js";
import { plural } from "./format.js";
import { controlId, registerForm } from "./forms.js";
import { icon } from "./icons.js";
import { requestRender } from "./renderRequest.js";
import { type SharingChoice, clearSharing, folderSharingChange, hasSharingChanges, sharingList } from "./sharingFields.js";
import { type EditFolderFormState, appState, explorerLocation, isArrayNode } from "./state.js";
import { hasUnsavedIgnores, ignoresSection, loadIgnores, unsavedIgnoresText } from "./ignoresSection.js";
import { versioningSection } from "./versioningSection.js";

const formId = "edit-folder-form";
registerForm(formId);

type TextSetting = "label" | "path";
type ToggleSetting = "fsWatcherEnabled" | "ignorePerms" | "syncOwnership" | "syncXattrs";
type NumberSetting = "rescanIntervalS" | "fsWatcherDelayS" | "maxConflicts";

/** What each type means for this node's copy, shown when the type is changed. */
const typeMeanings: Record<FolderType, string> = {
  sendreceive: "Send and receive: this node sends its changes to the other devices and takes theirs.",
  sendonly: "Send only: this node sends its changes and takes none from the other devices; their changes show as out of sync here until overridden.",
  receiveonly: "Receive only: this node takes the other devices' changes and sends none of its own; a file changed here stays a local change until it is reverted to the other devices' version.",
  receiveencrypted: "Receive encrypted: this node keeps the other devices' data encrypted and cannot read it.",
};

const pathMoveNotice = "Syncthing does not move the files; the folder rescans at the new path.";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Fills the form from the folder detail once per opening.
 * @implNote Never refilled by a later poll, so a change made elsewhere meanwhile is not taken for one the person made.
 */
export function openEditFolderForm(form: EditFolderFormState, detail: FolderDetailResponse): void {
  const settings = detail.summary.id === form.folderId ? detail.settings[form.nodeId] : undefined;
  if (form.saved || !settings) return;
  form.saved = structuredClone(settings);
  form.draft = structuredClone(settings);
  if (copyOf(detail, form.nodeId)?.local && settings.type !== "receiveencrypted") void loadIgnores(form);
}

function copyOf(detail: FolderDetailResponse, nodeId: string): FolderCopy | undefined {
  return detail.summary.copies.find((copy) => copy.nodeId === nodeId);
}

function settingLabel(field: keyof FolderSettingsChange, control: HTMLElement, hint: HTMLElement | string | null = null): HTMLElement {
  return element(
    "label",
    { className: "setting", attributes: { for: controlId(formId, field) } },
    element("span", {}, folderSettingLabels[field]),
    control,
    typeof hint === "string" ? element("small", { className: "muted" }, hint) : hint,
  );
}

function textInput(form: EditFolderFormState, field: TextSetting): HTMLInputElement {
  const { saved, draft } = form as { saved: FolderSettings; draft: FolderSettings };
  const input = element("input", { attributes: { id: controlId(formId, field), autocomplete: "off", spellcheck: "false" } });
  input.defaultValue = saved[field];
  input.value = draft[field];
  input.disabled = form.saving;
  input.addEventListener("input", () => (draft[field] = input.value));
  return input;
}

function numberInput(form: EditFolderFormState, field: NumberSetting, min: number): HTMLInputElement {
  const { saved, draft } = form as { saved: FolderSettings; draft: FolderSettings };
  const input = element("input", { attributes: { id: controlId(formId, field), type: "number", min: String(min), step: "1" } });
  input.defaultValue = String(saved[field]);
  input.value = String(draft[field]);
  input.disabled = form.saving;
  input.addEventListener("input", () => (draft[field] = input.value === "" ? Number.NaN : Number(input.value)));
  return input;
}

function toggle(form: EditFolderFormState, field: ToggleSetting, hint: string): HTMLElement {
  const { saved, draft } = form as { saved: FolderSettings; draft: FolderSettings };
  const id = controlId(formId, field);
  const box = element("input", { attributes: { id, type: "checkbox" } });
  box.defaultChecked = saved[field];
  box.checked = draft[field];
  box.disabled = form.saving;
  box.addEventListener("change", () => {
    draft[field] = box.checked;
    if (field === "fsWatcherEnabled") requestRender();
  });
  return element("label", { className: "toggle", attributes: { for: id } }, box, element("span", {}, folderSettingLabels[field], hint ? element("small", { className: "muted" }, ` ${hint}`) : null));
}

function select<Value extends string>(id: string, choices: readonly Value[], words: (value: Value) => string, savedValue: Value, draftValue: Value, onChange: (value: Value) => void, disabled: boolean): HTMLSelectElement {
  const control = element("select", { attributes: { id } });
  for (const value of choices) {
    const option = element("option", { attributes: { value } }, words(value));
    option.defaultSelected = value === savedValue;
    control.append(option);
  }
  control.value = draftValue;
  control.disabled = disabled;
  control.addEventListener("change", () => onChange(control.value as Value));
  return control;
}

/** @implNote Answers only for the path still in the field, so a slow check never labels a later one. */
async function runPathCheck(form: EditFolderFormState, typed: string): Promise<void> {
  if (!form.saved || typed.trim() === form.saved.path) {
    form.pathCheck = null;
    return requestRender();
  }
  let check;
  try {
    check = await checkFolderPath(form.nodeId, typed, form.folderId, changedFields(form.saved, form.draft as FolderSettings).versioning !== undefined);
  } catch (error) {
    check = { path: typed, problem: messageOf(error), warning: null };
  }
  if (form.draft?.path !== typed) return;
  form.pathCheck = { typed, check };
  requestRender();
}

function pathHint(form: EditFolderFormState): HTMLElement {
  const { saved, draft } = form as { saved: FolderSettings; draft: FolderSettings };
  if (draft.path.trim() === saved.path) return element("small", { className: "muted" }, "Inside the node's root.");
  const current = form.pathCheck?.typed === draft.path ? form.pathCheck.check : null;
  const judged = !current
    ? element("small", { className: "muted" }, "Checking the path…")
    : current.problem
      ? element("small", { className: "tone-text-bad" }, current.problem)
      : element("small", { className: current.warning ? "tone-text-warn" : "tone-text-ok" }, current.warning ? `Allowed, but this path ${current.warning}.` : `Saved as ${current.path}`);
  return element("span", { className: "setting-hints" }, judged, element("small", { className: "tone-text-warn" }, pathMoveNotice));
}

function pathField(form: EditFolderFormState): HTMLElement {
  const input = textInput(form, "path");
  input.addEventListener("change", () => void runPathCheck(form, input.value));
  return settingLabel("path", input, pathHint(form));
}

/** @implNote A receive encrypted folder keeps its type: it is only ever given that type by accepting an offer. */
function typeField(form: EditFolderFormState): HTMLElement {
  const { saved, draft } = form as { saved: FolderSettings; draft: FolderSettings };
  const choices = editableFolderTypes.includes(saved.type) ? editableFolderTypes : [saved.type];
  const control = select(controlId(formId, "type"), choices, (type) => folderTypeTexts[type], saved.type, draft.type, (type) => {
    draft.type = type;
    requestRender();
  }, form.saving || choices.length === 1);
  return settingLabel("type", control);
}

function isAre(count: number): string {
  return count === 1 ? "is" : "are";
}

/** What leaving a one-way type does to the items that differ: receive only sends its local changes, send only pulls what is out of sync. */
function leavingOneWayWarning(form: EditFolderFormState, copy: FolderCopy | undefined): string | null {
  const { saved } = form as { saved: FolderSettings };
  const changedHere = copy?.localChanged ?? 0;
  const outOfSync = copy?.needItems ?? 0;
  if (saved.type === "receiveonly" && changedHere > 0) return `${plural(changedHere, "item")} changed here ${isAre(changedHere)} sent to the other devices once this is saved, replacing their versions.`;
  if (saved.type === "sendonly" && outOfSync > 0) return `${plural(outOfSync, "item")} out of sync here ${isAre(outOfSync)} pulled from the other devices once this is saved, replacing the local versions.`;
  return null;
}

function typeNotices(form: EditFolderFormState, copy: FolderCopy | undefined): HTMLElement[] {
  const { saved, draft } = form as { saved: FolderSettings; draft: FolderSettings };
  if (draft.type === saved.type) return [];
  const warning = leavingOneWayWarning(form, copy);
  return [element("p", { className: "notice tone-text-warn", attributes: { role: "status" } }, typeMeanings[draft.type]), ...(warning ? [element("p", { className: "notice tone-text-warn" }, warning)] : [])];
}

function generalSection(form: EditFolderFormState, copy: FolderCopy | undefined): HTMLElement {
  return section(
    "General",
    element("div", { className: "form-fields device-fields" }, settingLabel("label", textInput(form, "label"), "The name the pages show; empty shows the ID."), pathField(form), typeField(form)),
    ...typeNotices(form, copy),
  );
}

function minDiskFreeField(form: EditFolderFormState): HTMLElement {
  const { saved, draft } = form as { saved: FolderSettings; draft: FolderSettings };
  const value = element("input", { attributes: { id: controlId(formId, "minDiskFree"), type: "number", min: "0", step: "any", "aria-label": "Minimum free disk value" } });
  value.defaultValue = String(saved.minDiskFree.value);
  value.value = String(draft.minDiskFree.value);
  value.disabled = form.saving;
  value.addEventListener("input", () => (draft.minDiskFree = { ...draft.minDiskFree, value: value.value === "" ? Number.NaN : Number(value.value) }));
  const unit = select(controlId(formId, "minDiskFree-unit"), diskFreeUnits, (choice) => choice, saved.minDiskFree.unit, draft.minDiskFree.unit, (choice: DiskFreeUnit) => (draft.minDiskFree = { ...draft.minDiskFree, unit: choice }), form.saving);
  unit.setAttribute("aria-label", "Minimum free disk unit");
  return settingLabel("minDiskFree", element("span", { className: "setting-input" }, value, unit), "Syncthing stops pulling into the folder below this.");
}

function advancedSection(form: EditFolderFormState): HTMLElement {
  const { saved, draft } = form as { saved: FolderSettings; draft: FolderSettings };
  const order = select(controlId(formId, "order"), Object.keys(pullOrderTexts) as PullOrder[], (choice) => pullOrderTexts[choice], saved.order, draft.order, (choice) => (draft.order = choice), form.saving);
  return section(
    "Advanced",
    element(
      "div",
      { className: "form-fields device-fields" },
      element(
        "div",
        { className: "number-fields" },
        settingLabel("rescanIntervalS", numberInput(form, "rescanIntervalS", 0), "Seconds between full rescans; 0 rescans only on changes."),
        draft.fsWatcherEnabled ? settingLabel("fsWatcherDelayS", numberInput(form, "fsWatcherDelayS", 1), "Seconds the watcher gathers changes before a scan.") : null,
        settingLabel("maxConflicts", numberInput(form, "maxConflicts", -1), "-1 keeps every copy, 0 keeps none."),
      ),
      settingLabel("order", order, "Which files are pulled first."),
      minDiskFreeField(form),
      element(
        "div",
        { className: "toggles" },
        toggle(form, "fsWatcherEnabled", "scans a change as it happens"),
        toggle(form, "ignorePerms", "neither syncs nor sets file permissions"),
        toggle(form, "syncOwnership", "needs Syncthing to run with the rights to set owners"),
        toggle(form, "syncXattrs", ""),
      ),
    ),
  );
}

function nodeOf(nodeId: string): StorageNode | undefined {
  return appState.data?.nodes.find((node) => node.id === nodeId);
}

/** The node's devices, other than its own, and any device the folder is shared with that the node no longer lists. */
function deviceChoices(form: EditFolderFormState): SharingChoice[] {
  const saved = form.saved as FolderSettings;
  const node = nodeOf(form.nodeId);
  const peers = node?.peers ?? [];
  const deviceIds = [...new Set([...peers.map((peer) => peer.deviceId), ...saved.devices.map((device) => device.deviceId)])].filter((deviceId) => deviceId !== node?.syncthing?.deviceId);
  const choices = deviceIds.map((deviceId): SharingChoice => {
    const peer = peers.find((candidate) => candidate.deviceId === deviceId);
    const shared = saved.devices.find((device) => device.deviceId === deviceId);
    const name = deviceDisplayName(peer?.name, deviceId);
    return { key: deviceId, label: name, detail: shared?.encrypted ? "encrypted" : null, isShared: shared !== undefined, needsPassword: peer?.untrusted ?? false, receiver: name };
  });
  return choices.sort((first, second) => first.label.localeCompare(second.label));
}

/** On an array a new share is saved only with the folder ID typed, as the server checks it. */
function needsShareConfirm(form: EditFolderFormState): boolean {
  return isArrayNode(form.nodeId) && form.sharing.share.size > 0;
}

function isShareConfirmed(form: EditFolderFormState): boolean {
  return !needsShareConfirm(form) || isArrayConfirmed(form.confirm, form.folderId);
}

function shareConfirmField(form: EditFolderFormState): HTMLElement | null {
  if (!isArrayNode(form.nodeId)) return null;
  const nodeName = nodeOf(form.nodeId)?.name ?? form.nodeId;
  return element("div", { className: "form-fields device-fields" }, arrayConfirmField({ formId, nodeName, doing: "share it", folderId: () => form.folderId, showsId: true, typed: form.confirm, disabled: form.saving, onInput: (typed) => (form.confirm = typed) }));
}

function sharingSection(form: EditFolderFormState): HTMLElement {
  const choices = deviceChoices(form);
  if (!choices.length) return section("Sharing", element("p", { className: "muted" }, "This node has no other device yet; add one on its Nodes page to share the folder with it."));
  return section("Sharing", element("div", {}, sharingList(formId, "Shared with", form.sharing, choices, form.saving, () => (form.result = null)), shareConfirmField(form)));
}

/** The folder detail shows the saved settings and sharing at once, rather than after the next poll. */
function showSavedInDetail(form: EditFolderFormState, settings: FolderSettings): void {
  const detail = appState.folderDetail;
  if (detail?.summary.id !== form.folderId) return;
  detail.settings[form.nodeId] = settings;
  const copy = copyOf(detail, form.nodeId);
  const node = nodeOf(form.nodeId);
  if (!copy || !node?.syncthing) return;
  const others = settings.devices.filter((device) => device.deviceId !== node.syncthing?.deviceId);
  copy.sharedWith = others.map((device) => ({ deviceId: device.deviceId, name: deviceDisplayName(node.peers.find((peer) => peer.deviceId === device.deviceId)?.name, device.deviceId) }));
}

/** @implNote Measured against `saved`, the answer the form opened with, so a setting the person did not touch is never sent. */
async function save(form: EditFolderFormState): Promise<void> {
  if (!form.saved || !form.draft) return;
  const change = changedFields(form.saved, form.draft) as FolderSettingsChange;
  if (hasSharingChanges(form.sharing)) change.devices = folderSharingChange(form.sharing);
  const confirm = needsShareConfirm(form) ? { confirm: form.confirm } : {};
  if (Object.keys(change).length === 0) {
    form.result = hasUnsavedIgnores(form) ? { text: unsavedIgnoresText, tone: "warn" } : { text: "Nothing changed.", tone: "ok" };
    return requestRender();
  }
  form.saving = true;
  form.result = null;
  requestRender();
  const result = await saveFolderSettings(form.nodeId, form.folderId, { ...change, ...confirm });
  form.saving = false;
  if (result.ok) {
    form.saved = result.value;
    form.draft = structuredClone(result.value);
    form.pathCheck = null;
    clearSharing(form.sharing);
    form.confirm = "";
    form.result = hasUnsavedIgnores(form) ? { text: `Saved. ${unsavedIgnoresText}`, tone: "warn" } : { text: "Saved.", tone: "ok" };
    showSavedInDetail(form, result.value);
  } else {
    form.result = editFailureNotice(result);
  }
  requestRender();
}

function revert(form: EditFolderFormState): void {
  if (form.saved) form.draft = structuredClone(form.saved);
  if (form.ignores.opened) form.ignores.text = form.ignores.opened.lines.join("\n");
  form.ignores.result = null;
  form.pathCheck = null;
  clearSharing(form.sharing);
  form.confirm = "";
  form.result = null;
  requestRender();
}

function formBody(form: EditFolderFormState, copy: FolderCopy | undefined): HTMLElement[] {
  if (!copy?.local) return [element("p", { className: "read-only-note" }, `Read-only. A folder's settings on ${copy?.nodeName ?? "another host's node"} are edited on ${copy?.host ?? "that host"}'s own dashboard.`)];
  if (!form.saved || !form.draft) return [element("p", { className: "muted" }, appState.folderDetailError ? `Could not read the folder: ${appState.folderDetailError}` : "Reading the folder…")];
  return [
    element(
      "div",
      { className: "device-form", attributes: { id: formId } },
      generalSection(form, copy),
      sharingSection(form),
      versioningSection(form, formId),
      ignoresSection(form, formId, form.saved.type),
      advancedSection(form),
      resultLine(form.result),
      element(
        "div",
        { className: "button-row" },
        Object.assign(button(form.saving ? "Saving…" : "Save", () => void save(form), "button primary"), { disabled: form.saving || !isShareConfirmed(form) }),
        Object.assign(button("Revert", () => revert(form), "button ghost"), { disabled: form.saving }),
      ),
    ),
  ];
}

function formHeader(form: EditFolderFormState, detail: FolderDetailResponse, copy: FolderCopy | undefined): HTMLElement {
  const back = `Back to ${detail.summary.label}`;
  return element(
    "header",
    { className: "detail-header" },
    element("a", { className: "icon-button close-detail", title: back, attributes: { href: explorerLocation(form.folderId), "aria-label": back } }, icon("close")),
    element("h2", {}, `Edit ${form.saved ? form.saved.label || form.folderId : detail.summary.label}`),
    element("p", { className: "detail-status" }, `On ${copy?.nodeName ?? form.nodeId}, folder ID `, element("code", {}, form.folderId)),
  );
}

export function renderEditFolderForm(form: EditFolderFormState, detail: FolderDetailResponse): HTMLElement {
  const copy = copyOf(detail, form.nodeId);
  return element("div", { className: "detail-inner" }, formHeader(form, detail, copy), ...formBody(form, copy));
}
