import { RequestError } from "./http.js";

/** A list as read, with the size of Syncthing's answer it was parsed from. */
export interface SizedList {
  bytes: number;
}

interface Entry<T extends SizedList> {
  read: Promise<T>;
  settled: boolean;
  /** Forgotten while it was read: it holds its slot until Syncthing answers, and is then dropped instead of shared. */
  outdated: boolean;
  bytes: number;
  expiresAt: number;
  lastUsed: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface ListLimits {
  /** How long a list is kept after it was read. */
  keptMs: number;
  /** The most the kept lists may add up to, by the bytes of Syncthing's answers. */
  maxTotalBytes: number;
  /** How many lists may be read at once; a further read waits for one of them to finish. */
  maxReading: number;
  /** How long a read waits for one of the reads under way to finish before it is refused. */
  slotWaitMs: number;
}

function readingText(count: number): string {
  return `${count} versions ${count === 1 ? "list is" : "lists are"} being read right now; try again in a moment`;
}

/**
 * Lists read once and shared for `keptMs`, such as each folder's versions while its tree is browsed.
 * @implNote A list is released when it expires, by a timer and on every access; past `maxTotalBytes` the least recently used settled
 * lists go first, and a list still being read is never dropped, so no second read of it starts beside the first. A kept list is
 * forgotten for a fresh read only once a slot is free, so a refused fresh read leaves it shared.
 */
export class SharedLists<T extends SizedList> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly slotWaiters = new Set<() => void>();

  constructor(
    private readonly limits: ListLimits,
    private readonly now: () => number = Date.now,
  ) {}

  async read(key: string, fresh: boolean, start: () => Promise<T>): Promise<T> {
    const waitEndsAt = Date.now() + this.limits.slotWaitMs;
    for (;;) {
      this.dropExpired();
      const entry = this.entries.get(key);
      if (entry && !entry.settled && !entry.outdated) return entry.read;
      if (entry?.settled && !fresh) {
        entry.lastUsed = this.now();
        return entry.read;
      }
      if (entry && !entry.settled) {
        await entry.read.catch(() => undefined);
        continue;
      }
      if (this.readingCount() < this.limits.maxReading) {
        if (entry) this.forget(key);
        return this.begin(key, start);
      }
      if (!(await this.slotFreed(waitEndsAt - Date.now()))) throw new RequestError(409, readingText(this.readingCount()));
    }
  }

  /** Drops the key's list; one still being read keeps its slot until Syncthing answers, and is not kept then. */
  forget(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (!entry.settled) {
      entry.outdated = true;
      return;
    }
    if (entry.timer) clearTimeout(entry.timer);
    this.entries.delete(key);
  }

  /** The keys kept or being read, least recently used first. */
  keys(): string[] {
    this.dropExpired();
    return [...this.entries].sort(([, left], [, right]) => left.lastUsed - right.lastUsed).map(([key]) => key);
  }

  totalBytes(): number {
    return [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  }

  private begin(key: string, start: () => Promise<T>): Promise<T> {
    const read = start();
    const entry: Entry<T> = { read, settled: false, outdated: false, bytes: 0, expiresAt: Infinity, lastUsed: this.now(), timer: null };
    this.entries.set(key, entry);
    read.then(
      (value) => this.settle(key, entry, value.bytes),
      () => this.release(key, entry),
    );
    return read;
  }

  private settle(key: string, entry: Entry<T>, bytes: number): void {
    if (entry.outdated) return this.release(key, entry);
    entry.settled = true;
    entry.bytes = bytes;
    entry.expiresAt = this.now() + this.limits.keptMs;
    entry.timer = setTimeout(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    }, this.limits.keptMs);
    entry.timer.unref?.();
    this.evictOver(key);
    this.wakeSlotWaiters();
  }

  private release(key: string, entry: Entry<T>): void {
    if (this.entries.get(key) === entry) this.entries.delete(key);
    this.wakeSlotWaiters();
  }

  private slotFreed(waitMs: number): Promise<boolean> {
    if (waitMs <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.slotWaiters.delete(wake);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.slotWaiters.delete(wake);
        resolve(false);
      }, waitMs);
      this.slotWaiters.add(wake);
    });
  }

  private wakeSlotWaiters(): void {
    for (const wake of [...this.slotWaiters]) wake();
  }

  private evictOver(keep: string): void {
    for (const key of this.keys()) {
      if (this.totalBytes() <= this.limits.maxTotalBytes) return;
      const entry = this.entries.get(key);
      if (key !== keep && entry?.settled) this.forget(key);
    }
    if (this.totalBytes() > this.limits.maxTotalBytes) this.forget(keep);
  }

  private readingCount(): number {
    return [...this.entries.values()].filter((entry) => !entry.settled).length;
  }

  private dropExpired(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) if (entry.settled && entry.expiresAt <= now) this.forget(key);
  }
}
