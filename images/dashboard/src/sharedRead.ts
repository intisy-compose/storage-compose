interface Shared<T> {
  startedAt: number;
  settled: boolean;
  value: Promise<T>;
}

/** One read shared by every caller while it runs and until `maxAgeMs` after it started; a failed read is not shared. */
export class SharedRead<T> {
  private current: Shared<T> | null = null;

  constructor(
    private readonly maxAgeMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  read(start: () => Promise<T>): Promise<T> {
    if (this.current && this.isShareable(this.current)) return this.current.value;
    return this.offer(start());
  }

  /** Shares a read another path started, such as the local part of a full build. */
  offer(value: Promise<T>): Promise<T> {
    const entry: Shared<T> = { startedAt: this.now(), settled: false, value };
    this.current = entry;
    value.then(
      () => {
        entry.settled = true;
      },
      () => {
        if (this.current === entry) this.current = null;
      },
    );
    return value;
  }

  isReading(): boolean {
    return this.current !== null && !this.current.settled;
  }

  /** Makes the next read start a new one, as after a write the shared answer is out of date. */
  invalidate(): void {
    this.current = null;
  }

  private isShareable(entry: Shared<T>): boolean {
    return !entry.settled || this.now() - entry.startedAt < this.maxAgeMs;
  }
}

/**
 * Reads shared by key, such as each page of a list, with at most `maxSettled` settled ones kept.
 * @implNote Past the limit the least recently used settled read goes first; one still being read is never dropped, so a page asked
 * for again while it is read never starts a second read beside the first.
 */
export class KeyedSharedReads<T> {
  private readonly reads = new Map<string, SharedRead<T>>();

  constructor(
    private readonly maxAgeMs: number,
    private readonly maxSettled: number,
    private readonly now: () => number = Date.now,
  ) {}

  read(key: string, start: () => Promise<T>): Promise<T> {
    const entry = this.reads.get(key) ?? new SharedRead<T>(this.maxAgeMs, this.now);
    this.reads.delete(key);
    this.reads.set(key, entry);
    const value = entry.read(start);
    value.then(
      () => this.dropOverLimit(),
      () => undefined,
    );
    return value;
  }

  /** The keys kept, least recently used first. */
  keys(): string[] {
    return [...this.reads.keys()];
  }

  private dropOverLimit(): void {
    let settled = [...this.reads.values()].filter((entry) => !entry.isReading()).length;
    for (const [key, entry] of this.reads) {
      if (settled <= this.maxSettled) return;
      if (entry.isReading()) continue;
      this.reads.delete(key);
      settled -= 1;
    }
  }
}

/**
 * A read shared by scope: a full read shares any recent build, a local-scope read only a local-scope one.
 * @implNote Another host reads this one with `scope=local`; sharing a full build there would make it
 * wait on this host's reads of other hosts and their timeouts, and two hosts could wait on each other.
 */
export class ScopedShare<T> {
  private readonly anyScope: SharedRead<T>;
  private readonly localScope: SharedRead<T>;

  constructor(maxAgeMs: number, now: () => number = Date.now) {
    this.anyScope = new SharedRead<T>(maxAgeMs, now);
    this.localScope = new SharedRead<T>(maxAgeMs, now);
  }

  offer(scope: "all" | "local", value: Promise<T>): Promise<T> {
    this.anyScope.offer(value);
    if (scope === "local") this.localScope.offer(value);
    return value;
  }

  read(scope: "all" | "local", start: () => Promise<T>): Promise<T> {
    if (scope === "all") return this.anyScope.read(start);
    return this.localScope.read(() => this.anyScope.offer(start()));
  }

  invalidate(): void {
    this.anyScope.invalidate();
    this.localScope.invalidate();
  }
}
