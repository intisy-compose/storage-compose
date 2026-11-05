import type { NodePlan, PlannedFolder } from "./nodePlan.js";

/** A folder's size in the network (`/rest/db/status` `globalBytes`) and what this node holds of it (`localBytes`). */
export interface FolderSize {
  globalBytes: number;
  localBytes: number;
}

/** By folder ID. */
export type FolderSizes = Record<string, FolderSize>;

export interface NodeSpace {
  totalBytes: number;
  freeBytes: number;
}

export type SpaceState = "fits" | "raised" | "stopped";

export interface SpaceDecision {
  state: SpaceState;
  /** The threshold the node syncs at; when stopped, the top value, which did not fit either. */
  threshold: number;
  /** What the node keeps at that threshold. */
  neededBytes: number;
  /** Its free space with what it holds of the planned folders counted back in. */
  availableBytes: number;
}

/** Every node keeps this share of itself free (section 5, item 10). */
export const spaceHeadroom = 0.1;

/** @implNote Assigned folders and the node's own priority 0 entries are never dropped for space; only the threshold moves. */
function keptAt(folder: PlannedFolder, threshold: number): boolean {
  if (folder.keptBy === "assigned" || (folder.local && folder.type === "sendonly")) return true;
  return folder.keptBy !== null && folder.priority >= threshold;
}

function bytes(sizes: FolderSizes, folder: PlannedFolder, key: keyof FolderSize): number {
  return sizes[folder.id]?.[key] ?? 0;
}

function neededAt(plan: NodePlan, sizes: FolderSizes, threshold: number): number {
  return plan.folders.filter((folder) => keptAt(folder, threshold)).reduce((total, folder) => total + bytes(sizes, folder, "globalBytes"), 0);
}

/** The committed threshold, then each higher priority the node keeps, lowest first. */
function candidateThresholds(plan: NodePlan): number[] {
  const higher = plan.folders.filter((folder) => folder.keptBy !== null && folder.keptBy !== "assigned" && folder.priority > plan.threshold).map((folder) => folder.priority);
  return [plan.threshold, ...[...new Set(higher)].sort((left, right) => left - right)];
}

/**
 * The threshold at which what the node keeps fits with `spaceHeadroom` of it free (call 9).
 * @implNote What the node holds of a planned folder counts as available, so a hand-off that frees it changes nothing here and a raise never flaps back; the decision returns to the committed threshold by itself once space allows.
 */
export function effectiveThreshold(plan: NodePlan, sizes: FolderSizes, space: NodeSpace): SpaceDecision {
  const availableBytes = space.freeBytes + plan.folders.reduce((total, folder) => total + bytes(sizes, folder, "localBytes"), 0);
  const reserve = space.totalBytes * spaceHeadroom;
  const candidates = candidateThresholds(plan);
  for (const threshold of candidates) {
    const neededBytes = neededAt(plan, sizes, threshold);
    if (availableBytes - neededBytes >= reserve) return { state: threshold === plan.threshold ? "fits" : "raised", threshold, neededBytes, availableBytes };
  }
  const top = candidates[candidates.length - 1];
  return { state: "stopped", threshold: top, neededBytes: neededAt(plan, sizes, top), availableBytes };
}
