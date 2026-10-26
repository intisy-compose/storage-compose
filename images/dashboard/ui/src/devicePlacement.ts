import { type ArrayMember, type DeviceSummary, type DevicesResponse, type DriveSummary, type NodeKind, type NodesResponse, type StorageNode, connectionKindText } from "./api.js";
import { isOffline, isSmartWarning, needsAttention } from "./nodeStatus.js";

export type ReachFilter = "all" | "online" | "offline" | "attention";
export type KindFilter = "all" | Exclude<NodeKind, "device">;

export interface NodeFilters {
  search: string;
  reach: ReachFilter;
  kind: KindFilter;
}

/** A device with the nodes it holds; a Syncthing-only device's own entry is the device line, not a node. */
export interface DevicePlacement {
  device: DeviceSummary;
  nodes: StorageNode[];
  /** The drives not already shown under one of those nodes. */
  looseDrives: DriveSummary[];
}

export interface Placements {
  placements: DevicePlacement[];
  /** Nodes no device claims, for example while the devices are still being read. */
  unplacedNodes: StorageNode[];
}

/** One row under a device: a node (an array with the member drives the filters leave), an array's members alone, or a drive. */
export type DeviceRow =
  | { type: "node"; node: StorageNode; members: ArrayMember[] }
  | { type: "members"; array: StorageNode; members: ArrayMember[] }
  | { type: "drive"; drive: DriveSummary };

const driveKindText: Record<DriveSummary["kind"], string> = {
  "array-member": "array member",
  "drive-node": "drive node",
  "folder-node": "folder node",
};

export function driveKindLabel(drive: DriveSummary): string {
  return driveKindText[drive.kind];
}

/** A Syncthing device no dashboard or join record describes, listed as a node only so its connection shows. */
export function isDeviceOnly(node: StorageNode): boolean {
  return node.kind === "device";
}

export function storageNodes(nodes: StorageNode[]): StorageNode[] {
  return nodes.filter((node) => !isDeviceOnly(node));
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
    return { device, nodes: storageNodes(own), looseDrives: drives.filter((drive) => !isShownUnderNode(drive, nodeIds)) };
  });
  return { placements, unplacedNodes: nodes.filter((node) => !placed.has(node.id)) };
}

export function matchesTerms(parts: (string | null | undefined)[], search: string): boolean {
  if (!search) return true;
  const haystack = parts.filter(Boolean).join(" ").toLowerCase();
  return search.toLowerCase().split(/\s+/).every((term) => haystack.includes(term));
}

export function matchesNodeSearch(node: StorageNode, search: string): boolean {
  return matchesTerms([node.name, node.host, node.kind, ...node.folders.map((folder) => folder.id)], search);
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

function matchesMemberSearch(array: StorageNode, member: ArrayMember, drives: DriveSummary[], search: string): boolean {
  const drive = memberDrive(array, member, drives);
  return drive ? matchesDriveSearch(drive, search) : matchesTerms([member.label, member.role, member.serial], search);
}

function passesReach(filter: ReachFilter, online: boolean, attention: boolean): boolean {
  if (filter === "online") return online;
  if (filter === "offline") return !online;
  if (filter === "attention") return attention;
  return true;
}

export function passesNodeFilters(response: NodesResponse, node: StorageNode, filters: NodeFilters): boolean {
  const kind = filters.kind === "all" || node.kind === filters.kind;
  return kind && passesReach(filters.reach, !isOffline(node), needsAttention(response, node));
}

/** @implNote A detached array's members are expected to be missing, so they need attention only while the array is attached. */
function memberNeedsAttention(array: StorageNode, member: ArrayMember): boolean {
  return array.array?.state !== "absent" && (!member.present || isSmartWarning(member));
}

function passesMemberFilters(array: StorageNode, member: ArrayMember, filters: NodeFilters): boolean {
  if (filters.kind === "folder") return false;
  return passesReach(filters.reach, member.present, memberNeedsAttention(array, member));
}

function passesDriveFilters(drive: DriveSummary, filters: NodeFilters): boolean {
  if (filters.kind !== "all" && filters.kind !== "drive") return false;
  return passesReach(filters.reach, drive.present, false);
}

function passesDeviceFilters(device: DeviceSummary, filters: NodeFilters): boolean {
  return filters.kind === "all" && passesReach(filters.reach, device.online, false);
}

/** Online nodes first, then by name, so a long list leads with what can be acted on. */
export function byReachThenName(left: StorageNode, right: StorageNode): number {
  const reach = Number(isOffline(left)) - Number(isOffline(right));
  return reach !== 0 ? reach : left.name.localeCompare(right.name, undefined, { numeric: true });
}

function nodeRows(response: NodesResponse, node: StorageNode, drives: DriveSummary[], filters: NodeFilters, isDeviceMatch: boolean): DeviceRow[] {
  const isNodeMatch = isDeviceMatch || matchesNodeSearch(node, filters.search);
  const allMembers = node.array?.members ?? [];
  const searched = allMembers.filter((member) => isNodeMatch || matchesMemberSearch(node, member, drives, filters.search));
  const members = searched.filter((member) => passesMemberFilters(node, member, filters));
  const isShown = passesNodeFilters(response, node, filters) && (isNodeMatch || searched.length > 0);
  if (isShown) return [{ type: "node", node, members }];
  return members.length ? [{ type: "members", array: node, members }] : [];
}

/**
 * The rows the search and filters leave under a device. A device that matches the search keeps every
 * row that passes the filters; a member drive that passes is listed even when its array does not.
 */
export function deviceRows(response: NodesResponse, drives: DriveSummary[], placement: DevicePlacement, filters: NodeFilters): DeviceRow[] {
  const isDeviceMatch = matchesDeviceSearch(placement.device, filters.search);
  const sorted = [...placement.nodes].sort(byReachThenName);
  const loose = placement.looseDrives.filter((drive) => passesDriveFilters(drive, filters) && (isDeviceMatch || matchesDriveSearch(drive, filters.search)));
  return [...sorted.flatMap((node) => nodeRows(response, node, drives, filters, isDeviceMatch)), ...loose.map((drive) => ({ type: "drive" as const, drive }))];
}

export function isDeviceShown(placement: DevicePlacement, rows: DeviceRow[], filters: NodeFilters): boolean {
  return rows.length > 0 || (passesDeviceFilters(placement.device, filters) && matchesDeviceSearch(placement.device, filters.search));
}

export function visibleUnplacedNodes(response: NodesResponse, nodes: StorageNode[], filters: NodeFilters): StorageNode[] {
  return nodes.filter((node) => matchesNodeSearch(node, filters.search) && passesNodeFilters(response, node, filters));
}

/** Every drive the device holds or last held, which the device line, the header and the device detail all count. */
export function deviceDriveCount(placement: DevicePlacement): number {
  return placement.device.driveKeys.length;
}
