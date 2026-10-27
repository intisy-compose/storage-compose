import { RequestError } from "./http.js";

/** A list as read, with the size of Syncthing's answer it was parsed from. */
export interface SizedList {
  bytes: number;
}

interface Entry<T extends SizedList> {
  read: Promise<T>;
  settled: boolean;
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
  /** How many lists may be read at once; a further one is refused. */
  maxReading: number;
}

/**
 * Lists read once and shared for `keptMs`, such as each folder's versions while its tree is browsed.
 * @implNote A list is released when it expires, by a timer and on every access; past `maxTotalBytes` the least recently used settled
 * lists go first, and a list still being read is never dropped, so no second read of it starts beside the first.
 */
export class SharedLists<T extends SizedList> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(
    private readonly limits: ListLimits,
    private readonly now: () => number = Date.now,
  ) {}

  read(key: string, fresh: boolean, start: () => Promise<T>): Promise<T> {
    this.dropExpired();
    const entry = this.entries.get(key);
    if (entry && !entry.settled) return entry.read;
    if (entry && !fresh) {
      entry.lastUsed = this.now();
      return entry.read;
    }
    if (entry) this.forget(key);
    if (this.readingCount() >= this.limits.maxReading) throw new RequestError(409, `${this.readingCount()} versions lists are being read right now; try again in a moment`);
    return this.begin(key, start);
  }

  forget(key: string): void {
    const entry = this.entries.get(key);
    if (entry?.timer) clearTimeout(entry.timer);
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
    const entry: Entry<T> = { read, settled: false, bytes: 0, expiresAt: Infinity, lastUsed: this.now(), timer: null };
    this.entries.set(key, entry);
    read.then(
      (value) => this.settle(key, entry, value.bytes),
      () => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      },
    );
    return read;
  }

  private settle(key: string, entry: Entry<T>, bytes: number): void {
    if (this.entries.get(key) !== entry) return;
    entry.settled = true;
    entry.bytes = bytes;
    entry.expiresAt = this.now() + this.limits.keptMs;
    entry.timer = setTimeout(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    }, this.limits.keptMs);
    entry.timer.unref?.();
    this.evictOver(key);
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
