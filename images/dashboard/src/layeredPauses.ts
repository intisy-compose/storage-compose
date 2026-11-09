import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { FolderSize } from "./spacePlan.js";

/** One folder the layered sync paused, with its size as Syncthing counted it just before, since a paused folder reports none. */
export interface PauseMark {
  at: string;
  size: FolderSize | null;
}

/**
 * The folders the layered sync paused, by node, so a resume only ever undoes its own pause.
 * @implNote A folder paused by a person, or by an array's freeze (C-24), is never in it, so it is never resumed by a round.
 */
export interface LayeredPauses {
  /** Throws while the record cannot be read: nothing may be resumed on a guess. */
  of(nodeId: string): Promise<Map<string, PauseMark>>;
  /** Records a pause before it is written; a record that cannot be read is set aside first, so a pause is never stopped by it. */
  mark(nodeId: string, folderId: string, mark: PauseMark): Promise<void>;
  unmark(nodeId: string, folderId: string): Promise<void>;
  /** Every node with a recorded pause. */
  nodes(): Promise<string[]>;
}

type Marks = Record<string, Record<string, PauseMark>>;

function isSize(value: unknown): value is FolderSize {
  const size = value as FolderSize;
  return typeof size === "object" && size !== null && Number.isFinite(size.globalBytes) && Number.isFinite(size.localBytes);
}

function isMarks(value: unknown): value is Marks {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(
    (folders) => typeof folders === "object" && folders !== null && !Array.isArray(folders) && Object.values(folders as Record<string, PauseMark>).every((mark) => typeof mark?.at === "string" && (mark.size === null || isSize(mark.size))),
  );
}

function mapOf(folders: Record<string, PauseMark> | undefined): Map<string, PauseMark> {
  return new Map(Object.entries(folders ?? {}));
}

/**
 * Kept in one JSON file, replaced whole through a rename.
 * @implNote A record that cannot be parsed refuses every resume rather than reading as empty; a pause sets it aside as `.bad` and starts a
 * new one, so the folders it named stay paused until a person resumes them.
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${path} is not a record of layered pauses`);
    }
    if (!isMarks(parsed)) throw new Error(`${path} is not a record of layered pauses`);
    return parsed;
  };
  const write = async (marks: Marks) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(`${path}.new`, `${JSON.stringify(marks, null, 2)}\n`);
    await rename(`${path}.new`, path);
  };
  return {
    of: async (nodeId) => mapOf((await read())[nodeId]),
    mark: async (nodeId, folderId, mark) => {
      const marks = await read().catch(async (error) => {
        console.error(`layered sync: ${(error as Error).message}; it is kept as ${path}.bad and a new record started`);
        await rename(path, `${path}.bad`);
        return {} as Marks;
      });
      marks[nodeId] = { ...(marks[nodeId] ?? {}), [folderId]: mark };
      await write(marks);
    },
    unmark: async (nodeId, folderId) => {
      const marks = await read();
      const { [folderId]: _, ...left } = marks[nodeId] ?? {};
      if (Object.keys(left).length) marks[nodeId] = left;
      else delete marks[nodeId];
      await write(marks);
    },
    nodes: async () => Object.keys(await read()).sort(),
  };
}

export function memoryLayeredPauses(initial: Marks = {}): LayeredPauses & { marks: Marks; corrupt: boolean } {
  const store = {
    marks: structuredClone(initial) as Marks,
    corrupt: false,
    of: async (nodeId: string) => {
      if (store.corrupt) throw new Error("the record of layered pauses cannot be read");
      return mapOf(store.marks[nodeId]);
    },
    mark: async (nodeId: string, folderId: string, mark: PauseMark) => {
      if (store.corrupt) {
        store.marks = {};
        store.corrupt = false;
      }
      store.marks[nodeId] = { ...(store.marks[nodeId] ?? {}), [folderId]: mark };
    },
    unmark: async (nodeId: string, folderId: string) => {
      if (store.corrupt) throw new Error("the record of layered pauses cannot be read");
      const { [folderId]: _, ...left } = store.marks[nodeId] ?? {};
      if (Object.keys(left).length) store.marks[nodeId] = left;
      else delete store.marks[nodeId];
    },
    nodes: async () => {
      if (store.corrupt) throw new Error("the record of layered pauses cannot be read");
      return Object.keys(store.marks).sort();
    },
  };
  return store;
}
