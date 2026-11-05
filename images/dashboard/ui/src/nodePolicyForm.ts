import { type LayoutNodeView, type NodePolicyPreview, type StorageNode, fetchPolicyPreview, saveNodePolicy, setNodeApply } from "./api.js";
import { button, element, section } from "./dom.js";
import { registerForm } from "./forms.js";
import { formatBytes } from "./format.js";
import { typedPriority } from "./priorityEditor.js";
import { requestRefresh, requestRender } from "./renderRequest.js";
import { type Notice, appState } from "./state.js";

/** `path = priority` per line, as the pins field takes them. */
export function pinsText(pins: Record<string, number>): string {
  return Object.entries(pins)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, priority]) => `${path} = ${priority}`)
    .join("\n");
}

/** The pins typed into the field, or the first line that is not `path = priority`. */
export function typedPins(text: string): { pins: Record<string, number> } | { problem: string } {
  const pins: Record<string, number> = {};
  for (const line of text.split("\n").map((entry) => entry.trim()).filter(Boolean)) {
    const match = /^(.+?)\s*=\s*(\S+)$/.exec(line);
    const priority = match ? typedPriority(match[2]) : null;
    if (!match || priority === null) return { problem: `"${line}" is not a path = priority from 0 to 100` };
    pins[match[1]] = priority;
  }
  return { pins };
}

export function typedPaths(text: string): string[] {
  return text.split("\n").map((entry) => entry.trim()).filter(Boolean);
}

/** What the preview of a raise says before it is saved: each folder that would hand off, how much, and to which keeper. */
export function raiseLines(preview: NodePolicyPreview): string[] {
  if (!preview.handoffs.length) return [`At ${preview.threshold} nothing more turns send-only, so nothing more is handed off.`];
  const lines = preview.handoffs.map((entry) =>
    entry.keepers.length
      ? `${entry.label}: up to ${entry.files} ${entry.files === 1 ? "file" : "files"} (${formatBytes(entry.bytes)}) leave this node once ${entry.keepers.join(" or ")} confirms each`
      : `${entry.label}: turns send-only, but no node keeps it, so nothing of it leaves`,
  );
  return [`Raising the threshold to ${preview.threshold} hands off up to ${preview.files} ${preview.files === 1 ? "file" : "files"} (${formatBytes(preview.bytes)}):`, ...lines, "Nothing leaves before a keeper confirms each file, and only while the node acts on its plan."];
}

/** Whether the name typed lets the node act: it must be the node's name exactly. */
export function isApplyConfirmed(node: Pick<LayoutNodeView, "name">, typed: string): boolean {
  return typed === node.name;
}

interface PolicyDraft {
  threshold: string;
  assigned: string;
  pins: string;
  enabled: boolean;
  busy: boolean;
  /** The preview of a raise, waiting for its confirmation. */
  raise: NodePolicyPreview | null;
  applyOpen: boolean;
  applyTyped: string;
  notice: Notice | null;
}

const drafts = new Map<string, PolicyDraft>();

function draftOf(policy: LayoutNodeView): PolicyDraft {
  const existing = drafts.get(policy.id);
  if (existing) return existing;
  const fresh: PolicyDraft = { threshold: String(policy.threshold), assigned: policy.assigned.join("\n"), pins: pinsText(policy.pins), enabled: policy.enabled, busy: false, raise: null, applyOpen: false, applyTyped: "", notice: null };
  drafts.set(policy.id, fresh);
  return fresh;
}

function done(policy: LayoutNodeView, draft: PolicyDraft, notice: Notice): void {
  if (notice.tone === "bad") {
    draft.busy = false;
    draft.notice = notice;
  } else {
    drafts.delete(policy.id);
    pendingNotices.set(policy.id, notice);
  }
  requestRefresh();
  requestRender();
}

/** A saved form starts again from the layout as read next, with the notice of what was saved. */
const pendingNotices = new Map<string, Notice>();

function savedText(message: string, pushed: boolean): Notice {
  return { text: `Saved: ${message}.`, tone: pushed ? "ok" : "warn" };
}

async function savePolicy(policy: LayoutNodeView, draft: PolicyDraft, threshold: number, pins: Record<string, number>): Promise<void> {
  const base = appState.layout?.version;
  if (!base) return done(policy, draft, { text: "The layout is not read yet.", tone: "bad" });
  draft.busy = true;
  draft.raise = null;
  requestRender();
  const answer = await saveNodePolicy(policy.id, { base, threshold, assigned: typedPaths(draft.assigned), pins, enabled: draft.enabled });
  if (!answer.ok) return done(policy, draft, { text: `Not saved: ${answer.message}`, tone: "bad" });
  done(policy, draft, savedText(answer.value.saved.message, answer.value.saved.pushed));
}

/** @implNote A raise is previewed first and saved by a second click, since it may hand off what the node holds once it acts. */
async function submit(policy: LayoutNodeView, draft: PolicyDraft): Promise<void> {
  const threshold = typedPriority(draft.threshold);
  const pins = typedPins(draft.pins);
  if (threshold === null || "problem" in pins) return;
  if (threshold <= policy.threshold) return savePolicy(policy, draft, threshold, pins.pins);
  draft.busy = true;
  draft.notice = null;
  requestRender();
  try {
    draft.raise = await fetchPolicyPreview(policy.id, threshold);
    draft.busy = false;
    requestRender();
  } catch (error) {
    done(policy, draft, { text: `Not saved: ${(error as Error).message}`, tone: "bad" });
  }
}

async function sendApply(policy: LayoutNodeView, draft: PolicyDraft, apply: boolean): Promise<void> {
  const base = appState.layout?.version;
  if (!base) return done(policy, draft, { text: "The layout is not read yet.", tone: "bad" });
  draft.busy = true;
  requestRender();
  const answer = await setNodeApply(policy.id, { base, apply, confirm: apply ? draft.applyTyped : undefined });
  if (!answer.ok) return done(policy, draft, { text: `Not changed: ${answer.message}`, tone: "bad" });
  done(policy, draft, savedText(answer.value.saved.message, answer.value.saved.pushed));
}

function field(id: string, label: string, control: HTMLElement, hint?: string): HTMLElement {
  return element("label", { className: "field", attributes: { for: id } }, element("span", {}, label), control, hint ? element("small", { className: "muted" }, hint) : null);
}

function textArea(id: string, value: string, disabled: boolean, onInput: (value: string) => void): HTMLTextAreaElement {
  const area = element("textarea", { attributes: { id, rows: "3", spellcheck: "false" } });
  area.defaultValue = value;
  area.value = value;
  area.disabled = disabled;
  area.addEventListener("input", () => onInput(area.value));
  return area;
}

function raiseConfirmation(policy: LayoutNodeView, draft: PolicyDraft): HTMLElement | null {
  const raise = draft.raise;
  if (!raise) return null;
  const [heading, ...lines] = raiseLines(raise);
  const pins = typedPins(draft.pins);
  const go = button(`Save threshold ${raise.threshold}`, () => "pins" in pins && void savePolicy(policy, draft, raise.threshold, pins.pins), "button danger");
  const keep = button("Keep the threshold", () => {
    draft.raise = null;
    requestRender();
  }, "button ghost");
  go.disabled = keep.disabled = draft.busy;
  return element("div", { className: "confirm-box" }, element("p", {}, element("strong", {}, heading)), element("ul", {}, ...lines.map((line) => element("li", {}, line))), element("div", { className: "form-actions" }, go, keep));
}

function policyFields(policy: LayoutNodeView, draft: PolicyDraft, formId: string): HTMLElement {
  const disabled = draft.busy || draft.raise !== null;
  const threshold = element("input", { attributes: { id: `${formId}-threshold`, type: "number", min: "0", max: "100", step: "1" } });
  threshold.defaultValue = String(policy.threshold);
  threshold.value = draft.threshold;
  threshold.disabled = disabled;
  threshold.addEventListener("input", () => (draft.threshold = threshold.value));
  const enabled = element("input", { attributes: { id: `${formId}-enabled`, type: "checkbox" } });
  enabled.defaultChecked = policy.enabled;
  enabled.checked = draft.enabled;
  enabled.disabled = disabled;
  enabled.addEventListener("change", () => (draft.enabled = enabled.checked));
  const pins = typedPins(draft.pins);
  const problem = typedPriority(draft.threshold) === null ? "The threshold is a whole number from 0 to 100." : "problem" in pins ? pins.problem : null;
  const save = button(draft.busy ? "Saving…" : "Save", () => void submit(policy, draft));
  save.disabled = disabled || problem !== null;
  return element(
    "div",
    { className: "policy-fields" },
    field(`${formId}-threshold`, "Threshold", threshold, "Keeps every folder at or above it both ways; below, it only sends and hands off."),
    field(`${formId}-assigned`, "Assigned", textArea(`${formId}-assigned`, draft.assigned, disabled, (value) => (draft.assigned = value)), "One path per line; kept here whatever the threshold."),
    field(`${formId}-pins`, "Pins", textArea(`${formId}-pins`, draft.pins, disabled, (value) => (draft.pins = value)), "path = priority per line, for this node only."),
    element("label", { className: "checkbox", attributes: { for: `${formId}-enabled` } }, enabled, " Enabled"),
    problem ? element("p", { className: "tone-text-bad small" }, problem) : null,
    element("div", { className: "form-actions" }, save),
    raiseConfirmation(policy, draft),
  );
}

/** @implNote Turning apply on lets the node move files into its trash once keepers confirm them, so it takes the node's name typed, for this one node. */
function applySection(policy: LayoutNodeView, draft: PolicyDraft, formId: string): HTMLElement {
  if (policy.apply) {
    const stop = button("Stop acting, report only", () => void sendApply(policy, draft, false), "button");
    stop.disabled = draft.busy;
    return element("div", { className: "apply-switch" }, element("p", {}, element("strong", {}, "Acts on its plan: "), "the layout commits apply = true, so its rounds write the plan and hand files off once keepers confirm them."), stop);
  }
  if (!draft.applyOpen) {
    const open = button(`Let ${policy.name} act on its plan…`, () => {
      draft.applyOpen = true;
      requestRender();
    }, "button danger");
    open.disabled = draft.busy || !policy.admitted;
    return element("div", { className: "apply-switch" }, element("p", {}, element("strong", {}, "Reports only: "), "nothing is written to the node until apply = true is committed for it."), open);
  }
  const typed = element("input", { attributes: { id: `${formId}-apply-confirm`, autocomplete: "off", spellcheck: "false", "aria-label": `Type ${policy.name} to confirm` } });
  typed.defaultValue = "";
  typed.value = draft.applyTyped;
  typed.disabled = draft.busy;
  typed.addEventListener("input", () => {
    draft.applyTyped = typed.value;
    requestRender();
  });
  const go = button(`Let ${policy.name} act`, () => void sendApply(policy, draft, true), "button danger");
  go.disabled = draft.busy || !isApplyConfirmed(policy, draft.applyTyped);
  const cancel = button("Keep reporting", () => {
    draft.applyOpen = false;
    draft.applyTyped = "";
    requestRender();
  }, "button ghost");
  return element(
    "div",
    { className: "apply-switch confirm-box" },
    element("p", {}, `Once it acts, ${policy.name}'s Syncthing folders follow the plan and what it holds below its threshold leaves it for its trash as soon as a keeper confirms each file. Type ${policy.name} to let it act.`),
    typed,
    element("div", { className: "form-actions" }, go, cancel),
  );
}

/** The node's layered policy from the layout, editable on this host's nodes; null for a node the layout does not list. */
export function nodePolicySection(node: StorageNode): HTMLElement | null {
  const policy = appState.layout?.nodes.find((entry) => entry.id === node.id);
  if (!policy) return null;
  if (!node.local) return section("Layered policy", element("p", { className: "muted" }, `Threshold ${policy.threshold}; edited on ${node.host}'s dashboard.`));
  const draft = draftOf(policy);
  const waiting = pendingNotices.get(policy.id);
  if (waiting) {
    draft.notice = waiting;
    pendingNotices.delete(policy.id);
  }
  const formId = `node-policy-${policy.id}`;
  registerForm(formId);
  return section(
    "Layered policy",
    element("div", { attributes: { id: formId } }, policyFields(policy, draft, formId), applySection(policy, draft, formId)),
    draft.notice ? element("p", { className: `notice tone-text-${draft.notice.tone}` }, draft.notice.text) : null,
  );
}
