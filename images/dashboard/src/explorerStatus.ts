import type { EntryStatus } from "./api/types.js";

/** What is known about one explorer row on one node; counts below include the row itself. */
export interface StatusInput {
  answering: boolean;
  hasFolder: boolean;
  offered: boolean;
  folderPaused: boolean;
  folderState: string;
  /** The node's own index entry, null where it has none. */
  local: { deleted: boolean; ignored: boolean } | null;
  outstandingBelow: number | "too-many";
  failedBelow: number | "too-many";
  locallyChanged: boolean;
  sharedWithOthers: boolean;
  effectivePriority: number;
  threshold: number;
}

export interface StatusResult {
  status: EntryStatus;
  detail: string | null;
}

function itemCount(count: number, what: string): string {
  return `${count} ${count === 1 ? "item" : "items"} ${what} below`;
}

function hasAny(count: number | "too-many"): boolean {
  return count === "too-many" || count > 0;
}

function isMissingLocally(input: StatusInput): boolean {
  return input.local === null || input.local.deleted;
}

/**
 * The spec's status table, first match wins.
 * @implNote "unknown" is checked first although the table lists it late: without an answer every
 * other input is a placeholder, and a placeholder must not read as "not here yet".
 */
export function entryStatus(input: StatusInput): StatusResult {
  if (!input.answering) return { status: "unknown", detail: "the node's Syncthing is not answering" };
  if (hasAny(input.failedBelow)) {
    return { status: "failed", detail: input.failedBelow === "too-many" ? "too many failed items to place" : itemCount(input.failedBelow, "failed") };
  }
  if (input.hasFolder && !input.folderPaused) {
    if (hasAny(input.outstandingBelow)) {
      return { status: "syncing", detail: input.outstandingBelow === "too-many" ? "too many outstanding items to place" : itemCount(input.outstandingBelow, "outstanding") };
    }
    if (isMissingLocally(input) && input.folderState === "syncing") return { status: "syncing", detail: "being fetched" };
  }
  if (!input.hasFolder) return { status: "missing", detail: input.offered ? "offered, not accepted" : "not shared with this node" };
  if (isMissingLocally(input)) return { status: "missing", detail: "not on this node yet" };
  if (input.local?.ignored) return { status: "ignored", detail: "ignored by .stignore" };
  if (input.locallyChanged) return { status: "local-only", detail: "changed here in a receive-only folder" };
  if (!input.sharedWithOthers) return { status: "local-only", detail: "shared with no other device" };
  if (input.effectivePriority < input.threshold) return { status: "below-threshold", detail: `below threshold ${input.threshold}` };
  if (input.folderPaused) return { status: "paused", detail: null };
  return { status: "in-sync", detail: null };
}
