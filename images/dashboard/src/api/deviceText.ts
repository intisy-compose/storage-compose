import type { ConnectionKind, StorageNode } from "./types.js";

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

export function connectionKindLabel(kind: ConnectionKind): string {
  return connectionKindLabels[kind];
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
