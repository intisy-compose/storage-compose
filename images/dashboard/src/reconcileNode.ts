import { shortDeviceId } from "./api/deviceText.js";
import { type FolderType, folderTypeTexts } from "./api/types.js";
import { type LocalInstance, arrayConfirmProblem, callSyncthing, defaultReadBackDelaysMs, writeConfirmed } from "./instanceResolver.js";
import { type NodePlan, type PlannedFolder, type PlannedVersioning, handoffIgnoreFile, handoffIgnoreLines } from "./nodePlan.js";
import { writeIgnoreLines } from "./routes/folderIgnores.js";
import { type SetupLayout, topDirectoryPath } from "./setupRepo.js";
import type { SyncthingFolderSettings } from "./syncthing.js";
import { sharedDevices } from "./syncthingConfig.js";

export type ReconcileField = "type" | "sharing" | "ignores" | "versioning";

export interface FieldChange {
  field: ReconcileField;
  text: string;
}

export interface FolderReconcile {
  folderId: string;
  label: string;
  changes: FieldChange[];
  /** The fields written, in the order they were sent. */
  written: ReconcileField[];
  /** Why changes of the folder were not written; null when nothing held them. */
  held: string | null;
}

export interface MissingFolder {
  folderId: string;
  label: string;
  path: string;
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
}

/** The node's own files, which the dashboard reaches only where this host mounts them. */
export interface HandoffFiles {
  /** Creates the folder's empty `.stignore-handoff` unless it exists, never changing one that does; false when this host cannot. */
  ensure(instance: LocalInstance, folder: { id: string; path: string }): Promise<boolean>;
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

type SyncthingObject = Record<string, unknown>;

interface CurrentFolder {
  settings: SyncthingFolderSettings;
  ignores: string[] | null;
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
  ignores: string[] | null;
  versioning: SyncthingObject | null;
}

/** Every device ID the layout lists. */
export function layoutDeviceIds(layout: SetupLayout): Set<string> {
  return new Set(layout.devices.map((device) => device.id).filter(Boolean));
}

/**
 * The layout paths the node carries for `nodePlan`'s `localFolders`: each layout folder its Syncthing has, by the shared ID or its own priority 0 ID.
 * @implNote A folder the node has counts as held whatever it holds, so one that goes below the threshold turns send-only and stops pulling instead
 * of falling out of the plan while it stays send-receive; what it holds nothing in is left for the hand-off to empty.
 */
export function carriedLayoutPaths(layout: SetupLayout, nodeId: string, configuredIds: ReadonlySet<string>): Set<string> {
  return new Set(layout.folders.filter((folder) => folder.relativePath !== topDirectoryPath && (configuredIds.has(folder.id) || configuredIds.has(`${nodeId}-${folder.id}`))).map((folder) => folder.relativePath));
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
  return seconds ? `${type}, ${Number(seconds) / secondsPerDay} days` : type;
}

/** The folder's versioning with the plan's type and maximum age, every other field as Syncthing has it. */
function wantedVersioning(current: SyncthingFolderSettings["versioning"], planned: PlannedVersioning | null): SyncthingObject {
  const base = { ...(current ?? {}) } as SyncthingObject;
  if (!planned) return { ...base, type: "", params: {} };
  const params = current?.type === "staggered" ? { ...(current.params ?? {}) } : {};
  return { ...base, type: "staggered", params: { ...params, maxAge: String(planned.maxAgeDays * secondsPerDay) } };
}

function isSameLines(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

function sharingOf(current: SyncthingFolderSettings, planned: PlannedFolder, ownId: string, known: ReadonlySet<string>, layoutDevices: ReadonlySet<string>): { sharing: Sharing | null; unknown: string[] } {
  const shared = new Set(current.devices.map((entry) => entry.deviceID));
  const wanted = planned.devices.filter((deviceId) => deviceId !== ownId);
  const share = wanted.filter((deviceId) => !shared.has(deviceId) && known.has(deviceId));
  const unknown = wanted.filter((deviceId) => !shared.has(deviceId) && !known.has(deviceId));
  const unshare = [...shared].filter((deviceId) => deviceId !== ownId && layoutDevices.has(deviceId) && !planned.devices.includes(deviceId));
  return { sharing: share.length || unshare.length ? { share, unshare } : null, unknown };
}

function devicesWords(deviceIds: string[]): string {
  return deviceIds.map(shortDeviceId).join(", ");
}

function changesOf(work: FolderWork): FieldChange[] {
  const changes: FieldChange[] = [];
  if (work.type) changes.push({ field: "type", text: `type ${folderTypeTexts[work.current.settings.type]} to ${folderTypeTexts[work.type]}` });
  if (work.sharing) {
    const parts = [...(work.sharing.share.length ? [`share with ${devicesWords(work.sharing.share)}`] : []), ...(work.sharing.unshare.length ? [`stop sharing with ${devicesWords(work.sharing.unshare)}`] : [])];
    changes.push({ field: "sharing", text: parts.join(", ") });
  }
  if (work.ignores) {
    const before = work.current.ignores ?? [];
    const added = work.ignores.filter((line) => !before.includes(line));
    const removed = before.filter((line) => !work.ignores!.includes(line));
    const parts = [...(added.length ? [`add ${added.join(" ")}`] : []), ...(removed.length ? [`remove ${removed.join(" ")}`] : [])];
    changes.push({ field: "ignores", text: `ignore patterns: ${parts.length ? parts.join("; ") : "reordered"}` });
  }
  if (work.versioning) changes.push({ field: "versioning", text: `versioning ${versioningWords(versioningSummary(work.current.settings.versioning))} to ${versioningWords(plannedSummary(work.planned.versioning))}` });
  return changes;
}

/**
 * The order the folder's writes go in.
 * @implNote Whatever makes a folder pull comes last: a folder turning send-receive first ignores its child entries and keeps versions, so it
 * never pulls a child's files into itself or replaces a file unversioned; a folder turning send-only stops pulling before anything else.
 */
function writeOrder(work: FolderWork): ReconcileField[] {
  return work.type === "sendonly" ? ["type", "ignores", "versioning", "sharing"] : ["ignores", "versioning", "sharing", "type"];
}

async function readFolder(instance: LocalInstance, folderId: string): Promise<SyncthingFolderSettings> {
  return callSyncthing(instance, (client) => client.folderSettings(folderId));
}

async function readIgnores(instance: LocalInstance, folderId: string): Promise<string[]> {
  const answer = await callSyncthing(instance, (client) => client.request<{ ignore: string[] | null }>("GET", `/db/ignores?folder=${encodeURIComponent(folderId)}`));
  return answer?.ignore ?? [];
}

interface Writer {
  instance: LocalInstance;
  options: ReconcileOptions;
  delays: readonly number[];
}

async function patchField(writer: Writer, folderId: string, change: SyncthingObject, isInPlace: (settings: SyncthingFolderSettings) => boolean): Promise<void> {
  await writeConfirmed(
    writer.instance,
    (client) => client.request("PATCH", `/config/folders/${encodeURIComponent(folderId)}`, change),
    async () => isInPlace(await readFolder(writer.instance, folderId)),
    writer.delays,
  );
}

async function writeIgnores(writer: Writer, folderId: string, lines: string[]): Promise<void> {
  await writeConfirmed(
    writer.instance,
    () => writeIgnoreLines(writer.instance, folderId, lines),
    async () => isSameLines(await readIgnores(writer.instance, folderId), lines),
    writer.delays,
  );
}

/**
 * Writes the plan's ignore lines, and only once the hand-off list they include exists; null when written, else why it waits.
 * @implNote Syncthing stops a folder whose `#include` names a missing file, so the list is first ignored, then created, then included:
 * created before it is ignored, a scan could send it to every keeper as an ordinary file.
 */
async function applyIgnores(writer: Writer, work: FolderWork, lines: string[]): Promise<string | null> {
  const [include] = handoffIgnoreLines;
  const current = work.current.ignores ?? [];
  if (lines.includes(include) && !current.includes(include)) {
    const withoutInclude = lines.filter((line) => line !== include);
    if (!isSameLines(current, withoutInclude)) await writeIgnores(writer, work.planned.id, withoutInclude);
    if (!(await writer.options.handoffFiles.ensure(writer.instance, { id: work.planned.id, path: work.current.settings.path }))) {
      return `${handoffIgnoreFile} could not be created on ${writer.instance.name} from this host, so its #include waits`;
    }
  }
  await writeIgnores(writer, work.planned.id, lines);
  return null;
}

async function applyField(writer: Writer, work: FolderWork, field: ReconcileField): Promise<"written" | "none" | string> {
  const folderId = work.planned.id;
  if (field === "type" && work.type) {
    const type = work.type;
    await patchField(writer, folderId, { type }, (settings) => settings.type === type);
    return "written";
  }
  if (field === "sharing" && work.sharing) {
    const devices = sharedDevices(work.current.settings.devices, { share: work.sharing.share.map((deviceId) => ({ deviceId })), unshare: work.sharing.unshare });
    const wanted = [...new Set(devices.map((entry) => entry.deviceID))].sort();
    await patchField(writer, folderId, { devices }, (settings) => JSON.stringify([...new Set(settings.devices.map((entry) => entry.deviceID))].sort()) === JSON.stringify(wanted));
    return "written";
  }
  if (field === "versioning" && work.versioning) {
    const wanted = plannedSummary(work.planned.versioning);
    await patchField(writer, folderId, { versioning: work.versioning }, (settings) => versioningSummary(settings.versioning) === wanted);
    return "written";
  }
  if (field === "ignores" && work.ignores) {
    const held = await applyIgnores(writer, work, work.ignores);
    return held ?? "written";
  }
  return "none";
}

function changeText(instance: LocalInstance, work: FolderWork, change: FieldChange): string {
  return `${instance.name}: layered sync changed folder ${work.planned.label}: ${change.text}`;
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
    if (outcome !== "written") {
      result.held = outcome;
      continue;
    }
    result.written.push(field);
    const change = result.changes.find((entry) => entry.field === field);
    if (change) writer.options.onWritten?.(work.planned.id, changeText(writer.instance, work, change));
  }
}

function workOf(planned: PlannedFolder, current: CurrentFolder, ownId: string, known: ReadonlySet<string>, layoutDevices: ReadonlySet<string>): { work: FolderWork; unknown: string[] } {
  const { sharing, unknown } = sharingOf(current.settings, planned, ownId, known, layoutDevices);
  const ignores = current.ignores !== null && !isSameLines(current.ignores, planned.ignores) ? planned.ignores : null;
  const versioning = versioningSummary(current.settings.versioning) !== plannedSummary(planned.versioning) ? wantedVersioning(current.settings.versioning, planned.versioning) : null;
  return { work: { planned, current, type: current.settings.type !== planned.type ? planned.type : null, sharing, ignores, versioning }, unknown };
}

/**
 * Brings the node's Syncthing to its plan, changing only the fields that differ (type, sharing, ignore lines, versioning), each by a write
 * of its own, read back as `writeConfirmed` does. Report mode (`apply` false) writes nothing and returns the same diff.
 * An array's folder is changed only with its folder ID typed (`arrayConfirmProblem`); a folder is never added, removed or moved here.
 * A node that does not answer is the 503 of `callSyncthing`, which names it.
 */
export async function reconcileNode(instance: LocalInstance, plan: NodePlan, options: ReconcileOptions): Promise<NodeReconcile> {
  const [ownId, configured, devices] = await Promise.all([
    callSyncthing(instance, (client) => client.myId()),
    callSyncthing(instance, (client) => client.request<SyncthingFolderSettings[] | null>("GET", "/config/folders")),
    callSyncthing(instance, (client) => client.devices()),
  ]);
  const byId = new Map((configured ?? []).map((folder) => [folder.id, folder]));
  const known = new Set((devices ?? []).map((device) => device.deviceID));
  const result: NodeReconcile = { nodeId: plan.nodeId, mode: options.apply ? "apply" : "report", folders: [], missing: [], unplanned: [], unknownDevices: [] };
  const unknownDevices = new Set<string>();
  const layoutDevices = layoutDeviceIds(options.layout);
  const works: { work: FolderWork; reconcile: FolderReconcile }[] = [];
  for (const planned of plan.folders) {
    const settings = byId.get(planned.id);
    if (!settings) {
      result.missing.push({ folderId: planned.id, label: planned.label, path: planned.path });
      continue;
    }
    const ignores = settings.type === "receiveencrypted" ? null : await readIgnores(instance, planned.id);
    const { work, unknown } = workOf(planned, { settings, ignores }, ownId, known, layoutDevices);
    for (const deviceId of unknown) unknownDevices.add(deviceId);
    const changes = changesOf(work);
    if (changes.length) works.push({ work, reconcile: { folderId: planned.id, label: planned.label, changes, written: [], held: null } });
  }
  result.unplanned = unplannedFolders(options.layout, plan, new Set(byId.keys()));
  result.unknownDevices = [...unknownDevices].sort();
  result.folders = works.map((entry) => entry.reconcile);
  if (!options.apply) return result;
  const writer: Writer = { instance, options, delays: options.readBackDelaysMs ?? defaultReadBackDelaysMs };
  for (const { work, reconcile } of works) await applyFolder(writer, work, reconcile);
  return result;
}

/** The layout folders the node has that its plan leaves out. */
function unplannedFolders(layout: SetupLayout, plan: NodePlan, configuredIds: ReadonlySet<string>): string[] {
  const planned = new Set(plan.folders.map((folder) => folder.id));
  const layoutIds = layout.folders.flatMap((folder) => [folder.id, `${plan.nodeId}-${folder.id}`]);
  return [...new Set(layoutIds)].filter((id) => configuredIds.has(id) && !planned.has(id)).sort();
}
