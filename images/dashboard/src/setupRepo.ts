import { readFile, writeFile } from "node:fs/promises";
import type { PriorityBand } from "./api/types.js";
import { runCommand } from "./commands.js";
import { setupLayoutPath, setupRepoDirectory } from "./settings.js";
import { type TomlTable, parseToml } from "./toml.js";

export interface LayoutFolder {
  relativePath: string;
  id: string;
  priority: number;
}

export interface LayoutDevice {
  name: string;
  id: string;
  joined: boolean;
}

export interface SetupLayout {
  devices: LayoutDevice[];
  folders: LayoutFolder[];
  /** The layout's `[bands]` table, highest first; empty while the layered sync sets none. */
  bands: PriorityBand[];
}

export interface SetupRecordResult {
  committed: boolean;
  pushed: boolean;
  message: string;
}

/** The layered sync's reading of C-30's categories. */
const categoryPriority: Record<string, number> = { synced: 80, archive: 30, local: 0 };

/** @implNote The same derivation as drive-sync's `folder_id`; Syncthing matches folders across devices by it. */
export function folderId(relativePath: string): string {
  return relativePath.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** The layout's spelling of the tree root, which `[folders."."]` gives a priority. */
export const topDirectoryPath = ".";

/** Separators as `/`, no leading, trailing or `.` segments; the tree root is `.`. */
export function normaliseRelativePath(relativePath: string): string {
  const segments = relativePath.split(/[\\/]+/).filter((segment) => segment !== "" && segment !== ".");
  return segments.length ? segments.join("/") : topDirectoryPath;
}

function asTable(value: unknown): TomlTable {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as TomlTable) : {};
}

export function parseLayout(text: string): SetupLayout {
  const toml = parseToml(text);
  const devices = Object.entries(asTable(toml.devices)).map(([name, value]) => {
    const entry = asTable(value);
    return { name, id: typeof entry.id === "string" ? entry.id : "", joined: entry.joined !== false };
  });
  const folders = Object.entries(asTable(toml.folders)).map(([key, value]) => {
    const entry = asTable(value);
    const relativePath = normaliseRelativePath(key);
    const priority = typeof entry.priority === "number" ? entry.priority : (categoryPriority[String(entry.category)] ?? 0);
    return { relativePath, id: folderId(relativePath), priority };
  });
  const bands = Object.entries(asTable(toml.bands))
    .flatMap(([name, from]) => (typeof from === "number" ? [{ name, from }] : []))
    .sort((left, right) => right.from - left.from);
  return { devices, folders, bands };
}

function tomlString(value: string): string {
  return value.includes("'") || value.includes("\n") ? JSON.stringify(value) : `'${value}'`;
}

function setKey(lines: string[], start: number, end: number, key: string, value: string): void {
  const pattern = new RegExp(`^\\s*${key}\\s*=`);
  for (let index = start; index < end; index++) {
    if (pattern.test(lines[index])) {
      const indent = lines[index].match(/^\s*/)?.[0] ?? "";
      const alignment = lines[index].match(/^\s*\S+(\s*)=/)?.[1] ?? " ";
      lines[index] = `${indent}${key}${alignment}= ${value}`;
      return;
    }
  }
  let insertAt = end;
  while (insertAt > start && lines[insertAt - 1].trim() === "") insertAt--;
  lines.splice(insertAt, 0, `${key} = ${value}`);
}

/**
 * The device's section with its ID and `joined = true`, edited in place so the file's comments and
 * order stay; a new device gets its section after the last device and its root when given.
 */
export function upsertDevice(text: string, name: string, deviceId: string, root: string | null): string {
  const lines = text.split("\n");
  const header = `[devices.${name}]`;
  const start = lines.findIndex((line) => line.trim() === header);
  if (start >= 0) {
    let end = start + 1;
    while (end < lines.length && !lines[end].trim().startsWith("[")) end++;
    while (end > start + 1 && lines[end - 1].trim().startsWith("#")) end--;
    setKey(lines, start + 1, end, "joined", "true");
    setKey(lines, start + 1, end, "id", JSON.stringify(deviceId));
    return lines.join("\n");
  }
  const section = [header, `id     = ${JSON.stringify(deviceId)}`, ...(root ? [`root   = ${tomlString(root)}`] : []), "joined = true", ""];
  let insertAt = lines.findIndex((line) => /^\[folders[.\]]/.test(line.trim()));
  if (insertAt < 0) insertAt = lines.length;
  while (insertAt > 0 && (lines[insertAt - 1].trim().startsWith("#") || lines[insertAt - 1].trim() === "")) insertAt--;
  if (insertAt > 0) section.unshift("");
  lines.splice(insertAt, 0, ...section);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

async function readLayoutText(): Promise<string | null> {
  try {
    return await readFile(`${setupRepoDirectory}/${setupLayoutPath}`, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Null while the setup repo holds no layout yet, as a fresh data repo does. */
export async function readLayout(): Promise<SetupLayout | null> {
  if (!setupRepoDirectory) return null;
  const text = await readLayoutText();
  return text === null ? null : parseLayout(text);
}

async function git(...args: string[]): Promise<{ ok: boolean; output: string }> {
  const result = await runCommand("git", ["-C", setupRepoDirectory, ...args], 60_000);
  return { ok: result.exitCode === 0, output: `${result.stdout}${result.stderr}`.trim() };
}

/** Writes the device into the layout, commits with the repo's own identity, and pushes. */
export async function recordDevice(name: string, deviceId: string, root: string | null): Promise<SetupRecordResult> {
  const path = `${setupRepoDirectory}/${setupLayoutPath}`;
  const before = await readLayoutText();
  if (before === null) return { committed: false, pushed: false, message: `the setup repo has no ${setupLayoutPath}; the admission is recorded on this host only` };
  const after = upsertDevice(before, name, deviceId, root);
  if (after === before) return { committed: true, pushed: true, message: `${name} is already in the setup repo` };
  await writeFile(path, after);
  await git("add", setupLayoutPath);
  const commit = await git("commit", "-m", `feat(devices): admit ${name} to the storage network`);
  if (!commit.ok) return { committed: false, pushed: false, message: `written to ${setupLayoutPath} but not committed: ${commit.output.split("\n").pop()}` };
  const push = await git("push");
  if (!push.ok) return { committed: true, pushed: false, message: `committed, not pushed yet: ${push.output.split("\n").pop()}` };
  return { committed: true, pushed: true, message: `committed and pushed to the setup repo` };
}
