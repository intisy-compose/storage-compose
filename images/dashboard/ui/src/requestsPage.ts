import { type JoinEntry, type PendingDevice, type PendingFolderOffer, type RequestsResponse, acceptPendingDevice, deviceDisplayName, deviceSettingLabels, dismissPendingDevice, ignorePendingDevice, shortDeviceId } from "./api.js";
import { button, element } from "./dom.js";
import { formatAge, formatDate } from "./format.js";
import { registerForm } from "./forms.js";
import { requestRender } from "./renderRequest.js";
import { folderOfferAnswer, pruneFolderAnswers } from "./folderOfferForm.js";
import { type AnswerResult, type DeviceAnswer, answerKey, freshAnswer, ignoreClick, pruneAnswers } from "./requestAnswers.js";
import { appState, deviceFormLocation, locationFor } from "./state.js";

function since(time: string): HTMLElement {
  return element("small", { className: "request-time", title: formatDate(time) }, formatAge(time));
}

function nodeLink(nodeId: string, nodeName: string): HTMLElement {
  return element("a", { attributes: { href: locationFor("nodes", nodeId) } }, nodeName);
}

const answers = new Map<string, DeviceAnswer>();
let lastAnswer: AnswerResult | null = null;

function answerOf(device: PendingDevice): DeviceAnswer {
  const key = answerKey(device);
  const existing = answers.get(key);
  if (existing) return existing;
  const fresh = freshAnswer(device);
  answers.set(key, fresh);
  return fresh;
}

function formIdOf(device: PendingDevice): string {
  return `pending-device-${device.nodeId}-${device.deviceId}`;
}

function report(result: AnswerResult): void {
  lastAnswer = result;
  requestRender();
}

function finish(device: PendingDevice, result: AnswerResult, answered: boolean): void {
  if (answered) answers.delete(answerKey(device));
  else answerOf(device).busy = false;
  report(result);
}

async function accept(device: PendingDevice): Promise<void> {
  const answer = answerOf(device);
  answer.busy = true;
  requestRender();
  const result = await acceptPendingDevice(device.nodeId, device.deviceId, { name: answer.name, recordInSetup: answer.recordInSetup });
  if (!result.ok) return finish(device, { text: `Not accepted: ${result.message}`, tone: "bad", link: null }, false);
  const name = deviceDisplayName(result.value.device.name, device.deviceId);
  const link = { href: deviceFormLocation(device.nodeId, device.deviceId), label: `Open ${name}` };
  finish(device, { text: `Accepted ${name} on ${device.nodeName}; ${result.value.setup}.`, tone: "ok", link }, true);
}

async function ignore(device: PendingDevice): Promise<void> {
  const answer = answerOf(device);
  if (ignoreClick(answer) === "ask") return requestRender();
  answer.busy = true;
  requestRender();
  const result = await ignorePendingDevice(device.nodeId, device.deviceId);
  const name = deviceDisplayName(device.name, device.deviceId);
  if (!result.ok) {
    answer.confirmingIgnore = false;
    return finish(device, { text: `Not ignored: ${result.message}`, tone: "bad", link: null }, false);
  }
  const text = result.value.alreadyIgnored ? `${name} was already ignored on ${device.nodeName}; nothing changed.` : `Ignored ${name} on ${device.nodeName}; it is not offered again.`;
  finish(device, { text, tone: "ok", link: null }, true);
}

function keepAsking(answer: DeviceAnswer): void {
  answer.confirmingIgnore = false;
  requestRender();
}

function ignoreButtons(device: PendingDevice, answer: DeviceAnswer): HTMLButtonElement[] {
  const name = deviceDisplayName(device.name, device.deviceId);
  if (!answer.confirmingIgnore) return [answerButton("Ignore", `${device.nodeName} never lists this device again (Syncthing's Ignore)`, () => ignore(device), "button", answer.busy)];
  return [
    answerButton(`Ignore ${name}? It stays ignored until un-ignored in Settings`, `Click again to ignore ${name} on ${device.nodeName}`, () => ignore(device), "button danger", answer.busy),
    Object.assign(button("Keep it", () => keepAsking(answer), "button ghost"), { disabled: answer.busy }),
  ];
}

async function dismiss(device: PendingDevice): Promise<void> {
  answerOf(device).busy = true;
  requestRender();
  const result = await dismissPendingDevice(device.nodeId, device.deviceId);
  const name = deviceDisplayName(device.name, device.deviceId);
  if (!result.ok) return finish(device, { text: `Not dismissed: ${result.message}`, tone: "bad", link: null }, false);
  finish(device, { text: `Dismissed ${name}'s request to ${device.nodeName}; it is listed again if it asks again.`, tone: "ok", link: null }, true);
}

function nameField(device: PendingDevice, answer: DeviceAnswer): HTMLElement {
  const id = `${formIdOf(device)}-name`;
  const input = element("input", { attributes: { id, autocomplete: "off", spellcheck: "false", placeholder: shortDeviceId(device.deviceId) } });
  input.defaultValue = device.name;
  input.value = answer.name;
  input.disabled = answer.busy;
  input.addEventListener("input", () => (answer.name = input.value));
  return element("label", { className: "request-name", attributes: { for: id } }, element("span", {}, deviceSettingLabels.name), input);
}

function recordField(device: PendingDevice, answer: DeviceAnswer): HTMLElement {
  const id = `${formIdOf(device)}-record`;
  const box = element("input", { attributes: { id, type: "checkbox" } });
  box.defaultChecked = true;
  box.checked = answer.recordInSetup;
  box.disabled = answer.busy;
  box.addEventListener("change", () => (answer.recordInSetup = box.checked));
  return element("label", { className: "toggle", attributes: { for: id } }, box, element("span", {}, "Record in the setup repo"));
}

function answerButton(label: string, title: string, run: () => Promise<void>, className: string, busy: boolean): HTMLButtonElement {
  return Object.assign(button(label, () => void run(), className), { title, disabled: busy });
}

function deviceAnswerForm(device: PendingDevice): HTMLElement {
  const formId = formIdOf(device);
  registerForm(formId);
  const answer = answerOf(device);
  return element(
    "div",
    { className: "request-answer", attributes: { id: formId } },
    nameField(device, answer),
    recordField(device, answer),
    element(
      "div",
      { className: "button-row" },
      answerButton(answer.busy ? "Working…" : "Accept", `Add this device to ${device.nodeName} under the name typed`, () => accept(device), "button primary", answer.busy),
      ...ignoreButtons(device, answer),
      answerButton("Dismiss", "Drop this request; it is listed again when the device next asks", () => dismiss(device), "button ghost", answer.busy),
    ),
  );
}

/** The answer controls for a request to a node of this host; another host's node is answered on that host's dashboard. */
function answerPart(nodeId: string, localAnswer: () => HTMLElement): HTMLElement {
  const node = appState.data?.nodes.find((candidate) => candidate.id === nodeId);
  if (node?.local) return localAnswer();
  return element("small", { className: "request-detail" }, node ? `Answered on ${node.host}'s own dashboard.` : "Answered on its host's own dashboard.");
}

function deviceEntry(device: PendingDevice): HTMLElement {
  return element(
    "li",
    { className: "request-entry request-entry-answerable" },
    element(
      "div",
      { className: "request-head" },
      element(
        "span",
        { className: "request-text" },
        element("strong", {}, deviceDisplayName(device.name, device.deviceId)),
        ` (${shortDeviceId(device.deviceId)}) asks to connect to `,
        nodeLink(device.nodeId, device.nodeName),
        device.address ? element("small", { className: "request-detail" }, `from ${device.address}`) : null,
      ),
      since(device.time),
    ),
    answerPart(device.nodeId, () => deviceAnswerForm(device)),
  );
}

/** The page forgets the last answer's outcome once the person leaves it. */
export function forgetLastAnswer(): void {
  lastAnswer = null;
}

function lastAnswerLine(): HTMLElement | null {
  if (!lastAnswer) return null;
  const { text, tone, link } = lastAnswer;
  return element(
    "div",
    { className: "request-result" },
    element("p", { className: `notice tone-text-${tone}`, attributes: { role: "status" } }, text),
    link ? element("a", { className: "button ghost", attributes: { href: link.href } }, link.label) : null,
  );
}

function folderEntry(offer: PendingFolderOffer): HTMLElement {
  const folder = element("a", { attributes: { href: locationFor("folders", offer.folderId) } }, offer.label || offer.folderId);
  return element(
    "li",
    { className: "request-entry request-entry-answerable" },
    element(
      "div",
      { className: "request-head" },
      element(
        "span",
        { className: "request-text" },
        element("strong", {}, offer.offeredByName),
        " offers ",
        folder,
        " to ",
        nodeLink(offer.nodeId, offer.nodeName),
        element("small", { className: "request-detail" }, `folder ID ${offer.folderId}${offer.receiveEncrypted ? ", encrypted on receipt" : ""}`),
      ),
      since(offer.time),
    ),
    answerPart(offer.nodeId, () => folderOfferAnswer(offer, report)),
  );
}

function joinEntry(join: JoinEntry): HTMLElement {
  return element(
    "li",
    { className: "request-entry" },
    element("span", { className: "request-text" }, element("strong", {}, join.name), " joined through the join API", element("small", { className: "request-detail" }, join.setup)),
    since(join.joinedAt),
  );
}

function group<Entry>(heading: string, entries: Entry[], render: (entry: Entry) => HTMLElement, emptyText: string): HTMLElement {
  return element(
    "section",
    { className: "request-group" },
    element("h2", { className: "group-heading" }, heading, element("span", { className: "group-count" }, String(entries.length))),
    entries.length ? element("ul", { className: "request-list" }, ...entries.map(render)) : element("p", { className: "empty-line" }, emptyText),
  );
}

function unreadableNotes(requests: RequestsResponse): HTMLElement | null {
  const faults = requests.unreadable.filter((entry) => !entry.notConnected);
  if (!faults.length) return null;
  return element("div", { className: "warnings" }, ...faults.map((entry) => element("div", { className: "warning" }, `${entry.name}: ${entry.reason}, so its requests are not listed.`)));
}

function notConnectedNote(requests: RequestsResponse): HTMLElement | null {
  const names = requests.unreadable.filter((entry) => entry.notConnected).map((entry) => entry.name);
  if (!names.length) return null;
  return element("p", { className: "muted" }, `Not connected, so their requests are not listed: ${names.join(", ")}.`);
}

function body(): (HTMLElement | null)[] {
  const requests = appState.requests;
  if (!requests) return [element("p", { className: appState.requestsError ? "warning level-error" : "muted" }, appState.requestsError ?? "Loading requests…")];
  pruneAnswers(answers, requests.devices.map(answerKey), requests.unreadable);
  pruneFolderAnswers(requests);
  return [
    unreadableNotes(requests),
    notConnectedNote(requests),
    lastAnswerLine(),
    group("Devices asking to connect", requests.devices, deviceEntry, "No device is asking to connect to a node."),
    group("Folders offered", requests.folders, folderEntry, "No folder is waiting to be accepted on a node."),
    group("Joined", requests.joins, joinEntry, "No device has joined through the join API yet."),
  ];
}

export function renderRequestsPage(): HTMLElement {
  return element(
    "div",
    { className: "page" },
    element(
      "header",
      { className: "page-header" },
      element("h1", {}, "Requests"),
      element("p", { className: "page-summary" }, "Devices and folders waiting for a node's answer, and the devices admitted through the join API."),
    ),
    ...body(),
  );
}
