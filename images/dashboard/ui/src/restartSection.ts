import { type StorageNode, restartNode } from "./api.js";
import { editFailureNotice, resultLine } from "./deviceForm.js";
import { button, element } from "./dom.js";
import { controlId, registerForm } from "./forms.js";
import { requestRender } from "./renderRequest.js";
import { type Notice, appState } from "./state.js";

interface RestartForm {
  confirm: string;
  restarting: boolean;
  result: Notice | null;
}

const forms = new Map<string, RestartForm>();

function formOf(nodeId: string): RestartForm {
  const known = forms.get(nodeId);
  if (known) return known;
  const created: RestartForm = { confirm: "", restarting: false, result: null };
  forms.set(nodeId, created);
  return created;
}

function formIdOf(nodeId: string): string {
  return `restart-form-${nodeId}`;
}

async function restart(node: StorageNode, form: RestartForm): Promise<void> {
  form.restarting = true;
  form.result = null;
  requestRender();
  const result = await restartNode(node.id, form.confirm);
  form.restarting = false;
  if (result.ok) {
    form.confirm = "";
    form.result = { text: `Restarting ${node.name}'s Syncthing; it answers again in a few seconds.`, tone: "ok" };
    appState.restartStates.delete(node.id);
  } else {
    form.result = editFailureNotice(result);
  }
  requestRender();
}

function confirmField(node: StorageNode, form: RestartForm): HTMLElement {
  const input = element("input", { attributes: { id: controlId(formIdOf(node.id), "confirm"), type: "text", autocomplete: "off", spellcheck: "false" } });
  input.value = form.confirm;
  input.defaultValue = "";
  input.disabled = form.restarting;
  input.addEventListener("input", () => {
    form.confirm = input.value;
    const restartButton = input.closest(".restart-form")?.querySelector<HTMLButtonElement>("button.restart-button");
    if (restartButton) restartButton.disabled = input.value !== node.name;
  });
  return element("label", { className: "setting" }, element("span", {}, `Type ${node.name} to restart it: its folders stop syncing until it is back`), input);
}

function restartNeededLine(node: StorageNode): HTMLElement | null {
  const state = appState.restartStates.get(node.id);
  if (!state) return null;
  if ("error" in state) return element("p", { className: "muted" }, `Whether it needs a restart is not known: ${state.error}`);
  return state.restartRequired ? element("p", { className: "notice restart-banner tone-text-warn", attributes: { role: "status" } }, `Restart needed: ${node.name}'s Syncthing applies a saved change only after it restarts.`) : null;
}

/**
 * The node's "restart needed" banner and its Restart button, as Syncthing's own Actions menu has one.
 * @implNote An array or the host's own native node asks for its name typed, as the dashboard's other risky node actions do.
 */
export function restartSection(node: StorageNode): HTMLElement {
  const form = formOf(node.id);
  const formId = formIdOf(node.id);
  registerForm(formId);
  const state = appState.restartStates.get(node.id);
  const confirmRequired = state !== undefined && !("error" in state) && state.confirmRequired;
  const restartButton = Object.assign(button(form.restarting ? "Restarting…" : "Restart Syncthing", () => void restart(node, form), "button restart-button"), {
    disabled: form.restarting || (confirmRequired && form.confirm !== node.name),
  });
  return element(
    "div",
    { className: "restart-form", attributes: { id: formId } },
    restartNeededLine(node),
    confirmRequired ? confirmField(node, form) : null,
    resultLine(form.result),
    element("div", { className: "button-row" }, restartButton),
  );
}
