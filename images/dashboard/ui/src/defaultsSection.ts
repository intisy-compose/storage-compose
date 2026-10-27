import {
  type DeviceDefaults,
  type DeviceSettings,
  type DiskFreeUnit,
  type FolderDefaults,
  type FolderSettings,
  type SaveResult,
  type StorageNode,
  changedFields,
  deviceDefaultKeys,
  diskFreeUnits,
  editableFolderTypes,
  fetchDefaultIgnores,
  fetchDeviceDefaultSettings,
  fetchFolderDefaultSettings,
  folderDefaultKeys,
  folderSettingLabels,
  folderTypeTexts,
  ignoreLinesOf,
  ignoreLinesProblem,
  pullOrderTexts,
  saveDefaultIgnores,
  saveDeviceDefaultSettings,
  saveFolderDefaultSettings,
} from "./api.js";
import { editFailureNotice, resultLine, settingFields } from "./deviceForm.js";
import { button, element } from "./dom.js";
import { type FieldForm, numberControl, selectControl, setting, toggleControl } from "./fieldKit.js";
import { controlId, registerForm } from "./forms.js";
import { requestRender } from "./renderRequest.js";
import type { Notice } from "./state.js";
import { versioningSection } from "./versioningSection.js";

interface SavingForm<Values> extends FieldForm<Values> {
  result: Notice | null;
}

/**
 * A node's defaults while their section is open; each form is held in the shape of the form it shares controls with.
 * @implNote The folder defaults are a whole `FolderSettings` so the folder edit form's Versioning section serves them unchanged.
 */
interface DefaultsState {
  open: boolean;
  loading: boolean;
  error: string | null;
  folder: SavingForm<FolderSettings> | null;
  device: SavingForm<DeviceSettings> | null;
  ignores: SavingForm<{ text: string }> | null;
}

const states = new Map<string, DefaultsState>();

function stateOf(nodeId: string): DefaultsState {
  const known = states.get(nodeId);
  if (known) return known;
  const created: DefaultsState = { open: false, loading: false, error: null, folder: null, device: null, ignores: null };
  states.set(nodeId, created);
  return created;
}

function formIdOf(nodeId: string): string {
  return `defaults-form-${nodeId}`;
}

function asFolder(defaults: FolderDefaults): FolderSettings {
  return { ...structuredClone(defaults), id: "", label: "", path: "", paused: false, devices: [] };
}

function asDevice(defaults: DeviceDefaults): DeviceSettings {
  return { ...structuredClone(defaults), deviceId: "", name: "", paused: false };
}

function savingForm<Values>(formId: string, values: Values): SavingForm<Values> {
  return { formId, saved: values, draft: structuredClone(values), saving: false, result: null };
}

async function load(nodeId: string): Promise<void> {
  const state = stateOf(nodeId);
  state.loading = true;
  state.error = null;
  requestRender();
  try {
    const [folder, device, ignores] = await Promise.all([fetchFolderDefaultSettings(nodeId), fetchDeviceDefaultSettings(nodeId), fetchDefaultIgnores(nodeId)]);
    const formId = formIdOf(nodeId);
    state.folder = savingForm(`${formId}-folder`, asFolder(folder));
    state.device = savingForm(`${formId}-device`, asDevice(device));
    state.ignores = savingForm(`${formId}-ignores`, { text: ignores.lines.join("\n") });
  } catch (error) {
    state.error = (error as Error).message;
  }
  state.loading = false;
  requestRender();
}

function pickedChange<Values extends object, Key extends keyof Values>(form: SavingForm<Values>, keys: readonly Key[]): Partial<Pick<Values, Key>> {
  const pick = (values: Values) => Object.fromEntries(keys.map((key) => [key, values[key]])) as Pick<Values, Key>;
  return changedFields(pick(form.saved), pick(form.draft));
}

async function saveForm<Values, Answer>(form: SavingForm<Values>, change: object, send: () => Promise<SaveResult<Answer>>, settle: (answer: Answer) => Values): Promise<void> {
  if (Object.keys(change).length === 0) {
    form.result = { text: "Nothing changed.", tone: "ok" };
    return requestRender();
  }
  form.saving = true;
  form.result = null;
  requestRender();
  const result = await send();
  form.saving = false;
  if (result.ok) {
    form.saved = settle(result.value);
    form.draft = structuredClone(form.saved);
    form.result = { text: "Saved.", tone: "ok" };
  } else {
    form.result = editFailureNotice(result);
  }
  requestRender();
}

function revert<Values>(form: SavingForm<Values>): void {
  form.draft = structuredClone(form.saved);
  form.result = null;
  requestRender();
}

function buttons<Values>(form: SavingForm<Values>, label: string, onSave: () => void): HTMLElement {
  return element(
    "div",
    { className: "button-row" },
    Object.assign(button(form.saving ? "Saving…" : label, onSave, "button primary"), { disabled: form.saving }),
    Object.assign(button("Revert", () => revert(form), "button ghost"), { disabled: form.saving }),
  );
}

function minDiskFreeFields(form: SavingForm<FolderSettings>): HTMLElement {
  const value = element("input", { attributes: { id: controlId(form.formId, "minDiskFree"), type: "number", min: "0", step: "any" } });
  value.defaultValue = String(form.saved.minDiskFree.value);
  value.value = String(form.draft.minDiskFree.value);
  value.addEventListener("input", () => (form.draft.minDiskFree = { ...form.draft.minDiskFree, value: value.value === "" ? Number.NaN : Number(value.value) }));
  value.disabled = form.saving;
  const unit = element("select", { attributes: { id: controlId(form.formId, "minDiskFreeUnit") } });
  for (const choice of diskFreeUnits) {
    const option = element("option", {}, choice);
    option.value = choice;
    option.defaultSelected = choice === form.saved.minDiskFree.unit;
    unit.append(option);
  }
  unit.value = form.draft.minDiskFree.unit;
  unit.addEventListener("change", () => (form.draft.minDiskFree = { ...form.draft.minDiskFree, unit: unit.value as DiskFreeUnit }));
  unit.disabled = form.saving;
  return element("div", { className: "number-fields" }, setting(form.formId, "minDiskFree", folderSettingLabels.minDiskFree, value), setting(form.formId, "minDiskFreeUnit", "Unit", unit));
}

function folderFields(form: SavingForm<FolderSettings>): HTMLElement {
  const id = form.formId;
  const label = (key: keyof typeof folderSettingLabels) => folderSettingLabels[key];
  return element(
    "div",
    { className: "form-fields device-fields" },
    setting(id, "type", label("type"), selectControl(form, "type", editableFolderTypes.map((type) => [type, folderTypeTexts[type]] as const))),
    element(
      "div",
      { className: "number-fields" },
      setting(id, "rescanIntervalS", label("rescanIntervalS"), numberControl(form, "rescanIntervalS"), "Seconds, 0 never rescans in full."),
      setting(id, "fsWatcherDelayS", label("fsWatcherDelayS"), numberControl(form, "fsWatcherDelayS", 1), "Seconds."),
      setting(id, "maxConflicts", label("maxConflicts"), numberControl(form, "maxConflicts", -1), "-1 keeps every conflict copy."),
    ),
    setting(id, "order", label("order"), selectControl(form, "order", Object.entries(pullOrderTexts) as [FolderSettings["order"], string][])),
    minDiskFreeFields(form),
    element(
      "div",
      { className: "toggles" },
      toggleControl(form, "fsWatcherEnabled", label("fsWatcherEnabled"), "picks up changes as they happen"),
      toggleControl(form, "ignorePerms", label("ignorePerms"), "does not sync file permissions"),
      toggleControl(form, "syncOwnership", label("syncOwnership"), ""),
      toggleControl(form, "syncXattrs", label("syncXattrs"), ""),
    ),
  );
}

function folderDefaultsForm(nodeId: string, form: SavingForm<FolderSettings>): HTMLElement {
  const save = () => void saveForm(form, pickedChange(form, folderDefaultKeys), () => saveFolderDefaultSettings(nodeId, pickedChange(form, folderDefaultKeys)), asFolder);
  return element(
    "div",
    { className: "device-form options-form", attributes: { id: form.formId } },
    element("h4", { className: "settings-subheading" }, "New folders start with"),
    folderFields(form),
    versioningSection(form, form.formId),
    resultLine(form.result),
    buttons(form, "Save folder defaults", save),
  );
}

function deviceDefaultsForm(node: StorageNode, form: SavingForm<DeviceSettings>): HTMLElement {
  const save = () => void saveForm(form, pickedChange(form, deviceDefaultKeys), () => saveDeviceDefaultSettings(node.id, pickedChange(form, deviceDefaultKeys)), asDevice);
  return element(
    "div",
    { className: "device-form options-form", attributes: { id: form.formId } },
    element("h4", { className: "settings-subheading" }, "New devices start with"),
    settingFields({ formId: form.formId, saving: form.saving, saved: form.saved, draft: form.draft, isArray: node.kind === "array", isDefaults: true }),
    resultLine(form.result),
    buttons(form, "Save device defaults", save),
  );
}

function ignoresField(form: SavingForm<{ text: string }>): HTMLTextAreaElement {
  const area = element("textarea", { attributes: { id: controlId(form.formId, "lines"), rows: "4", spellcheck: "false" } });
  area.defaultValue = form.saved.text;
  area.value = form.draft.text;
  area.addEventListener("input", () => (form.draft.text = area.value));
  area.disabled = form.saving;
  return area;
}

function saveIgnores(nodeId: string, form: SavingForm<{ text: string }>): void {
  const lines = ignoreLinesOf(form.draft.text);
  const problem = ignoreLinesProblem(lines);
  if (problem) {
    form.result = { text: `Not saved: ${problem}`, tone: "bad" };
    return requestRender();
  }
  const change = form.draft.text === form.saved.text ? {} : { lines };
  void saveForm(form, change, () => saveDefaultIgnores(nodeId, lines, ignoreLinesOf(form.saved.text)), (answer) => ({ text: answer.lines.join("\n") }));
}

function ignoresDefaultsForm(nodeId: string, form: SavingForm<{ text: string }>): HTMLElement {
  return element(
    "div",
    { className: "device-form options-form", attributes: { id: form.formId } },
    element("h4", { className: "settings-subheading" }, "New folders' ignore patterns"),
    setting(form.formId, "lines", "Patterns", ignoresField(form), "One per line, as in .stignore; a new folder starts with them."),
    resultLine(form.result),
    buttons(form, "Save patterns", () => saveIgnores(nodeId, form)),
  );
}

function body(node: StorageNode, state: DefaultsState): (HTMLElement | null)[] {
  if (state.error) return [element("p", { className: "warning" }, state.error), button("Read again", () => void load(node.id), "button ghost")];
  if (state.loading || !state.folder || !state.device || !state.ignores) return [element("p", { className: "muted" }, "Reading its defaults…")];
  return [folderDefaultsForm(node.id, state.folder), deviceDefaultsForm(node, state.device), ignoresDefaultsForm(node.id, state.ignores)];
}

/**
 * What a local node's new folders and devices start with, read each time the section is opened.
 * @implNote Each form is registered, so a poll does not rebuild one that holds typed input; a closed section reads nothing and drops its forms.
 */
export function defaultsSection(node: StorageNode): HTMLElement {
  const state = stateOf(node.id);
  const formId = formIdOf(node.id);
  for (const part of ["folder", "device", "ignores"]) registerForm(`${formId}-${part}`);
  const details = element("details", { className: "defaults-section" }, element("summary", {}, "Defaults for new folders and devices"), ...(state.open ? body(node, state) : []));
  details.open = state.open;
  details.addEventListener("toggle", () => {
    if (details.open === state.open) return;
    state.open = details.open;
    if (state.open && !state.loading) return void load(node.id);
    Object.assign(state, { folder: null, device: null, ignores: null, error: null });
    requestRender();
  });
  return details;
}
