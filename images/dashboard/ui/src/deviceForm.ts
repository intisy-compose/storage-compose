import {
  type DeviceCompression,
  type DeviceSettings,
  type DeviceSettingsChange,
  type FolderSettings,
  type FolderSettingsChange,
  type SaveResult,
  type StorageNode,
  changedFields,
  deviceDisplayName,
  deviceSettingLabels,
  removeDevice,
  saveDeviceSettings,
  saveFolderSettings,
} from "./api.js";
import { button, element, section } from "./dom.js";
import { registerForm } from "./forms.js";
import { icon } from "./icons.js";
import { requestRender } from "./renderRequest.js";
import { type SharingChoice, clearSharing, sharingList } from "./sharingFields.js";
import { type DeviceFormState, type Notice, appState, locationFor } from "./state.js";

const formId = "device-form";
registerForm(formId);
const removeFormId = "device-remove-form";
registerForm(removeFormId);
const foldersFormId = "device-folders-form";
registerForm(foldersFormId);

type TextField = "name";
type ListField = "addresses" | "allowedNetworks";
type ToggleField = "introducer" | "autoAcceptFolders" | "paused" | "untrusted";
type NumberField = "maxSendKbps" | "maxRecvKbps" | "numConnections";

/** What a device form's setting controls work on: the form they belong to, the values it opened with and what it holds now. */
export interface SettingsContext {
  formId: string;
  saving: boolean;
  /** Each control's default, so the poll can tell typed input from what the form opened with. */
  saved: DeviceSettings;
  draft: DeviceSettings;
}

const compressionChoices: [DeviceCompression, string][] = [
  ["metadata", "Metadata only"],
  ["always", "All data"],
  ["never", "Off"],
];

export function controlId(owner: string, field: string): string {
  return `${owner}-${field}`;
}

/** One entry per line or comma, as a person pastes them. */
function listOf(text: string): string[] {
  return text.split(/[\n,]/).map((entry) => entry.trim()).filter(Boolean);
}

function labelled(context: SettingsContext, field: keyof DeviceSettingsChange, control: HTMLElement, hint?: string): HTMLElement {
  return element("label", { className: "setting", attributes: { for: controlId(context.formId, field) } }, element("span", {}, deviceSettingLabels[field]), control, hint ? element("small", { className: "muted" }, hint) : null);
}

function textInput(context: SettingsContext, field: TextField): HTMLInputElement {
  const { saved, draft } = context;
  const input = element("input", { attributes: { id: controlId(context.formId, field), autocomplete: "off" } });
  input.defaultValue = saved[field];
  input.value = draft[field];
  input.addEventListener("input", () => (draft[field] = input.value));
  input.disabled = context.saving;
  return input;
}

function listInput(context: SettingsContext, field: ListField): HTMLTextAreaElement {
  const { saved, draft } = context;
  const area = element("textarea", { attributes: { id: controlId(context.formId, field), rows: "3", spellcheck: "false" } });
  area.defaultValue = saved[field].join("\n");
  area.value = draft[field].join("\n");
  area.addEventListener("input", () => (draft[field] = listOf(area.value)));
  area.disabled = context.saving;
  return area;
}

function numberInput(context: SettingsContext, field: NumberField): HTMLInputElement {
  const { saved, draft } = context;
  const input = element("input", { attributes: { id: controlId(context.formId, field), type: "number", min: "0", step: "1" } });
  input.defaultValue = String(saved[field]);
  input.value = String(draft[field]);
  input.addEventListener("input", () => (draft[field] = input.value === "" ? Number.NaN : Number(input.value)));
  input.disabled = context.saving;
  return input;
}

function toggle(context: SettingsContext, field: ToggleField, hint: string): HTMLElement {
  const { saved, draft } = context;
  const id = controlId(context.formId, field);
  const box = element("input", { attributes: { id, type: "checkbox" } });
  box.defaultChecked = saved[field];
  box.checked = draft[field];
  box.addEventListener("change", () => (draft[field] = box.checked));
  box.disabled = context.saving;
  return element("label", { className: "toggle", attributes: { for: id } }, box, element("span", {}, deviceSettingLabels[field], hint ? element("small", { className: "muted" }, ` ${hint}`) : null));
}

function compressionSelect(context: SettingsContext): HTMLSelectElement {
  const { saved, draft } = context;
  const select = element("select", { attributes: { id: controlId(context.formId, "compression") } });
  for (const [value, label] of compressionChoices) {
    const option = element("option", {}, label);
    option.value = value;
    option.defaultSelected = value === saved.compression;
    select.append(option);
  }
  select.value = draft.compression;
  select.addEventListener("change", () => (draft.compression = select.value as DeviceCompression));
  select.disabled = context.saving;
  return select;
}

/** A device's settings, the same controls and labels whether the device is being edited or added. */
export function settingFields(context: SettingsContext): HTMLElement {
  return element(
    "div",
    { className: "form-fields device-fields" },
    labelled(context, "name", textInput(context, "name"), "Empty shows the short device ID."),
    labelled(context, "addresses", listInput(context, "addresses"), "One per line: dynamic, tcp://host:port, quic://host:port or relay://host:port?id=…"),
    labelled(context, "compression", compressionSelect(context)),
    element(
      "div",
      { className: "toggles" },
      toggle(context, "introducer", "adds the devices it shares folders with"),
      toggle(context, "autoAcceptFolders", "accepts the folders it offers"),
      toggle(context, "untrusted", "shares only encrypted folders with it"),
      toggle(context, "paused", ""),
    ),
    labelled(context, "allowedNetworks", listInput(context, "allowedNetworks"), "One network per line, such as 192.168.0.0/16; empty allows any."),
    element(
      "div",
      { className: "number-fields" },
      labelled(context, "maxSendKbps", numberInput(context, "maxSendKbps"), "KiB/s, 0 is unlimited."),
      labelled(context, "maxRecvKbps", numberInput(context, "maxRecvKbps"), "KiB/s, 0 is unlimited."),
      labelled(context, "numConnections", numberInput(context, "numConnections"), "0 lets Syncthing choose."),
    ),
  );
}

/** The node's own device: only its name can be changed, the name other devices are offered for the node. */
function ownNameField(context: SettingsContext): HTMLElement {
  return element("div", { className: "form-fields device-fields" }, labelled(context, "name", textInput(context, "name"), "Empty shows the short device ID."));
}

function isOwnDevice(node: StorageNode, form: DeviceFormState): boolean {
  return node.syncthing?.deviceId === form.deviceId;
}

/** @implNote Measured against `saved`, the answer the form opened with, so a field the person did not touch is never sent. */
async function save(form: DeviceFormState): Promise<void> {
  if (!form.saved || !form.draft) return;
  const change = changedFields(form.saved, form.draft);
  if (Object.keys(change).length === 0) {
    form.result = { text: "Nothing changed.", tone: "ok" };
    return requestRender();
  }
  form.saving = true;
  form.result = null;
  requestRender();
  const result = await saveDeviceSettings(form.nodeId, form.deviceId, change);
  form.saving = false;
  if (result.ok) {
    form.saved = result.value;
    form.draft = structuredClone(result.value);
    form.result = { text: "Saved.", tone: "ok" };
  } else {
    form.result = editFailureNotice(result);
  }
  requestRender();
}

function revert(form: DeviceFormState): void {
  if (form.saved) form.draft = structuredClone(form.saved);
  form.result = null;
  requestRender();
}

/** An edit that was refused says so; one whose node stopped answering mid-write may have been saved, and the server's words say to check. */
export function editFailureNotice(result: Extract<SaveResult<unknown>, { ok: false }>): Notice {
  return result.maybeSaved ? { text: `${result.message}.`, tone: "warn" } : { text: `Not saved: ${result.message}`, tone: "bad" };
}

export function resultLine(result: DeviceFormState["result"]): HTMLElement | null {
  return result ? element("p", { className: `notice tone-text-${result.tone}`, attributes: { role: "status" } }, result.text) : null;
}

function formBody(node: StorageNode, form: DeviceFormState): HTMLElement {
  if (!form.saved || !form.draft) {
    return element("p", { className: form.loadError ? "tone-text-bad" : "muted" }, form.loadError ? `Could not read the device: ${form.loadError}` : "Reading the device…");
  }
  if (!node.local) return element("p", { className: "read-only-note" }, `Read-only. ${node.name}'s devices are edited on ${node.host}'s own dashboard.`);
  const context: SettingsContext = { formId, saving: form.saving, saved: form.saved, draft: form.draft };
  return element(
    "div",
    { className: "device-form", attributes: { id: formId } },
    isOwnDevice(node, form) ? ownNameField(context) : settingFields(context),
    resultLine(form.result),
    element(
      "div",
      { className: "button-row" },
      Object.assign(button(form.saving ? "Saving…" : "Save", () => void save(form), "button primary"), { disabled: form.saving }),
      Object.assign(button("Revert", () => revert(form), "button ghost"), { disabled: form.saving }),
    ),
  );
}

/** The panel's header with a way back to the node's detail. */
export function nodeFormHeader(node: StorageNode, title: string, status: string): HTMLElement {
  return element(
    "header",
    { className: "detail-header" },
    element("a", { className: "icon-button close-detail", title: `Back to ${node.name}`, attributes: { href: locationFor("nodes", node.id), "aria-label": `Back to ${node.name}` } }, icon("close")),
    element("h2", {}, title),
    element("p", { className: "detail-status" }, status),
  );
}

/** @implNote Looked up again: the form is not rebuilt while it holds typed input, so the node it was drawn with may be an earlier poll's. */
function dropFromCurrentNode(form: DeviceFormState): void {
  const node = appState.data?.nodes.find((candidate) => candidate.id === form.nodeId);
  if (node) node.peers = node.peers.filter((peer) => peer.deviceId !== form.deviceId);
}

async function remove(form: DeviceFormState): Promise<void> {
  form.removing = true;
  form.removeResult = null;
  requestRender();
  const result = await removeDevice(form.nodeId, form.deviceId, form.removeConfirm);
  form.removing = false;
  if (result.ok) {
    form.removed = true;
    dropFromCurrentNode(form);
  } else {
    form.removeResult = { text: `Not removed: ${result.message}`, tone: "bad" };
  }
  requestRender();
}

/** @implNote The device's name, typed, is the confirmation the server asks for; the button waits for it so a stray click cannot remove a device. */
function removeForm(node: StorageNode, form: DeviceFormState, name: string): HTMLElement {
  const confirmInput = element("input", { attributes: { id: controlId(removeFormId, "confirm"), autocomplete: "off", placeholder: `type ${name} to confirm` } });
  confirmInput.defaultValue = "";
  confirmInput.value = form.removeConfirm;
  confirmInput.disabled = form.removing;
  const removeButton = button(form.removing ? "Removing…" : `Remove ${name}`, () => void remove(form), "button danger");
  removeButton.disabled = form.removing || form.removeConfirm !== name;
  confirmInput.addEventListener("input", () => {
    form.removeConfirm = confirmInput.value;
    removeButton.disabled = form.removing || form.removeConfirm !== name;
  });
  return element(
    "div",
    { className: "action-form destructive", attributes: { id: removeFormId } },
    element("p", {}, `${node.name} stops syncing with ${name}, and every folder it shares with ${name} stops sharing. Type ${name} to confirm.`),
    element("div", { className: "form-fields" }, confirmInput),
    resultLine(form.removeResult),
    element("div", { className: "button-row" }, removeButton),
  );
}

function removedBody(node: StorageNode, name: string): HTMLElement {
  return element(
    "div",
    {},
    element("p", { className: "notice tone-text-ok", attributes: { role: "status" } }, `Removed ${name} from ${node.name}.`),
    element("div", { className: "button-row" }, element("a", { className: "button", attributes: { href: locationFor("nodes", node.id) } }, `Back to ${node.name}`)),
  );
}

function folderChoices(node: StorageNode, form: DeviceFormState, name: string): SharingChoice[] {
  const choices = node.folders.map((folder): SharingChoice => ({
    key: folder.id,
    label: folder.label || folder.id,
    detail: folder.path,
    isShared: folder.sharedWith.some((peer) => peer.deviceId === form.deviceId),
    needsPassword: form.saved?.untrusted ?? false,
    receiver: name,
  }));
  return choices.sort((first, second) => first.label.localeCompare(second.label));
}

interface FolderShareWrite {
  folderId: string;
  change: FolderSettingsChange;
}

function folderShareWrites(form: DeviceFormState): FolderShareWrite[] {
  const shares = [...form.sharing.share].map(([folderId, password]) => ({ folderId, change: { devices: { share: [{ deviceId: form.deviceId, ...(password ? { encryptionPassword: password } : {}) }] } } }));
  const unshares = [...form.sharing.unshare].map((folderId) => ({ folderId, change: { devices: { unshare: [form.deviceId] } } }));
  return [...shares, ...unshares];
}

/** @implNote Looked up again, like a removal: the node the form was drawn with may be an earlier poll's. */
function showSharedInCurrentNode(form: DeviceFormState, settings: FolderSettings, name: string): void {
  const folder = appState.data?.nodes.find((candidate) => candidate.id === form.nodeId)?.folders.find((candidate) => candidate.id === settings.id);
  if (!folder) return;
  const others = folder.sharedWith.filter((peer) => peer.deviceId !== form.deviceId);
  folder.sharedWith = settings.devices.some((device) => device.deviceId === form.deviceId) ? [...others, { deviceId: form.deviceId, name }] : others;
}

function forgetSaved(form: DeviceFormState, folderId: string): void {
  form.sharing.share.delete(folderId);
  form.sharing.unshare.delete(folderId);
  form.sharing.revealed.delete(folderId);
}

function sharingNotice(failures: string[], unsure: string[]): Notice {
  if (failures.length) return { text: `Not saved for ${failures.join("; ")}`, tone: "bad" };
  return unsure.length ? { text: `${unsure.join("; ")}.`, tone: "warn" } : { text: "Saved.", tone: "ok" };
}

/** Each ticked or unticked folder is its own edit of that folder's sharing; one that fails stays ticked to try again. */
async function saveSharing(form: DeviceFormState, name: string): Promise<void> {
  const writes = folderShareWrites(form);
  if (writes.length === 0) {
    form.sharingResult = { text: "Nothing changed.", tone: "ok" };
    return requestRender();
  }
  form.sharingSaving = true;
  form.sharingResult = null;
  requestRender();
  const failures: string[] = [];
  const unsure: string[] = [];
  for (const write of writes) {
    const result = await saveFolderSettings(form.nodeId, write.folderId, write.change);
    if (result.ok) {
      forgetSaved(form, write.folderId);
      showSharedInCurrentNode(form, result.value, name);
    } else if (result.maybeSaved) {
      unsure.push(`${write.folderId}: ${result.message}`);
    } else {
      failures.push(`${write.folderId}: ${result.message}`);
    }
  }
  form.sharingSaving = false;
  form.sharingResult = sharingNotice(failures, unsure);
  requestRender();
}

function revertSharing(form: DeviceFormState): void {
  clearSharing(form.sharing);
  form.sharingResult = null;
  requestRender();
}

function foldersForm(node: StorageNode, form: DeviceFormState, name: string): HTMLElement {
  const choices = folderChoices(node, form, name);
  if (choices.length === 0) return element("p", { className: "muted" }, `${node.name} has no folder yet.`);
  return element(
    "div",
    { className: "device-form", attributes: { id: foldersFormId } },
    sharingList(foldersFormId, `${node.name}'s folders shared with ${name}`, form.sharing, choices, form.sharingSaving),
    resultLine(form.sharingResult),
    element(
      "div",
      { className: "button-row" },
      Object.assign(button(form.sharingSaving ? "Saving…" : "Save sharing", () => void saveSharing(form, name), "button primary"), { disabled: form.sharingSaving }),
      Object.assign(button("Revert", () => revertSharing(form), "button ghost"), { disabled: form.sharingSaving }),
    ),
  );
}

function deviceSections(node: StorageNode, form: DeviceFormState, name: string): HTMLElement[] {
  if (form.removed) return [section("Removed", removedBody(node, name))];
  const isOtherLocalDevice = node.local && form.saved !== null && !isOwnDevice(node, form);
  return [
    section("Device ID", element("code", { className: "device-id" }, form.deviceId)),
    section("Settings", formBody(node, form)),
    ...(isOtherLocalDevice ? [section("Folders", foldersForm(node, form, name)), section("Remove device", removeForm(node, form, name))] : []),
  ];
}

export function renderDeviceForm(node: StorageNode, form: DeviceFormState): HTMLElement {
  const name = deviceDisplayName(form.saved?.name, form.deviceId);
  const own = isOwnDevice(node, form);
  return element(
    "div",
    { className: "detail-inner" },
    nodeFormHeader(node, own ? `Rename ${node.name}` : name, own ? `The device name other devices see for ${node.name}` : `A device as ${node.name} has it configured`),
    ...deviceSections(node, form, name),
  );
}
