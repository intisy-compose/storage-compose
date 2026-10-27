import { element } from "./dom.js";
import { controlId } from "./forms.js";

/**
 * A settings form's controls work on: its element ID, the values it opened with, what it holds now.
 * @implNote Each control sets its default from `saved`, so the poll can tell typed input from what the form opened with.
 */
export interface FieldForm<Values> {
  formId: string;
  saved: Values;
  draft: Values;
  saving: boolean;
}

type KeysOf<Values, Value> = { [Key in keyof Values]: Values[Key] extends Value ? Key : never }[keyof Values] & string;

export function setting(formId: string, field: string, label: string, control: HTMLElement, hint = ""): HTMLElement {
  return element("label", { className: "setting", attributes: { for: controlId(formId, field) } }, element("span", {}, label), control, hint ? element("small", { className: "muted" }, hint) : null);
}

export function textControl<Values>(form: FieldForm<Values>, key: KeysOf<Values, string>): HTMLInputElement {
  const input = element("input", { attributes: { id: controlId(form.formId, key), autocomplete: "off" } });
  input.defaultValue = form.saved[key] as string;
  input.value = form.draft[key] as string;
  input.addEventListener("input", () => ((form.draft[key] as string) = input.value));
  input.disabled = form.saving;
  return input;
}

/** @implNote A field left empty is held as NaN, so the server names it instead of the form sending a guess; `step` "any" takes fractions. */
export function numberControl<Values>(form: FieldForm<Values>, key: KeysOf<Values, number>, minimum = 0, step = "1"): HTMLInputElement {
  const input = element("input", { attributes: { id: controlId(form.formId, key), type: "number", min: String(minimum), step } });
  input.defaultValue = String(form.saved[key]);
  input.value = String(form.draft[key]);
  input.addEventListener("input", () => ((form.draft[key] as number) = input.value === "" ? Number.NaN : Number(input.value)));
  input.disabled = form.saving;
  return input;
}

/** One entry per line or comma, as a person pastes them. */
function listOf(text: string): string[] {
  return text.split(/[\n,]/).map((entry) => entry.trim()).filter(Boolean);
}

export function listControl<Values>(form: FieldForm<Values>, key: KeysOf<Values, string[]>): HTMLTextAreaElement {
  const area = element("textarea", { attributes: { id: controlId(form.formId, key), rows: "2", spellcheck: "false" } });
  area.defaultValue = (form.saved[key] as string[]).join("\n");
  area.value = (form.draft[key] as string[]).join("\n");
  area.addEventListener("input", () => ((form.draft[key] as string[]) = listOf(area.value)));
  area.disabled = form.saving;
  return area;
}

export function selectControl<Values, Choice extends string>(form: FieldForm<Values>, key: KeysOf<Values, Choice>, choices: readonly (readonly [Choice, string])[]): HTMLSelectElement {
  const select = element("select", { attributes: { id: controlId(form.formId, key) } });
  for (const [value, label] of choices) {
    const option = element("option", {}, label);
    option.value = value;
    option.defaultSelected = value === form.saved[key];
    select.append(option);
  }
  select.value = form.draft[key] as Choice;
  select.addEventListener("change", () => ((form.draft[key] as Choice) = select.value as Choice));
  select.disabled = form.saving;
  return select;
}

export function toggleControl<Values>(form: FieldForm<Values>, key: KeysOf<Values, boolean>, label: string, hint: string, locked = false): HTMLElement {
  const id = controlId(form.formId, key);
  const box = element("input", { attributes: { id, type: "checkbox" } });
  box.defaultChecked = form.saved[key] as boolean;
  box.checked = form.draft[key] as boolean;
  box.addEventListener("change", () => ((form.draft[key] as boolean) = box.checked));
  box.disabled = form.saving || locked;
  return element("label", { className: "toggle", attributes: { for: id } }, box, element("span", {}, label, hint ? element("small", { className: "muted" }, ` ${hint}`) : null));
}
