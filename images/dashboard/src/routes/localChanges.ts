import { type LocalChangesAction, localChangesDoneText, localChangesFolderType } from "../api/localChangesText.js";
import { type LocalChangesDone, folderTypeTexts } from "../api/types.js";
import { folderSettings } from "../folderIndex.js";
import { RequestError, UnconfirmedWrite, readBody, sendJson } from "../http.js";
import { type LocalInstance, type ResolvedInstance, arrayConfirmProblem, callSyncthing, requireLocal, resolveInstance } from "../instanceResolver.js";
import type { AnyRoute, WriteNote } from "../routes.js";
import type { FolderStatus, SyncthingFolderSettings } from "../syncthing.js";
import { decodedSegment } from "./devices.js";

const actionWords: Record<LocalChangesAction, { doing: string; guard: string; done: string }> = {
  revert: { doing: "revert its local changes", guard: "revert the local changes", done: "reverted" },
  override: { doing: "override the other devices' changes", guard: "override the other devices' changes", done: "overridden" },
};

function typedConfirm(body: unknown): unknown {
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>).confirm : undefined;
}

/** Refuses an untyped or mistyped folder ID before any request to the node; on an array through the array guard, in its words. */
function requireTypedId(instance: LocalInstance, folderId: string, action: LocalChangesAction, body: unknown): void {
  const confirm = typedConfirm(body);
  const arrayProblem = arrayConfirmProblem(instance, folderId, confirm, actionWords[action].doing);
  if (arrayProblem) throw new RequestError(400, arrayProblem);
  if (confirm !== folderId) throw new RequestError(400, `type the folder ID ${folderId} to ${actionWords[action].guard}`);
}

async function knownFolder(instance: LocalInstance, folderId: string): Promise<SyncthingFolderSettings> {
  const folders = (await callSyncthing(instance, (client) => client.folders())) ?? [];
  if (!folders.some((candidate) => candidate.id === folderId)) throw new RequestError(404, `${instance.name} has no folder ${folderId}`);
  return callSyncthing(instance, (client) => client.folderSettings(folderId));
}

function requireFolderFor(action: LocalChangesAction, folder: SyncthingFolderSettings, instance: LocalInstance): void {
  const name = folder.label || folder.id;
  const wanted = localChangesFolderType[action];
  if (folder.type !== wanted) throw new RequestError(409, `${action} is only for a ${folderTypeTexts[wanted]} folder; ${name} is ${folderTypeTexts[folder.type] ?? folder.type} on ${instance.name}`);
  if (folder.paused) throw new RequestError(409, `${name} is paused on ${instance.name}; resume it first`);
}

/** Syncthing's count of what the action discards: the items changed here for a revert, the items other devices changed for an override. */
function discardedCount(action: LocalChangesAction, status: FolderStatus | null): number | null {
  if (!status) return null;
  const count = action === "revert" ? status.receiveOnlyTotalItems : status.needTotalItems;
  return typeof count === "number" ? count : null;
}

async function askToDiscard(instance: LocalInstance, folderId: string, action: LocalChangesAction): Promise<void> {
  try {
    await callSyncthing(instance, (client) => client.request("POST", `/db/${action}?folder=${encodeURIComponent(folderId)}`));
  } catch (error) {
    if (error instanceof RequestError && error.status === 503) throw new UnconfirmedWrite(instance.name, actionWords[action].done);
    throw error;
  }
}

export interface LocalChangesResult {
  done: LocalChangesDone;
  note: WriteNote;
}

/**
 * Reverts a receive only folder's local changes, or overrides what other devices changed in a send only folder, once its ID is typed exactly.
 * @implNote Both discard data, here or on every other device, so the typed ID is checked before the node is asked anything and the
 * folder type before Syncthing is told to act. A lost answer may mean Syncthing already discarded the data, so it is never a plain failure.
 */
export async function discardChanges(instance: ResolvedInstance, folderId: string, action: LocalChangesAction, body: unknown): Promise<LocalChangesResult> {
  const local = requireLocal(instance);
  requireTypedId(local, folderId, action, body);
  const folder = await knownFolder(local, folderId);
  requireFolderFor(action, folder, local);
  const status = await callSyncthing(local, (client) => client.folderStatus(folderId)).catch(() => null);
  await askToDiscard(local, folderId, action);
  const items = discardedCount(action, status);
  const text = localChangesDoneText(action, local.name, folder.label || folder.id, items, folderSettings(folder).versioning);
  return { done: { folderId, action, items, text }, note: { nodeId: local.nodeId, nodeName: local.name, folderId, text } };
}

export interface LocalChangesSources {
  resolve(nodeId: string): Promise<ResolvedInstance>;
}

const liveSources: LocalChangesSources = { resolve: (nodeId) => resolveInstance(nodeId) };

export function localChangesRoutes(sources: LocalChangesSources = liveSources): AnyRoute[] {
  return [
    {
      method: "POST",
      pattern: /^\/api\/nodes\/([^/]+)\/folders\/([^/]+)\/(revert|override)$/,
      write: async ({ request, response, params: [nodeSegment, folderSegment, action] }) => {
        const instance = await sources.resolve(decodedSegment(nodeSegment, "node ID"));
        const result = await discardChanges(instance, decodedSegment(folderSegment, "folder ID"), action as LocalChangesAction, await readBody(request));
        sendJson(response, 200, result.done);
        return result.note;
      },
    },
  ];
}
