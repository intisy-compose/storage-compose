import { type FolderCopy, type FolderSettings, type LocalChangesAction, discardChanges, discardedCount, fetchDiscardCounts, localChangesFolderType, overrideLossText, revertLossText } from "./api.js";
import { acceptCountsRead, forgetCountsRead, startCountsRead } from "./discardCounts.js";
import { button, element } from "./dom.js";
import { closeItemList, isItemListOpen } from "./itemList.js";
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

/** Reads Syncthing's counts once as the form opens, so the form names what would be discarded now rather than at the last poll. */
async function readDiscardCounts(settings: FolderSettings, state: FolderActionState): Promise<void> {
  const token = startCountsRead(state);
  const answer = await fetchDiscardCounts(state.nodeId, settings.id);
  if (acceptCountsRead(state, token, answer)) requestRender();
}

export function localChangesToggle(action: LocalChangesAction, settings: FolderSettings, state: FolderActionState): HTMLButtonElement {
  const control = button(
    state.discardOpen ? "Keep them" : buttonTexts[action].open,
    () => {
      state.discardOpen = !state.discardOpen;
      state.discardConfirm = "";
      if (state.discardOpen) void readDiscardCounts(settings, state);
      else forgetCountsRead(state);
      requestRender();
    },
    state.discardOpen ? "button ghost" : "button danger",
  );
  control.disabled = state.busy || settings.paused;
  if (settings.paused) control.title = `${folderName(settings)} is paused; resume it first`;
  return control;
}

function lossLines(action: LocalChangesAction, copy: FolderCopy, settings: FolderSettings, state: FolderActionState): string[] {
  const lines = action === "revert" ? revertLossText : overrideLossText;
  return lines(copy.nodeName, folderName(settings), discardedCount(action, copy, state.discardCounts), settings.versioning);
}

/** @implNote Syncthing acts on a revert or override after answering, so the list of what it discards is closed rather than read again too early. */
function closeListOfDiscarded(action: LocalChangesAction, copy: FolderCopy): void {
  const target = { nodeId: copy.nodeId, folderId: copy.id, deviceId: null, kind: action === "revert" ? ("local-changed" as const) : ("need" as const) };
  if (isItemListOpen(target)) closeItemList();
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
          closeListOfDiscarded(action, copy);
          return { text: `${text}.`, tone: "ok" };
        },
        action === "revert" ? "Not reverted" : "Not overridden",
      ),
    "button danger",
  );
  const isTyped = () => state.discardConfirm === settings.id;
  go.disabled = state.busy || state.discardCountsReading || !isTyped();
  confirmInput.addEventListener("input", () => {
    state.discardConfirm = confirmInput.value;
    go.disabled = state.busy || state.discardCountsReading || !isTyped();
  });
  const [lost, kept] = state.discardCountsReading ? ["Reading what Syncthing counts now…", ""] : lossLines(action, copy, settings, state);
  return element(
    "div",
    { className: "action-form destructive" },
    element("p", {}, element("strong", {}, lost)),
    kept ? element("p", {}, kept) : null,
    element("p", {}, "Type the folder ID ", element("code", {}, settings.id), " to confirm."),
    element("div", { className: "form-fields" }, confirmInput),
    element("div", { className: "button-row" }, go),
  );
}
