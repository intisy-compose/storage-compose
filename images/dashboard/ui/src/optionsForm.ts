import {
  type ConnectionOptionKey,
  type ConnectionOptions,
  type InstanceOptions,
  type NodeOptionsEdit,
  type OptionsEditResponse,
  type SettingsKeeper,
  type StorageNode,
  applyToHostLabel,
  changedFields,
  connectionOptionLabels,
  connectionOptionsOf,
  isKeeperManaged,
  keeperManagedText,
  listenAddressProblem,
  perNodeListenText,
  saveNodeOptions,
} from "./api.js";
import { editFailureNotice, resultLine } from "./deviceForm.js";
import { button, element } from "./dom.js";
import { controlId, registerForm } from "./forms.js";
import { requestRender } from "./renderRequest.js";
import type { Notice } from "./state.js";

type ToggleKey = "globalAnnounceEnabled" | "localAnnounceEnabled" | "relaysEnabled" | "natEnabled" | "limitBandwidthInLan";
type ListKey = "listenAddresses" | "globalAnnounceServers";
type RateKey = "maxSendKbps" | "maxRecvKbps";

interface OptionsFormState {
  /** The options the form opened with, or last saved: a change is measured against them, never against a later read. */
  saved: ConnectionOptions;
  draft: ConnectionOptions;
  /** The person's choice, on by default; listen addresses are each node's own and never go to every node. */
  applyToHost: boolean;
  saving: boolean;
  result: Notice | null;
  /** What became of each other node of the host in the last save applied to all of them. */
  otherNodes: NodeOptionsEdit[];
}

const applyToHostDefault = true;
const forms = new Map<string, OptionsFormState>();

function formIdOf(nodeId: string): string {
  return `options-form-${nodeId}`;
}

function hasUnsavedChange(form: OptionsFormState): boolean {
  return Object.keys(changedFields(form.saved, form.draft)).length > 0;
}

/**
 * The node's form, following each read of its options while it holds nothing unsaved.
 * @implNote A form with typed input keeps the options it opened with, so only what the person changed is sent.
 */
function formFor(nodeId: string, options: InstanceOptions): OptionsFormState {
  const read = connectionOptionsOf(options);
  const form = forms.get(nodeId);
  if (!form) {
    registerForm(formIdOf(nodeId));
    const created: OptionsFormState = { saved: read, draft: structuredClone(read), applyToHost: applyToHostDefault, saving: false, result: null, otherNodes: [] };
    forms.set(nodeId, created);
    return created;
  }
  if (!form.saving && !hasUnsavedChange(form)) {
    form.saved = read;
    form.draft = structuredClone(read);
  }
  return form;
}

/** One entry per line or comma, as a person pastes them. */
function listOf(text: string): string[] {
  return text.split(/[\n,]/).map((entry) => entry.trim()).filter(Boolean);
}

interface FieldContext {
  formId: string;
  form: OptionsFormState;
  keeper: SettingsKeeper | null;
}

function isLocked(context: FieldContext, key: ConnectionOptionKey): boolean {
  return context.form.saving || isKeeperManaged(context.keeper, key);
}

function hintOf(context: FieldContext, key: ConnectionOptionKey, hint: string): string {
  return context.keeper && isKeeperManaged(context.keeper, key) ? `Read only: ${keeperManagedText(context.keeper)}.` : hint;
}

function labelled(context: FieldContext, key: ConnectionOptionKey, control: HTMLElement, hint: string): HTMLElement {
  return element("label", { className: "setting", attributes: { for: controlId(context.formId, key) } }, element("span", {}, connectionOptionLabels[key]), control, element("small", { className: "muted" }, hintOf(context, key, hint)));
}

function listInput(context: FieldContext, key: ListKey): HTMLTextAreaElement {
  const { form } = context;
  const area = element("textarea", { attributes: { id: controlId(context.formId, key), rows: "2", spellcheck: "false" } });
  area.defaultValue = form.saved[key].join("\n");
  area.value = form.draft[key].join("\n");
  area.addEventListener("input", () => (form.draft[key] = listOf(area.value)));
  area.disabled = isLocked(context, key);
  return area;
}

function rateInput(context: FieldContext, key: RateKey): HTMLInputElement {
  const { form } = context;
  const input = element("input", { attributes: { id: controlId(context.formId, key), type: "number", min: "0", step: "1" } });
  input.defaultValue = String(form.saved[key]);
  input.value = String(form.draft[key]);
  input.addEventListener("input", () => (form.draft[key] = input.value === "" ? Number.NaN : Number(input.value)));
  input.disabled = isLocked(context, key);
  return input;
}

function toggle(context: FieldContext, key: ToggleKey, hint: string): HTMLElement {
  const { form } = context;
  const id = controlId(context.formId, key);
  const box = element("input", { attributes: { id, type: "checkbox" } });
  box.defaultChecked = form.saved[key];
  box.checked = form.draft[key];
  box.addEventListener("change", () => (form.draft[key] = box.checked));
  box.disabled = isLocked(context, key);
  return element("label", { className: "toggle", attributes: { for: id } }, box, element("span", {}, connectionOptionLabels[key], element("small", { className: "muted" }, ` ${hintOf(context, key, hint)}`)));
}

/** @implNote The choice is the form's state, not unsaved input: its default follows it, so ticking it alone never holds the page still. */
function applyToHostToggle(context: FieldContext, nodeCount: number): HTMLElement {
  const { form } = context;
  const id = controlId(context.formId, "apply-to-host");
  const box = element("input", { attributes: { id, type: "checkbox" } });
  box.defaultChecked = form.applyToHost;
  box.checked = form.applyToHost;
  box.addEventListener("change", () => {
    form.applyToHost = box.checked;
    box.defaultChecked = box.checked;
  });
  box.disabled = form.saving || nodeCount < 2;
  const hint = nodeCount < 2 ? "this host runs no other node" : "discovery, relays, NAT and limits; listen addresses stay this node's own, an array is changed only on its own card, and a node is sent nothing its keeper sets at each start";
  return element("label", { className: "toggle", attributes: { for: id } }, box, element("span", {}, applyToHostLabel, element("small", { className: "muted" }, ` ${hint}`)));
}

function optionFields(context: FieldContext): HTMLElement {
  return element(
    "div",
    { className: "form-fields device-fields" },
    labelled(context, "listenAddresses", listInput(context, "listenAddresses"), "One per line: default, tcp://:port or quic://:port, on a port of this stack's rows in access/PORTS.md (22000, 22001-22099)."),
    element(
      "div",
      { className: "toggles" },
      toggle(context, "globalAnnounceEnabled", "announces this node to the discovery servers"),
      toggle(context, "localAnnounceEnabled", "finds devices on the local network"),
      toggle(context, "relaysEnabled", "connects through relays when nothing else does"),
      toggle(context, "natEnabled", "opens its port on the router by UPnP or NAT-PMP"),
      toggle(context, "limitBandwidthInLan", "applies the limits on the local network too"),
    ),
    labelled(context, "globalAnnounceServers", listInput(context, "globalAnnounceServers"), "One per line: default, or an https:// address."),
    element(
      "div",
      { className: "number-fields" },
      labelled(context, "maxSendKbps", rateInput(context, "maxSendKbps"), "KiB/s, 0 is unlimited."),
      labelled(context, "maxRecvKbps", rateInput(context, "maxRecvKbps"), "KiB/s, 0 is unlimited."),
    ),
  );
}

/** Why the change cannot be sent, said before anything is sent; the server checks the same. */
function changeProblem(form: OptionsFormState, change: Partial<ConnectionOptions>): string | null {
  if (form.applyToHost && change.listenAddresses !== undefined) return perNodeListenText;
  return change.listenAddresses?.map(listenAddressProblem).find((problem) => problem !== null) ?? null;
}

const outcomeWords: Record<NodeOptionsEdit["outcome"], string> = {
  saved: "saved",
  unchanged: "already so, nothing sent",
  "maybe saved": "may have been saved",
  failed: "not saved",
  "not connected": "not connected, not changed",
  skipped: "left out",
};

function outcomeTone(edit: NodeOptionsEdit): Notice["tone"] {
  if (edit.outcome === "failed") return "bad";
  return edit.outcome === "saved" || edit.outcome === "unchanged" || edit.outcome === "skipped" ? "ok" : "warn";
}

function outcomeLine(edit: NodeOptionsEdit): HTMLElement {
  const words = edit.problem ? `${outcomeWords[edit.outcome]}: ${edit.problem}` : outcomeWords[edit.outcome];
  return element("li", { className: `tone-text-${outcomeTone(edit)}` }, `${edit.name}: ${words}`);
}

function ownText(own: NodeOptionsEdit): string {
  if (own.outcome === "failed") return `Not saved: ${own.problem}`;
  if (own.outcome === "maybe saved") return `${own.problem}.`;
  return own.outcome === "unchanged" ? "Nothing changed on this node." : "Saved.";
}

/** The worst tone among the nodes, so a node left unchanged elsewhere is not hidden behind this node's "Saved". */
function savedNotice(own: NodeOptionsEdit, others: NodeOptionsEdit[]): Notice {
  const tones = [own, ...others].map(outcomeTone);
  const tone = tones.includes("bad") ? "bad" : tones.includes("warn") ? "warn" : "ok";
  return { text: others.length ? `${ownText(own)} The other nodes of this host:` : ownText(own), tone };
}

function settle(form: OptionsFormState, answer: OptionsEditResponse): void {
  const [own, ...others] = answer.nodes;
  form.otherNodes = others;
  form.result = savedNotice(own, others);
  if (own.outcome === "saved" || own.outcome === "unchanged") {
    form.saved = own.options ? connectionOptionsOf(own.options) : form.draft;
    form.draft = structuredClone(form.saved);
  }
}

async function save(nodeId: string, form: OptionsFormState): Promise<void> {
  const change = changedFields(form.saved, form.draft);
  form.otherNodes = [];
  if (Object.keys(change).length === 0) {
    form.result = { text: "Nothing changed.", tone: "ok" };
    return requestRender();
  }
  const problem = changeProblem(form, change);
  if (problem) {
    form.result = { text: `Not saved: ${problem}`, tone: "bad" };
    return requestRender();
  }
  form.saving = true;
  form.result = null;
  requestRender();
  const result = await saveNodeOptions(nodeId, change, form.applyToHost);
  form.saving = false;
  if (result.ok) settle(form, result.value);
  else form.result = editFailureNotice(result);
  requestRender();
}

function revert(form: OptionsFormState): void {
  form.draft = structuredClone(form.saved);
  form.result = null;
  form.otherNodes = [];
  requestRender();
}

/**
 * A local node's connection options as a form; `nodeCount` is how many nodes this host runs, for the apply-to-all choice, and the
 * options `keeper` rewrites at each start are read only.
 */
export function connectionOptionsForm(node: StorageNode, options: InstanceOptions, nodeCount: number, keeper: SettingsKeeper | null): HTMLElement {
  const form = formFor(node.id, options);
  const context: FieldContext = { formId: formIdOf(node.id), form, keeper };
  return element(
    "div",
    { className: "device-form options-form", attributes: { id: context.formId } },
    element("h3", { className: "settings-subheading" }, "Connections"),
    optionFields(context),
    element("div", { className: "toggles device-fields" }, applyToHostToggle(context, nodeCount)),
    resultLine(form.result),
    form.otherNodes.length ? element("ul", { className: "options-outcomes" }, ...form.otherNodes.map(outcomeLine)) : null,
    element(
      "div",
      { className: "button-row" },
      Object.assign(button(form.saving ? "Saving…" : "Save", () => void save(node.id, form), "button primary"), { disabled: form.saving }),
      Object.assign(button("Revert", () => revert(form), "button ghost"), { disabled: form.saving }),
    ),
  );
}
