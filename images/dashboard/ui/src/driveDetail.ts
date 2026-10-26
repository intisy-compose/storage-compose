import { type DriveAttachment, type DevicesResponse, type DriveSummary, type NodesResponse, type StorageNode, driveWhereText, seenTimeText } from "./api.js";
import { driveKindLabel, isDeviceHost, memberDrive } from "./deviceList.js";
import { element, keyValueList, section } from "./dom.js";
import { formatBytes } from "./format.js";
import { icon } from "./icons.js";
import { deviceLocation, locationFor } from "./state.js";

function arrayOf(response: NodesResponse, drive: DriveSummary): StorageNode | undefined {
  return drive.arrayId ? response.nodes.find((node) => node.id === drive.arrayId) : undefined;
}

function roleIn(array: StorageNode, drive: DriveSummary, devices: DevicesResponse): string | null {
  const member = array.array?.members.find((candidate) => memberDrive(array, candidate, devices.drives)?.key === drive.key);
  return member?.role ?? null;
}

function arrayValue(response: NodesResponse, devices: DevicesResponse, drive: DriveSummary): HTMLElement | string {
  const array = arrayOf(response, drive);
  if (!array) return drive.arrayId ? `array ${drive.arrayId}, ${drive.attachments[0]?.as ?? "role unknown"}` : "none";
  const role = roleIn(array, drive, devices);
  return element("span", {}, element("a", { attributes: { href: locationFor("nodes", array.id) } }, array.name), role ? `, ${role}` : "");
}

function nodeValue(response: NodesResponse, drive: DriveSummary): HTMLElement | string {
  const node = drive.nodeId ? response.nodes.find((candidate) => candidate.id === drive.nodeId) : undefined;
  if (!node) return drive.nodeId ?? "none";
  return element("a", { attributes: { href: locationFor("nodes", node.id) } }, node.name);
}

function whereValue(devices: DevicesResponse, drive: DriveSummary, now: Date): HTMLElement | string {
  const text = driveWhereText(drive, now);
  const host = drive.currentHost ?? drive.lastHost;
  const device = devices.devices.find((candidate) => isDeviceHost(candidate, host));
  if (!device) return text;
  return element("span", {}, `${text} `, element("a", { attributes: { href: deviceLocation(device.key) } }, `(${device.name})`));
}

function factsSection(response: NodesResponse, devices: DevicesResponse, drive: DriveSummary, now: Date): HTMLElement {
  const placement: [string, HTMLElement | string] = drive.kind === "array-member" ? ["Array and role", arrayValue(response, devices, drive)] : ["Node", nodeValue(response, drive)];
  return section(
    "Drive",
    keyValueList([
      ["Kind", driveKindLabel(drive)],
      ["Serial", drive.serial ? element("code", {}, drive.serial) : "unknown"],
      ["Size", formatBytes(drive.size)],
      placement,
      ["Where", whereValue(devices, drive, now)],
    ]),
  );
}

function stayText(stay: DriveAttachment, now: Date): string {
  const until = stay.endedAt ? seenTimeText(stay.endedAt, now) : `now (last read ${seenTimeText(stay.lastAt, now)})`;
  return `${seenTimeText(stay.since, now)} to ${until}`;
}

function stayRow(stay: DriveAttachment, now: Date): HTMLElement {
  return element(
    "div",
    { className: `stay-row${stay.endedAt ? " ended" : ""}` },
    element("span", { className: `dot tone-${stay.endedAt ? "muted" : "ok"}` }),
    element("span", { className: "stay-text" }, element("strong", {}, stay.host), element("small", {}, stay.as)),
    element("small", { className: "stay-when" }, stayText(stay, now)),
  );
}

function historySection(drive: DriveSummary, now: Date): HTMLElement {
  return section(
    `Attachment history (${drive.attachments.length})`,
    drive.attachments.length ? element("div", { className: "stay-list" }, ...drive.attachments.map((stay) => stayRow(stay, now))) : element("p", { className: "muted" }, "Never seen attached."),
  );
}

export function renderDriveDetail(response: NodesResponse, devices: DevicesResponse, drive: DriveSummary): HTMLElement {
  const now = new Date();
  return element(
    "div",
    { className: "detail-inner" },
    element(
      "header",
      { className: "detail-header" },
      element("a", { className: "icon-button close-detail", title: "Close", attributes: { href: locationFor("nodes"), "aria-label": "Close detail" } }, icon("close")),
      element("h2", {}, drive.label),
      element("p", { className: "detail-status" }, element("span", { className: `dot tone-${drive.present ? "ok" : "muted"}` }), driveWhereText(drive, now)),
    ),
    factsSection(response, devices, drive, now),
    historySection(drive, now),
  );
}
