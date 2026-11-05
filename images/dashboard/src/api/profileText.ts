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

/** Why local discovery and NAT are off on a node whatever the profile says. */
export const untrustedNetworksText = "off: no trusted network on this host (mark the network Private in Windows to trust it)";

/** The read-only hint of a field the profile sets: the listen addresses are derived from it, the others set by it. */
export function profileOwnedText(key: string): string {
  return key === "listenAddresses" ? "derived from the connection profile" : "set by the connection profile";
}

/** Why a change naming these fields cannot be made on one node, or null: `Relays, Send limit: set by the connection profile, so ...`. */
export function profileProblem(fields: readonly string[], nameOf: (field: string) => string = (field) => field): string | null {
  const owned = fields.filter(isProfileOwned);
  return owned.length ? `${owned.map(nameOf).join(", ")}: set by the connection profile, so changed for the whole cluster in Settings under Connections, a node's limits as its override there` : null;
}

/** Why a device's addresses are not changed by hand on a node, `label` naming the field as the form or the editor does. */
export function profileAddressesProblem(label: string): string {
  return `${label}: set by the connection profile, which gives every node a cluster node's addresses each round, so not changed here`;
}

/** The read-only hint of a cluster node's addresses in the device form. */
export const profileAddressesHint = "Read only: set by the connection profile, which gives every node this cluster node's addresses each round.";

/** Why the profile on disk is not the one applied: a `connections.toml` that does not parse, with or without a good one read before it. */
export function profileFileProblemText(reason: string, isPreviousApplied: boolean): string {
  return isPreviousApplied ? `connections.toml rejected: ${reason}; the previous profile is still applied` : `connections.toml cannot be read: ${reason}; nothing applied`;
}

/** The 409 of a profile save made from a profile that is no longer the one on disk. */
export const profileChangedText = "the profile changed since you read it; it has been reloaded";

/** The 409 of a profile save whose push the remote refused because another host pushed first. */
export const profileConflictText = "another host saved the connection profile first; reload it and save again";

/** The 503 of a save whose push failed after another commit landed on top of its commit, so the commit could not be undone. */
export function profileStuckText(commit: string): string {
  return `this host committed the save as ${commit} but could not push it, and another commit landed on top of it in the data repo, so it was not undone; push or drop ${commit} there by hand`;
}

/** The pull problem, save refusal and admission message while a rebase is in progress in the data repo, `path` being its directory. */
export function rebaseInProgressText(path: string): string {
  return `a rebase is in progress in the data repo (${path}), so the dashboard changes nothing there; finish it, or run git rebase --abort in the data repo by hand`;
}

/** The pull problem of an unpushed commit the dashboard may not rebase or push, `reason` saying why. */
export function heldCommitText(commit: string, subject: string, reason: string): string {
  return `this clone holds the unpushed ${commit} (${subject}), which ${reason}, so the dashboard leaves it alone; rebase or push it in the data repo by hand`;
}

/** The pull problem of the dashboard's own unpushed commits whose rebase onto the remote conflicted and was undone. */
export function rebaseConflictText(commits: readonly string[]): string {
  return `the dashboard's unpushed ${commits.join(", ")} conflicts with the remote's changes, so the rebase onto them was undone; rebase it in the data repo by hand`;
}

/** The pull problem of the dashboard's own unpushed commits that git would not rebase, `reason` being git's last line. */
export function rebaseRefusedText(commits: readonly string[], reason: string): string {
  return `the dashboard's unpushed ${commits.join(", ")} could not be rebased onto the remote: ${reason}`;
}

/** The pull problem of the dashboard's own commits whose push failed; every round tries again. */
export function unpushedText(commits: readonly string[], reason: string): string {
  return `pulled, but the dashboard's ${commits.join(", ")} is not pushed yet: ${reason}`;
}

/** Whether a refused save was made from a profile that is no longer the one on disk, here or on another host. */
export function isProfileChangedRefusal(message: string): boolean {
  return message === profileChangedText || message === profileConflictText;
}

/** `aa01 and bb02, bb02 and cc03`, each node by `nameOf`. */
export function pairsText(pairs: readonly (readonly [string, string])[], nameOf: (nodeId: string) => string = (nodeId) => nodeId): string {
  return pairs.map(([first, second]) => `${nameOf(first)} and ${nameOf(second)}`).join(", ");
}

const strandedEnding = "would share no connection method; confirm to save anyway";

/** The 409 of a profile save that would leave pairs of nodes without a common connection method. */
export function strandedText(pairs: readonly (readonly [string, string])[], nameOf?: (nodeId: string) => string): string {
  return `${pairsText(pairs, nameOf)} ${strandedEnding}`;
}

/** Whether a refused save is the one `strandedText` words, whichever pairs it names. */
export function isStrandedRefusal(message: string): boolean {
  return message.endsWith(` ${strandedEnding}`);
}

/** The 409 of a layout save made from a layout that is no longer the one on disk. */
export const layoutChangedText = "the layout changed since this page read it; it has been read again, check the change and save again";

/** The 409 of a layout save whose push the remote refused because another host pushed first; nothing of the save remains. */
export const layoutConflictText = "another host pushed a change to the setup repo first; nothing was saved, read the layout again and save again";
