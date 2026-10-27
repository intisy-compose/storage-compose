import { type AdvancedConfig, type AdvancedTarget, changedFields, fetchAdvancedConfig, saveAdvancedConfig } from "./api.js";
import { editFailureNotice, resultLine } from "./deviceForm.js";
import { button, element } from "./dom.js";
import { controlId, registerForm } from "./forms.js";
import { requestRender } from "./renderRequest.js";
import type { Notice } from "./state.js";

type SyncthingObject = Record<string, unknown>;

/** One object's editor while its section is open: `saved` is the object as last read or saved, `text` what the textarea holds. */
interface EditorState {
  open: boolean;
  loading: boolean;
  error: string | null;
  saved: SyncthingObject | null;
  text: string;
  restartRequired: boolean;
  saving: boolean;
  result: Notice | null;
}

const states = new Map<string, EditorState>();

function keyOf(nodeId: string, target: AdvancedTarget): string {
  return target.kind === "options" ? `${nodeId}|options` : `${nodeId}|${target.kind}|${target.id}`;
}

function stateOf(key: string): EditorState {
  const known = states.get(key);
  if (known) return known;
  const created: EditorState = { open: false, loading: false, error: null, saved: null, text: "", restartRequired: false, saving: false, result: null };
  states.set(key, created);
  return created;
}

/** @implNote A folder or device ID may hold characters an element ID cannot, so the form is named by a hash of its key. */
function formIdOf(key: string): string {
  let hash = 0;
  for (const character of key) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0;
  return `advanced-form-${(hash >>> 0).toString(36)}`;
}

function pretty(config: SyncthingObject): string {
  return JSON.stringify(config, null, 2);
}

function settle(state: EditorState, answer: AdvancedConfig): void {
  state.saved = answer.config;
  state.text = pretty(answer.config);
  state.restartRequired = answer.restartRequired;
}

async function load(nodeId: string, target: AdvancedTarget, state: EditorState): Promise<void> {
  state.loading = true;
  state.error = null;
  requestRender();
  try {
    settle(state, await fetchAdvancedConfig(nodeId, target));
  } catch (error) {
    state.error = (error as Error).message;
  }
  state.loading = false;
  requestRender();
}

type Parsed = { change: SyncthingObject } | { problem: string };

/** The keys the text changes against the object as read; a key taken out is no change Syncthing takes, so it is refused. */
function parsedChange(state: EditorState): Parsed {
  let edited: unknown;
  try {
    edited = JSON.parse(state.text);
  } catch (error) {
    return { problem: `the text is not JSON: ${(error as Error).message}` };
  }
  if (typeof edited !== "object" || edited === null || Array.isArray(edited)) return { problem: "the text must be one JSON object, as it was read" };
  const saved = state.saved ?? {};
  const removed = Object.keys(saved).find((key) => !Object.hasOwn(edited as object, key));
  if (removed) return { problem: `${removed} was taken out: Syncthing keeps every key, so put it back and change its value instead` };
  return { change: changedFields(saved, edited as SyncthingObject) };
}

function savedText(answer: AdvancedConfig): string {
  return answer.restartRequired ? "Saved. Syncthing needs a restart before the change takes effect." : "Saved.";
}

async function save(nodeId: string, target: AdvancedTarget, state: EditorState, onSaved: () => void): Promise<void> {
  const parsed = parsedChange(state);
  if ("problem" in parsed) {
    state.result = { text: `Not saved: ${parsed.problem}`, tone: "bad" };
    return requestRender();
  }
  if (Object.keys(parsed.change).length === 0) {
    state.result = { text: "Nothing changed.", tone: "ok" };
    return requestRender();
  }
  state.saving = true;
  state.result = null;
  requestRender();
  const result = await saveAdvancedConfig(nodeId, target, parsed.change);
  state.saving = false;
  if (result.ok) {
    settle(state, result.value);
    state.result = { text: savedText(result.value), tone: result.value.restartRequired ? "warn" : "ok" };
    onSaved();
  } else {
    state.result = editFailureNotice(result);
  }
  requestRender();
}

function holdsDraft(state: EditorState): boolean {
  return state.saved !== null && state.text !== pretty(state.saved);
}

function revert(state: EditorState): void {
  if (state.saved) state.text = pretty(state.saved);
  state.result = null;
  requestRender();
}

function textArea(formId: string, state: EditorState): HTMLTextAreaElement {
  const area = element("textarea", { className: "advanced-text", attributes: { id: controlId(formId, "json"), spellcheck: "false", "aria-label": "Settings as JSON" } });
  area.defaultValue = state.saved ? pretty(state.saved) : "";
  area.value = state.text;
  area.rows = Math.min(30, state.text.split("\n").length + 1);
  area.disabled = state.saving;
  area.addEventListener("input", () => {
    state.text = area.value;
    state.result = null;
  });
  return area;
}

function editorBody(nodeId: string, target: AdvancedTarget, state: EditorState, formId: string, onSaved: () => void): HTMLElement[] {
  if (state.error) return [element("p", { className: "tone-text-bad" }, `Could not read it: ${state.error}`)];
  if (!state.saved) return [element("p", { className: "muted" }, "Reading…")];
  return [
    element(
      "div",
      { className: "advanced-form", attributes: { id: formId } },
      element("p", { className: "muted" }, "Syncthing's own keys. Only the keys you change are sent, each checked as its form checks it; the GUI, API keys and passwords are never shown or sent."),
      textArea(formId, state),
      resultLine(state.result),
      element(
        "div",
        { className: "button-row" },
        Object.assign(button(state.saving ? "Saving…" : "Save", () => void save(nodeId, target, state, onSaved), "button primary"), { disabled: state.saving }),
        Object.assign(button("Revert", () => revert(state), "button ghost"), { disabled: state.saving }),
      ),
    ),
  ];
}

/**
 * A closed "Advanced editor" section holding the object as JSON; a save sends only the keys that changed, and `onSaved` lets the form beside it follow.
 * @implNote Read again on each opening unless it holds a draft: a draft is measured against the read it was typed over, so a newer read
 * under it would send back keys the person never touched.
 */
export function advancedEditor(nodeId: string, target: AdvancedTarget, onSaved: () => void = () => {}): HTMLElement {
  const key = keyOf(nodeId, target);
  const state = stateOf(key);
  const formId = formIdOf(key);
  registerForm(formId);
  const details = element("details", { className: "defaults-section advanced-section" }, element("summary", {}, "Advanced editor"), ...(state.open ? editorBody(nodeId, target, state, formId, onSaved) : []));
  details.open = state.open;
  details.addEventListener("toggle", () => {
    if (details.open === state.open) return;
    state.open = details.open;
    requestRender();
    if (state.open && !state.saving && !holdsDraft(state)) void load(nodeId, target, state);
  });
  return details;
}
