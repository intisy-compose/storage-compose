import { ignoreLinesProblem, ignoresChangeWords } from "../api/ignorePatterns.js";
import type { FolderIgnores, IgnoresChange } from "../api/types.js";
import { RequestError, readBody, sendJson } from "../http.js";
import { type LocalInstance, type ResolvedInstance, callSyncthing, defaultReadBackDelaysMs, requireLocal, resolveInstance, writeConfirmed } from "../instanceResolver.js";
import type { AnyRoute, NothingWritten, WriteNote } from "../routes.js";
import { ownPatternCores, patternCore, shownSyncthingError } from "../shownSyncthingError.js";
import type { SyncthingFolderConfig } from "../syncthing.js";
import { decodedSegment } from "./devices.js";

/** `/rest/db/ignores` as Syncthing 2.1.6 answers both its GET and its POST; a parse error is an answer, not a failure. */
interface SyncthingIgnores {
  ignore: string[] | null;
  expanded: string[] | null;
  error: string | null;
}

function ignoresPath(folderId: string): string {
  return `/db/ignores?folder=${encodeURIComponent(folderId)}`;
}

function syncthingIgnores(instance: LocalInstance, folderId: string): Promise<SyncthingIgnores> {
  return callSyncthing(instance, (client) => client.request<SyncthingIgnores>("GET", ignoresPath(folderId)));
}

/** The node's default ignore patterns, which Syncthing's own page gives a new folder. */
export async function defaultIgnoreLines(instance: LocalInstance): Promise<string[]> {
  const answer = await callSyncthing(instance, (client) => client.request<{ lines?: string[] | null } | null>("GET", "/config/defaults/ignores"));
  return answer?.lines ?? [];
}

/** Writes the folder's whole `.stignore`; Syncthing answers with the file as it now reads it. */
export function writeIgnoreLines(instance: LocalInstance, folderId: string, lines: readonly string[]): Promise<SyncthingIgnores> {
  return callSyncthing(instance, (client) => client.request<SyncthingIgnores>("POST", ignoresPath(folderId), { ignore: lines }));
}

/**
 * The file as the page sees it: its lines, the expansions of its own lines, and Syncthing's error.
 * @implNote An included file's patterns are counted, never shown: Syncthing 2.1.6 expands an `#include` from anywhere the node
 * can read, nested includes too, so an included file inside the folder, synced from another device, could pull the node's
 * configuration into the expanded list.
 */
export function shownIgnores(answer: SyncthingIgnores): FolderIgnores {
  const lines = answer.ignore ?? [];
  const cores = ownPatternCores(lines);
  const expanded = answer.expanded ?? [];
  const shown = expanded.filter((pattern) => cores.has(patternCore(pattern)));
  return { lines, expanded: shown, hiddenIncluded: expanded.length - shown.length, error: answer.error ? shownSyncthingError(answer.error, lines) : null };
}

async function knownFolder(instance: LocalInstance, folderId: string): Promise<SyncthingFolderConfig> {
  const folders = (await callSyncthing(instance, (client) => client.folders())) ?? [];
  const folder = folders.find((candidate) => candidate.id === folderId);
  if (!folder) throw new RequestError(404, `${instance.name} has no folder ${folderId}`);
  return folder;
}

export async function readIgnores(instance: ResolvedInstance, folderId: string): Promise<FolderIgnores> {
  const local = requireLocal(instance);
  await knownFolder(local, folderId);
  return shownIgnores(await syncthingIgnores(local, folderId));
}

function isLineList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((line) => typeof line === "string");
}

/** Why `body` is no ignore change, or null; checked before anything is read from the node. */
export function ignoresChangeProblem(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "an ignore change needs the new lines and the lines the form opened with";
  const fields = body as Record<string, unknown>;
  const unknown = Object.keys(fields).find((key) => key !== "lines" && key !== "opened");
  if (unknown) return `${unknown} is not part of an ignore change`;
  if (!isLineList(fields.lines)) return "the ignore patterns must be a list of lines";
  if (!isLineList(fields.opened)) return "the lines the form opened with are missing";
  return ignoreLinesProblem(fields.lines);
}

function isSameLines(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

function folderName(folder: Pick<SyncthingFolderConfig, "id" | "label">): string {
  return folder.label || folder.id;
}

/** What an ignore change did, in words: `pc: changed ignore patterns of folder Documents; added *.tmp`. */
export function ignoresEditText(nodeName: string, folderName: string, before: readonly string[], after: readonly string[]): string {
  return [`${nodeName}: changed ignore patterns of folder ${folderName}`, ...ignoresChangeWords(before, after)].join("; ");
}

export interface IgnoresSave {
  ignores: FolderIgnores;
  note: WriteNote | NothingWritten;
}

/**
 * Replaces the folder's `.stignore` with `lines`, only while the node's file is still the one the form opened with.
 * @implNote Syncthing takes the file only whole and has no version check, so the file is read again as the last step before
 * the write and a difference is a 409; a change landing between that read and the POST, one request apart, is still overwritten.
 * When the POST's answer is lost, the read-back that finds the lines in place is the answer, so a confirmed save always enters Activity.
 */
export async function saveIgnores(instance: ResolvedInstance, folderId: string, body: unknown, readBackDelaysMs: readonly number[] = defaultReadBackDelaysMs): Promise<IgnoresSave> {
  const local = requireLocal(instance);
  const problem = ignoresChangeProblem(body);
  if (problem) throw new RequestError(400, problem);
  const { lines, opened } = body as IgnoresChange;
  const folder = await knownFolder(local, folderId);
  if (folder.type === "receiveencrypted") throw new RequestError(400, `${folderName(folder)} is receive encrypted, which takes no ignore patterns`);
  const current = await syncthingIgnores(local, folderId);
  const before = current.ignore ?? [];
  if (!isSameLines(before, opened)) throw new RequestError(409, "the ignore patterns changed on the node since the form opened; nothing was written");
  if (isSameLines(before, lines)) return { ignores: shownIgnores(current), note: { nothingWritten: true } };
  const latest: { answer: SyncthingIgnores | null } = { answer: null };
  await writeConfirmed(
    local,
    async () => void (latest.answer = await writeIgnoreLines(local, folderId, lines)),
    async () => {
      latest.answer = await local.client.request<SyncthingIgnores>("GET", ignoresPath(folderId));
      return isSameLines(latest.answer.ignore ?? [], lines);
    },
    readBackDelaysMs,
  );
  const after = latest.answer ?? (await syncthingIgnores(local, folderId));
  return { ignores: shownIgnores(after), note: { nodeId: local.nodeId, nodeName: local.name, folderId, text: ignoresEditText(local.name, folderName(folder), before, lines) } };
}

export interface FolderIgnoreSources {
  resolve(nodeId: string): Promise<ResolvedInstance>;
  /** The waits between read-backs of a write whose answer was lost; tests shorten them. */
  readBackDelaysMs?: readonly number[];
}

const liveSources: FolderIgnoreSources = { resolve: (nodeId) => resolveInstance(nodeId) };

export function folderIgnoreRoutes(sources: FolderIgnoreSources = liveSources): AnyRoute[] {
  const pattern = /^\/api\/nodes\/([^/]+)\/folders\/([^/]+)\/ignores$/;
  const node = (segment: string) => sources.resolve(decodedSegment(segment, "node ID"));
  return [
    {
      method: "GET",
      pattern,
      handle: async ({ response, params: [nodeId, folderId] }) => sendJson(response, 200, await readIgnores(await node(nodeId), decodedSegment(folderId, "folder ID"))),
    },
    {
      method: "PUT",
      pattern,
      write: async ({ request, response, params: [nodeId, folderId] }) => {
        const instance = await node(nodeId);
        const saved = await saveIgnores(instance, decodedSegment(folderId, "folder ID"), await readBody(request), sources.readBackDelaysMs);
        sendJson(response, 200, saved.ignores);
        return saved.note;
      },
    },
  ];
}
