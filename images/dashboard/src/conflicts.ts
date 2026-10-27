import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { deviceDisplayName } from "./api/deviceText.js";
import type { ConflictFile } from "./api/types.js";
import { conflictSettings, conflictsDirectory } from "./settings.js";
import type { SyncthingClient, SyncthingEvent, SyncthingFolderConfig } from "./syncthing.js";

export interface ConflictName {
  original: string;
  shortDeviceId: string;
}

const conflictPattern = /^(.*)\.sync-conflict-\d{8}-\d{6}-([A-Z2-7]{7})(\.[^/\\]*)?$/;

/** The file a conflict copy was kept of and the short ID of the device whose change lost, or null for a name that is no conflict copy. */
export function conflictNameOf(path: string): ConflictName | null {
  const nameStart = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1;
  const match = conflictPattern.exec(path.slice(nameStart));
  return match ? { original: `${path.slice(0, nameStart)}${match[1]}${match[3] ?? ""}`, shortDeviceId: match[2] } : null;
}

/** A conflict copy as the index keeps it; its original and device are read from the path. */
export interface StoredConflict {
  path: string;
  size: number;
  modified: string;
}

export function conflictFile(stored: StoredConflict, devices: { deviceID: string; name?: string }[]): ConflictFile {
  const name = conflictNameOf(stored.path);
  const device = name ? devices.find((candidate) => candidate.deviceID.startsWith(`${name.shortDeviceId}-`)) : undefined;
  return {
    path: stored.path,
    original: name?.original ?? stored.path,
    size: stored.size,
    modified: stored.modified,
    device: device ? deviceDisplayName(device.name, device.deviceID) : (name?.shortDeviceId ?? null),
  };
}

/** How long a folder whose sweep failed `failures` times in a row waits before the next try: doubling from `firstMs`, at most `maxMs`. */
export function retryDelayMs(failures: number, firstMs: number, maxMs: number): number {
  return Math.min(maxMs, firstMs * 2 ** Math.max(0, failures - 1));
}

/** What the index reads of one Syncthing; a `SyncthingClient` is one. */
export type ConflictReader = Pick<SyncthingClient, "browse" | "file" | "folderStatus" | "folders">;

export interface ConflictInstance {
  nodeId: string;
  client: ConflictReader;
}

export interface ConflictIndexOptions {
  directory: string;
  /** How long a node's folder list is trusted before it is read again for folders added or removed. */
  recheckMs: number;
  /** How long a move of the sequence alone waits before it is written, so a busy folder is not written on every index update. */
  sequenceWriteDelayMs: number;
  /** The pause between two directory reads of a sweep, so the instance keeps answering interactive reads. */
  browsePauseMs: number;
  /** How often every folder is checked against its current sequence, for updates lost in a way nothing reported. */
  verifyEveryMs: number;
  retryFirstMs: number;
  retryMaxMs: number;
  /** The most conflict copies kept per folder; beyond it the folder says there are more. */
  maxConflicts: number;
  report: (message: string) => void;
}

const defaultOptions: ConflictIndexOptions = {
  directory: conflictsDirectory,
  recheckMs: 60_000,
  sequenceWriteDelayMs: 10_000,
  browsePauseMs: conflictSettings.browsePauseMs,
  verifyEveryMs: conflictSettings.verifyEveryMs,
  retryFirstMs: 5 * 60_000,
  retryMaxMs: 6 * 3_600_000,
  maxConflicts: 1000,
  report: (message) => console.error(message),
};

interface StoredIndex {
  nodeId: string;
  folderId: string;
  sequence: number;
  sweptAt: string;
  more?: boolean;
  conflicts: StoredConflict[];
}

/** A sweep under way, kept across a failure so the next try goes on from the directories still to read. */
interface SweepState {
  directories: string[];
  found: Map<string, StoredConflict>;
  more: boolean;
  /** The copies index updates looked up meanwhile, which win over what the sweep read. */
  touched: Map<string, StoredConflict | null>;
}

interface FolderIndex {
  nodeId: string;
  folderId: string;
  /** Null until the folder was searched once, here or in a stored index. */
  conflicts: Map<string, StoredConflict> | null;
  more: boolean;
  /** The newest local index sequence seen, by a sweep's start or an index update. */
  sequence: number;
  sweptAt: string | null;
  needsSweep: boolean;
  sweep: SweepState | null;
  failures: number;
  retryAt: number;
  writeTimer: NodeJS.Timeout | null;
  writing: Promise<void>;
}

/** A folder's conflict copies; `complete` is false while it is still being searched, `more` when it holds more than the index keeps. */
export interface ConflictListing {
  conflicts: StoredConflict[];
  complete: boolean;
  more: boolean;
}

const directoryType = "FILE_INFO_TYPE_DIRECTORY";

function slashed(path: string): string {
  return path.replaceAll("\\", "/");
}

function isSweepable(folder: SyncthingFolderConfig): boolean {
  return !folder.paused && folder.type !== "receiveencrypted";
}

function keyOf(nodeId: string, folderId: string): string {
  return `${nodeId}\u0000${folderId}`;
}

let temporaryNames = 0;

/**
 * Per folder of each local Syncthing, the conflict copies it holds, kept in `<directory>/<nodeId>-<folderId>.json`.
 * @implNote A folder is searched by a sweep that lists one directory per `/rest/db/browse` call (`levels=0`), one call
 * in flight per instance and a pause between calls. A whole top directory (`levels=-1`) is not bounded: on pc's
 * `documents` one top directory holds 912,197 of 927,962 items and answered 333 MB of JSON in 21 s. After the sweep,
 * `LocalIndexUpdated` keeps the index current. Its `sequence` is not a count: Syncthing 2.1.6 moved it from 10 to 13
 * for one pulled item, so a jump proves nothing missed. Updates are lost while the dashboard is down, after the instance
 * restarted, when a poll overflows Syncthing's event buffer or after a poll failed; then the index is trusted only while
 * its sequence is the folder's current one. Only an index that is complete is written, so a stored sequence always
 * means "everything up to here was seen".
 */
export class ConflictIndexes {
  private readonly options: ConflictIndexOptions;
  private readonly indexes = new Map<string, FolderIndex>();
  private readonly clients = new Map<string, ConflictReader>();
  private readonly checkedAt = new Map<string, number>();
  private readonly verifiedAt = new Map<string, number>();
  private readonly sweeps = new Map<string, Promise<void>>();
  private readonly updates = new Map<string, Promise<void>>();
  private reconciling: Promise<void> | null = null;
  private filesCheckedAt = Number.NEGATIVE_INFINITY;
  private stopped = false;

  constructor(options: Partial<ConflictIndexOptions> = {}) {
    this.options = { ...defaultOptions, ...options };
  }

  /**
   * Follows the instances that exist now: new folders are loaded or swept, removed ones forgotten.
   * @param keptNodeIds the nodes this host still keeps, attached or not; the indexes of any other node are deleted. Left out, nothing is deleted.
   */
  reconcile(instances: ConflictInstance[], keptNodeIds?: ReadonlySet<string>): Promise<void> {
    this.reconciling ??= this.reconcileNow(instances, keptNodeIds).finally(() => {
      this.reconciling = null;
    });
    return this.reconciling;
  }

  /** Counts the conflict copies of a folder; null while it was never searched. */
  count(nodeId: string, folderId: string): number | null {
    return this.indexes.get(keyOf(nodeId, folderId))?.conflicts?.size ?? null;
  }

  /** Whether the folder holds more conflict copies than the index keeps. */
  hasMore(nodeId: string, folderId: string): boolean {
    return this.indexes.get(keyOf(nodeId, folderId))?.more ?? false;
  }

  /** The folder's conflict copies by path, or null for a folder the index does not follow. */
  list(nodeId: string, folderId: string): ConflictListing | null {
    const index = this.indexes.get(keyOf(nodeId, folderId));
    if (!index) return null;
    const conflicts = [...(index.conflicts?.values() ?? [])].sort((left, right) => left.path.localeCompare(right.path));
    return { conflicts, complete: isComplete(index), more: index.more };
  }

  /** Takes one event of the node's feed; only `LocalIndexUpdated` changes the index, in the order the events came. */
  takeEvent(nodeId: string, event: SyncthingEvent): void {
    if (event.type !== "LocalIndexUpdated" || this.stopped) return;
    const data = (event.data ?? {}) as IndexUpdate;
    this.queue(nodeId, () => this.applyIndexUpdate(nodeId, data), "an index update could not be read");
  }

  /** Checks each of the node's folders against its current sequence, as updates may be missing from the feed. */
  mayHaveMissedUpdates(nodeId: string): void {
    if (this.stopped) return;
    this.queue(nodeId, () => this.verify(nodeId), "could not be checked for missed updates");
  }

  /** Resolves once no sweep and no index update is running. */
  async idle(): Promise<void> {
    while (this.reconciling || this.sweeps.size || this.updates.size) {
      await Promise.all([this.reconciling, ...this.sweeps.values(), ...this.updates.values()]);
    }
    await Promise.all([...this.indexes.values()].map((index) => index.writing));
  }

  stop(): void {
    this.stopped = true;
    this.clients.clear();
    for (const index of this.indexes.values()) if (index.writeTimer) clearTimeout(index.writeTimer);
  }

  /** Keeps the node's index work in one line, so an update never overtakes an earlier one. */
  private queue(nodeId: string, work: () => Promise<void>, failure: string): void {
    const previous = this.updates.get(nodeId) ?? Promise.resolve();
    const next = previous.then(work).catch((error: Error) => this.options.report(`conflicts: ${nodeId}: ${failure}: ${error.message}`));
    this.updates.set(nodeId, next);
    void next.finally(() => {
      if (this.updates.get(nodeId) === next) this.updates.delete(nodeId);
    });
  }

  private async reconcileNow(instances: ConflictInstance[], keptNodeIds: ReadonlySet<string> | undefined): Promise<void> {
    const present = new Set(instances.map((instance) => instance.nodeId));
    for (const nodeId of this.clients.keys()) if (!present.has(nodeId)) this.clients.delete(nodeId);
    if (keptNodeIds) await this.forgetNodesNotKept(new Set([...keptNodeIds, ...present]));
    for (const instance of instances) {
      if (this.stopped) return;
      this.clients.set(instance.nodeId, instance.client);
      if (this.isVerifyDue(instance.nodeId)) this.mayHaveMissedUpdates(instance.nodeId);
      const checked = this.checkedAt.get(instance.nodeId);
      if (checked === undefined || Date.now() - checked >= this.options.recheckMs) {
        const folders = await instance.client.folders().catch(() => null);
        if (!folders) continue;
        this.checkedAt.set(instance.nodeId, Date.now());
        await this.followFolders(instance, folders);
      }
      this.startSweeps(instance.nodeId);
    }
  }

  /** @implNote A node seen for the first time is checked by loading its indexes, so its first periodic check is a whole interval later. */
  private isVerifyDue(nodeId: string): boolean {
    const verified = this.verifiedAt.get(nodeId);
    if (verified === undefined) {
      this.verifiedAt.set(nodeId, Date.now());
      return false;
    }
    return Date.now() - verified >= this.options.verifyEveryMs;
  }

  /** @implNote The stored files are read at most once per `recheckMs`, as `reconcile` runs with every `/api/nodes`. */
  private async forgetNodesNotKept(kept: ReadonlySet<string>): Promise<void> {
    if (!kept.size) return;
    for (const index of this.indexes.values()) if (!kept.has(index.nodeId)) await this.forget(index);
    if (Date.now() - this.filesCheckedAt < this.options.recheckMs) return;
    this.filesCheckedAt = Date.now();
    for (const name of await readdir(this.options.directory).catch(() => [] as string[])) {
      if (!name.endsWith(".json")) continue;
      const stored = await readStored(join(this.options.directory, name));
      if (!stored || !kept.has(stored.nodeId)) await rm(join(this.options.directory, name), { force: true });
    }
  }

  private async followFolders(instance: ConflictInstance, folders: SyncthingFolderConfig[]): Promise<void> {
    const configured = new Set(folders.map((folder) => folder.id));
    for (const index of this.indexesOf(instance.nodeId)) if (!configured.has(index.folderId)) await this.forget(index);
    for (const folder of folders.filter(isSweepable)) {
      if (!this.indexes.has(keyOf(instance.nodeId, folder.id))) await this.load(instance, folder.id);
    }
  }

  private indexesOf(nodeId: string): FolderIndex[] {
    return [...this.indexes.values()].filter((index) => index.nodeId === nodeId);
  }

  private filePath(nodeId: string, folderId: string): string {
    return join(this.options.directory, `${nodeId}-${encodeURIComponent(folderId)}.json`);
  }

  /** A stored index whose sequence the folder still has is taken as it is; any other is shown until a new sweep replaces it. */
  private async load(instance: ConflictInstance, folderId: string): Promise<void> {
    const stored = await readStored(this.filePath(instance.nodeId, folderId));
    const status = stored ? await instance.client.folderStatus(folderId).catch(() => null) : null;
    const isCurrent = stored !== null && status !== null && (status.sequence ?? 0) === stored.sequence;
    this.indexes.set(keyOf(instance.nodeId, folderId), {
      nodeId: instance.nodeId,
      folderId,
      conflicts: stored ? new Map(stored.conflicts.map((conflict) => [conflict.path, conflict])) : null,
      more: stored?.more === true,
      sequence: stored?.sequence ?? 0,
      sweptAt: stored?.sweptAt ?? null,
      needsSweep: !isCurrent,
      sweep: null,
      failures: 0,
      retryAt: 0,
      writeTimer: null,
      writing: Promise.resolve(),
    });
  }

  private async forget(index: FolderIndex): Promise<void> {
    if (index.writeTimer) clearTimeout(index.writeTimer);
    this.indexes.delete(keyOf(index.nodeId, index.folderId));
    await index.writing;
    await rm(this.filePath(index.nodeId, index.folderId), { force: true });
  }

  /** At most one sweep runs per instance; it takes the instance's folders that need one and are not waiting after a failure, one after the other. */
  private startSweeps(nodeId: string): void {
    if (this.sweeps.has(nodeId) || this.stopped) return;
    const run = async () => {
      for (let index = this.nextSweep(nodeId); index; index = this.nextSweep(nodeId)) await this.sweep(index);
    };
    const sweeping = run().finally(() => this.sweeps.delete(nodeId));
    this.sweeps.set(nodeId, sweeping);
  }

  private nextSweep(nodeId: string): FolderIndex | undefined {
    if (!this.clients.has(nodeId) || this.stopped) return undefined;
    const now = Date.now();
    return this.indexesOf(nodeId).find((index) => index.needsSweep && index.retryAt <= now);
  }

  private client(nodeId: string): ConflictReader {
    const client = this.clients.get(nodeId);
    if (!client || this.stopped) throw new Error(`${nodeId} is no longer followed`);
    return client;
  }

  private async sweep(index: FolderIndex): Promise<void> {
    index.needsSweep = false;
    try {
      if (!index.sweep) {
        const status = await this.client(index.nodeId).folderStatus(index.folderId);
        index.sequence = Math.max(index.sequence, status.sequence ?? 0);
        index.sweep = { directories: [""], found: new Map(), more: false, touched: new Map() };
      }
      const state = index.sweep;
      await this.searchFolder(index, state);
      if (index.sweep !== state) return;
      for (const [path, conflict] of state.touched) {
        if (conflict) state.more = keep(state.found, conflict, this.options.maxConflicts) || state.more;
        else state.found.delete(path);
      }
      index.conflicts = state.found;
      index.more = state.more;
      index.sweep = null;
      index.failures = 0;
      index.retryAt = 0;
      index.sweptAt = new Date().toISOString();
      this.write(index);
    } catch (error) {
      index.needsSweep = true;
      index.failures += 1;
      index.retryAt = Date.now() + retryDelayMs(index.failures, this.options.retryFirstMs, this.options.retryMaxMs);
      if (!this.stopped) this.options.report(`conflicts: ${index.folderId} on ${index.nodeId} could not be searched (try ${index.failures}): ${(error as Error).message}`);
    }
  }

  /** Reads the directories still to read; a directory leaves the list only once it was read, so a failed sweep goes on from there. */
  private async searchFolder(index: FolderIndex, state: SweepState): Promise<void> {
    while (state.directories.length && index.sweep === state) {
      const directory = state.directories[0];
      const entries = await this.client(index.nodeId).browse(index.folderId, directory, 0);
      state.directories.shift();
      for (const entry of entries) {
        const path = directory ? `${directory}/${entry.name}` : entry.name;
        if (entry.type === directoryType) state.directories.push(path);
        else if (conflictNameOf(path)) state.more = keep(state.found, { path, size: entry.size, modified: entry.modTime }, this.options.maxConflicts) || state.more;
      }
      if (this.options.browsePauseMs > 0 && state.directories.length) await delay(this.options.browsePauseMs);
    }
  }

  /** @implNote A sweep under way is dropped, not resumed: the updates it was waiting for may be among those missed. */
  private async verify(nodeId: string): Promise<void> {
    this.verifiedAt.set(nodeId, Date.now());
    for (const index of this.indexesOf(nodeId)) {
      if (index.needsSweep && !index.sweep) continue;
      const status = await this.client(nodeId).folderStatus(index.folderId).catch(() => null);
      if (!index.sweep && status && (status.sequence ?? 0) === index.sequence) continue;
      index.sweep = null;
      index.needsSweep = true;
      index.failures = 0;
      index.retryAt = 0;
    }
    this.startSweeps(nodeId);
  }

  private async applyIndexUpdate(nodeId: string, data: IndexUpdate): Promise<void> {
    const index = this.indexes.get(keyOf(nodeId, String(data.folder ?? "")));
    if (!index || (index.conflicts === null && index.sweep === null)) return;
    const sequence = Number(data.sequence);
    if (!Number.isFinite(sequence) || sequence <= index.sequence) return;
    index.sequence = sequence;
    const filenames = Array.isArray(data.filenames) ? data.filenames.filter((name): name is string => typeof name === "string") : [];
    let changed = false;
    for (const name of filenames.filter((candidate) => conflictNameOf(candidate))) {
      const file = await this.client(nodeId).file(index.folderId, name);
      const path = slashed(name);
      const isPresent = file !== null && !file.global.deleted && !file.global.ignored && file.global.type !== directoryType;
      const conflict = isPresent ? { path, size: file.global.size, modified: file.global.modified } : null;
      index.sweep?.touched.set(path, conflict);
      if (!index.conflicts) continue;
      if (conflict) index.more = keep(index.conflicts, conflict, this.options.maxConflicts) || index.more;
      else index.conflicts.delete(path);
      changed = true;
    }
    if (isShortList(data, filenames)) await this.verify(nodeId);
    else if (changed) this.write(index);
    else this.writeLater(index);
  }

  private writeLater(index: FolderIndex): void {
    if (index.writeTimer || !isComplete(index) || this.stopped) return;
    index.writeTimer = setTimeout(() => this.write(index), this.options.sequenceWriteDelayMs);
    index.writeTimer.unref();
  }

  /** Writes the index once the writes before it are done, and only while it is complete. */
  private write(index: FolderIndex): void {
    if (index.writeTimer) clearTimeout(index.writeTimer);
    index.writeTimer = null;
    index.writing = index.writing
      .then(() => this.writeNow(index))
      .catch((error: Error) => this.options.report(`conflicts: ${index.folderId} on ${index.nodeId} could not be stored: ${error.message}`));
  }

  private async writeNow(index: FolderIndex): Promise<void> {
    if (!isComplete(index) || this.indexes.get(keyOf(index.nodeId, index.folderId)) !== index) return;
    const stored: StoredIndex = { nodeId: index.nodeId, folderId: index.folderId, sequence: index.sequence, sweptAt: index.sweptAt ?? new Date().toISOString(), more: index.more, conflicts: [...index.conflicts!.values()] };
    const path = this.filePath(index.nodeId, index.folderId);
    temporaryNames += 1;
    const temporary = `${path}.${process.pid}-${temporaryNames}.new`;
    await mkdir(this.options.directory, { recursive: true });
    await writeFile(temporary, `${JSON.stringify(stored)}\n`);
    await rename(temporary, path);
  }
}

interface IndexUpdate {
  folder?: unknown;
  items?: unknown;
  filenames?: unknown;
  sequence?: unknown;
}

function isComplete(index: FolderIndex): boolean {
  return index.conflicts !== null && !index.needsSweep && index.sweep === null;
}

/** An update that names fewer items than it counts may hide a conflict copy; the sequence check decides whether the folder is read again. */
function isShortList(data: IndexUpdate, filenames: string[]): boolean {
  const items = Number(data.items);
  return !Array.isArray(data.filenames) || (Number.isFinite(items) && filenames.length < items);
}

/** Adds or updates the copy unless the index is full; true when a copy was left out. */
function keep(conflicts: Map<string, StoredConflict>, conflict: StoredConflict, max: number): boolean {
  if (!conflicts.has(conflict.path) && conflicts.size >= max) return true;
  conflicts.set(conflict.path, conflict);
  return false;
}

async function readStored(path: string): Promise<StoredIndex | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<StoredIndex>;
    return typeof parsed.nodeId === "string" && typeof parsed.sequence === "number" && Array.isArray(parsed.conflicts) ? (parsed as StoredIndex) : null;
  } catch {
    return null;
  }
}

export const conflictIndexes = new ConflictIndexes();
