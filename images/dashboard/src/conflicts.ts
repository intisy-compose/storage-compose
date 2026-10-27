import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deviceDisplayName } from "./api/deviceText.js";
import type { ConflictFile } from "./api/types.js";
import { conflictsDirectory } from "./settings.js";
import type { SyncthingClient, SyncthingEvent, SyncthingFolderConfig } from "./syncthing.js";

export interface ConflictName {
  original: string;
  shortDeviceId: string;
}

const conflictPattern = /^(.*)\.sync-conflict-\d{8}-\d{6}-([A-Z2-7]{7})(.*)$/;

/** The file a conflict copy was kept of and the short ID of the device whose change lost, or null for a name that is no conflict copy. */
export function conflictNameOf(path: string): ConflictName | null {
  const nameStart = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1;
  const match = conflictPattern.exec(path.slice(nameStart));
  return match ? { original: `${path.slice(0, nameStart)}${match[1]}${match[3]}`, shortDeviceId: match[2] } : null;
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
}

const defaultOptions: ConflictIndexOptions = { directory: conflictsDirectory, recheckMs: 60_000, sequenceWriteDelayMs: 10_000 };

interface StoredIndex {
  nodeId: string;
  folderId: string;
  sequence: number;
  sweptAt: string;
  conflicts: StoredConflict[];
}

interface FolderIndex {
  nodeId: string;
  folderId: string;
  /** Null until the folder was searched once, here or in a stored index. */
  conflicts: Map<string, StoredConflict> | null;
  /** The folder's local index sequence the conflicts are known up to. */
  sequence: number;
  sweptAt: string | null;
  needsSweep: boolean;
  sweepFailed: boolean;
  /** While a sweep runs: the copies index updates looked up meanwhile, which win over what the sweep read. */
  touched: Map<string, StoredConflict | null> | null;
  writeTimer: NodeJS.Timeout | null;
}

const directoryType = "FILE_INFO_TYPE_DIRECTORY";

function slashed(path: string): string {
  return path.replaceAll("\\", "/");
}

function isSweepable(folder: SyncthingFolderConfig): boolean {
  return !folder.paused && folder.type !== "receiveencrypted";
}

/**
 * Per folder of each local Syncthing, the conflict copies it holds, kept in `<directory>/<nodeId>-<folderId>.json`.
 * @implNote A folder is searched by a sweep that lists one directory per `/rest/db/browse` call (`levels=0`), one call
 * in flight per instance. A whole top directory (`levels=-1`) is not bounded: on pc's `documents` one top directory
 * holds 912,197 of 927,962 items and answered 333 MB of JSON in 21 s. After the sweep, `LocalIndexUpdated` keeps the
 * index current. Its `sequence` is not a count: Syncthing 2.1.6 moved it from 10 to 13 for one pulled item, so a jump
 * proves nothing missed. Updates are missed only while the dashboard is down or after the instance restarted, so a
 * stored index, and every index of a restarted instance, is trusted only while its sequence is the folder's current one.
 */
export class ConflictIndexes {
  private readonly options: ConflictIndexOptions;
  private readonly indexes = new Map<string, FolderIndex>();
  private readonly clients = new Map<string, ConflictReader>();
  private readonly checkedAt = new Map<string, number>();
  private readonly sweeps = new Map<string, Promise<void>>();
  private readonly updates = new Map<string, Promise<void>>();
  private reconciling: Promise<void> | null = null;
  private stopped = false;

  constructor(options: Partial<ConflictIndexOptions> = {}) {
    this.options = { ...defaultOptions, ...options };
  }

  /** Follows the instances that exist now: new folders are loaded or swept, removed ones forgotten. */
  reconcile(instances: ConflictInstance[]): Promise<void> {
    this.reconciling ??= this.reconcileNow(instances).finally(() => {
      this.reconciling = null;
    });
    return this.reconciling;
  }

  /** Counts the conflict copies of a folder; null while it was never searched. */
  count(nodeId: string, folderId: string): number | null {
    return this.indexes.get(keyOf(nodeId, folderId))?.conflicts?.size ?? null;
  }

  /** The folder's conflict copies by path, or null for a folder the index does not follow. */
  list(nodeId: string, folderId: string): { conflicts: StoredConflict[]; complete: boolean } | null {
    const index = this.indexes.get(keyOf(nodeId, folderId));
    if (!index) return null;
    const conflicts = [...(index.conflicts?.values() ?? [])].sort((left, right) => left.path.localeCompare(right.path));
    return { conflicts, complete: index.conflicts !== null && !index.needsSweep && index.touched === null };
  }

  /** Takes one event of the node's feed; only `LocalIndexUpdated` changes the index, in the order the events came. */
  takeEvent(nodeId: string, event: SyncthingEvent): void {
    if (event.type !== "LocalIndexUpdated" || this.stopped) return;
    const data = (event.data ?? {}) as { folder?: unknown; items?: unknown; filenames?: unknown; sequence?: unknown };
    const previous = this.updates.get(nodeId) ?? Promise.resolve();
    const next = previous.then(() => this.applyIndexUpdate(nodeId, data)).catch((error: Error) => console.error(`conflicts: an index update of ${nodeId} could not be read: ${error.message}`));
    this.track(nodeId, next);
  }

  /** Keeps the node's index work in one line, so an update never overtakes an earlier one. */
  private track(nodeId: string, next: Promise<void>): void {
    this.updates.set(nodeId, next);
    void next.finally(() => {
      if (this.updates.get(nodeId) === next) this.updates.delete(nodeId);
    });
  }

  private async verify(nodeId: string): Promise<void> {
    for (const index of this.indexesOf(nodeId)) {
      if (index.needsSweep || index.touched) continue;
      const status = await this.client(nodeId).folderStatus(index.folderId).catch(() => null);
      if (status && (status.sequence ?? 0) === index.sequence) continue;
      index.needsSweep = true;
      index.sweepFailed = false;
    }
    this.startSweeps(nodeId);
  }

  /** Checks each of the node's folders against its current sequence, as the updates since the restart are not in the feed. */
  instanceRestarted(nodeId: string): void {
    if (this.stopped) return;
    const previous = this.updates.get(nodeId) ?? Promise.resolve();
    const next = previous.then(() => this.verify(nodeId)).catch((error: Error) => console.error(`conflicts: ${nodeId} could not be checked after its restart: ${error.message}`));
    this.track(nodeId, next);
  }

  /** Resolves once no sweep and no index update is running. */
  async idle(): Promise<void> {
    while (this.reconciling || this.sweeps.size || this.updates.size) {
      await Promise.all([this.reconciling, ...this.sweeps.values(), ...this.updates.values()]);
    }
  }

  stop(): void {
    this.stopped = true;
    this.clients.clear();
    for (const index of this.indexes.values()) if (index.writeTimer) clearTimeout(index.writeTimer);
  }

  private async reconcileNow(instances: ConflictInstance[]): Promise<void> {
    const present = new Set(instances.map((instance) => instance.nodeId));
    for (const nodeId of this.clients.keys()) if (!present.has(nodeId)) this.clients.delete(nodeId);
    for (const instance of instances) {
      if (this.stopped) return;
      this.clients.set(instance.nodeId, instance.client);
      const checked = this.checkedAt.get(instance.nodeId);
      if (checked !== undefined && Date.now() - checked < this.options.recheckMs) continue;
      const folders = await instance.client.folders().catch(() => null);
      if (!folders) continue;
      this.checkedAt.set(instance.nodeId, Date.now());
      await this.followFolders(instance, folders);
      for (const index of this.indexesOf(instance.nodeId)) index.sweepFailed = false;
      this.startSweeps(instance.nodeId);
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
      sequence: stored?.sequence ?? 0,
      sweptAt: stored?.sweptAt ?? null,
      needsSweep: !isCurrent,
      sweepFailed: false,
      touched: null,
      writeTimer: null,
    });
  }

  private async forget(index: FolderIndex): Promise<void> {
    if (index.writeTimer) clearTimeout(index.writeTimer);
    this.indexes.delete(keyOf(index.nodeId, index.folderId));
    await rm(this.filePath(index.nodeId, index.folderId), { force: true });
  }

  /** At most one sweep runs per instance; it takes the instance's folders that need one, one after the other. */
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
    return this.indexesOf(nodeId).find((index) => index.needsSweep && !index.sweepFailed && this.indexes.get(keyOf(index.nodeId, index.folderId)) === index);
  }

  private client(nodeId: string): ConflictReader {
    const client = this.clients.get(nodeId);
    if (!client || this.stopped) throw new Error(`${nodeId} is no longer followed`);
    return client;
  }

  private async sweep(index: FolderIndex): Promise<void> {
    index.needsSweep = false;
    index.touched = new Map();
    try {
      const status = await this.client(index.nodeId).folderStatus(index.folderId);
      index.sequence = status.sequence ?? 0;
      const found = await this.searchFolder(index);
      for (const [path, conflict] of index.touched) {
        if (conflict) found.set(path, conflict);
        else found.delete(path);
      }
      index.conflicts = found;
      index.sweptAt = new Date().toISOString();
      await this.write(index);
    } catch (error) {
      index.needsSweep = true;
      index.sweepFailed = true;
      console.error(`conflicts: ${index.folderId} on ${index.nodeId} could not be searched: ${(error as Error).message}`);
    } finally {
      index.touched = null;
    }
  }

  private async searchFolder(index: FolderIndex): Promise<Map<string, StoredConflict>> {
    const found = new Map<string, StoredConflict>();
    const directories = [""];
    while (directories.length) {
      const directory = directories.shift()!;
      for (const entry of await this.client(index.nodeId).browse(index.folderId, directory, 0)) {
        const path = directory ? `${directory}/${entry.name}` : entry.name;
        if (entry.type === directoryType) directories.push(path);
        else if (conflictNameOf(path)) found.set(path, { path, size: entry.size, modified: entry.modTime });
      }
    }
    return found;
  }

  private async applyIndexUpdate(nodeId: string, data: { folder?: unknown; items?: unknown; filenames?: unknown; sequence?: unknown }): Promise<void> {
    const index = this.indexes.get(keyOf(nodeId, String(data.folder ?? "")));
    if (!index || (index.conflicts === null && index.touched === null)) return;
    const sequence = Number(data.sequence);
    const items = Number(data.items);
    if (!Number.isFinite(sequence) || sequence <= index.sequence) return;
    const filenames = Array.isArray(data.filenames) ? data.filenames.filter((name): name is string => typeof name === "string") : null;
    if (filenames === null || (Number.isFinite(items) && filenames.length < items)) {
      index.sequence = sequence;
      index.needsSweep = true;
      this.startSweeps(nodeId);
      return;
    }
    index.sequence = sequence;
    let changed = false;
    for (const name of filenames.filter((candidate) => conflictNameOf(candidate))) {
      const file = await this.client(nodeId).file(index.folderId, name);
      const path = slashed(name);
      const isPresent = file !== null && !file.global.deleted && !file.global.ignored;
      const conflict = isPresent ? { path, size: file.global.size, modified: file.global.modified } : null;
      index.touched?.set(path, conflict);
      if (!index.conflicts) continue;
      if (conflict) index.conflicts.set(path, conflict);
      else index.conflicts.delete(path);
      changed = true;
    }
    if (changed) await this.write(index);
    else this.writeLater(index);
  }

  private writeLater(index: FolderIndex): void {
    if (index.writeTimer || index.conflicts === null || this.stopped) return;
    index.writeTimer = setTimeout(() => void this.write(index).catch((error: Error) => console.error(`conflicts: ${index.folderId} could not be stored: ${error.message}`)), this.options.sequenceWriteDelayMs);
    index.writeTimer.unref();
  }

  private async write(index: FolderIndex): Promise<void> {
    if (index.writeTimer) clearTimeout(index.writeTimer);
    index.writeTimer = null;
    if (index.conflicts === null || this.indexes.get(keyOf(index.nodeId, index.folderId)) !== index) return;
    const stored: StoredIndex = { nodeId: index.nodeId, folderId: index.folderId, sequence: index.sequence, sweptAt: index.sweptAt ?? new Date().toISOString(), conflicts: [...index.conflicts.values()] };
    const path = this.filePath(index.nodeId, index.folderId);
    await mkdir(this.options.directory, { recursive: true });
    await writeFile(`${path}.new`, `${JSON.stringify(stored)}\n`);
    await rename(`${path}.new`, path);
  }
}

function keyOf(nodeId: string, folderId: string): string {
  return `${nodeId}\u0000${folderId}`;
}

async function readStored(path: string): Promise<StoredIndex | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<StoredIndex>;
    return typeof parsed.sequence === "number" && Array.isArray(parsed.conflicts) ? (parsed as StoredIndex) : null;
  } catch {
    return null;
  }
}

export const conflictIndexes = new ConflictIndexes();
