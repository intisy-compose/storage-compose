import { type LayoutView, type PriorityBand, saveBands } from "./api.js";
import { button, element } from "./dom.js";
import { registerForm } from "./forms.js";
import { typedPriority } from "./priorityEditor.js";
import { requestRefresh, requestRender } from "./renderRequest.js";
import { type Notice, appState } from "./state.js";

type BandRow = [name: string, from: string];

export function bandRows(bands: readonly PriorityBand[]): BandRow[] {
  return bands.map((band) => [band.name, String(band.from)]);
}

/** The bands typed into the rows, or the first problem; the server checks the rest (a band from 0, no shared name or start). */
export function typedBands(rows: readonly BandRow[]): { bands: PriorityBand[] } | { problem: string } {
  const bands: PriorityBand[] = [];
  for (const [name, from] of rows) {
    if (!name.trim()) return { problem: "every band needs a name" };
    const start = typedPriority(from);
    if (start === null) return { problem: `${name.trim()}: the start is a whole number from 0 to 100` };
    bands.push({ name: name.trim(), from: start });
  }
  return { bands };
}

interface BandsDraft {
  rows: BandRow[];
  busy: boolean;
  notice: Notice | null;
}

let draft: BandsDraft | null = null;
const formId = "bands-form";
registerForm(formId);

function draftFor(layout: LayoutView): BandsDraft {
  draft ??= { rows: bandRows(layout.bands), busy: false, notice: null };
  return draft;
}

async function save(layout: LayoutView, current: BandsDraft): Promise<void> {
  const typed = typedBands(current.rows);
  if ("problem" in typed) return;
  current.busy = true;
  requestRender();
  const answer = await saveBands({ base: layout.version, bands: typed.bands });
  if (!answer.ok) {
    current.busy = false;
    current.notice = { text: `Not saved: ${answer.message}`, tone: "bad" };
  } else {
    appState.layout = answer.value.layout;
    draft = { rows: bandRows(answer.value.layout.bands), busy: false, notice: { text: answer.value.saved.pushed ? "Bands saved and pushed to the setup repo." : `Bands saved on this host, ${answer.value.saved.message}.`, tone: answer.value.saved.pushed ? "ok" : "warn" } };
  }
  requestRefresh();
  requestRender();
}

function rowControls(current: BandsDraft, index: number): HTMLElement {
  const [name, from] = current.rows[index];
  const nameInput = element("input", { attributes: { id: `${formId}-name-${index}`, autocomplete: "off", spellcheck: "false", "aria-label": `Band ${index + 1} name` } });
  nameInput.defaultValue = name;
  nameInput.value = name;
  nameInput.addEventListener("input", () => (current.rows[index][0] = nameInput.value));
  const fromInput = element("input", { attributes: { id: `${formId}-from-${index}`, type: "number", min: "0", max: "100", step: "1", "aria-label": `Band ${index + 1} start` } });
  fromInput.defaultValue = from;
  fromInput.value = from;
  fromInput.addEventListener("input", () => (current.rows[index][1] = fromInput.value));
  const remove = button("Remove", () => {
    current.rows.splice(index, 1);
    requestRender();
  }, "button ghost");
  for (const control of [nameInput, fromInput, remove]) control.disabled = current.busy;
  return element("div", { className: "band-row" }, nameInput, element("span", { className: "muted" }, "from"), fromInput, remove);
}

/** The layout's priority bands, editable from Settings; null without a layout to keep them in. */
export function bandsForm(): HTMLElement | null {
  const layout = appState.layout;
  if (!layout) return null;
  const current = draftFor(layout);
  const typed = typedBands(current.rows);
  const add = button("Add a band", () => {
    current.rows.push(["", ""]);
    requestRender();
  }, "button ghost");
  const saveButton = button(current.busy ? "Saving…" : "Save bands", () => void save(layout, current));
  add.disabled = current.busy;
  saveButton.disabled = current.busy || "problem" in typed;
  return element(
    "div",
    { className: "bands-form", attributes: { id: formId } },
    element("p", { className: "muted small" }, layout.bandsFromLayout ? "The layout's own bands." : "The design's bands; saving writes them into the layout."),
    ...current.rows.map((_row, index) => rowControls(current, index)),
    "problem" in typed ? element("p", { className: "tone-text-bad small" }, typed.problem) : null,
    element("div", { className: "form-actions" }, add, saveButton),
    current.notice ? element("p", { className: `notice tone-text-${current.notice.tone}` }, current.notice.text) : null,
  );
}
