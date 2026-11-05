import { folderTypeTexts } from "./api/types.js";
import { type NodePlan, type PlannedFolder, nodePlan } from "./nodePlan.js";
import { carriedLayoutPaths } from "./reconcileNode.js";
import type { SetupLayout } from "./setupRepo.js";

/** What a layout edit changes in one node's plan, in words. */
export interface NodePlanChange {
  nodeId: string;
  nodeName: string;
  changes: string[];
}

/** The folder IDs each node's Syncthing has, as far as this host knows them; a node it does not know carries only what its plan keeps. */
export type ConfiguredFolders = (nodeId: string) => ReadonlySet<string>;

function planOf(layout: SetupLayout, nodeId: string, configured: ConfiguredFolders): NodePlan | null {
  return nodePlan(layout, nodeId, carriedLayoutPaths(layout, nodeId, configured(nodeId)));
}

function labelOf(folder: PlannedFolder): string {
  return `${folder.label} (${folder.id})`;
}

function folderChanges(before: PlannedFolder, after: PlannedFolder): string[] {
  const changes: string[] = [];
  if (before.type !== after.type) changes.push(`${labelOf(after)} turns ${folderTypeTexts[after.type]}${after.handsOff ? ", so what it holds there is handed off once a keeper confirms it" : ""}`);
  const added = after.ignores.filter((line) => !before.ignores.includes(line));
  const dropped = before.ignores.filter((line) => !after.ignores.includes(line));
  if (added.length) changes.push(`${labelOf(after)} ignores ${added.join(" ")}`);
  if (dropped.length) changes.push(`${labelOf(after)} no longer ignores ${dropped.join(" ")}`);
  if (before.devices.length !== after.devices.length || before.devices.some((device) => !after.devices.includes(device))) changes.push(`${labelOf(after)} is shared with other devices`);
  return changes;
}

function planDiff(before: NodePlan | null, after: NodePlan | null): string[] {
  const beforeFolders = new Map((before?.folders ?? []).map((folder) => [folder.id, folder]));
  const afterFolders = new Map((after?.folders ?? []).map((folder) => [folder.id, folder]));
  const changes: string[] = [];
  for (const [id, folder] of afterFolders) {
    const old = beforeFolders.get(id);
    if (!old) changes.push(`gains the folder ${labelOf(folder)} at ${folder.path}, ${folderTypeTexts[folder.type]}`);
    else changes.push(...folderChanges(old, folder));
  }
  for (const [id, folder] of beforeFolders) {
    if (!afterFolders.has(id)) changes.push(`no longer plans ${labelOf(folder)}; a round never removes it, so it stays until removed by hand`);
  }
  return changes;
}

/**
 * Each node whose plan the edit changes, with what changes: one plan made from the layout before and one from after, as the reconciler would diff them.
 * @implNote Plan against plan rather than a live read of every node's Syncthing, so a node of another host is previewed from the layout too.
 */
export function planChanges(before: SetupLayout, after: SetupLayout, configured: ConfiguredFolders): NodePlanChange[] {
  const ids = [...new Set([...before.nodes, ...after.nodes].map((node) => node.id))];
  return ids.flatMap((nodeId) => {
    const changes = planDiff(planOf(before, nodeId, configured), planOf(after, nodeId, configured));
    const name = (after.nodes.find((node) => node.id === nodeId) ?? before.nodes.find((node) => node.id === nodeId))?.name || nodeId;
    return changes.length ? [{ nodeId, nodeName: name, changes }] : [];
  });
}
