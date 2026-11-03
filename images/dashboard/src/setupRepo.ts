import { readFile, rm, writeFile } from "node:fs/promises";
import type { ConnectionProfile, PriorityBand, ProfileRead } from "./api/types.js";
import { runCommand } from "./commands.js";
import { defaultProfile, formatProfile, parseProfile } from "./connectionProfile.js";
import { profileChangedText, profileConflictText } from "./api/profileText.js";
import { RequestError } from "./http.js";
import { connectionsProfilePath, setupLayoutPath, setupRepoDirectory } from "./settings.js";
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

const urlCredentials = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#'"]+@/gi;

/**
 * `text` with the user and token of every URL in it masked, so a remote pushed with a token in its URL never shows it in an answer or in Activity.
 * @implNote Everything up to the last `@` before the host is masked, so a password holding an unencoded `@` is never shown in part.
 */
export function withoutUrlCredentials(text: string): string {
  return text.replace(urlCredentials, "$1***@");
}

async function gitIn(repository: string, ...args: string[]): Promise<{ ok: boolean; output: string }> {
  const result = await runCommand("git", ["-C", repository, ...args], 60_000);
  return { ok: result.exitCode === 0, output: withoutUrlCredentials(`${result.stdout}${result.stderr}`.trim()) };
}

function git(...args: string[]): Promise<{ ok: boolean; output: string }> {
  return gitIn(setupRepoDirectory, ...args);
}

const gitQueues = new Map<string, Promise<unknown>>();

/**
 * Runs `task` after every earlier git write on the repository has finished.
 * @implNote One working tree and index are shared by saves, admissions and pulls, so an interleaving would let one commit sweep in another's staged file or undo another's commit.
 */
function serializeGit<Result>(repository: string, task: () => Promise<Result>): Promise<Result> {
  const run = (gitQueues.get(repository) ?? Promise.resolve()).then(task, task);
  gitQueues.set(repository, run.catch(() => undefined));
  return run;
}

/** Writes the device into the layout, commits with the repo's own identity, and pushes. */
export function recordDevice(name: string, deviceId: string, root: string | null): Promise<SetupRecordResult> {
  return serializeGit(setupRepoDirectory, () => recordDeviceNow(name, deviceId, root));
}

async function recordDeviceNow(name: string, deviceId: string, root: string | null): Promise<SetupRecordResult> {
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

/** A save whose push the remote refused because another host pushed first; nothing of the save remains. */
export class ProfileConflict extends RequestError {
  constructor() {
    super(409, profileConflictText);
  }
}

/** A save made from a profile that is no longer the one on disk: another host's change was pulled in meanwhile. */
export class ProfileChanged extends RequestError {
  constructor() {
    super(409, profileChangedText);
  }
}

/** A save that git could not make reach the remote; nothing of the save remains. */
export class ProfileUnreachable extends RequestError {
  constructor(reason: string) {
    super(503, `the data repo's remote could not be reached: ${reason}`);
  }
}

interface PullState {
  pulledAt: string | null;
  pullProblem: string | null;
}

const pullStates = new Map<string, PullState>();

function pullStateOf(repository: string): PullState {
  return pullStates.get(repository) ?? { pulledAt: null, pullProblem: null };
}

async function readProfileText(repository: string): Promise<string | null> {
  try {
    return await readFile(`${repository}/${connectionsProfilePath}`, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** The profile on disk, the defaults while the repo holds none, with how the last pull went. */
export async function readProfile(repository = setupRepoDirectory): Promise<ProfileRead> {
  const text = repository ? await readProfileText(repository) : null;
  return { profile: text === null ? defaultProfile() : parseProfile(text), ...pullStateOf(repository) };
}

function lastLine(output: string, fallback: string): string {
  return output.split("\n").pop() || fallback;
}

/** `git pull --ff-only`; a failure is kept as pullProblem and the profile on disk stays as it was. */
export function pullDataRepo(repository = setupRepoDirectory): Promise<void> {
  return repository ? serializeGit(repository, () => pullNow(repository)) : Promise.resolve();
}

async function pullNow(repository: string): Promise<void> {
  const pull = await gitIn(repository, "pull", "--ff-only");
  if (pull.ok) pullStates.set(repository, { pulledAt: new Date().toISOString(), pullProblem: null });
  else pullStates.set(repository, { ...pullStateOf(repository), pullProblem: lastLine(pull.output, "git pull failed") });
}

function isRejectedPush(output: string): boolean {
  return /non-fast-forward|fetch first|\[rejected\]/i.test(output);
}

/** @implNote Only this file is touched: the data repo may hold other uncommitted work, so a commit is undone with a soft reset and the file restored by hand. */
async function undoSave(repository: string, before: string | null, savedCommit: string | null): Promise<void> {
  if (savedCommit !== null && (await gitIn(repository, "rev-parse", "HEAD")).output === savedCommit) await gitIn(repository, "reset", "--soft", "HEAD~1");
  await gitIn(repository, "reset", "-q", "--", connectionsProfilePath);
  const path = `${repository}/${connectionsProfilePath}`;
  if (before === null) await rm(path, { force: true });
  else await writeFile(path, before);
}

/** Writes the profile, commits and pushes it; a failed commit or push leaves the file and the repo as they were. */
/** Commits and pushes `profile`; with `base`, only while the profile on disk is still `base`, checked under the repo's lock. */
export async function saveProfile(profile: ConnectionProfile, message: string, repository = setupRepoDirectory, base?: ConnectionProfile): Promise<void> {
  if (!repository) throw new RequestError(503, "this host has no setup repo to keep the connection profile in");
  return serializeGit(repository, async () => {
    if (base && !(await isProfileOnDisk(repository, base))) throw new ProfileChanged();
    return saveNow(profile, message, repository);
  });
}

async function isProfileOnDisk(repository: string, profile: ConnectionProfile): Promise<boolean> {
  const text = await readProfileText(repository);
  return formatProfile(text === null ? defaultProfile() : parseProfile(text)) === formatProfile(profile);
}

async function committedProfileText(repository: string): Promise<string | null> {
  const shown = await gitIn(repository, "show", `HEAD:${connectionsProfilePath}`);
  return shown.ok ? shown.output : null;
}

/** A no-op save still leaves the file as committed, so a stale copy on disk never outlives a save that HEAD already holds. */
async function restoreCommittedProfile(repository: string, before: string | null, committed: string): Promise<void> {
  if (before?.trim() !== committed) await gitIn(repository, "checkout", "-q", "HEAD", "--", connectionsProfilePath);
}

async function saveNow(profile: ConnectionProfile, message: string, repository: string): Promise<void> {
  const before = await readProfileText(repository);
  const after = formatProfile(profile);
  const committed = await committedProfileText(repository);
  if (committed !== null && after.trim() === committed) return restoreCommittedProfile(repository, before, committed);
  await writeFile(`${repository}/${connectionsProfilePath}`, after);
  await gitIn(repository, "add", connectionsProfilePath);
  const commit = await gitIn(repository, "commit", "-m", message, "--", connectionsProfilePath);
  if (!commit.ok) {
    await undoSave(repository, before, null);
    throw new RequestError(500, `the connection profile could not be committed: ${lastLine(commit.output, "git commit failed")}`);
  }
  const savedCommit = (await gitIn(repository, "rev-parse", "HEAD")).output;
  const push = await gitIn(repository, "push");
  if (push.ok) return;
  await undoSave(repository, before, savedCommit);
  throw isRejectedPush(push.output) ? new ProfileConflict() : new ProfileUnreachable(lastLine(push.output, "git push failed"));
}
