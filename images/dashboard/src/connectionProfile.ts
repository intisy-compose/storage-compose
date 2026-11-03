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

function section(parent: TomlTable, name: string, path: string): TomlTable {
  const value = parent[name];
  if (value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new ProfileError(`${path} must be a table`);
  return value;
}

/** Node ids are lower case (`nodeFile.ts`), so a profile written by hand with `FB98` still means node `fb98`. */
function nodeKey(nodeId: string): string {
  return nodeId.toLowerCase();
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

function readAllNodeLimits(nodes: TomlTable): ConnectionProfile["nodeLimits"] {
  const nodeLimits: ConnectionProfile["nodeLimits"] = {};
  for (const written of Object.keys(nodes)) {
    const path = `limits.node.${written}`;
    const nodeId = nodeKey(written);
    if (Object.hasOwn(nodeLimits, nodeId)) throw new ProfileError(`${path} and another table both set node ${nodeId}`);
    nodeLimits[nodeId] = readNodeLimits(section(nodes, written, path), path);
  }
  return nodeLimits;
}

export function parseProfile(text: string): ConnectionProfile {
  const defaults = defaultProfile();
  const root = parseToml(text);
  const methods = section(root, "methods", "methods");
  const relays = section(root, "relays", "relays");
  const limits = section(root, "limits", "limits");
  const nodes = section(limits, "node", "limits.node");
  return {
    methods: {
      lan: readBoolean(methods, "lan", "methods", defaults.methods.lan),
      tailnet: readBoolean(methods, "tailnet", "methods", defaults.methods.tailnet),
      nat: readBoolean(methods, "nat", "methods", defaults.methods.nat),
    },
    discovery: { global: readDiscovery(section(root, "discovery", "discovery"), defaults.discovery.global) },
    relays: {
      public: readBoolean(relays, "public", "relays", defaults.relays.public),
      bridges: readBoolean(relays, "bridges", "relays", defaults.relays.bridges),
      bridgePort: readInteger(relays, "bridge_port", "relays", defaults.relays.bridgePort, portRange),
    },
    limits: readLimits(limits, "limits", defaults.limits),
    nodeLimits: readAllNodeLimits(nodes),
  };
}

function tableName(path: string[]): string {
  return path.map((part) => (/^[A-Za-z0-9_-]+$/.test(part) ? part : JSON.stringify(part))).join(".");
}

function limitPairs(limits: Partial<BandwidthLimits>): string[] {
  const written: [string, TomlValue | undefined][] = [
    ["max_send_kbps", limits.maxSendKbps],
    ["max_recv_kbps", limits.maxRecvKbps],
    ["limit_lan", limits.limitLan],
  ];
  const present = written.filter((pair): pair is [string, TomlValue] => pair[1] !== undefined);
  return formatPairs(Object.fromEntries(present), ["max_send_kbps", "max_recv_kbps", "limit_lan"]);
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
  return { ...profile.limits, ...profile.nodeLimits[nodeKey(nodeId)] };
}

const limitKeys: readonly (keyof BandwidthLimits)[] = ["maxSendKbps", "maxRecvKbps", "limitLan"];

/** What of `limits` differs from the cluster default, in the order `parseProfile` reads an override. */
function overrideOf(profile: ConnectionProfile, limits: BandwidthLimits): Partial<BandwidthLimits> {
  return Object.fromEntries(limitKeys.filter((key) => limits[key] !== profile.limits[key]).map((key) => [key, limits[key]]));
}

/**
 * A copy of `profile` in which `nodeId` runs with `limits`: the override keeps only what differs from the cluster default, and none is left when nothing does.
 * @implNote The node keeps its place among the overrides, so an unchanged override leaves a profile equal to the one it started from.
 */
export function withNodeLimits(profile: ConnectionProfile, nodeId: string, limits: BandwidthLimits): ConnectionProfile {
  const key = nodeKey(nodeId);
  const override = overrideOf(profile, limits);
  const nodeLimits = Object.entries(structuredClone(profile.nodeLimits)).filter(([id]) => nodeKey(id) !== key);
  const place = Object.keys(profile.nodeLimits).findIndex((id) => nodeKey(id) === key);
  if (Object.keys(override).length) nodeLimits.splice(place < 0 ? nodeLimits.length : place, 0, [key, override]);
  return { ...structuredClone(profile), nodeLimits: Object.fromEntries(nodeLimits) };
}
