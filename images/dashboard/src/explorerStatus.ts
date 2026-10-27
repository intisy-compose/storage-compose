import type { EntryStatus } from "./api/types.js";

/** Items below a row: counted, too many to place, still being read, or in lists that could not be read. */
export type Count = number | "too-many" | "reading" | "unreadable";

/** What is known about one explorer row on one node; counts below include the row itself. */
export interface StatusInput {
  answering: boolean;
  hasFolder: boolean;
  offered: boolean;
  folderPaused: boolean;
  folderState: string;
  /** The node's own index entry, null where it has none. */
  local: { deleted: boolean; ignored: boolean } | null;
  outstandingBelow: Count;
  failedBelow: Count;
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

type Unplaced = "reading" | "unreadable";

function isUnplaced(count: Count): count is Unplaced {
  return count === "reading" || count === "unreadable";
}

function unplacedResult(count: Unplaced): StatusResult {
  return { status: "unknown", detail: count === "reading" ? "still being read" : "where its folder's items are could not be read" };
}

function isMissingLocally(input: StatusInput): boolean {
  return input.local === null || input.local.deleted;
}

/**
 * The spec's status table, first match wins.
 * @implNote "unknown" is checked first although the table lists it late: without an answer every
 * other input is a placeholder, and a placeholder must not read as "not here yet". "paused" is checked
 * right after the folder is known to be there, before the rows the table lists above it: a paused folder
 * neither scans nor syncs, so "only here" or "not here yet" would hide why nothing changes.
 */
export function entryStatus(input: StatusInput): StatusResult {
  if (!input.answering) return { status: "unknown", detail: "the node's Syncthing is not answering" };
  if (isUnplaced(input.failedBelow)) return unplacedResult(input.failedBelow);
  if (hasAny(input.failedBelow)) {
    return { status: "failed", detail: input.failedBelow === "too-many" ? "too many failed items to place" : itemCount(input.failedBelow, "failed") };
  }
  if (input.hasFolder && !input.folderPaused) {
    if (isUnplaced(input.outstandingBelow)) return unplacedResult(input.outstandingBelow);
    if (hasAny(input.outstandingBelow)) {
      return { status: "syncing", detail: input.outstandingBelow === "too-many" ? "too many outstanding items to place" : itemCount(input.outstandingBelow, "outstanding") };
    }
    if (isMissingLocally(input) && input.folderState === "syncing") return { status: "syncing", detail: "being fetched" };
  }
  if (!input.hasFolder) return { status: "missing", detail: input.offered ? "offered, not accepted" : "not shared with this node" };
  if (input.folderPaused) return { status: "paused", detail: "Syncthing neither scans nor syncs it until it is resumed" };
  if (isMissingLocally(input)) return { status: "missing", detail: "not on this node yet" };
  if (input.local?.ignored) return { status: "ignored", detail: "ignored by .stignore" };
  if (input.locallyChanged) return { status: "local-only", detail: "changed here in a receive-only folder" };
  if (!input.sharedWithOthers) return { status: "local-only", detail: "shared with no other device" };
  if (input.effectivePriority < input.threshold) return { status: "below-threshold", detail: `below threshold ${input.threshold}` };
  return { status: "in-sync", detail: null };
}
