import type { NodePlan, PlannedFolder } from "./nodePlan.js";

/** A folder's size in the network (`/rest/db/status` `globalBytes`), what this node holds of it (`localBytes`) and what it lacks of it (`needBytes`). */
export interface FolderSize {
  globalBytes: number;
  localBytes: number;
  needBytes?: number;
}

/** By folder ID. */
export type FolderSizes = Record<string, FolderSize>;

/**
 * By folder ID, the bytes of what the node holds there that may leave it: what a keeper already holds in full, each file still to be
 * confirmed before it goes. Counted as freed only for a folder the threshold tried does not keep.
 */
export type ReleasableBytes = Record<string, number>;

export interface NodeSpace {
  totalBytes: number;
  freeBytes: number;
}

/**
 * `unknown`: a folder the node keeps has no size yet, so nothing can be said to fit. `full`: the cluster, which keeps every folder and so
 * cannot raise, does not fit with its headroom.
 */
export type SpaceState = "fits" | "raised" | "stopped" | "full" | "unknown";

export interface SpaceDecision {
  state: SpaceState;
  /** The threshold to plan with; the committed one when stopped, full or unknown. */
  threshold: number;
  /** What the node keeps at the threshold tried last. */
  neededBytes: number;
  /** Its free space with what it holds of kept folders and its confirmed hand-offs counted in, at that threshold. */
  availableBytes: number;
  /** False when stopped, full or unknown: nothing may leave a node whose space decision is not sound. */
  handoffAllowed: boolean;
  /** Whether what the node keeps fits with its headroom on what is on it now, nothing counted that has yet to leave: only then may a folder start to pull. */
  pullAllowed: boolean;
}

/** Every node keeps this share of itself free (section 5, item 10). */
export const spaceHeadroom = 0.1;

/**
 * @implNote Assigned folders and priority 0 entries (the node's own, or other nodes' on the cluster) are never dropped for space; only the
 * threshold moves. The cluster keeps every folder whatever its threshold (phase 2), so all of them count.
 */
function keptAt(plan: NodePlan, folder: PlannedFolder, threshold: number): boolean {
  if (plan.cluster || folder.keptBy === "assigned" || folder.local) return true;
  return folder.keptBy !== null && folder.priority >= threshold;
}

interface Tried {
  threshold: number;
  neededBytes: number;
  availableBytes: number;
  /** The part of `availableBytes` that is still on the node, waiting for its hand-off. */
  releasedBytes: number;
}

/**
 * @implNote What the node holds of a kept folder is already on it; a folder it hands off frees only what a keeper already holds, since
 * anything else may never leave, and never more than the node holds there.
 */
function tryThreshold(plan: NodePlan, sizes: FolderSizes, space: NodeSpace, releasable: ReleasableBytes, threshold: number): Tried {
  let neededBytes = 0;
  let availableBytes = space.freeBytes;
  let releasedBytes = 0;
  for (const folder of plan.folders) {
    if (keptAt(plan, folder, threshold)) {
      neededBytes += sizes[folder.id]?.globalBytes ?? 0;
      availableBytes += sizes[folder.id]?.localBytes ?? 0;
    } else {
      const released = Math.max(0, Math.min(releasable[folder.id] ?? 0, sizes[folder.id]?.localBytes ?? Number.POSITIVE_INFINITY));
      availableBytes += released;
      releasedBytes += released;
    }
  }
  return { threshold, neededBytes, availableBytes, releasedBytes };
}

/** The committed threshold, then each higher priority the node keeps, lowest first; only the committed one for the cluster, which no raise relieves. */
function candidateThresholds(plan: NodePlan): number[] {
  if (plan.cluster) return [plan.threshold];
  const higher = plan.folders.filter((folder) => folder.keptBy !== null && folder.keptBy !== "assigned" && !folder.local && folder.priority > plan.threshold).map((folder) => folder.priority);
  return [plan.threshold, ...[...new Set(higher)].sort((left, right) => left - right)];
}

/**
 * The threshold at which what the node keeps fits with `spaceHeadroom` of it free (call 9), from its plan at the committed threshold.
 * The decision returns to the committed threshold by itself once space allows.
 */
export function effectiveThreshold(plan: NodePlan, sizes: FolderSizes, space: NodeSpace, releasable: ReleasableBytes = {}): SpaceDecision {
  if (plan.appliedThreshold !== plan.threshold) throw new Error(`the plan of ${plan.nodeId} was made at threshold ${plan.appliedThreshold}, not at its committed ${plan.threshold}`);
  const reserve = space.totalBytes * spaceHeadroom;
  const decision = (state: SpaceState, tried: Tried, sound: boolean): SpaceDecision => ({
    state,
    threshold: sound ? tried.threshold : plan.threshold,
    neededBytes: tried.neededBytes,
    availableBytes: tried.availableBytes,
    handoffAllowed: sound,
    pullAllowed: sound && tried.availableBytes - tried.releasedBytes - tried.neededBytes >= reserve,
  });
  const committed = tryThreshold(plan, sizes, space, releasable, plan.threshold);
  if (plan.folders.some((folder) => keptAt(plan, folder, plan.threshold) && sizes[folder.id] === undefined)) return decision("unknown", committed, false);
  let tried = committed;
  for (const threshold of candidateThresholds(plan)) {
    tried = tryThreshold(plan, sizes, space, releasable, threshold);
    if (tried.availableBytes - tried.neededBytes >= reserve) return decision(threshold === plan.threshold ? "fits" : "raised", tried, true);
  }
  return decision(plan.cluster ? "full" : "stopped", tried, false);
}

/**
 * Whether a folder of the plan may turn send-receive and pull (phase 2's held type-up, released here): only while the decision fits or is
 * raised at the threshold the plan was made at, counting every folder the plan keeps, with the node's headroom on what is on it now.
 */
export function spaceAllowsPull(decision: SpaceDecision | null, plan: NodePlan): boolean {
  return decision !== null && (decision.state === "fits" || decision.state === "raised") && decision.pullAllowed && decision.threshold === plan.appliedThreshold;
}
