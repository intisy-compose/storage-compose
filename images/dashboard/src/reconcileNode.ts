import { shortDeviceId } from "./api/deviceText.js";
import { type FolderType, folderTypeTexts } from "./api/types.js";
import { type LocalInstance, arrayConfirmProblem, callSyncthing, defaultReadBackDelaysMs, writeConfirmed } from "./instanceResolver.js";
import { type NodePlan, type PlannedFolder, type PlannedVersioning, handoffIgnoreFile, handoffIgnoreLines } from "./nodePlan.js";
import { writeIgnoreLines } from "./routes/folderIgnores.js";
import { type SetupLayout, topDirectoryPath } from "./setupRepo.js";
import type { SyncthingFolderSettings } from "./syncthing.js";
import { effectiveSharing, sharedDevices } from "./syncthingConfig.js";

export type ReconcileField = "type" | "sharing" | "ignores" | "versioning";

export interface FieldChange {
  field: ReconcileField;
  text: string;
  /** Why the change is never written as things stand, or why its write waits; null for one that is written when the node applies. */
  held: string | null;
  written: boolean;
}

export interface FolderReconcile {
  folderId: string;
  label: string;
  changes: FieldChange[];
  /** The fields written, in the order they were sent. */
  written: ReconcileField[];
  /** Why no change of the folder was written (an array's confirmation); null when nothing held the folder as a whole. */
  held: string | null;
  /** Why writing the folder's changes failed; the other folders are reconciled all the same. */
  failed: string | null;
}

export interface MissingFolder {
  folderId: string;
  label: string;
  path: string;
}

/** Ignore lines of the node's own, outside the managed block, which the reconciler keeps as they are. */
export interface NodeOnlyIgnores {
  folderId: string;
  label: string;
  lines: string[];
}

export interface NodeReconcile {
  nodeId: string;
  mode: "report" | "apply";
  /** Only the folders with a change. */
  folders: FolderReconcile[];
  /** Planned folders the node's Syncthing does not have; the reconciler never adds a folder. */
  missing: MissingFolder[];
  /** Layout folders the node has that its plan leaves out; the reconciler never removes a folder. */
  unplanned: string[];
  /** Devices a planned folder is shared with that the node's Syncthing does not know, so they are not shared yet. */
  unknownDevices: string[];
  nodeOnlyIgnores: NodeOnlyIgnores[];
  /** One line per folder whose writes failed. */
  failed: string[];
}

/** The node's own files, which the dashboard reaches only where this host mounts them. */
export interface HandoffFiles {
  /** Creates the folder's empty `.stignore-handoff` unless a regular file is there, never changing it; null once it exists, else why it cannot. */
  ensure(instance: LocalInstance, folder: { id: string; path: string }): Promise<string | null>;
}

export interface ReconcileOptions {
  /** False writes nothing at all: the node only reports what its plan would change. */
  apply: boolean;
  /** The layout the plan was made from: a folder stops being shared only with one of its devices, never with a device it does not list. */
  layout: SetupLayout;
  handoffFiles: HandoffFiles;
  /** On an array, the folder ID as typed for each folder the person confirmed. */
  confirmations?: Readonly<Record<string, string>>;
  /** Called after each confirmed write, with the change in words for Activity. */
  onWritten?: (folderId: string, text: string) => void;
  readBackDelaysMs?: readonly number[];
}

/** The first line of the managed block, the part of `.stignore` the reconciler owns. */
export const ignoreBlockBegin = "// layered sync begin";
export const ignoreBlockEnd = "// layered sync end";

type SyncthingObject = Record<string, unknown>;

interface IgnoreFile {
  /** Null while the file has no managed block. */
  block: string[] | null;
  outside: string[];
}

interface CurrentFolder {
  settings: SyncthingFolderSettings;
  ignores: IgnoreFile | null;
}

interface Sharing {
  share: string[];
  unshare: string[];
}

interface FolderWork {
  planned: PlannedFolder;
  current: CurrentFolder;
  type: FolderType | null;
  sharing: Sharing | null;
  /** The managed block's lines as planned. */
  ignores: string[] | null;
  versioning: SyncthingObject | null;
}

/** Every device ID the layout lists. */
export function layoutDeviceIds(layout: SetupLayout): Set<string> {
  return new Set(layout.devices.map((device) => device.id).filter(Boolean));
}

/** The device IDs of nodes whose access is closed, which nothing is shared with until the encryption exists. */
function closedDeviceIds(layout: SetupLayout): Set<string> {
  const names = new Set(layout.nodes.filter((node) => node.access === "closed").map((node) => node.device));
  return new Set(layout.devices.filter((device) => names.has(device.name) && device.id).map((device) => device.id));
}

/**
 * The layout paths the node carries for `nodePlan`'s `localFolders`: each layout folder its Syncthing has, by the shared ID or its own priority 0 ID.
 * @implNote A folder the node has counts as held whatever it holds, so one that goes below the threshold turns send-only and stops pulling instead
 * of falling out of the plan while it stays send-receive; what it holds nothing in is left for the hand-off to empty.
 */
export function carriedLayoutPaths(layout: SetupLayout, nodeId: string, configuredIds: ReadonlySet<string>): Set<string> {
  return new Set(layout.folders.filter((folder) => folder.relativePath !== topDirectoryPath && (configuredIds.has(folder.id) || configuredIds.has(`${nodeId}-${folder.id}`))).map((folder) => folder.relativePath));
}

/**
 * A `.stignore` with the managed block first, then the node's own lines in their order.
 * @implNote First, because Syncthing applies the first pattern that matches: a node's `!` line below can never bring back a child entry or a handed-off path.
 */
export function managedIgnoreLines(block: readonly string[], outside: readonly string[] = []): string[] {
  return [ignoreBlockBegin, ...block, ignoreBlockEnd, ...outside];
}

/** A stray marker without its partner is dropped, as it would otherwise be taken for a block the next time. */
function splitIgnores(lines: readonly string[]): IgnoreFile {
  const begin = lines.indexOf(ignoreBlockBegin);
  const end = begin < 0 ? -1 : lines.indexOf(ignoreBlockEnd, begin + 1);
  if (begin < 0 || end < 0) return { block: null, outside: lines.filter((line) => line !== ignoreBlockBegin && line !== ignoreBlockEnd) };
  return { block: lines.slice(begin + 1, end), outside: [...lines.slice(0, begin), ...lines.slice(end + 1)] };
}

const secondsPerDay = 86400;

function versioningSummary(versioning: SyncthingFolderSettings["versioning"]): string {
  const type = versioning?.type ?? "";
  if (type !== "staggered") return type;
  return `staggered ${versioning?.params?.maxAge ?? ""}`;
}

function plannedSummary(planned: PlannedVersioning | null): string {
  return planned ? `staggered ${planned.maxAgeDays * secondsPerDay}` : "";
}

function versioningWords(summary: string): string {
  if (!summary) return "none";
  const [type, seconds] = summary.split(" ");
  if (!seconds) return type;
  return Number(seconds) === 0 ? `${type}, kept forever` : `${type}, ${Number(seconds) / secondsPerDay} days`;
}

const replacesVersioning = "would replace the folder's versioning";
const shortensVersioning = "would shorten how long versions are kept";

/**
 * Why the plan's versioning is not written over the folder's, or null when it may be.
 * @implNote Versioning only ever gets added or kept longer: a folder with none gets the plan's, a staggered one with a finite `maxAge` gets a
 * longer one, and anything else (kept forever as `maxAge` 0, another type, the plan's none) stays, so no kept version expires early.
 */
function versioningHeld(current: SyncthingFolderSettings["versioning"], planned: PlannedVersioning | null): string | null {
  const type = current?.type ?? "";
  if (!planned) return replacesVersioning;
  if (type === "") return null;
  if (type !== "staggered") return replacesVersioning;
  const maxAge = Number(current?.params?.maxAge);
  if (current?.params?.maxAge === undefined || !Number.isFinite(maxAge)) return replacesVersioning;
  return maxAge === 0 || planned.maxAgeDays * secondsPerDay < maxAge ? shortensVersioning : null;
}

/** The folder's versioning with the plan's type and maximum age, every other field as Syncthing has it. */
function wantedVersioning(current: SyncthingFolderSettings["versioning"], planned: PlannedVersioning): SyncthingObject {
  const params = current?.type === "staggered" ? { ...(current.params ?? {}) } : {};
  return { ...((current ?? {}) as SyncthingObject), type: "staggered", params: { ...params, maxAge: String(planned.maxAgeDays * secondsPerDay) } };
}

const changeableTypes: ReadonlySet<FolderType> = new Set(["sendreceive", "sendonly"]);

/**
 * Why the folder's type is not changed to the plan's, or null when it is.
 * @implNote Turning send-receive makes a folder pull, which only the space rule may allow, so it waits for it.
 */
function typeHeld(current: FolderType, planned: PlannedFolder, cluster: boolean): string | null {
  if (cluster && planned.type === "sendonly") return "the cluster is never made send-only";
  if (!changeableTypes.has(current)) return `type ${folderTypeTexts[current]} is not changed here`;
  return planned.type === "sendreceive" ? "turning send-receive waits for the space rule" : null;
}

function isSameLines(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

interface Shares {
  open: Sharing | null;
  closed: string[];
  unknown: string[];
}

function sharesOf(current: SyncthingFolderSettings, planned: PlannedFolder, ownId: string, known: ReadonlySet<string>, layoutDevices: ReadonlySet<string>, closed: ReadonlySet<string>): Shares {
  const shared = new Set(current.devices.map((entry) => entry.deviceID));
  const wanted = planned.devices.filter((deviceId) => deviceId !== ownId && !shared.has(deviceId));
  const share = wanted.filter((deviceId) => known.has(deviceId) && !closed.has(deviceId));
  const unshare = [...shared].filter((deviceId) => deviceId !== ownId && layoutDevices.has(deviceId) && !planned.devices.includes(deviceId));
  return {
    open: share.length || unshare.length ? { share, unshare } : null,
    closed: wanted.filter((deviceId) => known.has(deviceId) && closed.has(deviceId)),
    unknown: wanted.filter((deviceId) => !known.has(deviceId)),
  };
}

function devicesWords(deviceIds: string[]): string {
  return deviceIds.map(shortDeviceId).join(", ");
}

function change(field: ReconcileField, text: string, held: string | null = null): FieldChange {
  return { field, text, held, written: false };
}

function ignoresText(before: readonly string[] | null, after: readonly string[]): string {
  if (before === null) return `ignore patterns: add the layered sync block (${after.join(" ")}) above the node's own lines`;
  const added = after.filter((line) => !before.includes(line));
  const removed = before.filter((line) => !after.includes(line));
  const parts = [...(added.length ? [`add ${added.join(" ")}`] : []), ...(removed.length ? [`remove ${removed.join(" ")}`] : [])];
  return `ignore patterns: ${parts.length ? parts.join("; ") : "reordered"}`;
}

interface Diff {
  work: FolderWork;
  changes: FieldChange[];
  unknown: string[];
}

interface DiffContext {
  ownId: string;
  known: ReadonlySet<string>;
  layoutDevices: ReadonlySet<string>;
  closed: ReadonlySet<string>;
  cluster: boolean;
}

function typeDiff(planned: PlannedFolder, current: CurrentFolder, context: DiffContext): { type: FolderType | null; changes: FieldChange[] } {
  const from = current.settings.type;
  if (from === planned.type) return { type: null, changes: [] };
  const held = typeHeld(from, planned, context.cluster);
  return { type: held ? null : planned.type, changes: [change("type", `type ${folderTypeTexts[from]} to ${folderTypeTexts[planned.type]}`, held)] };
}

function sharingDiff(planned: PlannedFolder, current: CurrentFolder, context: DiffContext): { sharing: Sharing | null; changes: FieldChange[]; unknown: string[] } {
  const shares = sharesOf(current.settings, planned, context.ownId, context.known, context.layoutDevices, context.closed);
  const changes: FieldChange[] = [];
  if (shares.open) {
    const parts = [...(shares.open.share.length ? [`share with ${devicesWords(shares.open.share)}`] : []), ...(shares.open.unshare.length ? [`stop sharing with ${devicesWords(shares.open.unshare)}`] : [])];
    changes.push(change("sharing", parts.join(", ")));
  }
  for (const deviceId of shares.closed) {
    changes.push(change("sharing", `share with ${shortDeviceId(deviceId)}`, `${shortDeviceId(deviceId)}'s access is closed, so nothing is shared with it until its encryption exists`));
  }
  return { sharing: shares.open, changes, unknown: shares.unknown };
}

function ignoresDiff(planned: PlannedFolder, current: CurrentFolder): { ignores: string[] | null; changes: FieldChange[] } {
  if (!current.ignores) return { ignores: null, changes: [] };
  const { block } = current.ignores;
  if (block !== null && isSameLines(block, planned.ignores)) return { ignores: null, changes: [] };
  return { ignores: planned.ignores, changes: [change("ignores", ignoresText(block, planned.ignores))] };
}

function versioningDiff(planned: PlannedFolder, current: CurrentFolder): { versioning: SyncthingObject | null; changes: FieldChange[] } {
  const from = current.settings.versioning;
  if (versioningSummary(from) === plannedSummary(planned.versioning)) return { versioning: null, changes: [] };
  const held = versioningHeld(from, planned.versioning);
  const text = `versioning ${versioningWords(versioningSummary(from))} to ${versioningWords(plannedSummary(planned.versioning))}`;
  return { versioning: held || !planned.versioning ? null : wantedVersioning(from, planned.versioning), changes: [change("versioning", text, held)] };
}

function diffOf(planned: PlannedFolder, current: CurrentFolder, context: DiffContext): Diff {
  const type = typeDiff(planned, current, context);
  const sharing = sharingDiff(planned, current, context);
  const ignores = ignoresDiff(planned, current);
  const versioning = versioningDiff(planned, current);
  return {
    work: { planned, current, type: type.type, sharing: sharing.sharing, ignores: ignores.ignores, versioning: versioning.versioning },
    changes: [...type.changes, ...sharing.changes, ...ignores.changes, ...versioning.changes],
    unknown: sharing.unknown,
  };
}

/**
 * The order the folder's writes go in.
 * @implNote A folder turning send-only stops pulling before anything else; otherwise whatever makes it pull comes last.
 */
function writeOrder(work: FolderWork): ReconcileField[] {
  return work.type === "sendonly" ? ["type", "ignores", "versioning", "sharing"] : ["ignores", "versioning", "sharing", "type"];
}

async function readFolder(instance: LocalInstance, folderId: string): Promise<SyncthingFolderSettings> {
  return callSyncthing(instance, (client) => client.folderSettings(folderId));
}

async function readIgnoreLines(instance: LocalInstance, folderId: string): Promise<string[]> {
  const answer = await callSyncthing(instance, (client) => client.request<{ ignore: string[] | null }>("GET", `/db/ignores?folder=${encodeURIComponent(folderId)}`));
  return answer?.ignore ?? [];
}

interface Writer {
  instance: LocalInstance;
  options: ReconcileOptions;
  delays: readonly number[];
}

async function patchField(writer: Writer, folderId: string, body: SyncthingObject, isInPlace: (settings: SyncthingFolderSettings) => boolean): Promise<void> {
  await writeConfirmed(
    writer.instance,
    (client) => client.request("PATCH", `/config/folders/${encodeURIComponent(folderId)}`, body),
    async () => isInPlace(await readFolder(writer.instance, folderId)),
    writer.delays,
  );
}

async function writeIgnores(writer: Writer, folderId: string, lines: string[]): Promise<void> {
  await writeConfirmed(
    writer.instance,
    () => writeIgnoreLines(writer.instance, folderId, lines),
    async () => isSameLines(await readIgnoreLines(writer.instance, folderId), lines),
    writer.delays,
  );
}

/**
 * Writes the planned block above the node's own lines, and its `#include` only once the hand-off list exists; null when written, else why it waits.
 * @implNote Syncthing stops a folder whose `#include` names a missing file, so the list is first ignored, then created, then included:
 * created before it is ignored, a scan could send it to every keeper as an ordinary file.
 */
async function applyIgnores(writer: Writer, work: FolderWork, block: string[]): Promise<string | null> {
  const [include] = handoffIgnoreLines;
  const { block: currentBlock, outside } = work.current.ignores ?? { block: null, outside: [] };
  if (block.includes(include) && !(currentBlock ?? []).includes(include)) {
    const withoutInclude = managedIgnoreLines(block.filter((line) => line !== include), outside);
    const currentLines = currentBlock === null ? outside : managedIgnoreLines(currentBlock, outside);
    if (!isSameLines(currentLines, withoutInclude)) await writeIgnores(writer, work.planned.id, withoutInclude);
    const problem = await writer.options.handoffFiles.ensure(writer.instance, { id: work.planned.id, path: work.current.settings.path });
    if (problem) return `${handoffIgnoreFile} is not in place on ${writer.instance.name} (${problem}), so its #include waits`;
  }
  await writeIgnores(writer, work.planned.id, managedIgnoreLines(block, outside));
  return null;
}

function deviceSet(settings: SyncthingFolderSettings): string {
  return JSON.stringify([...new Set(settings.devices.map((entry) => entry.deviceID))].sort());
}

/** @implNote The list is read again just before it is written, so a device shared meanwhile by someone else stays shared. */
async function applySharing(writer: Writer, folderId: string, sharing: Sharing): Promise<void> {
  const fresh = await readFolder(writer.instance, folderId);
  const effective = effectiveSharing(fresh.devices, { share: sharing.share.map((deviceId) => ({ deviceId })), unshare: sharing.unshare });
  if (!effective.share.length && !effective.unshare.length) return;
  const devices = sharedDevices(fresh.devices, effective);
  const wanted = deviceSet({ ...fresh, devices });
  await patchField(writer, folderId, { devices }, (settings) => deviceSet(settings) === wanted);
}

async function applyField(writer: Writer, work: FolderWork, field: ReconcileField): Promise<"written" | "none" | string> {
  const folderId = work.planned.id;
  if (field === "type" && work.type) {
    const type = work.type;
    await patchField(writer, folderId, { type }, (settings) => settings.type === type);
    return "written";
  }
  if (field === "sharing" && work.sharing) {
    await applySharing(writer, folderId, work.sharing);
    return "written";
  }
  if (field === "versioning" && work.versioning) {
    const wanted = plannedSummary(work.planned.versioning);
    await patchField(writer, folderId, { versioning: work.versioning }, (settings) => versioningSummary(settings.versioning) === wanted);
    return "written";
  }
  if (field === "ignores" && work.ignores) return (await applyIgnores(writer, work, work.ignores)) ?? "written";
  return "none";
}

function changeText(instance: LocalInstance, work: FolderWork, entry: FieldChange): string {
  return `${instance.name}: layered sync changed folder ${work.planned.label}: ${entry.text}`;
}

async function applyFolder(writer: Writer, work: FolderWork, result: FolderReconcile): Promise<void> {
  const confirmProblem = arrayConfirmProblem(writer.instance, work.planned.id, writer.options.confirmations?.[work.planned.id], "change it");
  if (confirmProblem) {
    result.held = confirmProblem;
    return;
  }
  for (const field of writeOrder(work)) {
    const outcome = await applyField(writer, work, field);
    if (outcome === "none") continue;
    const entry = result.changes.find((candidate) => candidate.field === field && candidate.held === null);
    if (outcome !== "written") {
      if (entry) entry.held = outcome;
      continue;
    }
    result.written.push(field);
    if (!entry) continue;
    entry.written = true;
    writer.options.onWritten?.(work.planned.id, changeText(writer.instance, work, entry));
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Brings the node's Syncthing to its plan, changing only the fields that differ (type, sharing, the managed block of ignore lines,
 * versioning), each by a write of its own, read back as `writeConfirmed` does. Report mode (`apply` false) writes nothing and returns the same diff.
 * A change that must not be made as things stand is reported with why it is held. An array's folder is changed only with its folder ID typed;
 * a folder is never added, removed or moved here. A node that does not answer is the 503 of `callSyncthing`, which names it; a folder whose
 * writes fail is listed in `failed` and the others go on.
 */
export async function reconcileNode(instance: LocalInstance, plan: NodePlan, options: ReconcileOptions): Promise<NodeReconcile> {
  const [ownId, configured, devices] = await Promise.all([
    callSyncthing(instance, (client) => client.myId()),
    callSyncthing(instance, (client) => client.request<SyncthingFolderSettings[] | null>("GET", "/config/folders")),
    callSyncthing(instance, (client) => client.devices()),
  ]);
  const byId = new Map((configured ?? []).map((folder) => [folder.id, folder]));
  const context: DiffContext = { ownId, known: new Set((devices ?? []).map((device) => device.deviceID)), layoutDevices: layoutDeviceIds(options.layout), closed: closedDeviceIds(options.layout), cluster: plan.cluster };
  const result: NodeReconcile = { nodeId: plan.nodeId, mode: options.apply ? "apply" : "report", folders: [], missing: [], unplanned: [], unknownDevices: [], nodeOnlyIgnores: [], failed: [] };
  const unknownDevices = new Set<string>();
  const works: { work: FolderWork; reconcile: FolderReconcile }[] = [];
  for (const planned of plan.folders) {
    const settings = byId.get(planned.id);
    if (!settings) {
      result.missing.push({ folderId: planned.id, label: planned.label, path: planned.path });
      continue;
    }
    const ignores = settings.type === "receiveencrypted" ? null : splitIgnores(await readIgnoreLines(instance, planned.id));
    const ownLines = (ignores?.outside ?? []).filter((line) => line.trim());
    if (ownLines.length) result.nodeOnlyIgnores.push({ folderId: planned.id, label: planned.label, lines: ownLines });
    const diff = diffOf(planned, { settings, ignores }, context);
    for (const deviceId of diff.unknown) unknownDevices.add(deviceId);
    if (diff.changes.length) works.push({ work: diff.work, reconcile: { folderId: planned.id, label: planned.label, changes: diff.changes, written: [], held: null, failed: null } });
  }
  result.unplanned = unplannedFolders(options.layout, plan, new Set(byId.keys()));
  result.unknownDevices = [...unknownDevices].sort();
  result.folders = works.map((entry) => entry.reconcile);
  if (!options.apply) return result;
  const writer: Writer = { instance, options, delays: options.readBackDelaysMs ?? defaultReadBackDelaysMs };
  for (const { work, reconcile } of works) {
    try {
      await applyFolder(writer, work, reconcile);
    } catch (error) {
      reconcile.failed = reasonOf(error);
      result.failed.push(`${reconcile.label}: ${reconcile.failed}`);
    }
  }
  return result;
}

/** The layout folders the node has that its plan leaves out. */
function unplannedFolders(layout: SetupLayout, plan: NodePlan, configuredIds: ReadonlySet<string>): string[] {
  const planned = new Set(plan.folders.map((folder) => folder.id));
  const layoutIds = layout.folders.flatMap((folder) => [folder.id, `${plan.nodeId}-${folder.id}`]);
  return [...new Set(layoutIds)].filter((id) => configuredIds.has(id) && !planned.has(id)).sort();
}
