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
  localChanged: PathSet | "too-many";
}

interface Slot<Value> {
  done: { fingerprint: string; value: Value } | null;
  inFlight: Promise<Value> | null;
  wanted: { fingerprint: string; read: () => Promise<Value> } | null;
}

/**
 * Per key, the last answer read in full and at most one read in flight. A caller gets the last
 * answer at once, even while a newer one is read; only the very first read of a key is waited for.
 * A fingerprint asked for while a read runs is read after it, once, with the newest request's reader.
 */
class RefreshingCache<Value> {
  private readonly slots = new Map<string, Slot<Value>>();

  constructor(private readonly maxKeys = Infinity) {}

  get(key: string, fingerprint: string, read: () => Promise<Value>): Promise<Value> {
    const slot = this.slots.get(key) ?? { done: null, inFlight: null, wanted: null };
    this.slots.delete(key);
    this.slots.set(key, slot);
    if (this.slots.size > this.maxKeys) this.slots.delete(this.slots.keys().next().value!);
    if (slot.done?.fingerprint === fingerprint) return Promise.resolve(slot.done.value);
    if (slot.inFlight) slot.wanted = { fingerprint, read };
    else this.start(slot, fingerprint, read);
    return slot.done ? Promise.resolve(slot.done.value) : slot.inFlight!;
  }

  private start(slot: Slot<Value>, fingerprint: string, read: () => Promise<Value>): void {
    const reading = read();
    slot.inFlight = reading;
    slot.wanted = null;
    const finish = () => {
      slot.inFlight = null;
      const wanted = slot.wanted;
      if (wanted && wanted.fingerprint !== slot.done?.fingerprint) this.start(slot, wanted.fingerprint, wanted.read);
    };
    reading.then(
      (value) => {
        slot.done = { fingerprint, value };
        finish();
      },
      finish,
    );
  }
}

const listsCache = new RefreshingCache<FolderLists>();

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
  const [need, errors, localChanged] = await Promise.all([
    placedList(needTotalOf(status), limit, async (page) => {
      const answer = await client.needPage(folderId, page, perPage);
      return [...(answer.progress ?? []), ...(answer.queued ?? []), ...(answer.rest ?? [])].map((item) => item.name);
    }),
    placedList(errorTotalOf(status), limit, async (page) => ((await client.errorsPage(folderId, page, perPage)).errors ?? []).map((item) => item.path)),
    placedList(status.receiveOnlyTotalItems ?? 0, limit, async (page) => ((await client.localChangedPage(folderId, page, perPage)).files ?? []).map((item) => item.name)),
  ]);
  return { sequence: status.sequence ?? 0, need, errors, localChanged };
}

export function needTotalOf(status: FolderStatus): number {
  return status.needTotalItems ?? status.needFiles ?? 0;
}

export function errorTotalOf(status: FolderStatus): number {
  return status.errors ?? status.pullErrors ?? 0;
}

/**
 * Moves with any change of the folder's global tree, not only this instance's own index: another
 * device's change leaves `sequence` alone and moves the global counts and `remoteSequence`.
 */
export function treeFingerprint(status: FolderStatus): string {
  return [status.sequence ?? 0, status.globalTotalItems ?? 0, status.globalBytes ?? 0, status.globalDeleted ?? 0, JSON.stringify(status.remoteSequence ?? {})].join(":");
}

/** @implNote A pull error moves the counts without touching any sequence, so they are part of it. */
function listsFingerprint(status: FolderStatus): string {
  return [treeFingerprint(status), needTotalOf(status), errorTotalOf(status), status.receiveOnlyTotalItems ?? 0].join(":");
}

const browseCache = new RefreshingCache<BrowseEntry[]>(200);

/**
 * One level of the folder's tree below `prefix`, kept per tree fingerprint.
 * @implNote Syncthing walks every item below the prefix to answer, about 6 s at the root of a folder
 * with 900,000 items, so a changed folder is re-read once at a time behind the last answer, and the
 * explorer warms the roots it shows.
 */
export function browseFor(instanceKey: string, client: SyncthingClient, folderId: string, prefix: string, fingerprint: string): Promise<BrowseEntry[]> {
  return browseCache.get(`${instanceKey}\u0000${folderId}\u0000${prefix}`, fingerprint, () => client.browse(folderId, prefix, 0));
}

/** The folder's outstanding, failed and locally changed items, re-read behind the last answer when the folder changes. */
export async function listsFor(instanceKey: string, client: SyncthingClient, folderId: string, needLimit = explorerSettings.needLimit): Promise<FolderLists> {
  const status = await client.folderStatus(folderId);
  return listsWithStatus(instanceKey, client, folderId, status, needLimit);
}

/** As `listsFor`, for a caller that already holds the folder's status. */
export function listsWithStatus(instanceKey: string, client: SyncthingClient, folderId: string, status: FolderStatus, needLimit = explorerSettings.needLimit): Promise<FolderLists> {
  return listsCache.get(`${instanceKey}\u0000${folderId}`, listsFingerprint(status), () => readLists(client, folderId, status, needLimit));
}
