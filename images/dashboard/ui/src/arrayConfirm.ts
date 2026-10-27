import type { StorageNode } from "./api.js";
import { controlId } from "./deviceForm.js";
import { element } from "./dom.js";
import { requestRender } from "./renderRequest.js";
import { editFolderLocation } from "./state.js";

/** What an array's typed folder ID confirms: the act in words (`share it`) and the ID to type, read when it is checked. */
export interface ArrayConfirm {
  formId: string;
  nodeName: string;
  doing: string;
  folderId: () => string;
  /** Shown in the label; false while the ID is itself being typed in the same form. */
  showsId: boolean;
  typed: string;
  disabled: boolean;
  onInput: (typed: string) => void;
}

export function isArrayConfirmed(typed: string, folderId: string): boolean {
  return folderId !== "" && typed === folderId;
}

/**
 * The field an array asks the folder ID in before a folder is added, shared, accepted or ignored there, as the server checks it.
 * @implNote Renders again only when the typed ID starts or stops matching, so typing is never interrupted.
 */
export function arrayConfirmField(confirm: ArrayConfirm): HTMLElement {
  const id = controlId(confirm.formId, "confirm");
  const input = element("input", { attributes: { id, autocomplete: "off", spellcheck: "false" } });
  input.defaultValue = "";
  input.value = confirm.typed;
  input.disabled = confirm.disabled;
  input.addEventListener("input", () => {
    const wasConfirmed = isArrayConfirmed(confirm.typed, confirm.folderId());
    confirm.typed = input.value;
    confirm.onInput(input.value);
    if (wasConfirmed !== isArrayConfirmed(input.value, confirm.folderId())) requestRender();
  });
  const named = confirm.showsId ? [" ", element("code", {}, confirm.folderId())] : [];
  const text = element("span", {}, "Type the folder ID", ...named, ` to ${confirm.doing} on ${confirm.nodeName}`);
  const hint = element("small", { className: "muted" }, `${confirm.nodeName} is an array, so this is never one click.`);
  return element("label", { className: "setting", attributes: { for: id } }, text, input, hint);
}

/** What a device's forms show on an array instead of its folders to tick: each folder's own settings, where its ID is typed. */
export function arraySharesElsewhere(node: StorageNode): HTMLElement {
  const links = node.folders.map((folder) => element("li", {}, element("a", { attributes: { href: editFolderLocation(folder.id, node.id) } }, folder.label || folder.id)));
  return element(
    "div",
    { className: "array-shares" },
    element("p", { className: "muted" }, `On ${node.name}, an array, a folder is shared only from its own settings, where its folder ID is typed.`),
    links.length ? element("ul", {}, ...links) : null,
  );
}
