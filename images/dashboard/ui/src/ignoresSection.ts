import { type FolderIgnores, type FolderType, fetchFolderIgnores, ignoreLinesOf, ignoreLinesProblem, saveFolderIgnores } from "./api.js";
import { editFailureNotice, resultLine } from "./deviceForm.js";
import { controlId } from "./forms.js";
import { button, element, section } from "./dom.js";
import { areIgnoresUnsaved } from "./folderDraft.js";
import { plural } from "./format.js";
import { requestRender } from "./renderRequest.js";
import type { EditFolderFormState, IgnoresDraft } from "./state.js";

const heading = "Ignore patterns";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function showOpened(ignores: IgnoresDraft, opened: FolderIgnores): void {
  ignores.opened = opened;
  ignores.text = opened.lines.join("\n");
}

/**
 * Reads the folder's patterns, once when the form opens and again when asked.
 * @implNote Never refilled by a poll: a change made on the node meanwhile is caught by the save's comparison instead.
 */
export async function loadIgnores(form: EditFolderFormState): Promise<void> {
  const ignores = form.ignores;
  if (ignores.loading) return;
  ignores.loading = true;
  try {
    showOpened(ignores, await fetchFolderIgnores(form.nodeId, form.folderId));
    ignores.loadError = null;
  } catch (error) {
    ignores.loadError = messageOf(error);
  } finally {
    ignores.loading = false;
    requestRender();
  }
}

/** The textarea holds patterns that differ from the node's file as last read or saved. */
export function hasUnsavedIgnores(form: EditFolderFormState): boolean {
  return areIgnoresUnsaved(form.ignores.text, form.ignores.opened?.lines ?? null);
}

export const unsavedIgnoresText = "The ignore patterns are not saved yet; they are saved with Save patterns.";

function savedNotice(saved: FolderIgnores): IgnoresDraft["result"] {
  return saved.error ? { text: "Saved, but Syncthing cannot use these patterns; see below.", tone: "bad" } : { text: "Saved. Syncthing rescans the folder with them.", tone: "ok" };
}

async function save(form: EditFolderFormState): Promise<void> {
  const ignores = form.ignores;
  if (!ignores.opened) return;
  const lines = ignoreLinesOf(ignores.text);
  const problem = ignoreLinesProblem(lines);
  if (problem || lines.join("\n") === ignores.opened.lines.join("\n")) {
    ignores.result = problem ? { text: `Not saved: ${problem}`, tone: "bad" } : { text: "Nothing changed.", tone: "ok" };
    return requestRender();
  }
  ignores.saving = true;
  ignores.result = null;
  requestRender();
  const result = await saveFolderIgnores(form.nodeId, form.folderId, lines, ignores.opened.lines);
  ignores.saving = false;
  if (result.ok) {
    showOpened(ignores, result.value);
    ignores.result = savedNotice(result.value);
  } else {
    ignores.result = editFailureNotice(result);
  }
  requestRender();
}

function reload(form: EditFolderFormState): void {
  form.ignores.result = null;
  void loadIgnores(form);
}

function textarea(ignores: IgnoresDraft, formId: string): HTMLTextAreaElement {
  const area = element("textarea", { attributes: { id: controlId(formId, "ignores"), rows: "6", spellcheck: "false", placeholder: "*.tmp\n// a comment\n/build" } });
  area.defaultValue = ignores.opened?.lines.join("\n") ?? "";
  area.value = ignores.text;
  area.disabled = ignores.saving;
  area.addEventListener("input", () => (ignores.text = area.value));
  area.addEventListener("change", () => {
    ignores.result = null;
    requestRender();
  });
  return area;
}

function typedProblem(ignores: IgnoresDraft): HTMLElement | null {
  const problem = ignoreLinesProblem(ignoreLinesOf(ignores.text));
  return problem ? element("small", { className: "tone-text-bad" }, `${problem}.`) : null;
}

function expandedList(opened: FolderIgnores): HTMLElement[] {
  const hidden = opened.hiddenIncluded ? [element("small", { className: "muted" }, `${plural(opened.hiddenIncluded, "more pattern")} from included files ${opened.hiddenIncluded === 1 ? "is" : "are"} not shown.`)] : [];
  if (opened.error) return hidden;
  if (!opened.expanded.length) return [element("p", { className: "muted" }, opened.lines.length ? "The saved file expands to no pattern." : "Nothing is ignored."), ...hidden];
  return [
    element("p", { className: "muted" }, "As Syncthing reads the saved file:"),
    element("ul", { className: "ignore-expanded" }, ...opened.expanded.map((pattern) => element("li", {}, element("code", {}, pattern)))),
    ...hidden,
  ];
}

/** A file written elsewhere with a line the dashboard refuses, such as an outside `#include`, cannot be saved from here as it stands. */
function refusedLineNotice(opened: FolderIgnores): HTMLElement | null {
  const problem = ignoreLinesProblem(opened.lines);
  return problem ? element("p", { className: "notice tone-text-warn", attributes: { role: "status" } }, `The patterns cannot be saved from here until that line is removed: ${problem}.`) : null;
}

function syncthingError(opened: FolderIgnores): HTMLElement | null {
  return opened.error ? element("p", { className: "notice tone-text-bad", attributes: { role: "alert" } }, `Syncthing cannot use these patterns, so the folder does not sync until they are fixed: ${opened.error}`) : null;
}

function editor(form: EditFolderFormState, formId: string, opened: FolderIgnores): (HTMLElement | null)[] {
  const ignores = form.ignores;
  return [
    element(
      "div",
      { className: "form-fields device-fields" },
      element(
        "label",
        { className: "setting", attributes: { for: controlId(formId, "ignores") } },
        element("span", {}, "Patterns, one per line, as in .stignore"),
        textarea(ignores, formId),
        typedProblem(ignores) ?? element("small", { className: "muted" }, "Saved on their own with the button below; an included file must lie inside the folder."),
      ),
    ),
    refusedLineNotice(opened),
    syncthingError(opened),
    ...expandedList(opened),
    resultLine(ignores.result),
    element(
      "div",
      { className: "button-row" },
      Object.assign(button(ignores.saving ? "Saving…" : "Save patterns", () => void save(form), "button"), { disabled: ignores.saving }),
      Object.assign(button("Read again from the node", () => reload(form), "button ghost"), { disabled: ignores.saving || ignores.loading }),
    ),
  ];
}

export function ignoresSection(form: EditFolderFormState, formId: string, type: FolderType): HTMLElement {
  const ignores = form.ignores;
  if (type === "receiveencrypted") return section(heading, element("p", { className: "muted" }, "A receive encrypted folder takes no ignore patterns."));
  if (ignores.opened) return section(heading, ...editor(form, formId, ignores.opened));
  if (ignores.loadError) return section(heading, element("p", { className: "tone-text-bad" }, `Could not read the patterns: ${ignores.loadError}`), element("div", { className: "button-row" }, button("Try again", () => reload(form), "button ghost")));
  return section(heading, element("p", { className: "muted" }, "Reading the patterns…"));
}
