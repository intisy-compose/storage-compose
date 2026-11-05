import { type FolderCopy, type FolderSummary, type NodeFolder, type PriorityBand, type StorageNode, defaultPriorityBands } from "./api.js";
import { formatPercent, normaliseCompletion, plural } from "./format.js";
import type { Tone } from "./nodeStatus.js";
import type { FolderActionState } from "./state.js";

export interface FolderCondition {
  rank: number;
  tone: Tone;
  label: string;
}

function isHandoffQuiet(copy: FolderCopy): boolean {
  return copy.handoff === true && copy.state === "idle" && (copy.needTotalItems ?? copy.needItems ?? 0) <= (copy.handoffEntries ?? 0);
}

/**
 * How one copy stands; a higher rank is worse.
 * @implNote An idle hand-off folder needing no more items than its hand-off list holds reads as fine: an ignore line whose file left the node
 * can leave it short for good (section 4b), which is no fault. Any more is shown as out of sync.
 */
export function copyCondition(copy: FolderCopy): FolderCondition {
  const completion = normaliseCompletion(copy.completion);
  if (copy.state.includes("error")) return { rank: 7, tone: "bad", label: copy.state };
  if (copy.errors > 0) return { rank: 6, tone: "bad", label: plural(copy.errors, "failed item") };
  if (copy.state === "unknown") return { rank: 5, tone: "muted", label: "not answering" };
  if (copy.state === "paused") return { rank: 4, tone: "warn", label: "paused" };
  if (isHandoffQuiet(copy)) return { rank: 0, tone: "ok", label: "sends only, hands off" };
  if (completion < 1) return { rank: 3, tone: "accent", label: `${copy.state}, ${formatPercent(completion)}` };
  if (copy.state !== "idle") return { rank: 1, tone: "accent", label: copy.state };
  return { rank: 0, tone: "ok", label: "up to date" };
}

export function worstCondition(summary: FolderSummary): FolderCondition {
  if (!summary.copies.length) return { rank: 0, tone: "muted", label: "not accepted anywhere" };
  return summary.copies.map(copyCondition).reduce((worst, next) => (next.rank > worst.rank ? next : worst));
}

export function placementText(summary: FolderSummary): string {
  const kept = summary.copies.length ? `kept on ${plural(summary.copies.length, "node")}` : "kept on no node";
  const offeredTo = [...new Set(summary.offers.map((offer) => offer.nodeName))];
  return offeredTo.length ? `${kept}, offered to ${offeredTo.join(", ")}` : kept;
}

/** The band a priority falls in, the highest that starts at or below it, from the layout's bands or the design's while none is read; `rank` 0 is the highest band. */
export function bandOf(priority: number, bands: readonly PriorityBand[] = defaultPriorityBands): { name: string; rank: number } {
  const ordered = [...(bands.length ? bands : defaultPriorityBands)].sort((left, right) => right.from - left.from);
  const rank = ordered.findIndex((band) => priority >= band.from);
  return rank < 0 ? { name: ordered[ordered.length - 1].name, rank: ordered.length - 1 } : { name: ordered[rank].name, rank };
}

/** The colour class of a band: the top three ranks have their own, every lower one the last's. */
export function bandClass(priority: number, bands?: readonly PriorityBand[]): string {
  return `band-rank-${Math.min(bandOf(priority, bands).rank, 3)}`;
}

export const priorityUnsetText = "not set by the layered sync yet";

/** A folder's state on the Nodes page; a paused one reads as paused, never as 0 % of anything. */
export function nodeFolderState(folder: Pick<NodeFolder, "state" | "completion">): { text: string; tone: Tone } {
  const completion = normaliseCompletion(folder.completion);
  const state = folder.state;
  if (state === "paused") return { text: "paused", tone: "warn" };
  if (state.includes("error") || state.includes("fail")) return { text: completion < 1 ? `${state}, ${formatPercent(completion)}` : state, tone: "bad" };
  if (state === "unknown") return { text: completion < 1 ? `${state}, ${formatPercent(completion)}` : state, tone: "muted" };
  if (completion < 1) return { text: `${state}, ${formatPercent(completion)}`, tone: "accent" };
  if (state === "idle") return { text: "up to date", tone: "ok" };
  return { text: state, tone: "accent" };
}

/** The question before a node rescans every folder: how many it scans, the paused ones left out as Syncthing does, and their items. */
export function rescanAllQuestion(node: Pick<StorageNode, "name" | "folders">): string {
  const scanned = node.folders.filter((folder) => folder.state !== "paused");
  const items = scanned.reduce((total, folder) => total + folder.globalFiles + folder.globalDirectories, 0);
  return `Rescan all ${plural(scanned.length, "folder")} of ${node.name}, ${plural(items, "item")}?`;
}

/**
 * Whether the action's node no longer has the folder and nothing of the action is still in use.
 * @implNote A node can miss one read of its settings while it is slow, so an action still running, an open removal or a typed subfolder waits for the next read.
 */
export function isOrphanedAction(state: FolderActionState, nodeIdsWithSettings: string[]): boolean {
  if (nodeIdsWithSettings.includes(state.nodeId)) return false;
  return !state.busy && !state.removeOpen && !state.discardOpen && state.sub === "";
}
