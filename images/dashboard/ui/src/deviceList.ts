import { type ArrayMember, type DeviceSummary, type DevicesResponse, type DriveSummary, type StorageNode, connectionKindText, deviceStateText, driveLastSeenHereText, driveWhereText } from "./api.js";
import { element } from "./dom.js";
import { formatBytes, plural } from "./format.js";
import { requestRender } from "./renderRequest.js";
import { appState, deviceLocation, driveLocation } from "./state.js";

/** A device with the nodes it holds and the drives that are not already shown under one of those nodes. */
export interface DevicePlacement {
  device: DeviceSummary;
  nodes: StorageNode[];
  looseDrives: DriveSummary[];
}

export interface Placements {
  placements: DevicePlacement[];
  /** Nodes no device claims, for example while the devices are still being read. */
  unplacedNodes: StorageNode[];
}

const driveKindText: Record<DriveSummary["kind"], string> = {
  "array-member": "array member",
  "drive-node": "drive node",
  "folder-node": "folder node",
};

export function driveKindLabel(drive: DriveSummary): string {
  return driveKindText[drive.kind];
}

export function isDeviceHost(device: DeviceSummary, host: string | null): boolean {
  return host !== null && (device.key === host || device.name === host);
}

function isShownUnderNode(drive: DriveSummary, nodeIds: Set<string>): boolean {
  return nodeIds.has(drive.arrayId ?? "") || nodeIds.has(drive.nodeId ?? "");
}

export function placeOnDevices(nodes: StorageNode[], response: DevicesResponse | null): Placements {
  if (!response) return { placements: [], unplacedNodes: nodes };
  const drivesByKey = new Map(response.drives.map((drive) => [drive.key, drive]));
  const placed = new Set<string>();
  const placements = response.devices.map((device) => {
    const nodeIds = new Set(device.nodeIds);
    const own = nodes.filter((node) => nodeIds.has(node.id));
    for (const node of own) placed.add(node.id);
    const drives = device.driveKeys.map((key) => drivesByKey.get(key)).filter((drive) => drive !== undefined);
    return { device, nodes: own, looseDrives: drives.filter((drive) => !isShownUnderNode(drive, nodeIds)) };
  });
  return { placements, unplacedNodes: nodes.filter((node) => !placed.has(node.id)) };
}

function matchesTerms(parts: (string | null | undefined)[], search: string): boolean {
  if (!search) return true;
  const haystack = parts.filter(Boolean).join(" ").toLowerCase();
  return search.toLowerCase().split(/\s+/).every((term) => haystack.includes(term));
}

export function matchesDeviceSearch(device: DeviceSummary, search: string): boolean {
  const kind = device.thisHost ? "this device" : device.connection ? connectionKindText(device.connection.kind) : null;
  return matchesTerms([device.name, device.key, kind, ...device.deviceIds], search);
}

export function matchesDriveSearch(drive: DriveSummary, search: string): boolean {
  return matchesTerms([drive.label, drive.key, drive.serial, driveKindLabel(drive), ...drive.attachments.map((stay) => stay.as)], search);
}

/** The drive record of an array member: by serial, else by the role key used while the serial is unknown. */
export function memberDrive(array: StorageNode, member: ArrayMember, drives: DriveSummary[]): DriveSummary | undefined {
  const roleKey = `member:${array.id}-${member.role}`;
  return drives.find((drive) => drive.arrayId === array.id && (member.serial ? drive.serial === member.serial : drive.key === roleKey));
}

function chip(label: string, className = "chip", title?: string): HTMLElement {
  return element("span", { className, title }, label);
}

function connectionChip(device: DeviceSummary): HTMLElement | null {
  if (device.thisHost) return chip("this device");
  if (device.connection) return chip(connectionKindText(device.connection.kind), "chip", device.connection.address);
  if (device.lastConnection) return chip(connectionKindText(device.lastConnection.kind), "chip chip-muted", "how it was connected last time");
  return null;
}

function countsText(placement: DevicePlacement, memberCount: number): string {
  const drives = placement.looseDrives.length + memberCount;
  return [plural(placement.nodes.length, "node"), drives ? plural(drives, "drive") : ""].filter(Boolean).join(", ");
}

function deviceNote(device: DeviceSummary, now: Date): string | null {
  if (device.thisHost || device.connection) return null;
  return deviceStateText(device, now);
}

export function deviceLine(placement: DevicePlacement, memberCount: number, now: Date): HTMLElement {
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
    element("small", { className: "device-counts" }, countsText(placement, memberCount)),
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

export function looseDriveRow(drive: DriveSummary, device: DeviceSummary, now: Date): HTMLElement {
  const present = drive.present && isDeviceHost(device, drive.currentHost);
  return driveRow({ drive, label: drive.label, role: driveKindLabel(drive), size: drive.size, present }, device, now, "loose-drive");
}

function membersSummary(members: ArrayMember[]): string {
  const attached = members.filter((member) => member.present).length;
  const state = attached === 0 ? "none attached" : attached === members.length ? "all attached" : `${attached} attached`;
  return `${plural(members.length, "drive")}, ${state}`;
}

/** An array's member drives below its row, folded or unfolded by the person. */
export function arrayMembers(array: StorageNode, drives: DriveSummary[], device: DeviceSummary, now: Date): HTMLElement | null {
  const members = array.array?.members ?? [];
  if (members.length === 0) return null;
  const isOpen = !appState.foldedArrays.has(array.id);
  const toggle = element("button", { className: "disclosure members-toggle", attributes: { type: "button", "aria-expanded": String(isOpen) } }, membersSummary(members));
  toggle.addEventListener("click", () => {
    if (isOpen) appState.foldedArrays.add(array.id);
    else appState.foldedArrays.delete(array.id);
    requestRender();
  });
  const rows = members.map((member) =>
    driveRow({ drive: memberDrive(array, member, drives), label: member.label, role: member.role, size: member.size, present: member.present }, device, now, "member-drive"),
  );
  return element("div", { className: "array-members" }, toggle, isOpen ? element("div", { className: "member-drive-list" }, ...rows) : null);
}
