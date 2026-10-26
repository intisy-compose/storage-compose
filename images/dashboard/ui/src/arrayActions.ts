import { type ArrayAction, type ArrayActionBody, type NodeArray, type StorageNode, runArrayAction } from "./api.js";
import { button, element } from "./dom.js";
import { formatBytes } from "./format.js";
import { isSmartWarning } from "./nodeStatus.js";
import { requestRender } from "./renderRequest.js";
import { type OpenForm, appState } from "./state.js";

const formIntro: Record<OpenForm["action"], (role: string) => string> = {
  add: () => "Add a drive to the array: the chosen drive is erased, labelled and given a role, then parity is synced.",
  rebuild: (role) =>
    role.startsWith("parity")
      ? `Rebuild ${role} onto a replacement: the chosen drive is erased and its parity is recomputed, then verified.`
      : `Rebuild ${role} onto a replacement: the chosen drive is erased and its files are restored from parity, then verified.`,
  remove: (role) => `Continue without ${role}: it leaves the array for good, the files that were on it are lost, and parity is recomputed without it.`,
  "accept-smart": (role) => `Take ${role}'s current SMART counts as its new baseline, so the warning clears until they grow again.`,
  "sync-anyway": () => "Accept the deleted files and write them into parity. They can no longer be restored afterwards.",
};

const destructiveActions = new Set<OpenForm["action"]>(["add", "rebuild", "remove"]);

async function perform(node: StorageNode, action: ArrayAction, body: ArrayActionBody): Promise<void> {
  const result = await runArrayAction(node.id, action, body);
  appState.notice = { text: result.message, tone: result.ok ? "ok" : "bad" };
  if (result.ok) appState.openForm = null;
  requestRender();
}

function openForm(node: StorageNode, action: OpenForm["action"], role = "", device = ""): void {
  appState.openForm = { nodeId: node.id, action, role, device, confirm: "" };
  appState.notice = null;
  requestRender();
}

function missingMembers(array: NodeArray): string[] {
  return array.members.filter((member) => !member.present).map((member) => member.role);
}

function removableRoles(array: NodeArray): string[] {
  return missingMembers(array).filter((role) => role.startsWith("data") && role !== "data1");
}

function smartWarningRoles(array: NodeArray): string[] {
  return array.members.filter(isSmartWarning).map((member) => member.role);
}

function select(id: string, options: [string, string][], value: string, update: (value: string) => void): HTMLSelectElement {
  const chooser = element("select", { attributes: { id } });
  for (const [optionValue, label] of options) {
    const option = element("option", {}, label);
    option.value = optionValue;
    chooser.append(option);
  }
  chooser.value = value || options[0]?.[0] || "";
  update(chooser.value);
  chooser.addEventListener("change", () => update(chooser.value));
  return chooser;
}

function candidateOptions(array: NodeArray): [string, string][] {
  return array.candidates.map((candidate) => [
    candidate.path,
    [candidate.model, candidate.serial, formatBytes(candidate.size), candidate.path].filter(Boolean).join(" · "),
  ]);
}

function roleChoices(form: OpenForm, array: NodeArray): string[] {
  if (form.action === "rebuild") return missingMembers(array);
  if (form.action === "remove") return removableRoles(array);
  if (form.action === "accept-smart") return smartWarningRoles(array);
  return [];
}

function confirmationInput(form: OpenForm): HTMLInputElement {
  const input = element("input", { attributes: { id: "action-confirm", placeholder: `type ${form.role || "the role"} to confirm`, autocomplete: "off" } });
  input.value = form.confirm;
  input.addEventListener("input", () => (form.confirm = input.value));
  return input;
}

function submitLabel(form: OpenForm): string {
  if (form.action === "add") return "Erase and add";
  if (form.action === "rebuild") return `Erase and rebuild ${form.role}`;
  if (form.action === "remove") return `Remove ${form.role} and lose its files`;
  if (form.action === "accept-smart") return `Accept ${form.role}'s counts`;
  return "Sync anyway";
}

function submit(node: StorageNode, form: OpenForm): void {
  if (form.action === "sync-anyway") void perform(node, "sync", { anyway: true });
  else if (form.action === "add") void perform(node, "add", { device: form.device, confirm: form.confirm });
  else void perform(node, form.action, { role: form.role, device: form.device || undefined, confirm: form.confirm });
}

function formFields(form: OpenForm, array: NodeArray): HTMLElement[] {
  const fields: HTMLElement[] = [];
  const roles = roleChoices(form, array);
  if (roles.length) fields.push(select("action-role", roles.map((role) => [role, role]), form.role, (value) => (form.role = value)));
  const needsDevice = form.action === "add" || form.action === "rebuild";
  if (needsDevice && array.candidates.length === 0) {
    fields.push(element("p", { className: "muted" }, "Plug in an unused drive first; none is attached."));
    return fields;
  }
  if (needsDevice) fields.push(select("action-device", candidateOptions(array), form.device, (value) => (form.device = value)));
  if (destructiveActions.has(form.action)) fields.push(confirmationInput(form));
  return fields;
}

function actionForm(node: StorageNode, array: NodeArray, form: OpenForm): HTMLElement {
  const fields = formFields(form, array);
  const blocked = (form.action === "add" || form.action === "rebuild") && array.candidates.length === 0;
  const intro = formIntro[form.action](form.role || "the drive");
  return element(
    "div",
    { className: `action-form${destructiveActions.has(form.action) ? " destructive" : ""}` },
    element("p", {}, intro),
    element("div", { className: "form-fields" }, ...fields),
    element(
      "div",
      { className: "button-row" },
      blocked ? null : button(submitLabel(form), () => submit(node, form), destructiveActions.has(form.action) ? "button danger" : "button primary"),
      button("Cancel", () => {
        appState.openForm = null;
        requestRender();
      }, "button ghost"),
    ),
  );
}

function actionButton(label: string, onClick: () => void, disabledReason: string | null, className = "button"): HTMLButtonElement {
  const created = button(label, onClick, className);
  if (disabledReason) {
    created.disabled = true;
    created.title = disabledReason;
  }
  return created;
}

export function arrayActionArea(node: StorageNode, array: NodeArray): HTMLElement {
  const unavailable = array.state === "absent" ? "the array is not connected" : null;
  const busy = unavailable ?? (array.parity.job ? `a ${array.parity.job.kind} is running` : null);
  const missing = missingMembers(array);
  const form = appState.openForm?.nodeId === node.id ? appState.openForm : null;
  const buttons = element(
    "div",
    { className: "button-row" },
    actionButton("Sync now", () => void perform(node, "sync", {}), busy, "button primary"),
    actionButton("Scrub", () => void perform(node, "scrub", {}), busy),
    actionButton("Add drive…", () => openForm(node, "add", "add"), busy ?? (array.candidates.length ? null : "no unused drive is attached")),
    actionButton("Rebuild…", () => openForm(node, "rebuild", missing[0] ?? ""), busy ?? (missing.length ? null : "every drive is present")),
    actionButton("Remove…", () => openForm(node, "remove", removableRoles(array)[0] ?? ""), busy ?? (removableRoles(array).length ? null : "only a missing data drive other than data1 can be removed")),
    actionButton("Accept SMART…", () => openForm(node, "accept-smart", smartWarningRoles(array)[0] ?? ""), unavailable ?? (smartWarningRoles(array).length ? null : "no drive has a SMART warning")),
    array.parity.refused ? actionButton("Sync anyway…", () => openForm(node, "sync-anyway"), busy, "button danger") : null,
  );
  return element("div", { className: "array-actions" }, buttons, form ? actionForm(node, array, form) : null);
}
