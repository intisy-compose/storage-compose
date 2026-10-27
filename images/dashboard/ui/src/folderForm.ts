import { type FolderSettings, type FolderType, type StorageNode, addFolder, browseFolderPaths, checkFolderPath, fetchFolderDefaults, folderTypeTexts, ignoreLinesOf, ignoreLinesProblem } from "./api.js";
import { controlId, resultLine } from "./deviceForm.js";
import { button, element, section } from "./dom.js";
import { draftOf, newFolderBody, treePathOf } from "./folderDraft.js";
import { registerForm } from "./forms.js";
import { icon } from "./icons.js";
import { requestRender } from "./renderRequest.js";
import { type AddFolderFormState, type FolderDraft, type Notice, appState, explorerLocation } from "./state.js";

const formId = "add-folder-form";
registerForm(formId);
const suggestionListId = controlId(formId, "path-suggestions");

const offeredTypes: FolderType[] = ["sendreceive", "sendonly", "receiveonly"];

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** This host's nodes whose Syncthing answers, the only ones a folder can be added to here. */
export function addableNodes(): StorageNode[] {
  return (appState.data?.nodes ?? []).filter((node) => node.local && node.online && node.syncthing !== null && node.kind !== "device");
}

function isAddable(nodeId: string): boolean {
  return addableNodes().some((node) => node.id === nodeId);
}

const defaultsInFlight = new Set<AddFolderFormState>();

/**
 * Reads the chosen node's defaults once per choice, placed at the directory the form was opened at.
 * @implNote Answers only for the node still chosen, so switching nodes mid-read never fills in the other node's path.
 */
export async function loadAddFolderForm(form: AddFolderFormState): Promise<void> {
  const nodeId = form.nodeId;
  if (!nodeId || form.defaults || defaultsInFlight.has(form)) return;
  if (!isAddable(nodeId)) {
    if (appState.data) form.nodeId = null;
    return;
  }
  defaultsInFlight.add(form);
  try {
    const defaults = await fetchFolderDefaults(nodeId, form.under);
    if (form.nodeId !== nodeId) return;
    form.defaults = defaults;
    form.draft = draftOf(defaults.settings, defaults.ignores);
    form.loadError = null;
    void runPathCheck(form, defaults.settings.path);
  } catch (error) {
    if (form.nodeId === nodeId) form.loadError = messageOf(error);
  } finally {
    defaultsInFlight.delete(form);
  }
}

/** @implNote Answers only for the path still in the field, so a slow check never labels a later one. */
async function runPathCheck(form: AddFolderFormState, typed: string): Promise<void> {
  const nodeId = form.nodeId;
  if (!nodeId || !typed.trim()) {
    form.pathCheck = null;
    return requestRender();
  }
  let check;
  try {
    check = await checkFolderPath(nodeId, typed);
  } catch (error) {
    check = { path: typed, problem: messageOf(error), warning: null };
  }
  if (form.nodeId !== nodeId || form.draft?.path !== typed) return;
  form.pathCheck = { typed, check };
  requestRender();
}

/**
 * Offers the directories the node completes the typed path to.
 * @implNote Fills the suggestion list in place rather than rendering, so typing is never interrupted.
 */
async function suggestPaths(form: AddFolderFormState, typed: string): Promise<void> {
  const nodeId = form.nodeId;
  if (!nodeId) return;
  let suggestions: string[];
  try {
    suggestions = await browseFolderPaths(nodeId, typed);
  } catch {
    return;
  }
  if (form.nodeId !== nodeId || form.draft?.path !== typed) return;
  form.suggestions = suggestions;
  document.getElementById(suggestionListId)?.replaceChildren(...suggestionOptions(suggestions));
}

function suggestionOptions(suggestions: string[]): HTMLOptionElement[] {
  return suggestions.map((path) => element("option", { attributes: { value: path } }));
}

function chooseNode(form: AddFolderFormState, nodeId: string): void {
  Object.assign(form, { nodeId: nodeId || null, defaults: null, draft: null, pathCheck: null, suggestions: [], loadError: null, result: null, added: null });
  requestRender();
  void loadAddFolderForm(form).then(requestRender);
}

function nodeField(form: AddFolderFormState, nodes: StorageNode[]): HTMLElement {
  const id = controlId(formId, "node");
  const choose = element("option", { attributes: { value: "" } }, "Choose a node");
  choose.defaultSelected = form.nodeId === null;
  const select = element("select", { attributes: { id } }, choose);
  for (const node of nodes) {
    const option = element("option", { attributes: { value: node.id } }, `${node.name} (${node.host})`);
    option.defaultSelected = node.id === form.nodeId;
    select.append(option);
  }
  select.value = form.nodeId && isAddable(form.nodeId) ? form.nodeId : "";
  select.addEventListener("change", () => chooseNode(form, select.value));
  select.disabled = form.saving || form.added !== null;
  return element("label", { className: "setting", attributes: { for: id } }, element("span", {}, "Node"), select, element("small", { className: "muted" }, "The folder is added to this node's Syncthing, inside its root."));
}

type TextField = "id" | "label" | "path";

function textField(form: AddFolderFormState, field: TextField, label: string, hint: HTMLElement | string, extra: Record<string, string> = {}): HTMLElement {
  const { defaults, draft } = form as { defaults: NonNullable<AddFolderFormState["defaults"]>; draft: FolderDraft };
  const id = controlId(formId, field);
  const input = element("input", { attributes: { id, autocomplete: "off", spellcheck: "false", ...extra } });
  input.defaultValue = draftOf(defaults.settings)[field];
  input.value = draft[field];
  input.disabled = form.saving || form.added !== null;
  input.addEventListener("input", () => (draft[field] = input.value));
  return element("label", { className: "setting", attributes: { for: id } }, element("span", {}, label), input, typeof hint === "string" ? element("small", { className: "muted" }, hint) : hint);
}

function pathHint(form: AddFolderFormState): HTMLElement {
  const current = form.pathCheck;
  const root = form.defaults?.root ?? "";
  if (!current || current.typed !== form.draft?.path) return element("small", { className: "muted" }, `Inside ${root}. Syncthing creates the directory if it is missing.`);
  const { problem, warning, path } = current.check;
  if (problem) return element("small", { className: "tone-text-bad" }, problem);
  if (warning) return element("small", { className: "tone-text-warn" }, `Allowed, but this path ${warning}.`);
  return element("small", { className: "tone-text-ok" }, `Added as ${path}`);
}

function pathField(form: AddFolderFormState): HTMLElement {
  const field = textField(form, "path", "Path", pathHint(form), { list: suggestionListId });
  const input = field.querySelector("input") as HTMLInputElement;
  input.addEventListener("input", () => void suggestPaths(form, input.value));
  input.addEventListener("focus", () => void suggestPaths(form, input.value));
  input.addEventListener("change", () => {
    forgetLastAttempt(form);
    void runPathCheck(form, input.value);
  });
  field.append(element("datalist", { attributes: { id: suggestionListId } }, ...suggestionOptions(form.suggestions)));
  return field;
}

function typeField(form: AddFolderFormState): HTMLElement {
  const { defaults, draft } = form as { defaults: NonNullable<AddFolderFormState["defaults"]>; draft: FolderDraft };
  const id = controlId(formId, "type");
  const select = element("select", { attributes: { id } });
  for (const type of offeredTypes) {
    const option = element("option", { attributes: { value: type } }, folderTypeTexts[type]);
    option.defaultSelected = type === defaults.settings.type;
    select.append(option);
  }
  select.value = draft.type;
  select.disabled = form.saving || form.added !== null;
  select.addEventListener("change", () => (draft.type = select.value as FolderType));
  return element("label", { className: "setting", attributes: { for: id } }, element("span", {}, "Type"), select);
}

function pausedField(form: AddFolderFormState): HTMLElement {
  const { defaults, draft } = form as { defaults: NonNullable<AddFolderFormState["defaults"]>; draft: FolderDraft };
  const id = controlId(formId, "paused");
  const box = element("input", { attributes: { id, type: "checkbox" } });
  box.defaultChecked = defaults.settings.paused;
  box.checked = draft.paused;
  box.disabled = form.saving || form.added !== null;
  box.addEventListener("change", () => (draft.paused = box.checked));
  return element("label", { className: "toggle", attributes: { for: id } }, box, element("span", {}, "Start paused", element("small", { className: "muted" }, " Syncthing neither scans nor syncs it until resumed")));
}

function ignoresField(form: AddFolderFormState): HTMLElement {
  const { defaults, draft } = form as { defaults: NonNullable<AddFolderFormState["defaults"]>; draft: FolderDraft };
  const id = controlId(formId, "ignores");
  const area = element("textarea", { attributes: { id, rows: "4", spellcheck: "false" } });
  area.defaultValue = defaults.ignores.join("\n");
  area.value = draft.ignores;
  area.disabled = form.saving || form.added !== null;
  area.addEventListener("input", () => (draft.ignores = area.value));
  area.addEventListener("change", () => {
    forgetLastAttempt(form);
    requestRender();
  });
  const problem = ignoreLinesProblem(ignoreLinesOf(draft.ignores));
  const hint = problem
    ? element("small", { className: "tone-text-bad" }, `${problem}.`)
    : element("small", { className: "muted" }, defaults.ignores.length ? "The node's default patterns; the folder is added paused and resumed once they are written." : "One pattern per line, as in .stignore; empty ignores nothing.");
  return element("label", { className: "setting", attributes: { for: id } }, element("span", {}, "Ignore patterns"), area, hint);
}

function addedText(added: FolderSettings, draft: FolderDraft): Notice {
  const named = `${added.label || added.id} at ${added.path}`;
  if (added.paused && !draft.paused) return { text: `Added folder ${named}, but it stays paused: its ignore patterns could not be set. Activity says why; set them in its settings, then resume it.`, tone: "warn" };
  return { text: `Added folder ${named}.`, tone: "ok" };
}

function forgetLastAttempt(form: AddFolderFormState): void {
  if (form.added) return;
  form.result = null;
}

async function submit(form: AddFolderFormState): Promise<void> {
  const { nodeId, draft, defaults } = form;
  if (!nodeId || !defaults || !draft) return;
  form.saving = true;
  form.result = null;
  requestRender();
  const result = await addFolder(nodeId, newFolderBody(defaults.settings, draft, defaults.ignores));
  form.saving = false;
  if (result.ok) {
    form.added = result.value;
    form.result = addedText(result.value, draft);
  } else {
    form.result = { text: `Not added: ${result.message}`, tone: "bad" };
  }
  requestRender();
}

/** The directory that lists `path` as a row, so the opened folder's row is in view. */
function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

function actions(form: AddFolderFormState): HTMLElement {
  const added = form.added;
  if (added) {
    return element("div", { className: "button-row" }, element("a", { className: "button primary", attributes: { href: explorerLocation(added.id, form.nodeId ?? appState.explorer.node, parentOf(treePathOf(added.path, form.defaults?.root ?? "") ?? form.under)) } }, `Open ${added.label || added.id}`));
  }
  return element("div", { className: "button-row" }, Object.assign(button(form.saving ? "Adding…" : "Add", () => void submit(form), "button primary"), { disabled: form.saving }));
}

function settingsFields(form: AddFolderFormState): (HTMLElement | null)[] {
  if (!form.nodeId || !isAddable(form.nodeId)) return [element("p", { className: "muted" }, "Choose the node first; the path is offered inside its root.")];
  if (!form.defaults || !form.draft) {
    return [element("p", { className: form.loadError ? "tone-text-bad" : "muted" }, form.loadError ? `Could not read the node's defaults: ${form.loadError}` : "Reading the node's defaults…")];
  }
  return [
    element(
      "div",
      { className: "form-fields device-fields" },
      textField(form, "label", "Label", "The name the pages show; empty shows the ID."),
      textField(form, "id", "Folder ID", "The same on every device that shares the folder; it cannot be changed later."),
      pathField(form),
      typeField(form),
      ignoresField(form),
    ),
    element("div", { className: "toggles" }, pausedField(form)),
    resultLine(form.result),
    actions(form),
  ];
}

function formHeader(form: AddFolderFormState): HTMLElement {
  return element(
    "header",
    { className: "detail-header" },
    element("a", { className: "icon-button close-detail", title: "Close", attributes: { href: explorerLocation(null), "aria-label": "Close detail" } }, icon("close")),
    element("h2", {}, "Add a folder"),
    element("p", { className: "detail-status muted" }, form.under ? element("code", {}, form.under) : "At the top directory"),
    form.defaults?.placementProblem ? element("p", { className: "notice tone-text-warn", attributes: { role: "status" } }, `${form.defaults.placementProblem}. The root is offered instead.`) : null,
  );
}

export function renderAddFolderForm(form: AddFolderFormState): HTMLElement {
  const nodes = addableNodes();
  const body = nodes.length
    ? element("div", { className: "device-form", attributes: { id: formId } }, element("div", { className: "form-fields device-fields" }, nodeField(form, nodes)), ...settingsFields(form))
    : element("p", { className: "read-only-note" }, "No node on this host answers, so no folder can be added here. A remote node's folders are added on its own dashboard.");
  return element("div", { className: "detail-inner" }, formHeader(form), section("New folder", body));
}
