import type { BandwidthLimits, ConnectionOptions, ConnectionProfile } from "./api/types.js";
import { type TomlTable, type TomlValue, formatPairs, parseToml } from "./toml.js";

export class ProfileError extends Error {}

export function defaultProfile(): ConnectionProfile {
  return {
    methods: { lan: true, tailnet: true, nat: true },
    discovery: { global: "default" },
    relays: { public: true, bridges: true, bridgePort: 22100 },
    limits: { maxSendKbps: 0, maxRecvKbps: 0, limitLan: false },
    nodeLimits: {},
  };
}

function section(root: TomlTable, name: string): TomlTable {
  const value = root[name];
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

function readBoolean(table: TomlTable, key: string, path: string, fallback: boolean): boolean {
  const value = table[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new ProfileError(`${path}.${key} must be true or false`);
  return value;
}

interface IntegerRange {
  lowest: number;
  highest: number;
}

const kbpsRange: IntegerRange = { lowest: 0, highest: Number.MAX_SAFE_INTEGER };
const portRange: IntegerRange = { lowest: 1, highest: 65535 };

function readInteger(table: TomlTable, key: string, path: string, fallback: number, range: IntegerRange): number {
  const value = table[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number") throw new ProfileError(`${path}.${key} must be a number`);
  if (!Number.isInteger(value) || value < range.lowest || value > range.highest) {
    const highest = range.highest === Number.MAX_SAFE_INTEGER ? "" : ` to ${range.highest}`;
    throw new ProfileError(`${path}.${key} must be a whole number from ${range.lowest}${highest}`);
  }
  return value;
}

function readDiscovery(table: TomlTable, fallback: string | string[]): string | string[] {
  const value: TomlValue | undefined = table.global;
  if (value === undefined) return fallback;
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value as string[];
  throw new ProfileError("discovery.global must be a string or a list of strings");
}

function readLimits(table: TomlTable, path: string, fallback: BandwidthLimits): BandwidthLimits {
  return {
    maxSendKbps: readInteger(table, "max_send_kbps", path, fallback.maxSendKbps, kbpsRange),
    maxRecvKbps: readInteger(table, "max_recv_kbps", path, fallback.maxRecvKbps, kbpsRange),
    limitLan: readBoolean(table, "limit_lan", path, fallback.limitLan),
  };
}

function readNodeLimits(table: TomlTable, path: string): Partial<BandwidthLimits> {
  const limits: Partial<BandwidthLimits> = {};
  if (table.max_send_kbps !== undefined) limits.maxSendKbps = readInteger(table, "max_send_kbps", path, 0, kbpsRange);
  if (table.max_recv_kbps !== undefined) limits.maxRecvKbps = readInteger(table, "max_recv_kbps", path, 0, kbpsRange);
  if (table.limit_lan !== undefined) limits.limitLan = readBoolean(table, "limit_lan", path, false);
  return limits;
}

export function parseProfile(text: string): ConnectionProfile {
  const defaults = defaultProfile();
  const root = parseToml(text);
  const methods = section(root, "methods");
  const relays = section(root, "relays");
  const limits = section(root, "limits");
  const nodes = section(limits, "node");
  return {
    methods: {
      lan: readBoolean(methods, "lan", "methods", defaults.methods.lan),
      tailnet: readBoolean(methods, "tailnet", "methods", defaults.methods.tailnet),
      nat: readBoolean(methods, "nat", "methods", defaults.methods.nat),
    },
    discovery: { global: readDiscovery(section(root, "discovery"), defaults.discovery.global) },
    relays: {
      public: readBoolean(relays, "public", "relays", defaults.relays.public),
      bridges: readBoolean(relays, "bridges", "relays", defaults.relays.bridges),
      bridgePort: readInteger(relays, "bridge_port", "relays", defaults.relays.bridgePort, portRange),
    },
    limits: readLimits(limits, "limits", defaults.limits),
    nodeLimits: Object.fromEntries(
      Object.keys(nodes).map((nodeId) => [nodeId, readNodeLimits(section(nodes, nodeId), `limits.node.${nodeId}`)]),
    ),
  };
}

function tableName(path: string[]): string {
  return path.map((part) => (/^[A-Za-z0-9_-]+$/.test(part) ? part : JSON.stringify(part))).join(".");
}

function limitPairs(limits: Partial<BandwidthLimits>): string[] {
  return formatPairs(
    { max_send_kbps: limits.maxSendKbps, max_recv_kbps: limits.maxRecvKbps, limit_lan: limits.limitLan } as TomlTable,
    ["max_send_kbps", "max_recv_kbps", "limit_lan"],
  );
}

export function formatProfile(profile: ConnectionProfile): string {
  const blocks = [
    ["[methods]", ...formatPairs({ ...profile.methods }, ["lan", "tailnet", "nat"])],
    ["[discovery]", ...formatPairs({ global: profile.discovery.global }, ["global"])],
    [
      "[relays]",
      ...formatPairs(
        { public: profile.relays.public, bridges: profile.relays.bridges, bridge_port: profile.relays.bridgePort },
        ["public", "bridges", "bridge_port"],
      ),
    ],
    ["[limits]", ...limitPairs(profile.limits)],
    ...Object.entries(profile.nodeLimits).map(([nodeId, limits]) => [
      `[${tableName(["limits", "node", nodeId])}]`,
      ...limitPairs(limits),
    ]),
  ];
  return `${blocks.map((block) => block.join("\n")).join("\n\n")}\n`;
}

/**
 * @implNote `relaysEnabled` is Syncthing's one switch for public and private relays alike, so either
 * profile relay setting turns it on. `methods.tailnet` maps to no option; it shapes listen addresses.
 */
export function profileOptions(profile: ConnectionProfile, nodeId: string): Omit<ConnectionOptions, "listenAddresses"> {
  const limits = nodeLimitsOf(profile, nodeId);
  const global = profile.discovery.global;
  const servers = Array.isArray(global) ? global : global === "" ? [] : [global];
  return {
    localAnnounceEnabled: profile.methods.lan,
    natEnabled: profile.methods.nat,
    globalAnnounceEnabled: servers.length > 0,
    globalAnnounceServers: servers,
    relaysEnabled: profile.relays.public || profile.relays.bridges,
    maxSendKbps: limits.maxSendKbps,
    maxRecvKbps: limits.maxRecvKbps,
    limitBandwidthInLan: limits.limitLan,
  };
}

/** The limits a node runs with: the cluster default with the node's override over it. */
export function nodeLimitsOf(profile: ConnectionProfile, nodeId: string): BandwidthLimits {
  return { ...profile.limits, ...profile.nodeLimits[nodeId] };
}

/** A copy of `profile` in which `nodeId` runs with `limits`: the override keeps only what differs from the cluster default, and none is left when nothing does. */
export function withNodeLimits(profile: ConnectionProfile, nodeId: string, limits: BandwidthLimits): ConnectionProfile {
  const override = Object.fromEntries((Object.keys(limits) as (keyof BandwidthLimits)[]).filter((key) => limits[key] !== profile.limits[key]).map((key) => [key, limits[key]]));
  const nodeLimits = Object.fromEntries(Object.entries(profile.nodeLimits).filter(([id]) => id !== nodeId));
  return { ...structuredClone(profile), nodeLimits: Object.keys(override).length ? { ...structuredClone(nodeLimits), [nodeId]: override } : structuredClone(nodeLimits) };
}
