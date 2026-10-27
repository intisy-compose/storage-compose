import { type FolderCopy, type FolderSettings, type LocalChangesAction, discardChanges, localChangesFolderType, overrideLossText, revertLossText } from "./api.js";
import { button, element } from "./dom.js";
import { requestRender } from "./renderRequest.js";
import type { FolderActionState, Notice } from "./state.js";

/** The action a folder of this type offers: revert on receive only, override on send only, none on any other. */
export function localChangesActionOf(settings: FolderSettings): LocalChangesAction | null {
  if (settings.type === localChangesFolderType.revert) return "revert";
  if (settings.type === localChangesFolderType.override) return "override";
  return null;
}

const buttonTexts: Record<LocalChangesAction, { open: string; go: string; busy: string }> = {
  revert: { open: "Revert local changes…", go: "Revert local changes on", busy: "Reverting…" },
  override: { open: "Override other devices' changes…", go: "Override other devices' changes from", busy: "Overriding…" },
};

function folderName(settings: FolderSettings): string {
  return settings.label || settings.id;
}

export function localChangesToggle(action: LocalChangesAction, settings: FolderSettings, state: FolderActionState): HTMLButtonElement {
  const control = button(
    state.discardOpen ? "Keep them" : buttonTexts[action].open,
    () => {
      state.discardOpen = !state.discardOpen;
      state.discardConfirm = "";
      requestRender();
    },
    state.discardOpen ? "button ghost" : "button danger",
  );
  control.disabled = state.busy || settings.paused;
  if (settings.paused) control.title = `${folderName(settings)} is paused; resume it first`;
  return control;
}

/** The items the action discards as the folder's last read counts them: changed here for a revert, changed elsewhere for an override. */
function discardedCount(action: LocalChangesAction, copy: FolderCopy): number {
  return action === "revert" ? copy.localChanged : copy.needItems;
}

function lossLines(action: LocalChangesAction, copy: FolderCopy, settings: FolderSettings): string[] {
  const lines = action === "revert" ? revertLossText : overrideLossText;
  return lines(copy.nodeName, folderName(settings), discardedCount(action, copy), settings.versioning);
}

export type RunAction = (send: () => ReturnType<typeof discardChanges>, done: (text: string) => Notice, failed: string) => void;

/**
 * Asks for the folder ID typed exactly, as the server does, after saying how many items are lost and whether versioning keeps them.
 * @implNote Revert deletes or replaces this node's changes and override replaces what every other device changed, so neither is one click.
 */
export function localChangesForm(action: LocalChangesAction, copy: FolderCopy, settings: FolderSettings, state: FolderActionState, formId: string, run: RunAction): HTMLElement {
  const confirmInput = element("input", { attributes: { id: `${formId}-discard-confirm`, autocomplete: "off", spellcheck: "false", "aria-label": `Type the folder ID ${settings.id} to confirm` } });
  confirmInput.defaultValue = state.discardConfirm;
  confirmInput.value = state.discardConfirm;
  confirmInput.disabled = state.busy;
  const go = button(
    state.busy ? buttonTexts[action].busy : `${buttonTexts[action].go} ${copy.nodeName}`,
    () =>
      run(
        () => discardChanges(copy.nodeId, settings.id, action, state.discardConfirm),
        (text) => {
          state.discardOpen = false;
          state.discardConfirm = "";
          return { text: `${text}.`, tone: "ok" };
        },
        action === "revert" ? "Not reverted" : "Not overridden",
      ),
    "button danger",
  );
  const isTyped = () => state.discardConfirm === settings.id;
  go.disabled = state.busy || !isTyped();
  confirmInput.addEventListener("input", () => {
    state.discardConfirm = confirmInput.value;
    go.disabled = state.busy || !isTyped();
  });
  const [lost, kept] = lossLines(action, copy, settings);
  return element(
    "div",
    { className: "action-form destructive" },
    element("p", {}, element("strong", {}, lost)),
    element("p", {}, kept),
    element("p", {}, "Type the folder ID ", element("code", {}, settings.id), " to confirm."),
    element("div", { className: "form-fields" }, confirmInput),
    element("div", { className: "button-row" }, go),
  );
}
