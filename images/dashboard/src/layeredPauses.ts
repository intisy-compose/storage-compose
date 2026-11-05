import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * The folders the layered sync paused, by node, so a resume only ever undoes its own pause.
 * @implNote A folder paused by a person, or by an array's freeze (C-24), is never in it, so it is never resumed by a round.
 */
export interface LayeredPauses {
  of(nodeId: string): Promise<Set<string>>;
  mark(nodeId: string, folderId: string): Promise<void>;
  unmark(nodeId: string, folderId: string): Promise<void>;
}

type Marks = Record<string, string[]>;

function isMarks(value: unknown): value is Marks {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every((ids) => Array.isArray(ids) && ids.every((id) => typeof id === "string"));
}

/**
 * Kept in one JSON file, replaced whole through a rename.
 * @implNote A file that cannot be read or parsed throws instead of reading as empty: an empty record would leave a folder the round paused
 * paused for good, and the round then reports the pause write failed rather than forgetting it.
 */
export function fileLayeredPauses(path: string): LayeredPauses {
  const read = async (): Promise<Marks> => {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    const parsed: unknown = JSON.parse(text);
    if (!isMarks(parsed)) throw new Error(`${path} is not a record of layered pauses`);
    return parsed;
  };
  const write = async (marks: Marks) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(`${path}.new`, `${JSON.stringify(marks, null, 2)}\n`);
    await rename(`${path}.new`, path);
  };
  return {
    of: async (nodeId) => new Set((await read())[nodeId] ?? []),
    mark: async (nodeId, folderId) => {
      const marks = await read();
      marks[nodeId] = [...new Set([...(marks[nodeId] ?? []), folderId])].sort();
      await write(marks);
    },
    unmark: async (nodeId, folderId) => {
      const marks = await read();
      const left = (marks[nodeId] ?? []).filter((id) => id !== folderId);
      if (left.length) marks[nodeId] = left;
      else delete marks[nodeId];
      await write(marks);
    },
  };
}

export function memoryLayeredPauses(initial: Marks = {}): LayeredPauses & { marks: Marks } {
  const marks: Marks = structuredClone(initial);
  return {
    marks,
    of: async (nodeId) => new Set(marks[nodeId] ?? []),
    mark: async (nodeId, folderId) => void (marks[nodeId] = [...new Set([...(marks[nodeId] ?? []), folderId])].sort()),
    unmark: async (nodeId, folderId) => {
      const left = (marks[nodeId] ?? []).filter((id) => id !== folderId);
      if (left.length) marks[nodeId] = left;
      else delete marks[nodeId];
    },
  };
}
