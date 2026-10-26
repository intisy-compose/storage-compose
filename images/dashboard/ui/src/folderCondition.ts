import type { FolderCopy, FolderSummary } from "./api.js";
import { formatPercent, normaliseCompletion, plural } from "./format.js";
import type { Tone } from "./nodeStatus.js";

export interface FolderCondition {
  rank: number;
  tone: Tone;
  label: string;
}

/** How one copy stands; a higher rank is worse. */
export function copyCondition(copy: FolderCopy): FolderCondition {
  const completion = normaliseCompletion(copy.completion);
  if (copy.state.includes("error")) return { rank: 6, tone: "bad", label: copy.state };
  if (copy.errors > 0) return { rank: 5, tone: "bad", label: plural(copy.errors, "failed item") };
  if (copy.state === "unknown") return { rank: 4, tone: "muted", label: "not answering" };
  if (completion < 1) return { rank: 3, tone: "accent", label: `${copy.state}, ${formatPercent(completion)}` };
  if (copy.state === "paused") return { rank: 2, tone: "muted", label: "paused" };
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

/** The layered sync's categories: synced from 80, archive from 30, local below. */
export function priorityBand(priority: number): "high" | "middle" | "low" {
  if (priority >= 80) return "high";
  if (priority >= 30) return "middle";
  return "low";
}

export const priorityUnsetText = "not set by the layered sync yet";
