import { type DiskFreeUnit, type GeneralSettingsChange, type InstanceOptions, type StorageNode, type UsageReportingChoice, changedFields, diskFreeUnits, generalSettingLabels, saveGeneralSettings } from "./api.js";
import { editFailureNotice, resultLine } from "./deviceForm.js";
import { button, element } from "./dom.js";
import { type FieldForm, numberControl, selectControl, setting, textControl, toggleControl } from "./fieldKit.js";
import { registerForm } from "./forms.js";
import { requestRender } from "./renderRequest.js";
import { appState, type Notice } from "./state.js";

/** `usageReporting` is empty while the node's Syncthing has not been answered, which the form never sends. */
interface GeneralValues {
  deviceName: string;
  keepFree: number;
  keepFreeUnit: DiskFreeUnit;
  usageReporting: UsageReportingChoice | "";
  crashReportingEnabled: boolean;
}

interface GeneralFormState extends FieldForm<GeneralValues> {
  result: Notice | null;
}

const forms = new Map<string, GeneralFormState>();

function usageChoiceOf(urAccepted: number): GeneralValues["usageReporting"] {
  if (urAccepted < 0) return "declined";
  return urAccepted > 0 ? "accepted" : "";
}

function valuesOf(options: InstanceOptions): GeneralValues {
  const unit = diskFreeUnits.includes(options.minHomeDiskFree.unit as DiskFreeUnit) ? (options.minHomeDiskFree.unit as DiskFreeUnit) : "%";
  return { deviceName: options.deviceName, keepFree: options.minHomeDiskFree.value, keepFreeUnit: unit, usageReporting: usageChoiceOf(options.urAccepted), crashReportingEnabled: options.crashReportingEnabled };
}

function hasUnsavedChange(form: GeneralFormState): boolean {
  return Object.keys(changedFields(form.saved, form.draft)).length > 0;
}

/** The node's form, following each read of its options while it holds nothing unsaved. */
function formFor(nodeId: string, options: InstanceOptions): GeneralFormState {
  const read = valuesOf(options);
  const form = forms.get(nodeId);
  if (!form) {
    const formId = `general-form-${nodeId}`;
    registerForm(formId);
    const created: GeneralFormState = { formId, saved: read, draft: structuredClone(read), saving: false, result: null };
    forms.set(nodeId, created);
    return created;
  }
  if (!form.saving && !hasUnsavedChange(form)) {
    form.saved = read;
    form.draft = structuredClone(read);
  }
  return form;
}

/** The change as the server takes it: free space whole when either half changed, usage reporting only once answered. */
function generalChangeOf(saved: GeneralValues, draft: GeneralValues): GeneralSettingsChange {
  const changed = changedFields(saved, draft);
  const change: GeneralSettingsChange = {};
  if (changed.deviceName !== undefined) change.deviceName = draft.deviceName;
  if (changed.keepFree !== undefined || changed.keepFreeUnit !== undefined) change.minHomeDiskFree = { value: draft.keepFree, unit: draft.keepFreeUnit };
  if (changed.usageReporting) change.usageReporting = changed.usageReporting;
  if (changed.crashReportingEnabled !== undefined) change.crashReportingEnabled = draft.crashReportingEnabled;
  return change;
}

async function save(nodeId: string, form: GeneralFormState): Promise<void> {
  const change = generalChangeOf(form.saved, form.draft);
  if (Object.keys(change).length === 0) {
    form.result = { text: "Nothing changed.", tone: "ok" };
    return requestRender();
  }
  form.saving = true;
  form.result = null;
  requestRender();
  const result = await saveGeneralSettings(nodeId, change);
  form.saving = false;
  if (result.ok) {
    appState.nodeOptions.set(nodeId, result.value);
    form.saved = valuesOf(result.value.options);
    form.draft = structuredClone(form.saved);
    form.result = { text: "Saved.", tone: "ok" };
  } else {
    form.result = editFailureNotice(result);
  }
  requestRender();
}

function revert(form: GeneralFormState): void {
  form.draft = structuredClone(form.saved);
  form.result = null;
  requestRender();
}

function usageChoices(form: GeneralFormState): [GeneralValues["usageReporting"], string][] {
  const unanswered: [GeneralValues["usageReporting"], string][] = form.saved.usageReporting === "" ? [["", "Not answered yet: Syncthing sends nothing until it is"]] : [];
  return [...unanswered, ["declined", "Declined: sends nothing"], ["accepted", "Accepted: sends anonymous usage reports to data.syncthing.net"]];
}

function generalFields(form: GeneralFormState, nodeName: string): HTMLElement {
  const id = form.formId;
  return element(
    "div",
    { className: "form-fields device-fields" },
    setting(id, "deviceName", generalSettingLabels.deviceName, textControl(form, "deviceName"), `The name other devices see for ${nodeName}.`),
    element(
      "div",
      { className: "number-fields" },
      setting(id, "keepFree", generalSettingLabels.minHomeDiskFree, numberControl(form, "keepFree"), "Syncthing stops syncing when less is free where it keeps its database."),
      setting(id, "keepFreeUnit", "Unit", selectControl(form, "keepFreeUnit", diskFreeUnits.map((unit) => [unit, unit] as const))),
    ),
    setting(id, "usageReporting", generalSettingLabels.usageReporting, selectControl(form, "usageReporting", usageChoices(form)), "The person decides; the dashboard never accepts for them."),
    element("div", { className: "toggles" }, toggleControl(form, "crashReportingEnabled", generalSettingLabels.crashReportingEnabled, "sends a report to crash.syncthing.net when Syncthing crashes")),
  );
}

/** A local node's own device name, home disk reserve and the reports its Syncthing sends, as a form. */
export function generalSettingsForm(node: StorageNode, options: InstanceOptions): HTMLElement {
  const form = formFor(node.id, options);
  return element(
    "div",
    { className: "device-form options-form", attributes: { id: form.formId } },
    element("h3", { className: "settings-subheading" }, "General"),
    generalFields(form, node.name),
    resultLine(form.result),
    element(
      "div",
      { className: "button-row" },
      Object.assign(button(form.saving ? "Saving…" : "Save", () => void save(node.id, form), "button primary"), { disabled: form.saving }),
      Object.assign(button("Revert", () => revert(form), "button ghost"), { disabled: form.saving }),
    ),
  );
}
