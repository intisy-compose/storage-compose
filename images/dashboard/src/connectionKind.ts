import { BlockList, isIP } from "node:net";
import { addressHost } from "./api/deviceText.js";
import type { ConnectionKind } from "./api/types.js";

export type { ConnectionKind } from "./api/types.js";

export interface ConnectionInput {
  deviceId: string;
  connected: boolean;
  /** Syncthing's connection type, e.g. `tcp-client` or `relay-client`. */
  type: string | null;
  /** The other end's address as `/rest/system/connections` gives it. */
  address: string | null;
  /** The Syncthing device IDs of this host's own instances. */
  localDeviceIds: ReadonlySet<string>;
}

const kindsByCloseness: readonly ConnectionKind[] = ["this-device", "local-network", "tailscale", "internet", "relay"];

function subnets(entries: [string, number, "ipv4" | "ipv6"][]): BlockList {
  const list = new BlockList();
  for (const [network, prefix, family] of entries) list.addSubnet(network, prefix, family);
  return list;
}

const tailnet = subnets([
  ["100.64.0.0", 10, "ipv4"],
  ["fd7a:115c:a1e0::", 48, "ipv6"],
]);

const localNetwork = subnets([
  ["10.0.0.0", 8, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["fe80::", 10, "ipv6"],
  ["fc00::", 7, "ipv6"],
  ["::1", 128, "ipv6"],
]);

/** The address as a plain IP, without a zone (`fe80::1%eth0`) and with an IPv4-mapped IPv6 address as IPv4. */
function plainIp(address: string): { ip: string; family: "ipv4" | "ipv6" } | null {
  const host = addressHost(address).split("%")[0];
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(host);
  const ip = mapped ? mapped[1] : host;
  const version = isIP(ip);
  if (version === 4) return { ip, family: "ipv4" };
  return version === 6 ? { ip, family: "ipv6" } : null;
}

function networkKind(address: string): ConnectionKind {
  const plain = plainIp(address);
  if (!plain) return "internet";
  if (tailnet.check(plain.ip, plain.family)) return "tailscale";
  return localNetwork.check(plain.ip, plain.family) ? "local-network" : "internet";
}

/**
 * How a peer is reached, or null while it is not connected.
 * @implNote Another instance of this host comes first: such pairs often connect over the tailnet
 * address of the host, and that is still the same machine.
 * Relay comes before the address, which for a relayed connection is the relay's own.
 */
export function connectionKind(input: ConnectionInput): ConnectionKind | null {
  if (!input.connected) return null;
  if (input.localDeviceIds.has(input.deviceId)) return "this-device";
  if (input.type?.startsWith("relay")) return "relay";
  return input.address ? networkKind(input.address) : "internet";
}

export function closestKind(kinds: ConnectionKind[]): ConnectionKind | null {
  const ranks = kinds.map((kind) => kindsByCloseness.indexOf(kind));
  return ranks.length ? kindsByCloseness[Math.min(...ranks)] : null;
}
