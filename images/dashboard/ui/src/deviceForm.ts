import { type DeviceCompression, type DeviceSettings, type StorageNode, changedFields, deviceDisplayName, saveDeviceSettings } from "./api.js";
import { button, element, section } from "./dom.js";
import { registerForm } from "./forms.js";
import { icon } from "./icons.js";
import { requestRender } from "./renderRequest.js";
import { type DeviceFormState, locationFor } from "./state.js";

const formId = "device-form";
registerForm(formId);

type TextField = "name";
type ListField = "addresses" | "allowedNetworks";
type ToggleField = "introducer" | "autoAcceptFolders" | "paused" | "untrusted";
type NumberField = "maxSendKbps" | "maxRecvKbps" | "numConnections";

const compressionChoices: [DeviceCompression, string][] = [
  ["metadata", "Metadata only"],
  ["always", "All data"],
  ["never", "Off"],
];

function controlId(field: keyof DeviceSettings): string {
  return `${formId}-${field}`;
}

/** One entry per line or comma, as a person pastes them. */
function listOf(text: string): string[] {
  return text.split(/[\n,]/).map((entry) => entry.trim()).filter(Boolean);
}

function labelled(field: keyof DeviceSettings, label: string, control: HTMLElement, hint?: string): HTMLElement {
  return element("label", { className: "setting", attributes: { for: controlId(field) } }, element("span", {}, label), control, hint ? element("small", { className: "muted" }, hint) : null);
}

function textInput(form: DeviceFormState, field: TextField, saved: DeviceSettings, draft: DeviceSettings): HTMLInputElement {
  const input = element("input", { attributes: { id: controlId(field), autocomplete: "off" } });
  input.defaultValue = saved[field];
  input.value = draft[field];
  input.addEventListener("input", () => (draft[field] = input.value));
  input.disabled = form.saving;
  return input;
}

function listInput(form: DeviceFormState, field: ListField, saved: DeviceSettings, draft: DeviceSettings): HTMLTextAreaElement {
  const area = element("textarea", { attributes: { id: controlId(field), rows: "3", spellcheck: "false" } });
  area.defaultValue = saved[field].join("\n");
  area.value = draft[field].join("\n");
  area.addEventListener("input", () => (draft[field] = listOf(area.value)));
  area.disabled = form.saving;
  return area;
}

function numberInput(form: DeviceFormState, field: NumberField, saved: DeviceSettings, draft: DeviceSettings): HTMLInputElement {
  const input = element("input", { attributes: { id: controlId(field), type: "number", min: "0", step: "1" } });
  input.defaultValue = String(saved[field]);
  input.value = String(draft[field]);
  input.addEventListener("input", () => (draft[field] = input.value === "" ? Number.NaN : Number(input.value)));
  input.disabled = form.saving;
  return input;
}

function toggle(form: DeviceFormState, field: ToggleField, label: string, saved: DeviceSettings, draft: DeviceSettings): HTMLElement {
  const box = element("input", { attributes: { id: controlId(field), type: "checkbox" } });
  box.defaultChecked = saved[field];
  box.checked = draft[field];
  box.addEventListener("change", () => (draft[field] = box.checked));
  box.disabled = form.saving;
  return element("label", { className: "toggle", attributes: { for: controlId(field) } }, box, element("span", {}, label));
}

function compressionSelect(form: DeviceFormState, saved: DeviceSettings, draft: DeviceSettings): HTMLSelectElement {
  const select = element("select", { attributes: { id: controlId("compression") } });
  for (const [value, label] of compressionChoices) {
    const option = element("option", {}, label);
    option.value = value;
    option.defaultSelected = value === saved.compression;
    select.append(option);
  }
  select.value = draft.compression;
  select.addEventListener("change", () => (draft.compression = select.value as DeviceCompression));
  select.disabled = form.saving;
  return select;
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
    form.result = { text: `Not saved: ${result.message}`, tone: "bad" };
  }
  requestRender();
}

function revert(form: DeviceFormState): void {
  if (form.saved) form.draft = structuredClone(form.saved);
  form.result = null;
  requestRender();
}

function fields(form: DeviceFormState, saved: DeviceSettings, draft: DeviceSettings): HTMLElement {
  return element(
    "div",
    { className: "form-fields device-fields" },
    labelled("name", "Name", textInput(form, "name", saved, draft), "Empty shows the short device ID."),
    labelled("addresses", "Addresses", listInput(form, "addresses", saved, draft), "One per line: dynamic, tcp://host:port, quic://host:port or relay://…"),
    labelled("compression", "Compression", compressionSelect(form, saved, draft)),
    element(
      "div",
      { className: "toggles" },
      toggle(form, "introducer", "Introducer: add the devices it shares folders with", saved, draft),
      toggle(form, "autoAcceptFolders", "Accept the folders it offers automatically", saved, draft),
      toggle(form, "untrusted", "Untrusted: share only encrypted folders with it", saved, draft),
      toggle(form, "paused", "Paused", saved, draft),
    ),
    labelled("allowedNetworks", "Allowed networks", listInput(form, "allowedNetworks", saved, draft), "One network per line, such as 192.168.0.0/16; empty allows any."),
    element(
      "div",
      { className: "number-fields" },
      labelled("maxSendKbps", "Send limit", numberInput(form, "maxSendKbps", saved, draft), "KiB/s, 0 is unlimited."),
      labelled("maxRecvKbps", "Receive limit", numberInput(form, "maxRecvKbps", saved, draft), "KiB/s, 0 is unlimited."),
      labelled("numConnections", "Connections", numberInput(form, "numConnections", saved, draft), "0 lets Syncthing choose."),
    ),
  );
}

function resultLine(form: DeviceFormState): HTMLElement | null {
  const result = form.result;
  return result ? element("p", { className: `notice tone-text-${result.tone}`, attributes: { role: "status" } }, result.text) : null;
}

function formBody(node: StorageNode, form: DeviceFormState): HTMLElement {
  if (!form.saved || !form.draft) {
    return element("p", { className: form.loadError ? "tone-text-bad" : "muted" }, form.loadError ? `Could not read the device: ${form.loadError}` : "Reading the device…");
  }
  if (!node.local) return element("p", { className: "read-only-note" }, `Read-only. ${node.name}'s devices are edited on ${node.host}'s own dashboard.`);
  return element(
    "div",
    { className: "device-form", attributes: { id: formId } },
    fields(form, form.saved, form.draft),
    resultLine(form),
    element(
      "div",
      { className: "button-row" },
      Object.assign(button(form.saving ? "Saving…" : "Save", () => void save(form), "button primary"), { disabled: form.saving }),
      Object.assign(button("Revert", () => revert(form), "button ghost"), { disabled: form.saving }),
    ),
  );
}

export function renderDeviceForm(node: StorageNode, form: DeviceFormState): HTMLElement {
  const title = deviceDisplayName(form.saved?.name, form.deviceId);
  return element(
    "div",
    { className: "detail-inner" },
    element(
      "header",
      { className: "detail-header" },
      element("a", { className: "icon-button close-detail", title: `Back to ${node.name}`, attributes: { href: locationFor("nodes", node.id), "aria-label": `Back to ${node.name}` } }, icon("close")),
      element("h2", {}, title),
      element("p", { className: "detail-status" }, `A device as ${node.name} has it configured`),
    ),
    section("Device ID", element("code", { className: "device-id" }, form.deviceId)),
    section("Settings", formBody(node, form)),
  );
}
