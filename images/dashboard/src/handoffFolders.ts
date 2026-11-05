import type { FolderCopy } from "./api/types.js";
import { type LocalInstance, callSyncthing } from "./instanceResolver.js";
import type { SyncthingClient } from "./syncthing.js";
import { handoffIgnoreFile, nodePlan } from "./nodePlan.js";
import { carriedLayoutPaths } from "./reconcileNode.js";
import type { SetupLayout } from "./setupRepo.js";

/** The IDs of the node's hand-off folders as its plan has them: send-only, and what it holds there leaves once a keeper confirms it. */
export function handoffFolderIds(layout: SetupLayout | null, nodeId: string, configuredIds: ReadonlySet<string>): Set<string> {
  if (!layout) return new Set();
  const plan = nodePlan(layout, nodeId, carriedLayoutPaths(layout, nodeId, configuredIds));
  return new Set((plan?.folders ?? []).filter((folder) => folder.handsOff).map((folder) => folder.id));
}

/**
 * Whether the folder is a hand-off folder on the node: its `.stignore` includes the hand-off list, or the layout plans it as one.
 * @implNote Phase 0 measured an override on such a folder deleting every kept copy, so a folder whose ignores cannot be read counts as one.
 */
export async function isHandoffFolder(instance: LocalInstance, folderId: string, layout: SetupLayout | null): Promise<boolean> {
  const ignores = await callSyncthing(instance, (client) => client.request<{ ignore?: string[] | null }>("GET", `/db/ignores?folder=${encodeURIComponent(folderId)}`)).catch(() => null);
  if (!ignores) return true;
  if ((ignores.ignore ?? []).some((line) => line.trim() === `#include ${handoffIgnoreFile}`)) return true;
  const configured = new Set((await callSyncthing(instance, (client) => client.folders())).map((folder) => folder.id));
  return handoffFolderIds(layout, instance.nodeId, configured).has(folderId);
}

/** The copies of this host's nodes with `handoff` set from each node's plan, so the folder form never offers an override on one. */
export function withHandoffFlags(copies: FolderCopy[], layout: SetupLayout | null): FolderCopy[] {
  const byNode = new Map<string, Set<string>>();
  for (const copy of copies) byNode.set(copy.nodeId, (byNode.get(copy.nodeId) ?? new Set()).add(copy.id));
  const handing = new Map([...byNode].map(([nodeId, ids]) => [nodeId, handoffFolderIds(layout, nodeId, ids)]));
  return copies.map((copy) => ({ ...copy, handoff: handing.get(copy.nodeId)?.has(copy.id) ?? false }));
}

/**
 * How many entries the hand-off list adds to the folder's ignores: the expanded patterns no line of `.stignore` itself gives, a pattern and
 * its `/**` form counted once; null when the ignores cannot be read.
 * @implNote Syncthing has no read of an included file, so the list is counted from what it expands to.
 */
export async function handoffEntryCount(client: SyncthingClient, folderId: string): Promise<number | null> {
  const ignores = await client.request<{ ignore?: string[] | null; expanded?: string[] | null }>("GET", `/db/ignores?folder=${encodeURIComponent(folderId)}`).catch(() => null);
  if (!ignores) return null;
  const own = new Set((ignores.ignore ?? []).flatMap((line) => [line, `${line}/**`]));
  return new Set((ignores.expanded ?? []).filter((line) => !own.has(line)).map((line) => line.replace(/\/\*\*$/, ""))).size;
}
