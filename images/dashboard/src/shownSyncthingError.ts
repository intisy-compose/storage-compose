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

/** What is shown instead of an error that names an `#include`, or of one hidden for another reason. */
export const hiddenErrorTexts = {
  namesInclude: "Syncthing cannot read an included file",
  folderHasInclude: "error hidden: this folder's ignore file has an #include",
  ignoreFileUnread: "error hidden: the folder's ignore file could not be read",
} as const;

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
  if (includeMention.test(error)) return hiddenErrorTexts.namesInclude;
  if (!invalidPatternError.test(error)) {
    if (ownLines === null) return hiddenErrorTexts.ignoreFileUnread;
    if (ownLines.some(isIncludeLine)) return hiddenErrorTexts.folderHasInclude;
  }
  const cores = ownPatternCores(ownLines ?? []);
  return error.replace(quotedPattern, (whole, pattern: string) => (cores.has(patternCore(pattern)) ? whole : "invalid pattern in an included file"));
}

/** An error another host's dashboard already passed through `shownSyncthingError`, checked again with no pattern counted as the folder's own. */
export function reshownForwardedError(error: string): string {
  return shownSyncthingError(error, []);
}

/** What is shown instead of a text read without its folder's `.stignore` that could quote an ignore file. */
export const hiddenUnscopedTexts = {
  namesInclude: "error hidden: it mentions an include",
  quotesPattern: "error hidden: it quotes an ignore pattern; the folder's ignore patterns show it",
} as const;

const unscopedIncludeMention = /#include|\binclude (?:of|file)\b|\bincluded file/i;
const quotesIgnorePattern = /invalid pattern|ignore (?:file|pattern)|\.stignore\b[^\n]*"/i;
const longestShownText = 2000;

/**
 * Syncthing's text read where the folder's `.stignore` is not at hand: an event, a log line, a system error, a restore's per-file
 * error or a refused request's answer; where the lines are at hand, `shownSyncthingError` shows more.
 * @implNote Without them nothing tells whether the folder has an `#include`, so any text that names one (`#include`, `include of`,
 * `include file`, `included file`) or could quote a line of an ignore file is replaced whole; every other text is shown as Syncthing wrote it, cut at 2000 characters.
 */
export function shownUnscopedText(text: string): string {
  if (unscopedIncludeMention.test(text)) return hiddenUnscopedTexts.namesInclude;
  if (quotesIgnorePattern.test(text)) return hiddenUnscopedTexts.quotesPattern;
  return text.length > longestShownText ? `${text.slice(0, longestShownText)}…` : text;
}
