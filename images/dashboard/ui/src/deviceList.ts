import { type ArrayMember, type DeviceSummary, type DevicesResponse, type DriveSummary, type NodesResponse, type StorageNode, connectionKindText, deviceStateText, driveLastSeenHereText, driveWhereText } from "./api.js";
import {
  type DevicePlacement,
  type DeviceRow,
  type NodeFilters,
  deviceDriveCount,
  deviceRows,
  driveKindLabel,
  isDeviceHost,
  isDeviceShown,
  memberDrive,
} from "./devicePlacement.js";
import { element } from "./dom.js";
import { formatBytes, plural } from "./format.js";
import { chip, nodeRow } from "./nodeRow.js";
import { requestRender } from "./renderRequest.js";
import { appState, deviceLocation, driveLocation } from "./state.js";

function connectionChip(device: DeviceSummary): HTMLElement | null {
  if (device.thisHost) return chip("this device");
  if (device.connection) return chip(connectionKindText(device.connection.kind), "chip", device.connection.address);
  if (device.lastConnection) return chip(connectionKindText(device.lastConnection.kind), "chip chip-muted", "how it was connected last time");
  return null;
}

function countsText(placement: DevicePlacement): string {
  const drives = deviceDriveCount(placement);
  return [plural(placement.nodes.length, "node"), drives ? plural(drives, "drive") : ""].filter(Boolean).join(", ");
}

function deviceNote(device: DeviceSummary, now: Date): string | null {
  if (device.thisHost || device.connection) return null;
  return deviceStateText(device, now);
}

function deviceLine(placement: DevicePlacement, now: Date): HTMLElement {
  const { device } = placement;
  const isSelected = appState.selectedDeviceKey === device.key;
  const note = deviceNote(device, now);
  const line = element(
    "a",
    { className: `device-line${isSelected ? " selected" : ""}${device.online ? "" : " offline"}`, attributes: { href: deviceLocation(device.key), "data-device": device.key } },
    element("span", { className: `dot tone-${device.online ? "ok" : "muted"}`, title: device.online ? "online" : "offline" }),
    element("strong", { className: "device-name" }, device.name),
    connectionChip(device),
    note ? element("small", { className: "device-note" }, note) : null,
    element("small", { className: "device-counts" }, countsText(placement)),
  );
  if (isSelected) line.setAttribute("aria-current", "true");
  return line;
}

interface DriveRowFacts {
  drive: DriveSummary | undefined;
  label: string;
  role: string;
  size: number | null;
  present: boolean;
}

function presenceText(facts: DriveRowFacts, device: DeviceSummary, now: Date): string {
  const { drive } = facts;
  if (facts.present && (!drive || !drive.currentHost || isDeviceHost(device, drive.currentHost))) return "attached";
  if (!drive) return "not connected";
  if (drive.present && drive.currentHost) return `on ${drive.currentHost} now`;
  return isDeviceHost(device, drive.lastHost) ? driveLastSeenHereText(drive, now) : driveWhereText(drive, now);
}

function driveRow(facts: DriveRowFacts, device: DeviceSummary, now: Date, className: string): HTMLElement {
  const isSelected = facts.drive !== undefined && appState.selectedDriveKey === facts.drive.key;
  const classes = `node-row drive-row ${className}${facts.present ? "" : " offline"}${isSelected ? " selected" : ""}`;
  const attributes: Record<string, string> = facts.drive ? { href: driveLocation(facts.drive.key), "data-drive": facts.drive.key } : {};
  const row = element(
    facts.drive ? "a" : "div",
    { className: classes, attributes },
    element("span", { className: `dot tone-${facts.present ? "ok" : "muted"}`, title: facts.present ? "attached" : "not attached" }),
    element("span", { className: "node-name" }, element("strong", {}, facts.label), facts.drive?.serial ? element("small", {}, facts.drive.serial) : null),
    element("span", { className: "node-chips" }, chip(facts.role)),
    element("span", { className: "drive-size" }, facts.size === null ? "" : formatBytes(facts.size)),
    element("span", { className: `node-sync tone-text-${facts.present ? "ok" : "muted"}` }, presenceText(facts, device, now)),
  );
  if (isSelected) row.setAttribute("aria-current", "true");
  return row;
}

function looseDriveRow(drive: DriveSummary, device: DeviceSummary, now: Date): HTMLElement {
  const present = drive.present && isDeviceHost(device, drive.currentHost);
  return driveRow({ drive, label: drive.label, role: driveKindLabel(drive), size: drive.size, present }, device, now, "loose-drive");
}

function membersSummary(array: StorageNode, shown: ArrayMember[], withArrayName: boolean): string {
  const members = array.array?.members ?? [];
  const attached = members.filter((entry) => entry.present).length;
  const state = attached === 0 ? "none attached" : attached === members.length ? "all attached" : `${attached} attached`;
  const hidden = members.length - shown.length;
  const parts = [`${plural(members.length, "drive")}, ${state}`, hidden ? `${hidden} hidden by filters` : ""].filter(Boolean).join(", ");
  return withArrayName ? `${array.name}: ${parts}` : parts;
}

/** An array's member drives the filters leave, folded or unfolded by the person; named when the array's own row is filtered out. */
function arrayMembers(array: StorageNode, members: ArrayMember[], drives: DriveSummary[], device: DeviceSummary, now: Date, withArrayName: boolean): HTMLElement | null {
  if (members.length === 0) return null;
  const isOpen = !appState.foldedArrays.has(array.id);
  const toggle = element("button", { className: "disclosure members-toggle", attributes: { type: "button", "aria-expanded": String(isOpen) } }, membersSummary(array, members, withArrayName));
  toggle.addEventListener("click", () => {
    if (isOpen) appState.foldedArrays.add(array.id);
    else appState.foldedArrays.delete(array.id);
    requestRender();
  });
  const rows = members.map((entry) =>
    driveRow({ drive: memberDrive(array, entry, drives), label: entry.label, role: entry.role, size: entry.size, present: entry.present }, device, now, "member-drive"),
  );
  return element("div", { className: "array-members" }, toggle, isOpen ? element("div", { className: "member-drive-list" }, ...rows) : null);
}

function rowElements(response: NodesResponse, drives: DriveSummary[], device: DeviceSummary, row: DeviceRow, now: Date): (HTMLElement | null)[] {
  if (row.type === "drive") return [looseDriveRow(row.drive, device, now)];
  if (row.type === "members") return [arrayMembers(row.array, row.members, drives, device, now, true)];
  return [nodeRow(response, row.node), arrayMembers(row.node, row.members, drives, device, now, false)];
}

function deviceBlock(response: NodesResponse, devices: DevicesResponse, placement: DevicePlacement, filters: NodeFilters, now: Date): HTMLElement | null {
  const rows = deviceRows(response, devices.drives, placement, filters);
  if (!isDeviceShown(placement, rows, filters)) return null;
  const listed = rows.flatMap((row) => rowElements(response, devices.drives, placement.device, row, now)).filter((entry) => entry !== null);
  return element(
    "section",
    { className: "device-block", attributes: { "aria-label": placement.device.name } },
    deviceLine(placement, now),
    listed.length ? element("div", { className: "node-list" }, ...listed) : null,
  );
}

export function deviceBlocks(response: NodesResponse, devices: DevicesResponse, placements: DevicePlacement[], filters: NodeFilters): HTMLElement[] {
  const now = new Date();
  return placements.map((placement) => deviceBlock(response, devices, placement, filters, now)).filter((block) => block !== null);
}
