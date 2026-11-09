import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** What the layered sync last notified, by key, so a dashboard restart does not send the same notification again. */
export interface NotifiedState {
  get(key: string): Promise<string | null>;
  set(key: string, value: string | null): Promise<void>;
}

/** @implNote A file that cannot be read counts as empty: the worst it does is repeat one notification. */
export function fileNotifiedState(path: string): NotifiedState {
  const read = async (): Promise<Record<string, string>> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
    } catch {
      return {};
    }
  };
  return {
    get: async (key) => (await read())[key] ?? null,
    set: async (key, value) => {
      const state = await read();
      if (value === null) delete state[key];
      else state[key] = value;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(`${path}.new`, `${JSON.stringify(state, null, 2)}\n`);
      await rename(`${path}.new`, path);
    },
  };
}

export function memoryNotifiedState(): NotifiedState {
  const state = new Map<string, string>();
  return {
    get: async (key) => state.get(key) ?? null,
    set: async (key, value) => void (value === null ? state.delete(key) : state.set(key, value)),
  };
}
