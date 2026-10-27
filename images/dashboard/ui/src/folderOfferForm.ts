import { type AcceptFolderDefaults, type FolderSettings, type FolderType, type PendingFolderOffer, type RequestsResponse, acceptPendingFolder, dismissPendingFolder, editableFolderTypes, fetchAcceptFolderDefaults, folderSettingLabels, folderTypeTexts, ignorePendingFolder } from "./api.js";
import { arrayConfirmField, isArrayConfirmed } from "./arrayConfirm.js";
import { button, element } from "./dom.js";
import { controlId, registerForm } from "./forms.js";
import { requestRender } from "./renderRequest.js";
import { type AnswerResult, type FolderAnswer, folderAnswerKey, freshFolderAnswer, ignoreClick, isAcceptConfirmed, pruneAnswers } from "./requestAnswers.js";
import { isArrayNode, locationFor } from "./state.js";
import { versioningSection } from "./versioningSection.js";

const answers = new Map<string, FolderAnswer>();

function answerOf(offer: PendingFolderOffer): FolderAnswer {
  const key = folderAnswerKey(offer);
  const existing = answers.get(key);
  if (existing) return existing;
  const fresh = freshFolderAnswer(offer);
  answers.set(key, fresh);
  return fresh;
}

/** Forgets the answers of offers no longer listed, keeping those of a node that could not be read this time. */
export function pruneFolderAnswers(requests: RequestsResponse): void {
  pruneAnswers(answers, requests.folders.map(folderAnswerKey), requests.unreadable);
}

function formIdOf(offer: PendingFolderOffer): string {
  return `pending-folder-${offer.nodeId}-${offer.folderId}-${offer.offeredBy}`.replace(/[^A-Za-z0-9_-]/g, "_");
}

function offerName(offer: PendingFolderOffer): string {
  return offer.label || offer.folderId;
}

type Report = (result: AnswerResult) => void;

function finish(offer: PendingFolderOffer, report: Report, result: AnswerResult, answered: boolean): void {
  if (answered) answers.delete(folderAnswerKey(offer));
  else answerOf(offer).busy = false;
  report(result);
}

async function openAccept(offer: PendingFolderOffer): Promise<void> {
  const answer = answerOf(offer);
  answer.open = true;
  answer.loadError = null;
  requestRender();
  try {
    const defaults = await fetchAcceptFolderDefaults(offer);
    answer.defaults = defaults;
    answer.draft = structuredClone(defaults.settings);
  } catch (error) {
    answer.loadError = error instanceof Error ? error.message : String(error);
  }
  requestRender();
}

function closeAccept(answer: FolderAnswer): void {
  Object.assign(answer, { open: false, defaults: null, draft: null, loadError: null, confirm: "" });
  requestRender();
}

async function accept(offer: PendingFolderOffer, report: Report): Promise<void> {
  const answer = answerOf(offer);
  const { draft, defaults } = answer;
  if (!draft || !defaults) return;
  answer.busy = true;
  requestRender();
  const confirm = defaults.confirmRequired ? { confirm: answer.confirm } : {};
  const result = await acceptPendingFolder(offer, { offeredBy: offer.offeredBy, path: draft.path, type: draft.type, versioning: draft.versioning, ...confirm });
  if (!result.ok) return finish(offer, report, { text: `Not accepted: ${result.message}`, tone: "bad", link: null }, false);
  const link = { href: locationFor("folders", offer.folderId), label: `Open ${offerName(offer)}` };
  finish(offer, report, { text: `Accepted ${offerName(offer)} from ${offer.offeredByName} on ${offer.nodeName}, at ${result.value.path}.`, tone: "ok", link }, true);
}

async function ignore(offer: PendingFolderOffer, report: Report): Promise<void> {
  const answer = answerOf(offer);
  if (ignoreClick(answer) === "ask") return requestRender();
  answer.busy = true;
  requestRender();
  const result = await ignorePendingFolder(offer, isArrayNode(offer.nodeId) ? answer.confirm : null);
  if (!result.ok) {
    answer.confirmingIgnore = false;
    return finish(offer, report, { text: `Not ignored: ${result.message}`, tone: "bad", link: null }, false);
  }
  const text = result.value.alreadyIgnored
    ? `${offerName(offer)} from ${offer.offeredByName} was already ignored on ${offer.nodeName}; nothing changed.`
    : `Ignored ${offerName(offer)} from ${offer.offeredByName} on ${offer.nodeName}; ${offer.offeredByName} does not offer it again.`;
  finish(offer, report, { text, tone: "ok", link: null }, true);
}

async function dismiss(offer: PendingFolderOffer, report: Report): Promise<void> {
  answerOf(offer).busy = true;
  requestRender();
  const result = await dismissPendingFolder(offer);
  if (!result.ok) return finish(offer, report, { text: `Not dismissed: ${result.message}`, tone: "bad", link: null }, false);
  finish(offer, report, { text: `Dismissed ${offer.offeredByName}'s offer of ${offerName(offer)} to ${offer.nodeName}; it is listed again if offered again.`, tone: "ok", link: null }, true);
}

function answerButton(label: string, title: string, run: () => Promise<void>, className: string, busy: boolean): HTMLButtonElement {
  return Object.assign(button(label, () => void run(), className), { title, disabled: busy });
}

function labelled(formId: string, field: string, text: string, control: HTMLElement, hint: string | null): HTMLElement {
  return element("label", { className: "setting", attributes: { for: controlId(formId, field) } }, element("span", {}, text), control, hint ? element("small", { className: "muted" }, hint) : null);
}

function pathField(formId: string, answer: FolderAnswer, defaults: AcceptFolderDefaults, draft: FolderSettings): HTMLElement {
  const input = element("input", { attributes: { id: controlId(formId, "path"), autocomplete: "off", spellcheck: "false" } });
  input.defaultValue = defaults.settings.path;
  input.value = draft.path;
  input.disabled = answer.busy;
  input.addEventListener("input", () => (draft.path = input.value));
  const problem = draft.path === defaults.settings.path ? defaults.placementProblem : null;
  return element(
    "div",
    { className: "setting" },
    labelled(formId, "path", folderSettingLabels.path, input, `Inside ${defaults.root}; Syncthing creates the directory and starts syncing into it.`),
    problem ? element("small", { className: "tone-text-bad" }, problem) : null,
  );
}

function typeChoices(offer: PendingFolderOffer): readonly FolderType[] {
  return offer.receiveEncrypted ? ["receiveencrypted"] : editableFolderTypes;
}

function typeField(formId: string, offer: PendingFolderOffer, answer: FolderAnswer, defaults: AcceptFolderDefaults, draft: FolderSettings): HTMLElement {
  const select = element("select", { attributes: { id: controlId(formId, "type") } });
  for (const type of typeChoices(offer)) {
    const option = element("option", { attributes: { value: type } }, folderTypeTexts[type]);
    option.defaultSelected = type === defaults.settings.type;
    select.append(option);
  }
  select.value = draft.type;
  select.disabled = answer.busy || offer.receiveEncrypted;
  select.addEventListener("change", () => (draft.type = select.value as FolderType));
  const hint = offer.receiveEncrypted ? "Offered encrypted: this node keeps it encrypted and cannot read it." : null;
  return labelled(formId, "type", folderSettingLabels.type, select, hint);
}

function confirmField(formId: string, offer: PendingFolderOffer, answer: FolderAnswer, doing: string): HTMLElement {
  return arrayConfirmField({ formId, nodeName: offer.nodeName, doing, folderId: () => offer.folderId, showsId: true, typed: answer.confirm, disabled: answer.busy, onInput: (typed) => (answer.confirm = typed) });
}

function acceptForm(formId: string, offer: PendingFolderOffer, answer: FolderAnswer, report: Report): HTMLElement {
  if (answer.loadError) return element("div", { className: "accept-folder" }, element("p", { className: "notice tone-text-bad" }, `The accept form could not be opened: ${answer.loadError}`), button("Close", () => closeAccept(answer), "button ghost"));
  const { defaults, draft } = answer;
  if (!defaults || !draft) return element("p", { className: "muted" }, "Reading the node's defaults…");
  const isConfirmed = isAcceptConfirmed(answer, offer.folderId, defaults.confirmRequired);
  return element(
    "div",
    { className: "accept-folder" },
    element("div", { className: "form-fields device-fields" }, pathField(formId, answer, defaults, draft), typeField(formId, offer, answer, defaults, draft)),
    versioningSection({ saved: defaults.settings, draft, saving: answer.busy }, formId),
    defaults.confirmRequired ? element("div", { className: "form-fields device-fields" }, confirmField(formId, offer, answer, "accept it")) : null,
    element(
      "div",
      { className: "button-row" },
      answerButton(answer.busy ? "Working…" : `Accept on ${offer.nodeName}`, `Add ${offerName(offer)} to ${offer.nodeName}, shared with ${offer.offeredByName}`, () => accept(offer, report), "button primary", answer.busy || !isConfirmed),
      Object.assign(button("Cancel", () => closeAccept(answer), "button ghost"), { disabled: answer.busy }),
    ),
  );
}

/** On an array the second click needs the folder ID typed too, as the server checks it. */
function ignoreButtons(offer: PendingFolderOffer, answer: FolderAnswer, report: Report): HTMLButtonElement[] {
  if (!answer.confirmingIgnore) return [answerButton("Ignore", `${offer.nodeName} never lists ${offer.offeredByName}'s offer of this folder again (Syncthing's Ignore)`, () => ignore(offer, report), "button", answer.busy)];
  const isUnconfirmed = isArrayNode(offer.nodeId) && !isArrayConfirmed(answer.confirm, offer.folderId);
  return [
    answerButton(`Ignore ${offerName(offer)} from ${offer.offeredByName}? It stays ignored until un-ignored in Settings`, "Click again to ignore", () => ignore(offer, report), "button danger", answer.busy || isUnconfirmed),
    Object.assign(
      button(
        "Keep it",
        () => {
          answer.confirmingIgnore = false;
          requestRender();
        },
        "button ghost",
      ),
      { disabled: answer.busy },
    ),
  ];
}

/** Accept, Ignore and Dismiss for one device's offer of a folder to a node of this host; Accept opens the form with the node's defaults. */
export function folderOfferAnswer(offer: PendingFolderOffer, report: Report): HTMLElement {
  const formId = formIdOf(offer);
  registerForm(formId);
  const answer = answerOf(offer);
  const buttons = element(
    "div",
    { className: "button-row" },
    answer.open ? null : answerButton("Accept…", `Choose where and how ${offer.nodeName} keeps the folder`, () => openAccept(offer), "button primary", answer.busy),
    ...ignoreButtons(offer, answer, report),
    answerButton("Dismiss", "Drop this offer; it is listed again when the device next offers the folder", () => dismiss(offer, report), "button ghost", answer.busy),
  );
  const ignoreConfirm = answer.confirmingIgnore && !answer.open && isArrayNode(offer.nodeId) ? element("div", { className: "form-fields device-fields" }, confirmField(formId, offer, answer, "ignore it")) : null;
  return element("div", { className: "request-answer request-answer-folder", attributes: { id: formId } }, answer.open ? acceptForm(formId, offer, answer, report) : null, ignoreConfirm, buttons);
}
