import type { FolderLayered, FolderLayeredNode } from "./api/types.js";
import { type PlannedFolder, nodePlan } from "./nodePlan.js";
import { type LayoutNode, type SetupLayout, blockedNodeIds } from "./setupRepo.js";

/** The files a node's contract on this host names and waits with, per folder; null for a node whose contract this host does not write. */
export type HandoffCounts = (nodeId: string) => { entries: { folderId: string }[]; waiting: { folderId: string }[] } | null;

function whyOf(node: LayoutNode, planned: PlannedFolder | null, cluster: boolean): string {
  if (cluster) return "keeps everything: it is the cluster";
  if (!planned) return `not shared with it: below its threshold ${node.threshold}, and its plan carries nothing of it`;
  if (planned.keptBy === "assigned") return "kept both ways: assigned to it";
  if (planned.keptBy === "pin") return `kept both ways: pinned at ${planned.priority}`;
  if (planned.keptBy === "threshold") return `kept both ways: priority ${planned.priority} is at or above its threshold ${node.threshold}`;
  if (planned.local) return "sent to the cluster only: a local entry at priority 0, never handed off";
  return `sends only: priority ${planned.priority} is below its threshold ${node.threshold}, so what it holds leaves once a keeper confirms it`;
}

function plannedFolder(layout: SetupLayout, node: LayoutNode, folderId: string, relativePath: string) {
  const plan = nodePlan(layout, node.id, new Set([relativePath]));
  return { plan, folder: plan?.folders.find((entry) => entry.id === folderId || entry.id === `${node.id}-${folderId}`) ?? null };
}

function countIn(list: { folderId: string }[], folderId: string): number {
  return list.filter((entry) => entry.folderId === folderId).length;
}

/**
 * Per admitted node, whether it keeps the layout folder and why (threshold, assigned, pin), its pin, and what its contract on this host names.
 * @implNote Made from the layout as if each node held something of the folder, so a node that only sends it shows as sending; the folder's own copies say whether it does.
 */
export function folderLayered(layout: SetupLayout | null, folderId: string, counts: HandoffCounts = () => null): FolderLayered | null {
  const entry = layout?.folders.find((folder) => folder.id === folderId);
  if (!layout || !entry) return null;
  const blocked = blockedNodeIds(layout);
  const nodes: FolderLayeredNode[] = layout.nodes
    .filter((node) => node.admitted && !blocked.has(node.id))
    .map((node) => {
      const { plan, folder } = plannedFolder(layout, node, folderId, entry.relativePath);
      const contract = counts(node.id);
      return {
        nodeId: node.id,
        nodeName: node.name,
        threshold: node.threshold,
        type: folder?.type ?? null,
        keptBy: folder?.keptBy ?? null,
        pinned: node.pins[entry.relativePath] ?? null,
        why: whyOf(node, folder, plan?.cluster ?? false),
        pending: contract ? countIn(contract.entries, folderId) : null,
        waiting: contract ? countIn(contract.waiting, folderId) : null,
      };
    });
  return { path: entry.relativePath, priority: entry.priority, nodes };
}
