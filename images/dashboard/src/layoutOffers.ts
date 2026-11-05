import { nodePlan } from "./nodePlan.js";
import { type SetupLayout, topDirectoryPath } from "./setupRepo.js";

/**
 * Whether a folder offer to the node is only the keepers sharing a layout folder with a sender (phase 1 ruling), so no request:
 * the node is admitted and planned, and its plan does not take the folder.
 * @implNote The plan is made as if the node held nothing, which leaves out exactly the folders it would only send; a folder its plan keeps
 * stays a request, since the node should take it.
 */
export function isOfferHeldByLayout(layout: SetupLayout | null, nodeId: string, folderId: string): boolean {
  if (!layout) return false;
  const node = layout.nodes.find((entry) => entry.id === nodeId);
  if (!node?.admitted) return false;
  if (!layout.folders.some((folder) => folder.id === folderId && folder.relativePath !== topDirectoryPath)) return false;
  const plan = nodePlan(layout, nodeId, new Set());
  return plan !== null && plan.problems.length === 0 && !plan.folders.some((folder) => folder.id === folderId);
}
