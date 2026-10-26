import { type EntryStatus, type NodeEntryState, type PriorityInfo, topDirectoryDefault } from "./types.js";

export type StatusTone = "normal" | "muted" | "warn" | "bad";

export interface StatusPresentation {
  tone: StatusTone;
  label: string;
  chip: string | null;
  italic: boolean;
  dimmed: boolean;
}

function sourceName(inheritedFrom: string): string {
  return inheritedFrom === "." ? "the top directory" : inheritedFrom;
}

/**
 * @implNote The tree never marks the top directory as overriding its parent, it has none, so its own
 * entry is compared with `topDirectoryDefault` here and only when the caller says it is the top.
 */
function topDirectoryText(info: PriorityInfo): string {
  if (info.setHere === null) return `${info.effective}, default of the top directory`;
  if (info.setHere === topDirectoryDefault) return `set here: ${info.setHere}, same as the default`;
  return `overrides the default: ${info.setHere} (default ${topDirectoryDefault})`;
}

/** How a directory's priority came about, e.g. "overrides parent: 80 (parent 0)". */
export function priorityBadgeText(info: PriorityInfo, isTopDirectory = false): string {
  if (isTopDirectory) return topDirectoryText(info);
  if (info.setHere !== null) {
    return info.overridesParent ? `overrides parent: ${info.setHere} (parent ${info.inherited})` : `set here: ${info.setHere}, same as parent`;
  }
  if (info.inheritedFrom === null) return `${info.effective}, default of the top directory`;
  return `${info.effective}, inherited from ${sourceName(info.inheritedFrom)}`;
}

const plain: Omit<StatusPresentation, "tone" | "label"> = { chip: null, italic: false, dimmed: false };

const presentations: Record<Exclude<EntryStatus, "below-threshold">, StatusPresentation> = {
  failed: { ...plain, tone: "bad", label: "failed" },
  syncing: { ...plain, tone: "warn", label: "syncing" },
  missing: { ...plain, tone: "muted", label: "not here yet" },
  ignored: { ...plain, tone: "muted", label: "ignored", chip: "ignored", italic: true },
  "local-only": { ...plain, tone: "normal", label: "only here", chip: "only here" },
  paused: { ...plain, tone: "muted", label: "paused", chip: "paused" },
  unknown: { ...plain, tone: "muted", label: "?" },
  "in-sync": { ...plain, tone: "normal", label: "in sync" },
};

/** The spec's explorer colours for one node's state of a row. */
export function statusPresentation(state: NodeEntryState): StatusPresentation {
  if (state.status === "below-threshold") return { ...plain, tone: "normal", label: "below threshold", chip: state.detail ?? "below threshold", dimmed: true };
  return presentations[state.status];
}
