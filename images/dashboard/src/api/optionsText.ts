import type { ConnectionOptionKey, GeneralSettingsChange } from "./types.js";

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

/** The port `default` listens on. */
const defaultListenPort = 22000;

type HostPort = { port: string } | { problem: "malformed" | "no port" };

/**
 * An address's `host:port` split as Go's `net.SplitHostPort`, which Syncthing uses: an IPv6 host only in brackets,
 * the closing bracket followed by the port's colon, one colon otherwise.
 */
function splitHostPort(authority: string): HostPort {
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close < 0 || authority.indexOf("[", 1) >= 0 || authority.indexOf("]", close + 1) >= 0) return { problem: "malformed" };
    const rest = authority.slice(close + 1);
    if (rest === "") return { problem: "no port" };
    return rest.startsWith(":") && !rest.slice(1).includes(":") ? portPart(rest.slice(1)) : { problem: "malformed" };
  }
  if (authority.includes("[") || authority.includes("]")) return { problem: "malformed" };
  const colons = authority.split(":").length - 1;
  if (colons === 0) return { problem: "no port" };
  return colons === 1 ? portPart(authority.slice(authority.indexOf(":") + 1)) : { problem: "malformed" };
}

function portPart(port: string): HostPort {
  if (port === "") return { problem: "no port" };
  return /^\d+$/.test(port) ? { port } : { problem: "malformed" };
}

function isPortless(address: string): boolean {
  return address === "default" || /^(dynamic\+https|relay):\/\//i.test(address);
}

/** A listen address's scheme and `host:port`, null for one that is no tcp:// or quic:// address. */
function hostPortOf(address: string): HostPort | null {
  const parsed = /^([a-z0-9]+):\/\/([^/?#\s]*)$/i.exec(address);
  return parsed && portSchemes.has(parsed[1].toLowerCase()) ? splitHostPort(parsed[2]) : null;
}

/** The port of this host a listen address takes, null for one that takes none, such as a relay. */
export function listenPort(address: string): number | null {
  if (address === "default") return defaultListenPort;
  const hostPort = isPortless(address) ? null : hostPortOf(address);
  return hostPort && "port" in hostPort ? Number(hostPort.port) : null;
}

/**
 * Why Syncthing may not listen on this address, or null when it may.
 * @implNote `default` listens on 22000; a relay address listens on no port of this host.
 */
export function listenAddressProblem(address: string): string | null {
  if (isPortless(address)) return null;
  const hostPort = hostPortOf(address);
  if (!hostPort) return `${address || "an empty address"} is not a listen address: default, or a tcp://, quic://, relay:// or dynamic+https:// address`;
  if ("problem" in hostPort && hostPort.problem === "malformed") return `${address} is not host:port: write an IPv6 address in brackets, as [::]:${defaultListenPort}`;
  if ("problem" in hostPort) return `${address} names no port: give one of the storage stack's rows in access/PORTS.md, ${rowsText}`;
  const number = Number(hostPort.port);
  return syncPortRows.some((row) => number >= row.first && number <= row.last) ? null : `${address} listens on port ${number}, outside the storage stack's rows in access/PORTS.md: ${rowsText}`;
}

/** Why a discovery server cannot be used, or null when it can. */
export function discoveryServerProblem(server: string): string | null {
  return /^default(-v[46])?$/.test(server) || /^https:\/\/\S+$/.test(server) ? null : `${server || "an empty server"} is not a discovery server: default, default-v4, default-v6 or an https:// address`;
}

export const generalSettingLabels: Record<keyof GeneralSettingsChange, string> = {
  deviceName: "Device name",
  minHomeDiskFree: "Keep free on its home disk",
  usageReporting: "Usage reports",
  crashReportingEnabled: "Crash reports",
};
