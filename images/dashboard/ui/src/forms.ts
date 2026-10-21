const registeredForms = new Set<string>();

/** Marks the element with this ID as a form the poll must not rebuild while it is in use. */
export function registerForm(id: string): void {
  registeredForms.add(id);
}

function isTyping(form: HTMLElement): boolean {
  const active = document.activeElement;
  return active instanceof HTMLElement && form.contains(active) && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName);
}

function isChanged(control: Element): boolean {
  if (control instanceof HTMLInputElement) {
    return control.type === "checkbox" || control.type === "radio" ? control.checked !== control.defaultChecked : control.value !== control.defaultValue;
  }
  if (control instanceof HTMLTextAreaElement) return control.value !== control.defaultValue;
  if (control instanceof HTMLSelectElement) return control.multiple ? [...control.options].some((option) => option.selected !== option.defaultSelected) : control.selectedIndex !== defaultIndex(control);
  return false;
}

/** A single select without a `selected` option starts on its first one. */
function defaultIndex(select: HTMLSelectElement): number {
  return Math.max(0, [...select.options].findIndex((option) => option.defaultSelected));
}

function hasUnsavedInput(form: HTMLElement): boolean {
  return [...form.querySelectorAll("input, textarea, select")].some(isChanged);
}

/** True while a registered form on the page has focus or holds input that was not saved. */
export function isFormOpen(): boolean {
  for (const id of registeredForms) {
    const form = document.getElementById(id);
    if (form && (isTyping(form) || hasUnsavedInput(form))) return true;
  }
  return false;
}
