import { type LayoutSaveAnswer, type PriorityInfo, type PriorityPreview, previewPriority, savePriority } from "./api.js";
import { button, element } from "./dom.js";
import { registerForm } from "./forms.js";
import { requestRefresh, requestRender } from "./renderRequest.js";
import { type Notice, appState } from "./state.js";

/** A priority typed into the form: a whole number from 0 to 100, or null for one that is not. */
export function typedPriority(text: string): number | null {
  if (!/^\s*\d{1,3}\s*$/.test(text)) return null;
  const value = Number(text);
  return value <= 100 ? value : null;
}

/** What the confirmation says before a save that adds or drops a Syncthing folder: the folder, then each node's change. */
export function boundaryLines(preview: PriorityPreview): string[] {
  const heading =
    preview.boundary === "created"
      ? `Saving makes ${preview.path} its own Syncthing folder, ${preview.folderId}, on every node that carries it.`
      : `Clearing removes the layout entry ${preview.path}, so the folder ${preview.folderId} is no longer planned; no round removes it from a node.`;
  const nodes = preview.nodes.length ? preview.nodes.flatMap((node) => node.changes.map((change) => `${node.nodeName}: ${change}`)) : ["No node's plan changes."];
  return [heading, ...nodes];
}

/** The notice after a save: pushed, kept on this host until the remote answers, or nothing to change. */
export function savedNotice(path: string, answer: LayoutSaveAnswer): Notice {
  if (!answer.saved.committed) return { text: `${path}: nothing to change.`, tone: "ok" };
  return answer.saved.pushed ? { text: `${path}: saved and pushed to the setup repo.`, tone: "ok" } : { text: `${path}: saved on this host, ${answer.saved.message}.`, tone: "warn" };
}

interface PriorityDraft {
  value: string;
  busy: boolean;
  /** Set while a save that adds or drops a folder waits for its confirmation. */
  pending: { priority: number | null; preview: PriorityPreview } | null;
  notice: Notice | null;
}

const drafts = new Map<string, PriorityDraft>();

function draftOf(path: string, info: PriorityInfo): PriorityDraft {
  const existing = drafts.get(path);
  if (existing) return existing;
  const fresh: PriorityDraft = { value: String(info.setHere ?? info.effective), busy: false, pending: null, notice: null };
  drafts.set(path, fresh);
  return fresh;
}

function finish(draft: PriorityDraft, notice: Notice): void {
  draft.busy = false;
  draft.pending = null;
  draft.notice = notice;
  requestRefresh();
  requestRender();
}

async function save(path: string, draft: PriorityDraft, priority: number | null, confirm?: string): Promise<void> {
  const base = appState.layout?.version;
  if (!base) return finish(draft, { text: "The layout is not read yet.", tone: "bad" });
  draft.busy = true;
  requestRender();
  const answer = await savePriority(path, priority, base, confirm);
  if (!answer.ok) return finish(draft, { text: `Not saved: ${answer.message}`, tone: "bad" });
  appState.layout = answer.value.layout;
  finish(draft, savedNotice(path, answer.value));
}

/** @implNote The preview is read first, so a save that adds or drops a Syncthing folder waits for a second click that names it (section 5 item 7). */
async function start(path: string, draft: PriorityDraft, priority: number | null): Promise<void> {
  draft.busy = true;
  draft.notice = null;
  requestRender();
  const preview = await previewPriority(path, priority);
  if (!preview.ok) return finish(draft, { text: `Not saved: ${preview.message}`, tone: "bad" });
  if (preview.value.boundary) {
    draft.busy = false;
    draft.pending = { priority, preview: preview.value };
    return requestRender();
  }
  await save(path, draft, priority);
}

function confirmation(path: string, draft: PriorityDraft): HTMLElement | null {
  const pending = draft.pending;
  if (!pending) return null;
  const [heading, ...lines] = boundaryLines(pending.preview);
  const go = button(pending.preview.boundary === "created" ? `Make ${pending.preview.folderId} a folder` : `Remove the entry ${pending.preview.path}`, () => void save(path, draft, pending.priority, pending.preview.folderId), "button danger");
  const keep = button("Keep it as it is", () => {
    draft.pending = null;
    requestRender();
  }, "button ghost");
  go.disabled = keep.disabled = draft.busy;
  return element("div", { className: "confirm-box" }, element("p", {}, element("strong", {}, heading)), element("ul", {}, ...lines.map((line) => element("li", {}, line))), element("div", { className: "form-actions" }, go, keep));
}

function formIdOf(path: string): string {
  return `priority-form-${path.replace(/[^A-Za-z0-9_-]/g, "_") || "top"}`;
}

/** The priority form of a directory, or null while this host has no layout to edit. */
export function priorityEditor(path: string, info: PriorityInfo): HTMLElement | null {
  if (!appState.layout) return null;
  const draft = draftOf(path, info);
  const formId = formIdOf(path);
  registerForm(formId);
  const input = element("input", { attributes: { id: `${formId}-value`, type: "number", min: "0", max: "100", step: "1", "aria-label": `Priority of ${path || "the top directory"}` } });
  input.defaultValue = draft.value;
  input.value = draft.value;
  input.disabled = draft.busy || draft.pending !== null;
  input.addEventListener("input", () => (draft.value = input.value));
  const typed = typedPriority(draft.value);
  const saveButton = button(draft.busy ? "Saving…" : "Save", () => typed !== null && void start(path, draft, typed));
  saveButton.disabled = draft.busy || draft.pending !== null;
  const inherit = info.setHere !== null ? button("Inherit from above", () => void start(path, draft, null), "button ghost") : null;
  if (inherit) inherit.disabled = draft.busy || draft.pending !== null;
  return element(
    "div",
    { className: "priority-form", attributes: { id: formId } },
    element("div", { className: "form-actions" }, input, saveButton, inherit),
    typed === null ? element("p", { className: "tone-text-bad small" }, "A priority is a whole number from 0 to 100.") : null,
    confirmation(path, draft),
    draft.notice ? element("p", { className: `notice tone-text-${draft.notice.tone}` }, draft.notice.text) : null,
  );
}
