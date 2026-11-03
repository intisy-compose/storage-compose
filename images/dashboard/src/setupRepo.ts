import { access, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ConnectionProfile, PriorityBand, ProfileRead } from "./api/types.js";
import { runCommand } from "./commands.js";
import { defaultProfile, formatProfile, parseProfile } from "./connectionProfile.js";
import { heldCommitText, profileChangedText, profileConflictText, profileStuckText, rebaseConflictText, rebaseInProgressText, rebaseRefusedText, unpushedText } from "./api/profileText.js";
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

async function readLayoutText(repository = setupRepoDirectory): Promise<string | null> {
  try {
    return await readFile(`${repository}/${setupLayoutPath}`, "utf8");
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

/** The trailer on every commit the dashboard makes, so a pull knows which unpushed commits it may rebase. */
const dashboardTrailer = { key: "Committed-by", value: "storage dashboard" };

function commitAsDashboard(repository: string, subject: string, ...paths: string[]): Promise<{ ok: boolean; output: string }> {
  return gitIn(repository, "commit", "-m", subject, "-m", `${dashboardTrailer.key}: ${dashboardTrailer.value}`, ...(paths.length ? ["--", ...paths] : []));
}

/** Whether `commit` carries the dashboard's trailer as git parses trailers, so the same words elsewhere in a message do not count. */
async function hasDashboardTrailer(repository: string, commit: string): Promise<boolean> {
  const values = await gitIn(repository, "log", "-1", `--format=%(trailers:key=${dashboardTrailer.key},valueonly)`, commit);
  return values.ok && values.output.split("\n").some((value) => value.trim() === dashboardTrailer.value);
}

/**
 * Pushes HEAD to its branch's upstream and nothing else, read from `branch.<name>.remote` and `.merge` so a branch name with slashes stays whole.
 * @implNote A bare `git push` follows `push.default`, which as `matching` would also send local branches the dashboard never checked.
 */
async function pushToUpstream(repository: string): Promise<{ ok: boolean; output: string }> {
  const branch = await gitIn(repository, "symbolic-ref", "-q", "--short", "HEAD");
  if (!branch.ok) return { ok: false, output: "HEAD is not on a branch, so there is no upstream to push to" };
  const remote = await gitIn(repository, "config", `branch.${branch.output}.remote`);
  const merge = await gitIn(repository, "config", `branch.${branch.output}.merge`);
  if (!remote.ok || !merge.ok) return { ok: false, output: `${branch.output} has no upstream to push to` };
  return gitIn(repository, "push", remote.output, `HEAD:${merge.output}`);
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
export function recordDevice(name: string, deviceId: string, root: string | null, repository = setupRepoDirectory): Promise<SetupRecordResult> {
  return serializeGit(repository, () => recordDeviceNow(name, deviceId, root, repository));
}

async function recordDeviceNow(name: string, deviceId: string, root: string | null, repository: string): Promise<SetupRecordResult> {
  const rebase = await rebaseInProgress(repository);
  if (rebase) return { committed: false, pushed: false, message: rebaseInProgressText(rebase) };
  const path = `${repository}/${setupLayoutPath}`;
  const before = await readLayoutText(repository);
  if (before === null) return { committed: false, pushed: false, message: `the setup repo has no ${setupLayoutPath}; the admission is recorded on this host only` };
  const after = upsertDevice(before, name, deviceId, root);
  if (after === before) return { committed: true, pushed: true, message: `${name} is already in the setup repo` };
  await writeFile(path, after);
  await gitIn(repository, "add", setupLayoutPath);
  const commit = await commitAsDashboard(repository, `feat(devices): admit ${name} to the storage network`);
  if (!commit.ok) return { committed: false, pushed: false, message: `written to ${setupLayoutPath} but not committed: ${commit.output.split("\n").pop()}` };
  const held = await heldUnpushedProblem(repository);
  if (held) return { committed: true, pushed: false, message: `committed, not pushed: ${held}` };
  const push = await pushToUpstream(repository);
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

/** A save whose push failed after HEAD moved past its commit outside this process, so the commit stays unpushed. */
export class ProfileStuck extends RequestError {
  constructor(commit: string) {
    super(503, profileStuckText(commit));
  }
}

/** A save refused before its push because a commit that is not the dashboard's would go with it; the save is undone. */
export class ProfileHeld extends RequestError {
  constructor(problem: string) {
    super(503, problem);
  }
}

interface PullState {
  pulledAt: string | null;
  pullProblem: string | null;
}

const pullStates = new Map<string, PullState>();

export function pullStateOf(repository: string): PullState {
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
  return { profile: text === null ? defaultProfile() : parseProfile(text), ...pullStateOf(repository), profileProblem: null };
}

function lastLine(output: string, fallback: string): string {
  return output.split("\n").pop() || fallback;
}

/** `git pull --ff-only`, rebasing the dashboard's own unpushed commits when the remote moved on; a failure is kept as pullProblem and the profile on disk stays as it was. */
export function pullDataRepo(repository = setupRepoDirectory): Promise<void> {
  return repository ? serializeGit(repository, () => pullNow(repository)) : Promise.resolve();
}

interface PullOutcome {
  pulled: boolean;
  problem: string | null;
}

async function pullNow(repository: string): Promise<void> {
  const rebase = await rebaseInProgress(repository);
  if (rebase) return void pullStates.set(repository, { ...pullStateOf(repository), pullProblem: rebaseInProgressText(rebase) });
  const pull = await gitIn(repository, "pull", "--ff-only");
  const outcome = pull.ok ? { pulled: true, problem: null } : await rebaseOwnCommits(repository, lastLine(pull.output, "git pull failed"));
  if (outcome.pulled) pullStates.set(repository, { pulledAt: new Date().toISOString(), pullProblem: await pushOwnCommits(repository) });
  else pullStates.set(repository, { ...pullStateOf(repository), pullProblem: outcome.problem });
}

async function revisions(repository: string, ...range: string[]): Promise<string[] | null> {
  const listed = await gitIn(repository, "rev-list", "--reverse", ...range);
  return listed.ok ? listed.output.split("\n").filter(Boolean) : null;
}

/** Why the unpushed `commits` may not be rebased or pushed by the dashboard, naming the first that is not its own, or null when all are. */
async function heldCommitProblem(repository: string, commits: readonly string[]): Promise<string | null> {
  const onNoRemote = new Set((await revisions(repository, "HEAD", "--not", "--remotes")) ?? []);
  for (const commit of commits) {
    const reason = !onNoRemote.has(commit) ? "is already on another branch of the remote" : !(await isDashboardCommit(repository, commit)) ? "is not the dashboard's" : null;
    if (reason) return heldCommitText(await shortCommitOf(repository, commit), await subjectOf(repository, commit), reason);
  }
  return null;
}

/**
 * A pull that cannot fast-forward because the remote moved on past unpushed commits: the dashboard's own are rebased onto it.
 * @implNote Anything else is left for a person: a commit that is not the dashboard's, one already on a remote branch, a conflict, or a tree git will not rebase.
 */
async function rebaseOwnCommits(repository: string, pullFailure: string): Promise<PullOutcome> {
  const unpushed = await revisions(repository, "@{upstream}..HEAD");
  const incoming = await revisions(repository, "HEAD..@{upstream}");
  if (!unpushed?.length || !incoming?.length) return { pulled: false, problem: pullFailure };
  const held = await heldCommitProblem(repository, unpushed);
  if (held) return { pulled: false, problem: held };
  return rebaseOnto(repository, await Promise.all(unpushed.map((commit) => shortCommitOf(repository, commit))));
}

async function rebaseOnto(repository: string, commits: string[]): Promise<PullOutcome> {
  const rebase = await gitIn(repository, "rebase", "-q", "@{upstream}");
  if (rebase.ok) return { pulled: true, problem: null };
  const conflicted = (await rebaseInProgress(repository)) !== null;
  await gitIn(repository, "rebase", "--abort");
  return { pulled: false, problem: conflicted ? rebaseConflictText(commits) : rebaseRefusedText(commits, lastLine(rebase.output, "git rebase failed")) };
}

/**
 * After every pull, pushes the dashboard's own commits the remote does not have yet, or names why they stay.
 * @implNote Checked each round, not only after a rebase: a fast-forward pull of an unchanged remote succeeds and would otherwise clear the problem of a push that failed.
 */
/** Why a push of HEAD would carry a commit the dashboard may not push, naming it, or null. */
async function heldUnpushedProblem(repository: string): Promise<string | null> {
  const unpushed = await revisions(repository, "@{upstream}..HEAD");
  return unpushed?.length ? heldCommitProblem(repository, unpushed) : null;
}

async function pushOwnCommits(repository: string): Promise<string | null> {
  const unpushed = await revisions(repository, "@{upstream}..HEAD");
  if (!unpushed?.length) return null;
  const held = await heldCommitProblem(repository, unpushed);
  if (held) return held;
  const push = await pushToUpstream(repository);
  if (push.ok) return null;
  const commits = await Promise.all(unpushed.map((commit) => shortCommitOf(repository, commit)));
  return unpushedText(commits, lastLine(push.output, "git push failed"));
}

/**
 * The directory of a rebase in progress in the data repo, as git names it, or null.
 * @implNote Never aborted by the dashboard: a killed process and a person's own rebase leave the same state.
 */
async function rebaseInProgress(repository: string): Promise<string | null> {
  for (const name of ["rebase-merge", "rebase-apply"]) {
    const path = await gitIn(repository, "rev-parse", "--git-path", name);
    if (path.ok && (await exists(resolve(repository, path.output)))) return path.output;
  }
  return null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function subjectOf(repository: string, commit: string): Promise<string> {
  return (await gitIn(repository, "log", "-1", "--format=%s", commit)).output;
}

/** `feat(devices): admit <name> to the storage network`, as the dashboard committed an admission before it marked its commits; the name as `isDeviceName` takes it. */
const unmarkedAdmissionSubject = /^feat\(devices\): admit [a-z0-9][a-z0-9-]* to the storage network$/;

/**
 * Whether the dashboard made `commit`: one with its trailer touching only the dashboard's files, or an unmarked admission touching the layout alone.
 * @implNote A merge lists no files here, so it never counts.
 */
async function isDashboardCommit(repository: string, commit: string): Promise<boolean> {
  const changed = await gitIn(repository, "diff-tree", "--no-commit-id", "--name-only", "-r", commit);
  const files = changed.ok ? changed.output.split("\n").filter(Boolean) : [];
  if (!files.length) return false;
  if (await hasDashboardTrailer(repository, commit)) return files.every((file) => file === setupLayoutPath || file === connectionsProfilePath);
  return files.length === 1 && files[0] === setupLayoutPath && unmarkedAdmissionSubject.test(await subjectOf(repository, commit));
}

function isRejectedPush(output: string): boolean {
  return /non-fast-forward|fetch first|\[rejected\]/i.test(output);
}

/**
 * Undoes the save, false when `savedCommit` is no longer HEAD: then the commit and its file stay as committed.
 * @implNote Only this file is touched: the data repo may hold other uncommitted work, so a commit is undone with a soft reset and the file restored by hand.
 */
async function undoSave(repository: string, before: string | null, savedCommit: string | null): Promise<boolean> {
  if (savedCommit !== null) {
    if ((await gitIn(repository, "rev-parse", "HEAD")).output !== savedCommit) return false;
    await gitIn(repository, "reset", "--soft", "HEAD~1");
  }
  await gitIn(repository, "reset", "-q", "--", connectionsProfilePath);
  const path = `${repository}/${connectionsProfilePath}`;
  if (before === null) await rm(path, { force: true });
  else await writeFile(path, before);
  return true;
}

async function shortCommitOf(repository: string, commit: string): Promise<string> {
  const short = await gitIn(repository, "rev-parse", "--short", commit);
  return short.ok ? short.output : commit;
}

/**
 * Commits and pushes `profile`; with `base`, only while the profile on disk is still `base`, checked under the repo's lock.
 * A failed commit or push leaves the file and the repo as they were, except a commit another landed on top of: that one stays, answered with ProfileStuck.
 */
export async function saveProfile(profile: ConnectionProfile, message: string, repository = setupRepoDirectory, base?: ConnectionProfile): Promise<void> {
  if (!repository) throw new RequestError(503, "this host has no setup repo to keep the connection profile in");
  return serializeGit(repository, async () => {
    const rebase = await rebaseInProgress(repository);
    if (rebase) throw new RequestError(503, rebaseInProgressText(rebase));
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
  const commit = await commitAsDashboard(repository, message, connectionsProfilePath);
  if (!commit.ok) {
    await undoSave(repository, before, null);
    throw new RequestError(500, `the connection profile could not be committed: ${lastLine(commit.output, "git commit failed")}`);
  }
  const savedCommit = (await gitIn(repository, "rev-parse", "HEAD")).output;
  const held = await heldUnpushedProblem(repository);
  if (held) return refuseAfterUndo(repository, before, savedCommit, new ProfileHeld(held));
  const push = await pushToUpstream(repository);
  if (push.ok) return;
  return refuseAfterUndo(repository, before, savedCommit, isRejectedPush(push.output) ? new ProfileConflict() : new ProfileUnreachable(lastLine(push.output, "git push failed")));
}

/** Undoes the save and throws `refusal`, or ProfileStuck when another commit landed on top of the save's. */
async function refuseAfterUndo(repository: string, before: string | null, savedCommit: string, refusal: RequestError): Promise<never> {
  if (!(await undoSave(repository, before, savedCommit))) throw new ProfileStuck(await shortCommitOf(repository, savedCommit));
  throw refusal;
}
