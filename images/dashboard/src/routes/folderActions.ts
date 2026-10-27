import type { FolderRescan, FolderSettings, RemoveFolderBody, RemovedFolder } from "../api/types.js";
import { folderSettings } from "../folderIndex.js";
import { RequestError, readBody, sendJson } from "../http.js";
import { type LocalInstance, type ResolvedInstance, callSyncthing, defaultReadBackDelaysMs, requireLocal, resolveInstance, writeConfirmed } from "../instanceResolver.js";
import type { AnyRoute, NothingWritten, WriteNote } from "../routes.js";
import type { SyncthingFolderSettings } from "../syncthing.js";
import { decodedSegment } from "./devices.js";

type Folder = SyncthingFolderSettings;

async function configuredFolders(instance: LocalInstance): Promise<Folder[]> {
  return (await callSyncthing(instance, (client) => client.request<Folder[] | null>("GET", "/config/folders"))) ?? [];
}

async function knownFolder(instance: LocalInstance, folderId: string): Promise<Folder> {
  const folder = (await configuredFolders(instance)).find((candidate) => candidate.id === folderId);
  if (!folder) throw new RequestError(404, `${instance.name} has no folder ${folderId}`);
  return folder;
}

function folderName(folder: Pick<Folder, "id" | "label">): string {
  return folder.label || folder.id;
}

function folderPath(folderId: string): string {
  return `/config/folders/${encodeURIComponent(folderId)}`;
}

export interface FolderPause {
  settings: FolderSettings;
  note: WriteNote | NothingWritten;
}

/**
 * Pauses or resumes one folder by sending only `paused`, so no other setting is written back over a change made elsewhere.
 * @implNote A folder already in that state is not written, and Activity records nothing.
 */
export async function pauseFolder(instance: ResolvedInstance, folderId: string, paused: boolean, readBackDelaysMs: readonly number[] = defaultReadBackDelaysMs): Promise<FolderPause> {
  const local = requireLocal(instance);
  const before = await knownFolder(local, folderId);
  if ((before.paused ?? false) === paused) return { settings: folderSettings(before), note: { nothingWritten: true } };
  await writeConfirmed(
    local,
    (client) => client.request("PATCH", folderPath(folderId), { paused }),
    async () => (await local.client.folderSettings(folderId)).paused === paused,
    readBackDelaysMs,
  );
  const after = await local.client.folderSettings(folderId).catch(() => ({ ...before, paused }));
  const note: WriteNote = { nodeId: local.nodeId, nodeName: local.name, folderId, text: `${local.name}: ${paused ? "paused" : "resumed"} folder ${folderName(before)}` };
  return { settings: folderSettings(after), note };
}

const controlCharacter = /[\u0000-\u001f\u007f-\u009f]/;

/** Why `sub` is no part of a folder to rescan, or null: it must name something below the folder's path. */
export function rescanSubProblem(sub: string): string | null {
  if (controlCharacter.test(sub)) return "the subfolder holds a control character";
  if (/^[\\/]/.test(sub) || /^[A-Za-z]:/.test(sub)) return `${sub} is not inside the folder: give a path below the folder's own, such as photos/2024`;
  if (sub.split(/[\\/]/).some((segment) => segment === "..")) return `${sub} climbs out of the folder with ..; give a path below the folder's own`;
  return null;
}

/** The part of the folder a rescan body names, or null for the whole folder; refused before any Syncthing call. */
function rescanSub(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new RequestError(400, "a rescan takes nothing, or { sub } naming a part of the folder");
  const fields = body as Record<string, unknown>;
  const unknown = Object.keys(fields).find((key) => key !== "sub");
  if (unknown) throw new RequestError(400, `${unknown} is not part of a rescan`);
  if (fields.sub === undefined) return null;
  if (typeof fields.sub !== "string") throw new RequestError(400, "the subfolder must be text");
  const sub = fields.sub.trim().replace(/[\\/]+$/, "");
  if (!sub) return null;
  const problem = rescanSubProblem(sub);
  if (problem) throw new RequestError(400, problem);
  return sub;
}

export interface FolderRescanDone {
  rescan: FolderRescan;
  note: WriteNote;
}

/** Asks the node's Syncthing to rescan one folder now, or only `sub` of it, as Syncthing's own Rescan does. */
export async function rescanFolder(instance: ResolvedInstance, folderId: string, body: unknown): Promise<FolderRescanDone> {
  const local = requireLocal(instance);
  const sub = rescanSub(body);
  const folder = await knownFolder(local, folderId);
  if (folder.paused) throw new RequestError(409, `${folderName(folder)} is paused, so Syncthing does not scan it; resume it first`);
  const query = new URLSearchParams({ folder: folderId, ...(sub ? { sub } : {}) });
  await callSyncthing(local, (client) => client.request("POST", `/db/scan?${query.toString()}`));
  const what = sub ? `${sub} of folder ${folderName(folder)}` : `folder ${folderName(folder)}`;
  return { rescan: { folderId, sub }, note: { nodeId: local.nodeId, nodeName: local.name, folderId, text: `${local.name}: rescanned ${what}` } };
}

/** Asks the node's Syncthing to rescan every folder now; Syncthing leaves out the paused ones. */
export async function rescanAll(instance: ResolvedInstance): Promise<FolderRescanDone> {
  const local = requireLocal(instance);
  await callSyncthing(local, (client) => client.request("POST", "/db/scan"));
  return { rescan: { folderId: null, sub: null }, note: { nodeId: local.nodeId, nodeName: local.name, folderId: null, text: `${local.name}: rescanned every folder that is not paused` } };
}

/** What a removal did, in words, saying plainly that nothing was deleted. */
export function folderRemovalText(nodeName: string, folder: Pick<Folder, "id" | "label" | "path">): string {
  const named = folder.label && folder.label !== folder.id ? `${folder.label} (${folder.id})` : folder.id;
  return `${nodeName}: removed folder ${named} from Syncthing; the files stay on disk at ${folder.path}`;
}

export interface FolderRemoval {
  removed: RemovedFolder;
  note: WriteNote;
}

/**
 * Removes a folder from the node's Syncthing once its ID is typed; Syncthing deletes nothing on disk.
 * @implNote The typed ID is the confirmation, as for a device: a stray click cannot stop a folder syncing with every device.
 */
export async function removeFolder(instance: ResolvedInstance, folderId: string, body: unknown, readBackDelaysMs: readonly number[] = defaultReadBackDelaysMs): Promise<FolderRemoval> {
  const local = requireLocal(instance);
  const folder = await knownFolder(local, folderId);
  const confirm = typeof body === "object" && body !== null ? (body as Partial<RemoveFolderBody>).confirm : undefined;
  if (confirm !== folderId) throw new RequestError(400, `type ${folderId} to confirm`);
  await writeConfirmed(
    local,
    (client) => client.request("DELETE", folderPath(folderId)),
    async () => !(await local.client.folders()).some((candidate) => candidate.id === folderId),
    readBackDelaysMs,
  );
  const text = folderRemovalText(local.name, folder);
  return { removed: { folderId, label: folder.label, path: folder.path, text }, note: { nodeId: local.nodeId, nodeName: local.name, folderId, text } };
}

export interface FolderActionSources {
  resolve(nodeId: string): Promise<ResolvedInstance>;
  /** The waits between read-backs of a write whose answer was lost; tests shorten them. */
  readBackDelaysMs?: readonly number[];
}

const liveSources: FolderActionSources = { resolve: (nodeId) => resolveInstance(nodeId) };

export function folderActionRoutes(sources: FolderActionSources = liveSources): AnyRoute[] {
  const node = (segment: string) => sources.resolve(decodedSegment(segment, "node ID"));
  const folder = (segment: string) => decodedSegment(segment, "folder ID");
  return [
    {
      method: "POST",
      pattern: /^\/api\/nodes\/([^/]+)\/folders\/([^/]+)\/(pause|resume)$/,
      write: async ({ response, params: [nodeId, folderId, verb] }) => {
        const pause = await pauseFolder(await node(nodeId), folder(folderId), verb === "pause", sources.readBackDelaysMs);
        sendJson(response, 200, pause.settings);
        return pause.note;
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/nodes\/([^/]+)\/folders\/([^/]+)\/rescan$/,
      write: async ({ request, response, params: [nodeId, folderId] }) => {
        const instance = await node(nodeId);
        const done = await rescanFolder(instance, folder(folderId), await readBody(request));
        sendJson(response, 200, done.rescan);
        return done.note;
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/nodes\/([^/]+)\/rescan-all$/,
      write: async ({ response, params: [nodeId] }) => {
        const done = await rescanAll(await node(nodeId));
        sendJson(response, 200, done.rescan);
        return done.note;
      },
    },
    {
      method: "DELETE",
      pattern: /^\/api\/nodes\/([^/]+)\/folders\/([^/]+)$/,
      write: async ({ request, response, params: [nodeId, folderId] }) => {
        const instance = await node(nodeId);
        const removal = await removeFolder(instance, folder(folderId), await readBody(request), sources.readBackDelaysMs);
        sendJson(response, 200, removal.removed);
        return removal.note;
      },
    },
  ];
}
