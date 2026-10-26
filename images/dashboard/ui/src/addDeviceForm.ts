import { type AddedDevice, type NearbyDevice, type StorageNode, addDevice, changedFields, checkDeviceId, deviceDisplayName, fetchDeviceDefaults, fetchNearbyDevices, qrCodeUrl, shareFoldersLabel, shortDeviceId } from "./api.js";
import { controlId, nodeFormHeader, resultLine, settingFields } from "./deviceForm.js";
import { button, element, section } from "./dom.js";
import { registerForm } from "./forms.js";
import { requestRender } from "./renderRequest.js";
import { type AddDeviceFormState, deviceFormLocation } from "./state.js";

const formId = "add-device-form";
registerForm(formId);

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function loadNearby(form: AddDeviceFormState): Promise<void> {
  try {
    form.nearby = await fetchNearbyDevices(form.nodeId);
    form.nearbyError = null;
  } catch (error) {
    form.nearbyError = messageOf(error);
  }
}

/**
 * Reads the node's defaults once per opening, so what the form sends is always measured against the same answer.
 * @implNote Another host's node, or one the nodes list does not show yet, is read nothing: its devices are added on its own dashboard.
 */
export async function loadAddDeviceForm(form: AddDeviceFormState, node: StorageNode | undefined): Promise<void> {
  if (!node?.local) return;
  const reads: Promise<void>[] = [];
  if (!form.defaults) {
    reads.push(
      fetchDeviceDefaults(form.nodeId).then(
        (defaults) => {
          if (form.defaults) return;
          form.defaults = defaults;
          form.draft = structuredClone(defaults);
          form.loadError = null;
        },
        (error: unknown) => void (form.loadError = messageOf(error)),
      ),
    );
  }
  if (form.nearby === null && form.nearbyError === null) reads.push(loadNearby(form));
  await Promise.all(reads);
}

/** @implNote Answers only for the ID still in the field, so a slow check never labels a later one. */
async function runCheck(form: AddDeviceFormState, typed: string): Promise<void> {
  const wanted = typed.trim();
  if (!wanted) {
    form.idCheck = null;
    return requestRender();
  }
  let check;
  try {
    check = await checkDeviceId(form.nodeId, wanted);
  } catch (error) {
    check = { deviceId: null, problem: messageOf(error) };
  }
  if (form.draft?.deviceId.trim() !== wanted) return;
  form.idCheck = { typed: wanted, check };
  requestRender();
}

function idCheckLine(form: AddDeviceFormState): HTMLElement | null {
  const current = form.idCheck;
  if (!current || current.typed !== form.draft?.deviceId.trim()) return null;
  const { deviceId, problem } = current.check;
  if (problem) return element("small", { className: "tone-text-bad" }, problem);
  return deviceId ? element("small", { className: "tone-text-ok" }, `Syncthing reads it as ${deviceId}`) : null;
}

function deviceIdField(form: AddDeviceFormState): HTMLElement {
  const id = controlId(formId, "deviceId");
  const input = element("input", { attributes: { id, autocomplete: "off", spellcheck: "false", placeholder: "XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX" } });
  input.defaultValue = "";
  input.value = form.draft?.deviceId ?? "";
  input.addEventListener("input", () => form.draft && (form.draft.deviceId = input.value));
  input.addEventListener("change", () => {
    forgetLastAttempt(form);
    void runCheck(form, input.value);
  });
  input.disabled = form.saving;
  return element("label", { className: "setting", attributes: { for: id } }, element("span", {}, "Device ID"), input, idCheckLine(form) ?? element("small", { className: "muted" }, "As the other device shows it; case and dashes do not matter."));
}

/** A new ID starts a new attempt: what the last one answered no longer applies. */
function forgetLastAttempt(form: AddDeviceFormState): void {
  form.result = null;
  form.added = null;
}

function useNearby(form: AddDeviceFormState, device: NearbyDevice): void {
  if (!form.draft) return;
  form.draft.deviceId = device.deviceId;
  form.idCheck = null;
  forgetLastAttempt(form);
  requestRender();
  void runCheck(form, device.deviceId);
}

function nearbyRow(form: AddDeviceFormState, device: NearbyDevice): HTMLElement {
  return element(
    "div",
    { className: "nearby-row", title: device.deviceId },
    element("span", { className: "peer-name" }, element("strong", {}, shortDeviceId(device.deviceId)), element("small", {}, device.addresses.join(", ") || "no address")),
    Object.assign(button("Use", () => useNearby(form, device), "button"), { disabled: form.saving }),
  );
}

async function lookAgain(form: AddDeviceFormState): Promise<void> {
  form.nearby = null;
  form.nearbyError = null;
  requestRender();
  await loadNearby(form);
  requestRender();
}

function nearbySection(form: AddDeviceFormState): HTMLElement {
  const again = button("Look again", () => void lookAgain(form), "button ghost");
  if (form.nearbyError) return section("Nearby", element("p", { className: "tone-text-bad" }, `Could not ask discovery: ${form.nearbyError}`), again);
  if (form.nearby === null) return section("Nearby", element("p", { className: "muted" }, "Asking discovery…"));
  if (form.nearby.length === 0) return section("Nearby", element("p", { className: "muted" }, "Discovery found no device this node does not know."), again);
  return section(`Nearby (${form.nearby.length})`, element("div", { className: "nearby-list" }, ...form.nearby.map((device) => nearbyRow(form, device))), again);
}

function folderChoice(form: AddDeviceFormState, folderId: string, label: string, path: string): HTMLElement {
  const id = controlId(formId, `share-${folderId}`);
  const box = element("input", { attributes: { id, type: "checkbox" } });
  box.defaultChecked = false;
  box.checked = form.shareFolders.has(folderId);
  box.addEventListener("change", () => (box.checked ? form.shareFolders.add(folderId) : form.shareFolders.delete(folderId)));
  box.disabled = form.saving;
  return element("label", { className: "toggle", attributes: { for: id } }, box, element("span", { className: "folder-name" }, label || folderId, element("small", {}, path)));
}

function shareFoldersField(node: StorageNode, form: AddDeviceFormState): HTMLElement {
  const choices = node.folders.length ? node.folders.map((folder) => folderChoice(form, folder.id, folder.label, folder.path)) : [element("small", { className: "muted" }, `${node.name} has no folders yet.`)];
  return element("fieldset", { className: "share-folders" }, element("legend", {}, shareFoldersLabel), ...choices);
}

function addedText(added: AddedDevice): string {
  const name = deviceDisplayName(added.device.name, added.device.deviceId);
  const shared = added.shared.length ? ` Shared ${added.shared.join(", ")}.` : "";
  const notShared = added.notShared.map((entry) => ` Not shared ${entry.folderId}: ${entry.problem}.`).join("");
  return `Added ${name}.${shared}${notShared}`;
}

/** @implNote Sends only the settings that differ from the node's defaults, which the node fills in for the rest. */
async function submit(form: AddDeviceFormState): Promise<void> {
  const { defaults, draft } = form;
  if (!defaults || !draft) return;
  const typed = draft.deviceId.trim();
  if (!typed) {
    form.result = { text: "Not added: the device ID is missing.", tone: "bad" };
    return requestRender();
  }
  form.saving = true;
  form.result = null;
  requestRender();
  const change = changedFields(defaults, { ...draft, deviceId: defaults.deviceId });
  const result = await addDevice(form.nodeId, { ...change, deviceId: typed, shareFolders: [...form.shareFolders] });
  form.saving = false;
  if (result.ok) {
    form.added = result.value;
    form.result = { text: addedText(result.value), tone: result.value.notShared.length ? "bad" : "ok" };
    form.draft = structuredClone(defaults);
    form.shareFolders = new Set();
    form.idCheck = null;
    void lookAgain(form);
  } else {
    form.result = { text: `Not added: ${result.message}`, tone: "bad" };
  }
  requestRender();
}

function addedLink(node: StorageNode, form: AddDeviceFormState): HTMLElement | null {
  const added = form.added;
  if (!added || !form.result) return null;
  return element("a", { className: "button ghost", attributes: { href: deviceFormLocation(node.id, added.device.deviceId) } }, `Open ${deviceDisplayName(added.device.name, added.device.deviceId)}`);
}

function formBody(node: StorageNode, form: AddDeviceFormState): HTMLElement {
  if (!node.local) return element("p", { className: "read-only-note" }, `Read-only. Devices are added to ${node.name} on ${node.host}'s own dashboard.`);
  if (!form.defaults || !form.draft) {
    return element("p", { className: form.loadError ? "tone-text-bad" : "muted" }, form.loadError ? `Could not read the node's defaults: ${form.loadError}` : "Reading the node's defaults…");
  }
  return element(
    "div",
    { className: "device-form", attributes: { id: formId } },
    element("div", { className: "form-fields device-fields" }, deviceIdField(form)),
    settingFields({ formId, saving: form.saving, saved: form.defaults, draft: form.draft }),
    shareFoldersField(node, form),
    resultLine(form.result),
    element(
      "div",
      { className: "button-row" },
      Object.assign(button(form.saving ? "Adding…" : "Add", () => void submit(form), "button primary"), { disabled: form.saving }),
      addedLink(node, form),
    ),
  );
}

function toggleQr(form: AddDeviceFormState): void {
  form.showQr = !form.showQr;
  requestRender();
}

function ownIdSection(node: StorageNode, form: AddDeviceFormState): HTMLElement | null {
  const ownId = node.syncthing?.deviceId;
  if (!ownId || !node.local) return null;
  return section(
    `${node.name}'s device ID`,
    element("code", { className: "device-id-full" }, ownId),
    element("p", { className: "muted" }, "The other device adds this one by this ID."),
    button(form.showQr ? "Hide QR code" : "Show QR code", () => toggleQr(form), "button"),
    form.showQr ? element("img", { className: "qr-code", attributes: { src: qrCodeUrl(node.id, ownId), alt: `QR code of ${ownId}`, width: "200", height: "200" } }) : null,
  );
}

export function renderAddDeviceForm(node: StorageNode, form: AddDeviceFormState): HTMLElement {
  return element(
    "div",
    { className: "detail-inner" },
    nodeFormHeader(node, "Add a device", `A new device for ${node.name}'s Syncthing`),
    ownIdSection(node, form),
    node.local ? nearbySection(form) : null,
    section("New device", formBody(node, form)),
  );
}
