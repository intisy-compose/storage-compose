/** The lines of a typed `.stignore`: one per line break, without the empty lines a textarea leaves at the end. */
export function ignoreLinesOf(text: string): string[] {
  const lines = text.split(/\r?\n/);
  while (lines.length && lines.at(-1)?.trim() === "") lines.pop();
  return lines;
}

/** An `#include` line read as Syncthing 2.1.6 reads it: the trimmed line starts with `#include`, the path is what follows its first space. */
interface IncludeLine {
  /** Null when the line has no space, which Syncthing refuses as an include without a path. */
  path: string | null;
}

/**
 * Go's `unicode.IsSpace`, which `strings.TrimSpace` strips: unlike JavaScript's `trim`, it takes U+0085 and leaves U+FEFF.
 * @implNote Kept as code points: the compiler writes U+2028 and U+2029 into a regular expression literal raw, which breaks it.
 */
const goSpaceCodes = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000]);

function isGoSpace(text: string, index: number): boolean {
  return goSpaceCodes.has(text.charCodeAt(index));
}

/** Go's `strings.TrimSpace`, so a line is read exactly as Syncthing reads it. */
export function goTrimSpace(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isGoSpace(text, start)) start += 1;
  while (end > start && isGoSpace(text, end - 1)) end -= 1;
  return text.slice(start, end);
}

function includeOf(line: string): IncludeLine | null {
  const trimmed = goTrimSpace(line);
  if (!trimmed.startsWith("#include")) return null;
  const space = trimmed.indexOf(" ");
  return { path: space === -1 ? null : goTrimSpace(trimmed.slice(space + 1)) };
}

/** A C0 or C1 control character other than tab, which no pattern needs and which Go and JavaScript read differently. */
function holdsControlCharacter(line: string): boolean {
  for (let index = 0; index < line.length; index++) {
    const code = line.charCodeAt(index);
    if ((code <= 0x1f && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

export function isIncludeLine(line: string): boolean {
  return includeOf(line) !== null;
}

function isOutsideFolder(path: string): boolean {
  if (/^[\\/]/.test(path) || /^[A-Za-z]:/.test(path)) return true;
  let depth = 0;
  for (const segment of path.split(/[\\/]+/)) {
    if (segment === "..") depth -= 1;
    else if (segment && segment !== ".") depth += 1;
    if (depth < 0) return true;
  }
  return false;
}

/**
 * Why the lines cannot be saved, or null: a line holding a line break or a control character, or an `#include` without a path
 * or of a file outside the folder, read as Syncthing reads it.
 * @implNote Syncthing 2.1.6 reads an included file from anywhere the node can, so `#include ../../config/config.xml`
 * would turn the node's configuration, API key included, into patterns; both separators count, as a Windows node reads either.
 */
export function ignoreLinesProblem(lines: readonly string[]): string | null {
  if (lines.some((line) => /[\r\n]/.test(line))) return "an ignore pattern cannot hold a line break";
  const controlled = lines.findIndex(holdsControlCharacter);
  if (controlled !== -1) return `line ${controlled + 1} holds a control character; no character below a space other than tab is allowed`;
  for (const line of lines) {
    const include = includeOf(line);
    if (!include) continue;
    const named = goTrimSpace(line);
    if (include.path === null) return `${named} names no file: an include is #include, a space and a path inside the folder`;
    if (isOutsideFolder(include.path)) return `${named} refers to a file outside the folder; an included file must lie inside it`;
  }
  return null;
}

const listedChanges = 5;

function quotedList(lines: string[]): string {
  const shown = lines.slice(0, listedChanges).map((line) => (line.trim() ? line : "an empty line"));
  return lines.length > listedChanges ? `${shown.join(", ")} and ${lines.length - listedChanges} more` : shown.join(", ");
}

function missingFrom(lines: readonly string[], other: readonly string[]): string[] {
  const remaining = [...other];
  return lines.filter((line) => {
    const index = remaining.indexOf(line);
    if (index === -1) return true;
    remaining.splice(index, 1);
    return false;
  });
}

/** What an ignore change did, in words: `added *.tmp; removed Thumbs.db`, or `reordered the patterns`. */
export function ignoresChangeWords(before: readonly string[], after: readonly string[]): string[] {
  const added = missingFrom(after, before);
  const removed = missingFrom(before, after);
  const words = [...(added.length ? [`added ${quotedList(added)}`] : []), ...(removed.length ? [`removed ${quotedList(removed)}`] : [])];
  return words.length ? words : ["reordered the patterns"];
}
