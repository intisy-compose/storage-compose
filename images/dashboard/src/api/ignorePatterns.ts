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

function includeOf(line: string): IncludeLine | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("#include")) return null;
  const space = trimmed.indexOf(" ");
  return { path: space === -1 ? null : trimmed.slice(space + 1).trim() };
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
 * Why the lines cannot be saved, or null: an `#include` without a path or of a file outside the folder, or a line holding a line break.
 * @implNote Syncthing 2.1.6 reads an included file from anywhere the node can, so `#include ../../config/config.xml`
 * would turn the node's configuration, API key included, into patterns; both separators count, as a Windows node reads either.
 */
export function ignoreLinesProblem(lines: readonly string[]): string | null {
  if (lines.some((line) => /[\r\n]/.test(line))) return "an ignore pattern cannot hold a line break";
  for (const line of lines) {
    const include = includeOf(line);
    if (!include) continue;
    if (include.path === null) return `${line.trim()} names no file: an include is #include, a space and a path inside the folder`;
    if (isOutsideFolder(include.path)) return `${line.trim()} refers to a file outside the folder; an included file must lie inside it`;
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
