import type { FolderSharingChange } from "./api.js";
import { button, element } from "./dom.js";
import { requestRender } from "./renderRequest.js";
import type { SharingDraft } from "./state.js";

/** One device a folder can be shared with, or one folder a device can be given, as a row of a form's sharing list. */
export interface SharingChoice {
  /** The device's ID in a folder's form, the folder's ID in a device's. */
  key: string;
  label: string;
  detail: string | null;
  isShared: boolean;
  /** The receiving device is untrusted, so a new share needs an encryption password. */
  needsPassword: boolean;
  /** The receiving device's name, for the hints. */
  receiver: string;
}

export function isTicked(draft: SharingDraft, choice: SharingChoice): boolean {
  return choice.isShared ? !draft.unshare.has(choice.key) : draft.share.has(choice.key);
}

function tick(draft: SharingDraft, choice: SharingChoice, ticked: boolean): void {
  if (choice.isShared) {
    if (ticked) draft.unshare.delete(choice.key);
    else draft.unshare.add(choice.key);
  } else if (ticked) {
    draft.share.set(choice.key, draft.share.get(choice.key) ?? "");
  } else {
    draft.share.delete(choice.key);
    draft.revealed.delete(choice.key);
  }
  requestRender();
}

function idPart(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]/g, "_");
}

function revealWords(revealed: boolean): string {
  return revealed ? "Hide" : "Show";
}

/** @implNote Masked until the person reveals it; the page never gets a saved password back, so only a new share has this field. */
function passwordField(formId: string, draft: SharingDraft, choice: SharingChoice, disabled: boolean): HTMLElement {
  const id = `${formId}-password-${idPart(choice.key)}`;
  const input = element("input", { attributes: { id, type: draft.revealed.has(choice.key) ? "text" : "password", autocomplete: "new-password", spellcheck: "false" } });
  input.defaultValue = "";
  input.value = draft.share.get(choice.key) ?? "";
  input.disabled = disabled;
  input.addEventListener("input", () => draft.share.set(choice.key, input.value));
  const reveal = button(revealWords(draft.revealed.has(choice.key)), () => {
    const revealed = !draft.revealed.has(choice.key);
    if (revealed) draft.revealed.add(choice.key);
    else draft.revealed.delete(choice.key);
    input.type = revealed ? "text" : "password";
    reveal.textContent = revealWords(revealed);
    reveal.setAttribute("aria-pressed", String(revealed));
  }, "button ghost");
  reveal.setAttribute("aria-pressed", String(draft.revealed.has(choice.key)));
  reveal.setAttribute("aria-label", `${revealWords(draft.revealed.has(choice.key))} the encryption password for ${choice.label}`);
  reveal.disabled = disabled;
  const hint = choice.needsPassword
    ? element("small", { className: "tone-text-warn" }, `Required: ${choice.receiver} is untrusted, so it gets the folder only encrypted.`)
    : element("small", { className: "muted" }, `Optional: with a password, ${choice.receiver} gets the folder encrypted and cannot read it.`);
  return element("label", { className: "setting share-password", attributes: { for: id } }, element("span", {}, "Encryption password"), element("span", { className: "setting-input" }, input, reveal), hint);
}

function choiceRow(formId: string, draft: SharingDraft, choice: SharingChoice, disabled: boolean): HTMLElement {
  const id = `${formId}-share-${idPart(choice.key)}`;
  const box = element("input", { attributes: { id, type: "checkbox" } });
  box.defaultChecked = choice.isShared;
  box.checked = isTicked(draft, choice);
  box.disabled = disabled;
  box.addEventListener("change", () => tick(draft, choice, box.checked));
  const ticked = isTicked(draft, choice);
  const stopping = choice.isShared && !ticked ? element("small", { className: "tone-text-warn" }, `Stops sharing once saved: ${choice.receiver} gets no more changes of it.`) : null;
  return element(
    "div",
    { className: "share-choice" },
    element("label", { className: "toggle", attributes: { for: id } }, box, element("span", {}, choice.label, choice.detail ? element("small", { className: "muted" }, ` ${choice.detail}`) : null)),
    !choice.isShared && ticked ? passwordField(formId, draft, choice, disabled) : null,
    stopping,
  );
}

/** A tick per choice; ticking one not yet shared asks for its encryption password. */
export function sharingList(formId: string, legend: string, draft: SharingDraft, choices: SharingChoice[], disabled: boolean): HTMLElement {
  return element("fieldset", { className: "share-folders" }, element("legend", {}, legend), ...choices.map((choice) => choiceRow(formId, draft, choice, disabled)));
}

export function hasSharingChanges(draft: SharingDraft): boolean {
  return draft.share.size + draft.unshare.size > 0;
}

/** A folder form's draft as the edit's `devices` field; an empty password is no password. */
export function folderSharingChange(draft: SharingDraft): FolderSharingChange {
  return {
    share: [...draft.share].map(([deviceId, password]) => ({ deviceId, ...(password ? { encryptionPassword: password } : {}) })),
    unshare: [...draft.unshare],
  };
}

export function clearSharing(draft: SharingDraft): void {
  draft.share.clear();
  draft.unshare.clear();
  draft.revealed.clear();
}
