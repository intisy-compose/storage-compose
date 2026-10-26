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

  private isShareable(entry: Shared<T>): boolean {
    return !entry.settled || this.now() - entry.startedAt < this.maxAgeMs;
  }
}
