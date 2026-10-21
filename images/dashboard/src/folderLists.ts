import { explorerSettings } from "./settings.js";
import type { BrowseEntry, FolderStatus, SyncthingClient } from "./syncthing.js";

const perPage = 100;

/**
 * Item paths of one folder, counted under every directory above them, so a row asks for its count
 * without walking the list.
 * @implNote Paths are compared with `/`: Syncthing names list items with the instance's own
 * separator, and a Windows instance writes `\`.
 */
export class PathSet {
  private readonly counts = new Map<string, number>();

  constructor(paths: Iterable<string>) {
    for (const path of paths) {
      const segments = path.split(/[\\/]+/).filter(Boolean);
      for (let depth = 0; depth <= segments.length; depth++) {
        const key = segments.slice(0, depth).join("/");
        this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
      }
    }
  }

  /** Items at the path or below it; "" is the folder root. */
  countUnder(path: string): number {
    return this.counts.get(path.split(/[\\/]+/).filter(Boolean).join("/")) ?? 0;
  }
}

export interface FolderLists {
  sequence: number;
  need: PathSet | "too-many";
  errors: PathSet | "too-many";
  localChanged: PathSet;
}

interface CachedLists {
  fingerprint: string;
  lists: Promise<FolderLists>;
}

const cache = new Map<string, CachedLists>();

async function readAllPages(readPage: (page: number) => Promise<string[]>, total: number): Promise<string[]> {
  const items: string[] = [];
  const lastPage = Math.ceil(total / perPage) + 1;
  for (let page = 1; page <= lastPage; page++) {
    const names = await readPage(page);
    items.push(...names);
    if (names.length < perPage) break;
  }
  return items;
}

async function placedList(total: number, limit: number, readPage: (page: number) => Promise<string[]>): Promise<PathSet | "too-many"> {
  if (total === 0) return new PathSet([]);
  if (total > limit) return "too-many";
  return new PathSet(await readAllPages(readPage, total));
}

async function readLists(client: SyncthingClient, folderId: string, status: FolderStatus, limit: number): Promise<FolderLists> {
  const needTotal = status.needTotalItems ?? status.needFiles ?? 0;
  const errorTotal = status.errors ?? status.pullErrors ?? 0;
  const changedTotal = Math.min(status.receiveOnlyTotalItems ?? 0, limit);
  const [need, errors, localChanged] = await Promise.all([
    placedList(needTotal, limit, async (page) => {
      const answer = await client.needPage(folderId, page, perPage);
      return [...(answer.progress ?? []), ...(answer.queued ?? []), ...(answer.rest ?? [])].map((item) => item.name);
    }),
    placedList(errorTotal, limit, async (page) => ((await client.errorsPage(folderId, page, perPage)).errors ?? []).map((item) => item.path)),
    placedList(changedTotal, limit, async (page) => ((await client.localChangedPage(folderId, page, perPage)).files ?? []).map((item) => item.name)),
  ]);
  return { sequence: status.sequence ?? 0, need, errors, localChanged: localChanged === "too-many" ? new PathSet([]) : localChanged };
}

/**
 * @implNote Kept until the sequence or one of the three counts changes: a pull error or a remote
 * device's change moves the counts without touching this instance's own sequence.
 */
function fingerprintOf(status: FolderStatus): string {
  return [status.sequence ?? 0, status.needTotalItems ?? status.needFiles ?? 0, status.errors ?? status.pullErrors ?? 0, status.receiveOnlyTotalItems ?? 0].join(":");
}

interface CachedBrowse {
  sequence: number;
  entries: Promise<BrowseEntry[]>;
}

/** Answers read in full; `browsesInFlight` holds the reads not finished yet. */
const browseCache = new Map<string, CachedBrowse>();
const browsesInFlight = new Map<string, CachedBrowse>();
const browseCacheSize = 200;

function rememberBrowse(key: string, value: CachedBrowse): void {
  browseCache.delete(key);
  browseCache.set(key, value);
  if (browseCache.size > browseCacheSize) browseCache.delete(browseCache.keys().next().value!);
}

function startBrowse(key: string, client: SyncthingClient, folderId: string, prefix: string, sequence: number): CachedBrowse {
  const read = { sequence, entries: client.browse(folderId, prefix, 0) };
  browsesInFlight.set(key, read);
  read.entries
    .then(() => rememberBrowse(key, read))
    .catch(() => undefined)
    .finally(() => {
      if (browsesInFlight.get(key) === read) browsesInFlight.delete(key);
    });
  return read;
}

/**
 * One level of the folder's tree below `prefix`, kept per folder sequence.
 * @implNote Syncthing walks every item below the prefix to answer, about 6 s at the root of a folder
 * with 900,000 items, so after the folder changed the previous answer is served while a new one is
 * read, and the explorer warms the roots it shows.
 */
export async function browseFor(instanceKey: string, client: SyncthingClient, folderId: string, prefix: string, sequence: number): Promise<BrowseEntry[]> {
  const key = `${instanceKey}\u0000${folderId}\u0000${prefix}`;
  const cached = browseCache.get(key);
  if (cached?.sequence === sequence) return cached.entries;
  const inFlight = browsesInFlight.get(key);
  const read = inFlight?.sequence === sequence ? inFlight : startBrowse(key, client, folderId, prefix, sequence);
  return cached ? cached.entries : read.entries;
}

/** The folder's outstanding, failed and locally changed items, read once per change of the folder. */
export async function listsFor(instanceKey: string, client: SyncthingClient, folderId: string, needLimit = explorerSettings.needLimit): Promise<FolderLists> {
  const status = await client.folderStatus(folderId);
  return listsWithStatus(instanceKey, client, folderId, status, needLimit);
}

/** As `listsFor`, for a caller that already holds the folder's status. */
export function listsWithStatus(instanceKey: string, client: SyncthingClient, folderId: string, status: FolderStatus, needLimit = explorerSettings.needLimit): Promise<FolderLists> {
  const key = `${instanceKey}\u0000${folderId}`;
  const fingerprint = fingerprintOf(status);
  const cached = cache.get(key);
  if (cached?.fingerprint === fingerprint) return cached.lists;
  const lists = readLists(client, folderId, status, needLimit);
  cache.set(key, { fingerprint, lists });
  lists.catch(() => {
    if (cache.get(key)?.lists === lists) cache.delete(key);
  });
  return lists;
}
