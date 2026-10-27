import type { LogMessage } from "./types.js";

function lineKey(line: LogMessage): string {
  return `${line.when}\u0000${line.level}\u0000${line.message}`;
}

/**
 * The lines kept after a read of what is new: the kept ones, then each answered line not kept yet, at most `keep` of the newest.
 * @implNote Syncthing writes times to a tenth of a microsecond, which a browser's `Date` cuts to milliseconds, so a line is known by its
 * whole text; one older than the last kept line by the millisecond is left out too.
 */
export function keptLogLines(known: readonly LogMessage[] | null, added: readonly LogMessage[], keep: number): LogMessage[] {
  const kept = known ?? [];
  const seen = new Set(kept.map(lineKey));
  const lastTime = kept.length ? Date.parse(kept[kept.length - 1].when) : Number.NEGATIVE_INFINITY;
  const fresh = added.filter((line) => !seen.has(lineKey(line)) && !(Date.parse(line.when) < lastTime));
  return [...kept, ...fresh].slice(-keep);
}
