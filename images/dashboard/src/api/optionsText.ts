import type { ConnectionOptionKey } from "./types.js";

/** The query of an options edit that is applied to every node of this host. */
export const applyToHostQuery = "applyTo=host";

export const applyToHostLabel = "Apply to every node on this host";

export const perNodeListenText = "listen addresses are each node's own, as each node listens on its own port from access/PORTS.md: untick apply to every node on this host to change them";

export const connectionOptionLabels: Record<ConnectionOptionKey, string> = {
  listenAddresses: "Listen addresses",
  maxRecvKbps: "Receive limit",
  maxSendKbps: "Send limit",
  limitBandwidthInLan: "Limits in LAN",
  natEnabled: "NAT traversal",
  localAnnounceEnabled: "Local discovery",
  globalAnnounceEnabled: "Global discovery",
  globalAnnounceServers: "Global discovery servers",
  relaysEnabled: "Relays",
};

interface PortRow {
  serves: string;
  first: number;
  last: number;
}

/**
 * The storage stack's Syncthing sync rows of `access/PORTS.md` in `intisy-compose/workflows`: the only ports a node may listen on.
 * @implNote A copy, as the dashboard image cannot read that repo; a change to those rows is made here too.
 */
const syncPortRows: readonly PortRow[] = [
  { serves: "Syncthing sync", first: 22000, last: 22000 },
  { serves: "Syncthing sync of each further node on a host, reserved", first: 22001, last: 22099 },
];

function rowRange(row: PortRow): string {
  return row.first === row.last ? String(row.first) : `${row.first}-${row.last}`;
}

const rowsText = syncPortRows.map((row) => `${row.serves} (${rowRange(row)})`).join(", ");

const portSchemes = new Set(["tcp", "tcp4", "tcp6", "quic", "quic4", "quic6"]);

/** The port of an address's `host:port` or `[ipv6]:port`, null when it names none. */
function portOf(authority: string): string | null {
  const port = /:(\d*)$/.exec(authority.startsWith("[") ? authority.slice(authority.indexOf("]") + 1) : authority);
  return port && port[1] !== "" ? port[1] : null;
}

/**
 * Why Syncthing may not listen on this address, or null when it may.
 * @implNote `default` listens on 22000; a relay address listens on no port of this host.
 */
export function listenAddressProblem(address: string): string | null {
  if (address === "default" || address.startsWith("dynamic+https://") || /^relay:\/\//i.test(address)) return null;
  const parsed = /^([a-z0-9]+):\/\/([^/?#\s]*)$/i.exec(address);
  if (!parsed || !portSchemes.has(parsed[1].toLowerCase())) return `${address || "an empty address"} is not a listen address: default, or a tcp://, quic://, relay:// or dynamic+https:// address`;
  const port = portOf(parsed[2]);
  if (port === null) return `${address} names no port: give one of the storage stack's rows in access/PORTS.md, ${rowsText}`;
  const number = Number(port);
  return syncPortRows.some((row) => number >= row.first && number <= row.last) ? null : `${address} listens on port ${number}, outside the storage stack's rows in access/PORTS.md: ${rowsText}`;
}

/** Why a discovery server cannot be used, or null when it can. */
export function discoveryServerProblem(server: string): string | null {
  return /^default(-v[46])?$/.test(server) || /^https:\/\/\S+$/.test(server) ? null : `${server || "an empty server"} is not a discovery server: default, default-v4, default-v6 or an https:// address`;
}
