import { type FolderSettings, type VersioningParam, type VersioningType, cleanupIntervalLabel, externalVersioningRefusal, folderSettingLabels, isKeptBySyncthing, secondsPerDay, versioningParamKeys, versioningParamLabels, versioningTypeTexts, versionsPathLabel } from "./api.js";
import { controlId } from "./deviceForm.js";
import { element, section } from "./dom.js";
import { versioningOfType } from "./folderDraft.js";
import { requestRender } from "./renderRequest.js";
import type { EditFolderFormState } from "./state.js";

/** What each type keeps, shown under the type. */
const typeMeanings: Record<VersioningType, string> = {
  "": "A file replaced or deleted by another device is gone from this node.",
  trashcan: "A file replaced or deleted by another device is moved to the versions path; only its last version is kept.",
  simple: "A file replaced or deleted by another device is moved to the versions path, keeping the given number of its versions.",
  staggered: "Keeps fewer versions the older they get: one every 30 s in the first hour, one an hour in the first day, one a day for 30 days, then one a week up to the maximum age.",
  external: "Syncthing runs a command on the node for a file about to be replaced or deleted, instead of keeping a version itself.",
};

const paramHints: Record<VersioningParam, string> = {
  cleanoutDays: "0 never cleans them out.",
  keep: "Per file, 1 or more.",
  maxAge: "0 keeps them forever.",
  command: "",
};

/** The params whose field shows days while Syncthing keeps seconds. */
const daysParams = new Set<VersioningParam>(["maxAge"]);

type Forms = { saved: FolderSettings; draft: FolderSettings };

function fieldLabel(formId: string, field: string, text: string, control: HTMLElement, hint: string): HTMLElement {
  return element("label", { className: "setting", attributes: { for: controlId(formId, field) } }, element("span", {}, text), control, hint ? element("small", { className: "muted" }, hint) : null);
}

function shownValue(key: VersioningParam, stored: string | undefined): string {
  if (stored === undefined) return "";
  return daysParams.has(key) && /^\d+$/.test(stored) ? String(Number(stored) / secondsPerDay) : stored;
}

/** @implNote A field left empty or not a number is stored as typed, so the save names it instead of sending a guess. */
function storedValue(key: VersioningParam, typed: string): string {
  const number = Number(typed);
  if (!daysParams.has(key) || typed.trim() === "" || !Number.isFinite(number)) return typed.trim();
  return String(Math.round(number * secondsPerDay));
}

function paramField(form: EditFolderFormState, formId: string, key: VersioningParam): HTMLElement {
  const { saved, draft } = form as Forms;
  const field = `versioning-${key}`;
  const input = element("input", { attributes: { id: controlId(formId, field), type: "number", min: key === "keep" ? "1" : "0", step: daysParams.has(key) ? "any" : "1" } });
  input.defaultValue = shownValue(key, saved.versioning.type === draft.versioning.type ? saved.versioning.params[key] : undefined);
  input.value = shownValue(key, draft.versioning.params[key]);
  input.disabled = form.saving;
  input.addEventListener("input", () => (draft.versioning = { ...draft.versioning, params: { ...draft.versioning.params, [key]: storedValue(key, input.value) } }));
  return fieldLabel(formId, field, versioningParamLabels[key], input, paramHints[key]);
}

function cleanupField(form: EditFolderFormState, formId: string): HTMLElement {
  const { saved, draft } = form as Forms;
  const input = element("input", { attributes: { id: controlId(formId, "versioning-cleanup"), type: "number", min: "0", step: "1" } });
  input.defaultValue = String(saved.versioning.cleanupIntervalS);
  input.value = String(draft.versioning.cleanupIntervalS);
  input.disabled = form.saving;
  input.addEventListener("input", () => (draft.versioning = { ...draft.versioning, cleanupIntervalS: input.value === "" ? Number.NaN : Number(input.value) }));
  return fieldLabel(formId, "versioning-cleanup", cleanupIntervalLabel, input, "Seconds between removing versions past their time; 0 never.");
}

function versionsPathField(form: EditFolderFormState, formId: string): HTMLElement {
  const { saved, draft } = form as Forms;
  const input = element("input", { attributes: { id: controlId(formId, "versioning-path"), autocomplete: "off", spellcheck: "false", placeholder: ".stversions inside the folder" } });
  input.defaultValue = saved.versioning.fsPath;
  input.value = draft.versioning.fsPath;
  input.disabled = form.saving;
  input.addEventListener("input", () => (draft.versioning = { ...draft.versioning, fsPath: input.value }));
  return fieldLabel(formId, "versioning-path", versionsPathLabel, input, "Empty keeps them in .stversions inside the folder. Inside the node's root; a relative path is read from the folder's path and saved in full.");
}

/** @implNote External is offered only to a folder that already has it, to leave it: the dashboard never sets a command. */
function typeChoices(saved: FolderSettings): VersioningType[] {
  const offered = (Object.keys(versioningTypeTexts) as VersioningType[]).filter((type) => type !== "external");
  return saved.versioning.type === "external" ? [...offered, "external"] : offered;
}

function typeField(form: EditFolderFormState, formId: string): HTMLElement {
  const { saved, draft } = form as Forms;
  const control = element("select", { attributes: { id: controlId(formId, "versioning-type") } });
  for (const type of typeChoices(saved)) {
    const option = element("option", { attributes: { value: type } }, versioningTypeTexts[type]);
    option.defaultSelected = type === saved.versioning.type;
    control.append(option);
  }
  control.value = draft.versioning.type;
  control.disabled = form.saving;
  control.addEventListener("change", () => {
    draft.versioning = versioningOfType(saved.versioning, draft.versioning, control.value as VersioningType);
    requestRender();
  });
  return fieldLabel(formId, "versioning-type", folderSettingLabels.versioning, control, typeMeanings[draft.versioning.type]);
}

function externalCommand(form: EditFolderFormState): HTMLElement[] {
  const { draft } = form as Forms;
  return [
    element("p", {}, "Command ", element("code", {}, draft.versioning.params.command ?? "")),
    element("p", { className: "notice tone-text-warn" }, `Read-only here: ${externalVersioningRefusal}. Choose another type to replace it.`),
  ];
}

function keptFields(form: EditFolderFormState, formId: string): (HTMLElement | null)[] {
  const { draft } = form as Forms;
  const type = draft.versioning.type;
  if (type === "external") return externalCommand(form);
  if (!isKeptBySyncthing(type)) return [];
  const params = versioningParamKeys[type].map((key) => paramField(form, formId, key));
  return [element("div", { className: "number-fields" }, ...params, cleanupField(form, formId)), versionsPathField(form, formId)];
}

/** The form's Versioning section; the draft's `versioning` is sent whole once anything in it differs from the saved one. */
export function versioningSection(form: EditFolderFormState, formId: string): HTMLElement {
  return section("Versioning", element("div", { className: "form-fields device-fields" }, typeField(form, formId), ...keptFields(form, formId)));
}
