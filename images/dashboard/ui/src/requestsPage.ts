import { type JoinEntry, type PendingDevice, type PendingFolderOffer, type RequestsResponse, deviceDisplayName, shortDeviceId } from "./api.js";
import { element } from "./dom.js";
import { formatAge, formatDate } from "./format.js";
import { appState, locationFor } from "./state.js";

function since(time: string): HTMLElement {
  return element("small", { className: "request-time", title: formatDate(time) }, formatAge(time));
}

function nodeLink(nodeId: string, nodeName: string): HTMLElement {
  return element("a", { attributes: { href: locationFor("nodes", nodeId) } }, nodeName);
}

function deviceEntry(device: PendingDevice): HTMLElement {
  return element(
    "li",
    { className: "request-entry" },
    element(
      "span",
      { className: "request-text" },
      element("strong", {}, deviceDisplayName(device.name, device.deviceId)),
      ` (${shortDeviceId(device.deviceId)}) asks to connect to `,
      nodeLink(device.nodeId, device.nodeName),
      device.address ? element("small", { className: "request-detail" }, `from ${device.address}`) : null,
    ),
    since(device.time),
  );
}

function folderEntry(offer: PendingFolderOffer): HTMLElement {
  const folder = element("a", { attributes: { href: locationFor("folders", offer.folderId) } }, offer.label || offer.folderId);
  return element(
    "li",
    { className: "request-entry" },
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
  return [
    unreadableNotes(requests),
    notConnectedNote(requests),
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
