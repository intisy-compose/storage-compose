import { goTrimSpace, isIncludeLine } from "./api/ignorePatterns.js";

/** A pattern stripped of its prefixes and of the leading and trailing `**` segments Syncthing expands it with, so an expansion is traced to its line. */
export function patternCore(pattern: string): string {
  let core = pattern.trim();
  for (let previous = ""; previous !== core; ) {
    previous = core;
    core = core.replace(/^(?:!|\(\?[di]\))/, "");
  }
  return core.replace(/^(?:\*\*\/)+/, "").replace(/(?:\/\*\*)+$/, "").replace(/\/+$/, "").toLowerCase();
}

function isPatternLine(line: string): boolean {
  const trimmed = goTrimSpace(line);
  return trimmed !== "" && !trimmed.startsWith("//") && !isIncludeLine(trimmed);
}

/** The cores of the folder's own pattern lines, the only patterns that may be shown. */
export function ownPatternCores(lines: readonly string[]): Set<string> {
  return new Set(lines.filter(isPatternLine).map(patternCore));
}

export const includedFileErrorText = "Syncthing cannot read an included file";

const includeMention = /#include/i;
const invalidPatternError = /invalid pattern "/;
const quotedPattern = /invalid pattern "((?:[^"\\]|\\.)*)"(?: in ignore file)?/g;

/**
 * Syncthing's error text with nothing passed on from an included ignore file. `ownLines` is the folder's own `.stignore`,
 * null when it could not be read, which counts as a file with an `#include`.
 * @implNote Syncthing 2.1.6 expands an `#include` from anywhere the node can read, so its text could quote the node's configuration:
 * an error naming an include is replaced whole, and so is any error other than an invalid pattern in a folder with an include;
 * a quoted invalid pattern is shown only when it is one of the folder's own lines.
 */
export function shownSyncthingError(error: string, ownLines: readonly string[] | null): string {
  const hasInclude = ownLines === null || ownLines.some(isIncludeLine);
  if (includeMention.test(error) || (hasInclude && !invalidPatternError.test(error))) return includedFileErrorText;
  const cores = ownPatternCores(ownLines ?? []);
  return error.replace(quotedPattern, (whole, pattern: string) => (cores.has(patternCore(pattern)) ? whole : "invalid pattern in an included file"));
}

/** An error another host's dashboard already passed through `shownSyncthingError`, checked again with no pattern counted as the folder's own. */
export function reshownForwardedError(error: string): string {
  return shownSyncthingError(error, []);
}
