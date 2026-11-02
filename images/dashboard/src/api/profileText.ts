import { type ConnectionOptionKey, connectionOptionKeys } from "./types.js";

/**
 * The Syncthing options the connection profile sets on every node, each round, whatever keeper the node has.
 * @implNote The table in section 1 of `docs/specs/2026-11-02-connection-methods-design.md`; a node's bandwidth limits are its
 * override in the profile, so they are changed there too, never on the node.
 */
export const profileOwnedKeys: readonly ConnectionOptionKey[] = connectionOptionKeys;

export function isProfileOwned(key: string): boolean {
  return (profileOwnedKeys as readonly string[]).includes(key);
}

/** The read-only hint of a field the profile sets: the listen addresses are derived from it, the others set by it. */
export function profileOwnedText(key: string): string {
  return key === "listenAddresses" ? "derived from the connection profile" : "set by the connection profile";
}

/** Why a change naming these fields cannot be made on one node, or null: `Relays, Send limit: set by the connection profile, so ...`. */
export function profileProblem(fields: readonly string[], nameOf: (field: string) => string = (field) => field): string | null {
  const owned = fields.filter(isProfileOwned);
  return owned.length ? `${owned.map(nameOf).join(", ")}: set by the connection profile, so changed for the whole cluster in Settings under Connections, a node's limits as its override there` : null;
}

/** `aa01 and bb02, bb02 and cc03`, each node by `nameOf`. */
export function pairsText(pairs: readonly (readonly [string, string])[], nameOf: (nodeId: string) => string = (nodeId) => nodeId): string {
  return pairs.map(([first, second]) => `${nameOf(first)} and ${nameOf(second)}`).join(", ");
}

/** The 409 of a profile save that would leave pairs of nodes without a common connection method. */
export function strandedText(pairs: readonly (readonly [string, string])[], nameOf?: (nodeId: string) => string): string {
  return `${pairsText(pairs, nameOf)} would share no connection method; confirm to save anyway`;
}
