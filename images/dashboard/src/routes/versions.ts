import { type FileVersion, type FolderSettings, type RestoredVersions, type Versioning, type VersionsDirectory, type VersionsPage, maxItemsPerPage } from "../api/types.js";
import { folderSettings } from "../folderIndex.js";
import { RequestError, UnconfirmedWrite, readBody, sendJson } from "../http.js";
import { type LocalInstance, type RemoteInstance, type ResolvedInstance, arrayConfirmProblem, callSyncthing, forwardRead, forwardedListTimeoutMs, requireLocal, resolveInstance } from "../instanceResolver.js";
import { folderSubpathProblem } from "../pathGuard.js";
import type { AnyRoute, NothingWritten, WriteNote } from "../routes.js";
import { versionsSettings } from "../settings.js";
import { AnswerTooLarge, listTimeoutMs } from "../syncthing.js";
import { SharedLists } from "../versionLists.js";
import { decodedSegment } from "./devices.js";
import { type PageRequest, pageRequestOf } from "./items.js";

interface StoredVersions {
  files: Record<string, FileVersion[]>;
  bytes: number;
  readAt: string;
}

interface DateRange {
  fromMs: number;
  toMs: number;
}

interface LevelQuery {
  prefix: string;
  range: DateRange;
  request: PageRequest;
}

/**
 * How long a folder's versions list is shared while its tree is browsed, and how many lists are read at once.
 * @implNote One list is kept at a time, as browsing reads one tree at a time; a parsed list holds several times its bytes.
 */
const listKeptMs = 60_000;
const listsReadAtOnce = 2;

function folderName(settings: Pick<FolderSettings, "id" | "label">): string {
  return settings.label || settings.id;
}

async function knownFolder(instance: LocalInstance, folderId: string): Promise<FolderSettings> {
  const folders = (await callSyncthing(instance, (client) => client.folders())) ?? [];
  if (!folders.some((candidate) => candidate.id === folderId)) throw new RequestError(404, `${instance.name} has no folder ${folderId}`);
  return folderSettings(await callSyncthing(instance, (client) => client.folderSettings(folderId)));
}

function externalRefusal(settings: FolderSettings, instance: LocalInstance): RequestError {
  return new RequestError(409, `${folderName(settings)} on ${instance.name} keeps its versions through an external command, which Syncthing cannot list or restore`);
}

function tooLarge(settings: FolderSettings, instance: LocalInstance, maxBytes: number): RequestError {
  return new RequestError(
    409,
    `${folderName(settings)} on ${instance.name} keeps more versions than the dashboard reads at once: Syncthing's list passed ${maxBytes / 1_000_000} MB (VERSIONS_LIST_MAX_MB); raise it in config.env to list them`,
  );
}

function instantParam(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  const value = Date.parse(raw);
  if (!Number.isFinite(value)) throw new RequestError(400, `${name} must be a date and time such as 2026-10-27T00:00:00+01:00, not ${raw}`);
  return value;
}

function levelQueryOf(url: URL): LevelQuery {
  const prefix = (url.searchParams.get("prefix") ?? "").replace(/^\/+|\/+$/g, "");
  return { prefix, range: { fromMs: instantParam(url, "from", -Infinity), toMs: instantParam(url, "to", Infinity) }, request: pageRequestOf(url) };
}

function inRange(versions: FileVersion[], range: DateRange): FileVersion[] {
  return versions
    .filter((entry) => {
      const at = Date.parse(entry.versionTime);
      return at >= range.fromMs && at <= range.toMs;
    })
    .sort((left, right) => Date.parse(right.versionTime) - Date.parse(left.versionTime));
}

function byPath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** One level of the tree below `prefix`: its directories with how many files below each have versions in range, then its own files. */
function treeLevel(stored: StoredVersions, query: LevelQuery): { directories: VersionsDirectory[]; files: [string, FileVersion[]][] } {
  const start = query.prefix ? `${query.prefix}/` : "";
  const directoryCounts = new Map<string, number>();
  const files: [string, FileVersion[]][] = [];
  for (const [path, versions] of Object.entries(stored.files)) {
    if (!path.startsWith(start)) continue;
    const kept = inRange(versions ?? [], query.range);
    if (!kept.length) continue;
    const rest = path.slice(start.length);
    const slash = rest.indexOf("/");
    if (slash < 0) files.push([path, kept]);
    else {
      const directory = `${start}${rest.slice(0, slash)}`;
      directoryCounts.set(directory, (directoryCounts.get(directory) ?? 0) + 1);
    }
  }
  const directories = [...directoryCounts].map(([path, count]) => ({ path, files: count })).sort((left, right) => byPath(left.path, right.path));
  return { directories, files: files.sort(([left], [right]) => byPath(left, right)) };
}

function levelPage(settings: FolderSettings, stored: StoredVersions, query: LevelQuery): VersionsPage {
  const level = treeLevel(stored, query);
  const { page, perPage } = query.request;
  const first = (page - 1) * perPage;
  const shownDirectories = level.directories.slice(first, first + perPage);
  const fileStart = Math.max(0, first - level.directories.length);
  const shownFiles = level.files.slice(fileStart, fileStart + perPage - shownDirectories.length);
  return {
    enabled: true,
    versioning: settings.versioning,
    folderType: settings.type,
    prefix: query.prefix,
    directories: shownDirectories,
    files: Object.fromEntries(shownFiles),
    page,
    perPage,
    total: level.directories.length + level.files.length,
    readAt: stored.readAt,
  };
}

function versioningOff(settings: FolderSettings, query: LevelQuery): VersionsPage {
  return { enabled: false, versioning: settings.versioning, folderType: settings.type, prefix: query.prefix, directories: [], files: {}, page: query.request.page, perPage: query.request.perPage, total: 0, readAt: null };
}

function listKey(nodeId: string, folderId: string): string {
  return `${nodeId}\u0000${folderId}`;
}

/** @implNote A folder without versioning is answered from its settings: Syncthing would answer 500, and it is never asked to walk anything. */
async function localVersions(instance: LocalInstance, folderId: string, url: URL, lists: SharedLists<StoredVersions>, maxBytes: number): Promise<VersionsPage> {
  const query = levelQueryOf(url);
  const settings = await knownFolder(instance, folderId);
  if (!settings.versioning.type) return versioningOff(settings, query);
  if (settings.versioning.type === "external") throw externalRefusal(settings, instance);
  const fresh = url.searchParams.get("reread") === "true";
  try {
    const stored = await lists.read(listKey(instance.nodeId, folderId), fresh, async () => ({
      ...(await callSyncthing(instance, (client) => client.folderVersions(folderId, maxBytes))),
      readAt: new Date().toISOString(),
    }));
    return levelPage(settings, stored, query);
  } catch (error) {
    if (error instanceof AnswerTooLarge) throw tooLarge(settings, instance, maxBytes);
    throw error;
  }
}

type Fields = Record<string, unknown>;

function fieldsOf(value: unknown): Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Fields) : {};
}

function forwardedVersion(value: unknown): FileVersion {
  const fields = fieldsOf(value);
  return { versionTime: String(fields.versionTime ?? ""), modTime: String(fields.modTime ?? ""), size: typeof fields.size === "number" ? fields.size : 0 };
}

function forwardedVersioning(value: unknown): Versioning {
  const fields = fieldsOf(value);
  const params = Object.fromEntries(Object.entries(fieldsOf(fields.params)).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const type = ["", "trashcan", "simple", "staggered", "external"].includes(fields.type as string) ? (fields.type as Versioning["type"]) : "";
  return { type, params, cleanupIntervalS: typeof fields.cleanupIntervalS === "number" ? fields.cleanupIntervalS : 0, fsPath: typeof fields.fsPath === "string" ? fields.fsPath : "" };
}

/** Another dashboard's level, rebuilt field by field, as an older or newer one may send more. */
function forwardedPage(answer: unknown, query: LevelQuery): VersionsPage {
  const fields = fieldsOf(answer);
  const files = Object.entries(fieldsOf(fields.files)).map(([path, versions]): [string, FileVersion[]] => [path, Array.isArray(versions) ? versions.map(forwardedVersion) : []]);
  const directories = Array.isArray(fields.directories) ? fields.directories.map((entry) => fieldsOf(entry)).map((entry) => ({ path: String(entry.path ?? ""), files: typeof entry.files === "number" ? entry.files : 0 })) : [];
  const folderType = ["sendreceive", "sendonly", "receiveonly", "receiveencrypted"].includes(fields.folderType as string) ? (fields.folderType as VersionsPage["folderType"]) : "sendreceive";
  return {
    enabled: fields.enabled === true,
    versioning: forwardedVersioning(fields.versioning),
    folderType,
    prefix: typeof fields.prefix === "string" ? fields.prefix : query.prefix,
    directories,
    files: Object.fromEntries(files),
    page: typeof fields.page === "number" ? fields.page : query.request.page,
    perPage: typeof fields.perPage === "number" ? fields.perPage : query.request.perPage,
    total: typeof fields.total === "number" ? fields.total : 0,
    readAt: typeof fields.readAt === "string" ? fields.readAt : null,
  };
}

function forwardedQuery(url: URL): string {
  const query = new URLSearchParams();
  for (const name of ["prefix", "from", "to", "page", "perPage", "reread"]) {
    const value = url.searchParams.get(name);
    if (value !== null) query.set(name, value);
  }
  return query.toString();
}

async function remoteVersions(instance: RemoteInstance, folderId: string, url: URL): Promise<VersionsPage> {
  const query = levelQueryOf(url);
  const path = `/api/nodes/${encodeURIComponent(instance.nodeId)}/folders/${encodeURIComponent(folderId)}/versions?${forwardedQuery(url)}`;
  return forwardedPage(await forwardRead(instance, path, forwardedListTimeoutMs), query);
}

const restoreBodyKeys = new Set(["files", "confirm"]);

/** RFC 3339 with seconds and a zone, as Syncthing writes `versionTime` and reads it back. */
const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function restoreBodyFiles(body: unknown, instance: LocalInstance): Record<string, string> {
  const unknown = Object.keys(fieldsOf(body)).find((key) => !restoreBodyKeys.has(key));
  if (unknown) throw new RequestError(400, `${unknown} is not part of a restore`);
  const files = fieldsOf(body).files;
  if (typeof files !== "object" || files === null || Array.isArray(files)) throw new RequestError(400, "a restore takes { files } naming each path and the versionTime of its version");
  const entries = Object.entries(files as Fields);
  if (!entries.length) throw new RequestError(400, "name at least one file to restore");
  if (entries.length > maxItemsPerPage) throw new RequestError(400, `restore at most ${maxItemsPerPage} files at once, not ${entries.length}`);
  for (const [path, versionTime] of entries) {
    if (!path) throw new RequestError(400, "a file to restore has no path");
    const problem = folderSubpathProblem(path, instance.os);
    if (problem) throw new RequestError(400, problem);
    if (typeof versionTime !== "string" || !rfc3339.test(versionTime) || !Number.isFinite(Date.parse(versionTime))) throw new RequestError(400, `the version of ${path} must be its versionTime as listed, not ${JSON.stringify(versionTime)}`);
  }
  return files as Record<string, string>;
}

function versionList(files: Record<string, string>, paths: string[]): string {
  const shown = paths.slice(0, 5).map((path) => `${path} (version of ${files[path]})`);
  return paths.length > shown.length ? `${shown.join(", ")} and ${paths.length - shown.length} more` : shown.join(", ");
}

function restoredText(instance: LocalInstance, settings: FolderSettings, files: Record<string, string>, restored: string[], failed: number): string {
  const count = `${restored.length} ${restored.length === 1 ? "file" : "files"}`;
  const what = restored.length ? `restored ${count} of folder ${folderName(settings)} from its versions: ${versionList(files, restored)}` : `restored no file of folder ${folderName(settings)}`;
  return `${instance.name}: ${what}${failed ? `; ${failed} not restored` : ""}`;
}

export interface VersionsRestore {
  done: RestoredVersions;
  note: WriteNote | NothingWritten;
}

/**
 * Replaces each named file with the version given, once the paths are checked and, on an array, the folder ID is typed.
 * @implNote It is refused before the node is asked anything; a lost answer may mean the files were restored, so it is never a plain failure.
 */
export async function restoreVersions(instance: ResolvedInstance, folderId: string, body: unknown): Promise<VersionsRestore> {
  const local = requireLocal(instance);
  const files = restoreBodyFiles(body, local);
  const arrayProblem = arrayConfirmProblem(local, folderId, fieldsOf(body).confirm, "restore versions");
  if (arrayProblem) throw new RequestError(400, arrayProblem);
  const settings = await knownFolder(local, folderId);
  if (settings.paused) throw new RequestError(409, `${folderName(settings)} is paused on ${local.name}; resume it first`);
  if (!settings.versioning.type) throw new RequestError(409, `versioning is off for ${folderName(settings)} on ${local.name}, so it keeps no versions to restore`);
  if (settings.versioning.type === "external") throw externalRefusal(settings, local);
  let errors: Record<string, string>;
  try {
    errors = await callSyncthing(local, (client) => client.restoreVersions(folderId, files));
  } catch (error) {
    if (error instanceof RequestError && error.status === 503) throw new UnconfirmedWrite(local.name);
    throw error;
  }
  const restored = Object.keys(files).filter((path) => !Object.hasOwn(errors, path));
  const text = restoredText(local, settings, files, restored, Object.keys(errors).length);
  const note: WriteNote | NothingWritten = restored.length ? { nodeId: local.nodeId, nodeName: local.name, folderId, text } : { nothingWritten: true };
  return { done: { folderId, restored, errors, text }, note };
}

export interface VersionSources {
  resolve(nodeId: string): Promise<ResolvedInstance>;
  /** How much of Syncthing's versions list is read before it is refused; tests make it small. */
  maxListBytes?: number;
  /** How long a list is shared; tests make it short. */
  listKeptMs?: number;
  /** How long a read waits for a list being read to finish when as many as allowed are; tests make it short. */
  slotWaitMs?: number;
}

const liveSources: VersionSources = { resolve: (nodeId) => resolveInstance(nodeId) };

/** A request another host forwarded names one of this host's nodes; forwarding it on could send it back and forth. */
async function resolveFor(sources: VersionSources, url: URL, nodeId: string): Promise<ResolvedInstance> {
  const instance = await sources.resolve(nodeId);
  if (instance.kind === "remote" && url.searchParams.get("scope") === "local") throw new RequestError(404, `no node ${nodeId} on this host`);
  return instance;
}

export function versionRoutes(sources: VersionSources = liveSources): AnyRoute[] {
  const maxBytes = sources.maxListBytes ?? versionsSettings.listMaxBytes;
  const lists = new SharedLists<StoredVersions>({ keptMs: sources.listKeptMs ?? listKeptMs, maxTotalBytes: maxBytes, maxReading: listsReadAtOnce, slotWaitMs: sources.slotWaitMs ?? listTimeoutMs });
  return [
    {
      method: "GET",
      pattern: /^\/api\/nodes\/([^/]+)\/folders\/([^/]+)\/versions$/,
      handle: async ({ response, url, params: [nodeSegment, folderSegment] }) => {
        const instance = await resolveFor(sources, url, decodedSegment(nodeSegment, "node ID"));
        const folderId = decodedSegment(folderSegment, "folder ID");
        sendJson(response, 200, instance.kind === "local" ? await localVersions(instance, folderId, url, lists, maxBytes) : await remoteVersions(instance, folderId, url));
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/nodes\/([^/]+)\/folders\/([^/]+)\/versions\/restore$/,
      write: async ({ request, response, params: [nodeSegment, folderSegment] }) => {
        const nodeId = decodedSegment(nodeSegment, "node ID");
        const folderId = decodedSegment(folderSegment, "folder ID");
        const instance = await sources.resolve(nodeId);
        const body = await readBody(request);
        let restore: VersionsRestore;
        try {
          restore = await restoreVersions(instance, folderId, body);
        } finally {
          lists.forget(listKey(instance.nodeId, folderId));
        }
        sendJson(response, 200, restore.done);
        return restore.note;
      },
    },
  ];
}
