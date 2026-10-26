import type { ConnectionKind, DeviceSummary, DriveSummary, StorageNode } from "./types.js";

export type ReachTone = "ok" | "muted";

interface AddressParts {
  scheme: string | null;
  host: string;
}

const connectionKindLabels: Record<ConnectionKind, string> = {
  "this-device": "this device",
  "local-network": "local network",
  tailscale: "Tailscale",
  internet: "internet",
  relay: "relay",
};

const unspecifiedHosts = new Set(["", "0.0.0.0", "::"]);

function hostOf(authority: string): string {
  if (authority.startsWith("[")) return authority.slice(1, authority.indexOf("]"));
  const colons = authority.split(":").length - 1;
  return colons === 1 ? authority.slice(0, authority.indexOf(":")) : authority;
}

function addressParts(address: string): AddressParts {
  const scheme = /^([a-z0-9+-]+):\/\//i.exec(address);
  const rest = scheme ? address.slice(scheme[0].length) : address;
  const authority = rest.split(/[/?]/, 1)[0];
  return { scheme: scheme ? scheme[1].toLowerCase() : null, host: hostOf(authority) };
}

/** The host of `tcp://host:port`, `host:port`, `[ipv6]:port`, a bare IPv4 or IPv6 address, or a relay URL. */
export function addressHost(address: string): string {
  return addressParts(address).host;
}

/** The first group of a device ID, as Syncthing's own page shortens it. */
export function shortDeviceId(deviceId: string): string {
  return deviceId.slice(0, 7);
}

/** A device's name, or its short ID while the name is empty, so a nameless device never shows blank. */
export function deviceDisplayName(name: string | null | undefined, deviceId: string): string {
  return name?.trim() ? name : shortDeviceId(deviceId);
}

export function connectionKindText(kind: ConnectionKind): string {
  return connectionKindLabels[kind];
}

const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

/** `3 Oct, 18:20` in local time, with the year when it is not `now`'s. */
export function seenTimeText(at: string, now: Date): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "at an unknown time";
  const year = date.getFullYear() === now.getFullYear() ? "" : ` ${date.getFullYear()}`;
  return `${date.getDate()} ${monthNames[date.getMonth()]}${year}, ${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
}

export function deviceStateText(device: DeviceSummary, now: Date): string {
  if (device.thisHost) return "this device";
  if (device.connection) return `connected over ${connectionKindText(device.connection.kind)}`;
  if (device.online) return "dashboard answering, no Syncthing connection";
  const seen = device.lastSeen ?? device.lastConnection?.at ?? null;
  if (!seen) return "never connected";
  const over = device.lastConnection ? ` over ${connectionKindText(device.lastConnection.kind)}` : "";
  return `last seen ${seenTimeText(seen, now)}${over}`;
}

function openStay(drive: DriveSummary): DriveSummary["attachments"][number] | undefined {
  return drive.attachments.find((stay) => stay.endedAt === null && stay.host === drive.currentHost);
}

export function driveWhereText(drive: DriveSummary, now: Date): string {
  if (drive.present && drive.currentHost) {
    const stay = openStay(drive);
    return stay ? `on ${drive.currentHost} since ${seenTimeText(stay.since, now)}` : `on ${drive.currentHost}`;
  }
  if (!drive.lastHost || !drive.lastAt) return "never seen attached";
  return `not attached; last on ${drive.lastHost} ${seenTimeText(drive.lastAt, now)}`;
}

/** For a drive listed under the device it was last on, which the row already names. */
export function driveLastSeenHereText(drive: DriveSummary, now: Date): string {
  return drive.lastAt ? `last seen here ${seenTimeText(drive.lastAt, now)}` : "never seen attached";
}

export function isReachable(node: Pick<StorageNode, "online" | "sync">): boolean {
  return node.online && node.sync.state !== "offline";
}

/** Reach only: a node's warnings are shown as their own mark, never by this tone. */
export function reachTone(node: Pick<StorageNode, "online" | "sync">): ReachTone {
  return isReachable(node) ? "ok" : "muted";
}

/** Without the addresses Syncthing listens on but no one can dial: `0.0.0.0`, `::` and a bare port. */
export function listedAddresses(addresses: string[]): string[] {
  return addresses.filter((address) => !unspecifiedHosts.has(addressParts(address).host));
}

/** @implNote A relay URL carries the relay's device ID and timing options, which say nothing to a person. */
export function addressLabel(address: string): string {
  const parts = addressParts(address);
  return parts.scheme === "relay" ? `relay ${parts.host}` : address;
}
