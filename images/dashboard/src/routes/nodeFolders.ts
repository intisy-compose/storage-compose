import { deviceDisplayName, shortDeviceId } from "../api/deviceText.js";
import { type FolderEditBody, type FolderPathCheck, type FolderSettings, type FolderSettingsChange, type FolderShare, type FolderSharingChange, type FolderType, type NewFolder, type NewFolderDefaults, type Versioning, folderSettingLabels, folderTypeTexts, pullOrderTexts, sharePassword } from "../api/types.js";
import { ignoreLinesProblem } from "../api/ignorePatterns.js";
import { versioningWords, versionsPathLabel } from "../api/versioningText.js";
import { folderSettings } from "../folderIndex.js";
import { RequestError, readBody, sendJson } from "../http.js";
import { type LocalInstance, type ResolvedInstance, arrayConfirmProblem, callSyncthing, defaultReadBackDelaysMs, isArrayInstance, localNodeInfos, requireLocal, resolveInstance, writeConfirmed } from "../instanceResolver.js";
import { type NodeRoot, folderPathProblem, isAbsolutePath, isInsideOtherNode, isInsideRoot, isStrictlyBelow, pathUnderRoot } from "../pathGuard.js";
import type { AnyRoute, NothingWritten, WriteNote } from "../routes.js";
import type { SyncthingDeviceConfig, SyncthingFolderSettings } from "../syncthing.js";
import { effectiveSharing, folderChangeProblem, isChangeInPlace, sharedDevices } from "../syncthingConfig.js";
import { otherFoldersGroup, relativeToRoot } from "../treePaths.js";
import { decodedSegment } from "./devices.js";
import { defaultIgnoreLines, writeIgnoreLines } from "./folderIgnores.js";

type SyncthingObject = Record<string, unknown>;

const folderTypes = Object.keys(folderTypeTexts) as FolderType[];

const newFolderKeys: readonly (keyof NewFolder)[] = ["id", "label", "path", "type", "paused", "ignores", "confirm"];

const confirmTypeProblem = "the confirmation must be the folder ID as text";

function asObject(value: unknown): SyncthingObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as SyncthingObject) : {};
}

/** Why `body` is no new folder, or null; checked before anything is read from the node. */
export function newFolderProblem(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "a new folder needs an ID and a path";
  const fields = body as SyncthingObject;
  const unknown = Object.keys(fields).find((key) => !newFolderKeys.includes(key as keyof NewFolder));
  if (unknown) return `${unknown} is not a setting of a new folder`;
  if (typeof fields.id !== "string" || !fields.id.trim()) return "the folder ID is missing";
  if (typeof fields.path !== "string" || !fields.path.trim()) return "the folder path is missing";
  if (fields.label !== undefined && typeof fields.label !== "string") return "Label must be text";
  if (fields.type !== undefined && !folderTypes.includes(fields.type as FolderType)) return `Type must be ${folderTypes.join(", ")}`;
  if (fields.paused !== undefined && typeof fields.paused !== "boolean") return "Paused must be on or off";
  if (fields.confirm !== undefined && typeof fields.confirm !== "string") return confirmTypeProblem;
  if (fields.ignores === undefined) return null;
  if (!Array.isArray(fields.ignores) || !fields.ignores.every((line) => typeof line === "string")) return "the ignore patterns must be a list of lines";
  return ignoreLinesProblem(fields.ignores);
}

interface RootedInstance {
  instance: LocalInstance;
  node: NodeRoot;
}

/** The node as the path guard judges it; a node whose root this host does not know cannot take a folder. */
function rooted(instance: ResolvedInstance): RootedInstance {
  const local = requireLocal(instance);
  if (!local.root) throw new RequestError(409, `${local.name} has no root known to the dashboard, so no folder can be placed on it`);
  return { instance: local, node: { nodeId: local.nodeId, name: local.name, root: local.root, os: local.os } };
}

async function configuredFolders(instance: LocalInstance): Promise<SyncthingFolderSettings[]> {
  return (await callSyncthing(instance, (client) => client.request<SyncthingFolderSettings[] | null>("GET", "/config/folders"))) ?? [];
}

async function syncthingDefaults(instance: LocalInstance): Promise<SyncthingObject> {
  return asObject(await callSyncthing(instance, (client) => client.request<unknown>("GET", "/config/defaults/folder")));
}

function isSamePath(left: string, right: string, node: NodeRoot): boolean {
  return relativeToRoot(left, right, node.os) === "" && relativeToRoot(right, left, node.os) === "";
}

/** The path as the guard read it: `..` and `.` resolved, the node's separator, the root as the node names it. */
function checkedPath(path: string, node: NodeRoot): string {
  return pathUnderRoot(node.root, relativeToRoot(path, node.root, node.os) ?? "", node.os);
}

function samePathProblem(instance: LocalInstance, folders: SyncthingFolderSettings[], path: string, node: NodeRoot): string | null {
  const samePath = folders.find((existing) => isSamePath(existing.path, path, node));
  return samePath ? `${instance.name}'s folder ${folderName(samePath)} already uses ${samePath.path}` : null;
}

function overlapWarning(folders: SyncthingFolderSettings[], path: string, node: NodeRoot): string | null {
  const holder = folders.find((existing) => isStrictlyBelow(path, existing.path, node.os));
  if (holder) return `inside folder ${folderName(holder)} (${holder.path}), so its files would sync in both`;
  const held = folders.find((existing) => isStrictlyBelow(existing.path, path, node.os));
  return held ? `holds folder ${folderName(held)} (${held.path}), so its files would sync in both` : null;
}

/**
 * How an add, or the edit of `editedFolderId`, would judge `typed` on this node: the guard's refusal first, without a
 * Syncthing call, then the node's other folders and, for a move, their versions paths as the save judges them when the
 * edit does or does not also change the folder's versioning (`editsVersioning`).
 */
export async function checkFolderPath(instance: ResolvedInstance, typed: string, nodes: NodeRoot[], editedFolderId: string | null = null, editsVersioning = false): Promise<FolderPathCheck> {
  const { instance: local, node } = rooted(instance);
  const problem = folderPathProblem(typed.trim(), node, nodes);
  if (problem) return { path: typed.trim(), problem, warning: null };
  const path = checkedPath(typed.trim(), node);
  const configured = await configuredFolders(local);
  const edited = configured.find((folder) => folder.id === editedFolderId);
  const folders = configured.filter((folder) => folder !== edited);
  const isMoved = edited !== undefined && !isSamePath(edited.path, path, node);
  const conflict = samePathProblem(local, folders, path, node) ?? (isMoved ? movedFolderVersionsProblem(path, configured, edited.id, editsVersioning, node) : null);
  return { path, problem: conflict, warning: overlapWarning(folders, path, node) };
}

/** The default devices with each of `deviceIds` added unless it is there already. */
function withDevices(devices: unknown, deviceIds: string[]): unknown[] {
  const list = Array.isArray(devices) ? [...devices] : [];
  for (const deviceId of deviceIds) if (!list.some((device) => asObject(device).deviceID === deviceId)) list.push({ deviceID: deviceId, introducedBy: "", encryptionPassword: "" });
  return list;
}

function folderName(folder: Pick<SyncthingFolderSettings, "id" | "label">): string {
  return folder.label || folder.id;
}

/** How the add's ignore patterns went: how many lines it started with, and why it stayed paused when they could not be set. */
export interface AddedIgnores {
  lines: number;
  keptPaused: string | null;
}

const noIgnores: AddedIgnores = { lines: 0, keptPaused: null };

/** What an add did, in words: `pc: added folder Projects (projects) at F:\Projects; send only; 2 lines of ignore patterns`. */
export function folderAddText(nodeName: string, folder: NewFolder, ignores: AddedIgnores = noIgnores): string {
  const named = folder.label && folder.label !== folder.id ? `${folder.label} (${folder.id})` : folder.id;
  const details = [
    ...(folder.type ? [folderTypeTexts[folder.type]] : []),
    ...(folder.paused ? ["paused"] : []),
    ...(ignores.lines ? [`${ignores.lines} ${ignores.lines === 1 ? "line" : "lines"} of ignore patterns`] : []),
    ...(ignores.keptPaused ? [ignores.keptPaused] : []),
  ];
  return [`${nodeName}: added folder ${named} at ${folder.path}`, ...details].join("; ");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Writes the new folder's patterns, then resumes it unless it was asked to start paused; null once it runs as asked, else why it stays paused. */
async function startWithIgnores(instance: LocalInstance, folder: NewFolder, lines: string[], startsPaused: boolean): Promise<string | null> {
  try {
    await writeIgnoreLines(instance, folder.id, lines);
  } catch (error) {
    return `kept paused, as its ignore patterns were not saved: ${messageOf(error)}`;
  }
  if (startsPaused) return null;
  try {
    await callSyncthing(instance, (client) => client.request("PATCH", `/config/folders/${encodeURIComponent(folder.id)}`, { paused: false }));
    return null;
  } catch (error) {
    return `kept paused, as it could not be resumed once its ignore patterns were saved: ${messageOf(error)}`;
  }
}

/** The folder as the node now has it; the change is already written, so a read that fails answers what was sent. */
async function settingsAfter(instance: LocalInstance, folderId: string, sent: SyncthingObject): Promise<FolderSettings> {
  try {
    return folderSettings(await callSyncthing(instance, (client) => client.folderSettings(folderId)));
  } catch {
    return folderSettings(sent as unknown as SyncthingFolderSettings);
  }
}

export interface FolderAddition {
  added: FolderSettings;
  note: WriteNote;
}

/** What accepting an offer adds to a new folder: the device that offered it, sharing it from the start, and the versioning chosen. */
export interface OfferedFolder {
  offeredBy: string;
  versioning: Versioning;
}

/** A folder as created: the node's answer, the folder as sent, and how its ignore patterns went. */
export interface CreatedFolder {
  instance: LocalInstance;
  added: FolderSettings;
  folder: NewFolder;
  ignores: AddedIgnores;
}

/** Refuses a new folder's path outside the node's root or in another node's, without a Syncthing call. */
export function guardNewFolderPath(instance: ResolvedInstance, path: string, nodes: NodeRoot[]): void {
  const { node } = rooted(instance);
  const problem = folderPathProblem(path.trim(), node, nodes);
  if (problem) throw new RequestError(400, problem);
}

/**
 * Why a new folder at `folder.path` would mix files and versions, or null: its versions path judged against every
 * folder (the new one included), its path against every folder's versions path.
 */
function newFolderVersionsProblem(folder: NewFolder, versioning: Versioning | null, folders: SyncthingFolderSettings[], node: NodeRoot): string | null {
  const withNew = [...folders, { id: folder.id, label: folder.label ?? "", path: folder.path } as SyncthingFolderSettings];
  const versionsProblem = versioning ? versionsPathFolderProblem(versioning.fsPath, withNew, folder.id, folder.path, node) : null;
  return versionsProblem ?? movedFolderVersionsProblem(folder.path, folders, folder.id, true, node);
}

/**
 * Adds a folder to the node's Syncthing, every setting the request leaves out taken from Syncthing's own defaults;
 * an accepted offer also shares it with the offering device and sets the chosen versioning.
 * @implNote The path is judged against the node's root and the other nodes' roots before any Syncthing call,
 * as adding a folder makes Syncthing create and scan its directory; the path sent is the one judged.
 * The node's own default versioning and default ignore patterns are copied unjudged: its admin set them in the node's configuration.
 * A folder with ignore patterns is created paused and resumed once they are written, as Syncthing's own page does, so its
 * first scan already skips what they ignore; when they cannot be written it stays paused and the note says why.
 */
export async function createFolder(instance: ResolvedInstance, request: NewFolder, nodes: NodeRoot[], offered: OfferedFolder | null = null): Promise<CreatedFolder> {
  const { instance: local, node } = rooted(instance);
  const { ignores: typedIgnores, ...rest } = request;
  guardNewFolderPath(local, rest.path, nodes);
  const folder: NewFolder = { ...rest, id: rest.id.trim(), path: checkedPath(rest.path.trim(), node) };
  const versioning = offered ? guardedVersioning(local, offered.versioning, folder.path, nodes) : null;
  const [folders, defaults, ownId, ignores] = await Promise.all([
    configuredFolders(local),
    syncthingDefaults(local),
    callSyncthing(local, (client) => client.myId()),
    typedIgnores ?? defaultIgnoreLines(local),
  ]);
  if (folders.some((existing) => existing.id === folder.id)) throw new RequestError(409, `${local.name} already has folder ${folder.id}`);
  const samePath = samePathProblem(local, folders, folder.path, node);
  if (samePath) throw new RequestError(409, samePath);
  const versionsProblem = newFolderVersionsProblem(folder, versioning, folders, node);
  if (versionsProblem) throw new RequestError(400, versionsProblem);
  const holdsIgnores = ignores.length > 0;
  const chosenVersioning = versioning ? { versioning: { ...asObject(defaults.versioning), ...versioning } } : {};
  const devices = withDevices(defaults.devices, offered ? [ownId, offered.offeredBy] : [ownId]);
  const config: SyncthingObject = { ...defaults, label: "", ...folder, ...chosenVersioning, ...(holdsIgnores ? { paused: true } : {}), devices };
  await callSyncthing(local, (client) => client.request("POST", "/config/folders", config));
  const startsPaused = folder.paused ?? defaults.paused === true;
  const keptPaused = holdsIgnores ? await startWithIgnores(local, folder, ignores, startsPaused) : null;
  return { instance: local, added: await settingsAfter(local, folder.id, config), folder, ignores: { lines: ignores.length, keptPaused } };
}

/**
 * Adds a folder typed into the add form; on an array only with its ID typed, checked before any request.
 * @implNote An add alone can share the folder: the node's default devices may list another device.
 */
export async function addFolder(instance: ResolvedInstance, body: unknown, nodes: NodeRoot[]): Promise<FolderAddition> {
  const problem = newFolderProblem(body);
  if (problem) throw new RequestError(400, problem);
  const { confirm, ...request } = body as NewFolder;
  const confirmProblem = arrayConfirmProblem(requireLocal(instance), request.id.trim(), confirm, "add it");
  if (confirmProblem) throw new RequestError(400, confirmProblem);
  const created = await createFolder(instance, request, nodes);
  const { instance: local, folder, ignores } = created;
  return { added: created.added, note: { nodeId: local.nodeId, nodeName: local.name, folderId: folder.id, text: folderAddText(local.name, folder, ignores) } };
}

function onOff(value: boolean): string {
  return value ? "on" : "off";
}

type SettingsChange = Omit<FolderSettingsChange, "devices">;
type ChangedSetting = keyof SettingsChange;
type Sharing = Required<FolderSharingChange>;

function settingValueWords(key: ChangedSetting, change: Required<SettingsChange>): string {
  const value = change[key];
  if (typeof value === "boolean") return onOff(value);
  if (key === "type") return folderTypeTexts[change.type];
  if (key === "order") return pullOrderTexts[change.order];
  if (key === "minDiskFree") return `${change.minDiskFree.value} ${change.minDiskFree.unit}`;
  if (key === "rescanIntervalS") return change.rescanIntervalS ? `${change.rescanIntervalS} s` : "off";
  if (key === "fsWatcherDelayS") return `${change.fsWatcherDelayS} s`;
  if (key === "maxConflicts") return change.maxConflicts < 0 ? "unlimited" : String(change.maxConflicts);
  if (key === "versioning") return versioningWords(change.versioning);
  return String(value) || "none";
}

function settingWords(key: ChangedSetting, change: SettingsChange): string {
  const label = folderSettingLabels[key];
  return `${label.charAt(0).toLowerCase()}${label.slice(1)} ${settingValueWords(key, change as Required<SettingsChange>)}`;
}

/** @implNote Names whether a share is encrypted, never its password. */
function sharingWords(sharing: FolderSharingChange, deviceNames: ReadonlyMap<string, string>): string[] {
  const named = (deviceId: string) => deviceDisplayName(deviceNames.get(deviceId), deviceId);
  return [
    ...(sharing.share ?? []).map((entry) => `shared with ${named(entry.deviceId)}${sharePassword(entry.encryptionPassword) === null ? "" : ", encrypted"}`),
    ...(sharing.unshare ?? []).map((deviceId) => `stopped sharing with ${named(deviceId)}`),
  ];
}

/** What a folder edit changed, in words: `pc: changed folder Documents; full rescan interval 60 s; shared with laptop`. */
export function folderEditText(nodeName: string, folderName: string, change: FolderSettingsChange, deviceNames: ReadonlyMap<string, string> = new Map()): string {
  const settings = (Object.keys(folderSettingLabels) as (keyof FolderSettingsChange)[]).filter((key): key is ChangedSetting => key !== "devices" && key in change);
  const details = [...settings.map((key) => settingWords(key, change)), ...(change.devices ? sharingWords(change.devices, deviceNames) : [])];
  return [`${nodeName}: changed folder ${folderName}`, ...details].join("; ");
}

/** The new path as the guard reads it; judged before any Syncthing call, as Syncthing rescans the folder at whatever path it is given. */
function guardedPath(instance: LocalInstance, path: string, nodes: NodeRoot[]): string {
  const { node } = rooted(instance);
  const problem = folderPathProblem(path.trim(), node, nodes);
  if (problem) throw new RequestError(400, problem);
  return checkedPath(path.trim(), node);
}

/** A typed versions path as Syncthing reads it: in full, or below the folder's path. */
function versionsPathOf(typed: string, folderPath: string, node: NodeRoot): string {
  if (isAbsolutePath(typed, node.os)) return typed;
  return pathUnderRoot(folderPath, node.os === "windows" ? typed.replace(/\\/g, "/") : typed, node.os);
}

/**
 * The versioning with its versions path judged like a folder path and sent as checked; empty keeps `.stversions` inside the folder.
 * @implNote A relative path is sent in full, read from the folder's path as Syncthing reads it, so a later move of the folder
 * cannot carry its versions outside the root.
 */
function guardedVersioning(instance: LocalInstance, versioning: Versioning, folderPath: string, nodes: NodeRoot[]): Versioning {
  const typed = versioning.fsPath.trim();
  if (!typed) return { ...versioning, fsPath: "" };
  const { node } = rooted(instance);
  const path = versionsPathOf(typed, folderPath, node);
  const problem = folderPathProblem(path, node, nodes);
  if (problem) throw new RequestError(400, `${versionsPathLabel}: ${problem}`);
  return { ...versioning, fsPath: checkedPath(path, node) };
}

/**
 * Why the versions path cannot be used beside the node's folders, or null: one equal to, inside or holding a folder's path
 * (this folder's at its new path included) would sync versioned files as that folder's content.
 */
function versionsPathFolderProblem(fsPath: string, folders: SyncthingFolderSettings[], folderId: string, folderPath: string, node: NodeRoot): string | null {
  if (!fsPath) return null;
  for (const folder of folders) {
    const path = folder.id === folderId ? folderPath : folder.path;
    const named = `folder ${folderName(folder)} (${path})`;
    if (isSamePath(fsPath, path, node)) return `${versionsPathLabel}: ${fsPath} is the path of ${named}, so its versions would sync as that folder's files`;
    if (isStrictlyBelow(fsPath, path, node.os)) return `${versionsPathLabel}: ${fsPath} is inside ${named}, so its versions would sync as that folder's files`;
    if (isStrictlyBelow(path, fsPath, node.os)) return `${versionsPathLabel}: ${fsPath} holds ${named}, so that folder's files would mix with versions`;
  }
  return null;
}

/**
 * Why the folder cannot move to `newPath` beside the node's versions paths, or null: a path equal to, holding or inside a
 * folder's versions path (its own included, read from `newPath` when relative) would mix versions with the folder's files.
 * @implNote The edited folder is skipped when the edit sets its versioning too: `versionsPathFolderProblem` judges that one.
 */
function movedFolderVersionsProblem(newPath: string, folders: SyncthingFolderSettings[], folderId: string, editsVersioning: boolean, node: NodeRoot): string | null {
  for (const folder of folders) {
    const isEdited = folder.id === folderId;
    const typed = folder.versioning?.fsPath?.trim() ?? "";
    if ((isEdited && editsVersioning) || !folder.versioning?.type || !typed) continue;
    const versionsPath = versionsPathOf(typed, isEdited ? newPath : folder.path, node);
    const named = isEdited ? `its own versions path ${versionsPath}` : `the versions path ${versionsPath} of folder ${folderName(folder)}`;
    const label = folderSettingLabels.path;
    if (isSamePath(newPath, versionsPath, node)) return `${label}: ${newPath} is ${named}, so versions and files would mix`;
    if (isStrictlyBelow(versionsPath, newPath, node.os)) return `${label}: ${newPath} would hold ${named}, so those versions would sync as its files`;
    if (isStrictlyBelow(newPath, versionsPath, node.os)) return `${label}: ${newPath} is inside ${named}, so its files would mix with versions`;
  }
  return null;
}

function isSameVersionsPath(current: string, sent: string, node: NodeRoot): boolean {
  return current === sent || (current !== "" && sent !== "" && isSamePath(current, sent, node));
}

/** @implNote Only the sent params are compared: Syncthing keeps the params of the folder's earlier types beside them. */
function isVersioningInPlace(current: SyncthingFolderSettings["versioning"], sent: Versioning, node: NodeRoot): boolean {
  const now = current ?? {};
  const isSameParams = Object.entries(sent.params).every(([key, value]) => now.params?.[key] === value);
  return (now.type ?? "") === sent.type && now.cleanupIntervalS === sent.cleanupIntervalS && isSameVersionsPath(now.fsPath ?? "", sent.fsPath, node) && isSameParams;
}

function otherFolderAtPath(instance: LocalInstance, folders: SyncthingFolderSettings[], folderId: string, path: string): string | null {
  const { node } = rooted(instance);
  return samePathProblem(instance, folders.filter((folder) => folder.id !== folderId), path, node);
}

function isSharingInPlace(current: SyncthingFolderSettings, sharing: Sharing): boolean {
  const shared = new Set(current.devices.map((entry) => entry.deviceID));
  return sharing.share.every((entry) => shared.has(entry.deviceId)) && sharing.unshare.every((deviceId) => !shared.has(deviceId));
}

/** @implNote The path is compared as the guard reads paths, so Syncthing writing it with another case or a trailing separator still counts. */
function isFolderChangeInPlace(instance: LocalInstance, current: SyncthingFolderSettings, settings: SettingsChange, sharing: Sharing): boolean {
  const { path, versioning, ...rest } = settings;
  const { node } = rooted(instance);
  const isPathInPlace = path === undefined || isSamePath(current.path, path, node);
  const isVersioningSaved = versioning === undefined || isVersioningInPlace(current.versioning, versioning, node);
  return isChangeInPlace(current, rest) && isPathInPlace && isVersioningSaved && isSharingInPlace(current, sharing);
}

interface SharingPlan {
  /** Only what changes the folder's devices. */
  sharing: Sharing;
  deviceNames: Map<string, string>;
}

const noSharing: SharingPlan = { sharing: { share: [], unshare: [] }, deviceNames: new Map() };

function shareProblem(instance: LocalInstance, devices: SyncthingDeviceConfig[], entry: FolderShare): string | null {
  const device = devices.find((candidate) => candidate.deviceID === entry.deviceId);
  if (!device) return `${instance.name} has no device ${shortDeviceId(entry.deviceId)}`;
  const isUnencrypted = sharePassword(entry.encryptionPassword) === null;
  return device.untrusted && isUnencrypted ? `${deviceDisplayName(device.name, device.deviceID)} is untrusted, so it is shared a folder only with an encryption password` : null;
}

/** A share of a device that already has the folder may not carry another password: Syncthing would re-encrypt it unannounced. */
function passwordChangeProblem(before: SyncthingFolderSettings, entry: FolderShare, deviceNames: ReadonlyMap<string, string>): string | null {
  const current = before.devices.find((device) => device.deviceID === entry.deviceId);
  const sent = sharePassword(entry.encryptionPassword);
  if (!current || sent === null || sent === (current.encryptionPassword ?? "")) return null;
  return `${deviceDisplayName(deviceNames.get(entry.deviceId), entry.deviceId)} already has the folder; its encryption password changes only by stopping sharing and sharing again`;
}

/** The sharing part of an edit, checked against the node's devices before anything is written. */
async function planSharing(instance: LocalInstance, before: SyncthingFolderSettings, change: FolderSharingChange): Promise<SharingPlan> {
  const [devices, ownId] = await Promise.all([callSyncthing(instance, (client) => client.devices()), callSyncthing(instance, (client) => client.myId())]);
  const deviceNames = new Map(devices.map((device) => [device.deviceID, device.name]));
  if (change.unshare?.includes(ownId)) throw new RequestError(400, `${deviceDisplayName(deviceNames.get(ownId), ownId)} is the node's own device; it keeps every folder of the node`);
  const passwordProblem = (change.share ?? []).map((entry) => passwordChangeProblem(before, entry, deviceNames)).find((found) => found !== null);
  if (passwordProblem) throw new RequestError(400, passwordProblem);
  const sharing = effectiveSharing(before.devices, change);
  const problem = sharing.share.map((entry) => shareProblem(instance, devices, entry)).find((found) => found !== null);
  if (problem) throw new RequestError(400, problem);
  return { sharing, deviceNames };
}

const sharingAttempts = 2;

interface SettledSharing {
  /** The folder as read last, the one the write is built from. */
  before: SyncthingFolderSettings;
  plan: SharingPlan;
}

/**
 * Plans the sharing, then reads the folder again as the last step before the write; when its devices changed meanwhile
 * (another browser, an introducer) it plans once more from the new list, and a second change is a 409 with nothing written.
 * @implNote Syncthing takes a folder's devices only as the whole list and has no version check, so a change landing
 * between that last read and the PATCH, one request apart, is still overwritten; only the window is narrowed.
 */
async function settledSharing(instance: LocalInstance, folderId: string, first: SyncthingFolderSettings, change: FolderSharingChange): Promise<SettledSharing> {
  let before = first;
  for (let attempt = 0; attempt < sharingAttempts; attempt++) {
    const plan = await planSharing(instance, before, change);
    const latest = await callSyncthing(instance, (client) => client.folderSettings(folderId));
    if (isChangeInPlace(latest, { devices: before.devices })) return { before, plan };
    before = latest;
  }
  throw new RequestError(409, "the folder's devices changed while saving; nothing was written");
}

function hasSharing(sharing: Sharing): boolean {
  return sharing.share.length + sharing.unshare.length > 0;
}

function typeChangeProblem(before: SyncthingFolderSettings, change: FolderSettingsChange): string | null {
  const isEncrypted = before.type === "receiveencrypted";
  return isEncrypted && change.type !== undefined && change.type !== before.type ? `${folderName(before)} is receive encrypted, a type it keeps: it was given it by accepting an offer` : null;
}

export interface FolderEdit {
  settings: FolderSettings;
  note: WriteNote | NothingWritten;
}

/** The edit's change apart from the typed confirmation, which is no setting of the folder. */
function withoutConfirm(body: unknown): { change: unknown; confirm: unknown } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { change: body, confirm: undefined };
  const { confirm, ...change } = body as FolderEditBody;
  return { change, confirm };
}

/**
 * Sends exactly the fields of the change to the node's Syncthing, so a setting the person did not touch is never written
 * back over a change made elsewhere meanwhile; a new path is judged like an add's and sent as checked. On an array a
 * change that shares the folder with a device needs the folder ID typed, checked before any request.
 * @implNote Syncthing does not move the files: the folder rescans at the new path. Sharing sends the devices list as
 * read last (see `settledSharing`) with only the shared and unshared devices changed.
 */
export async function editFolder(instance: ResolvedInstance, folderId: string, body: unknown, nodes: NodeRoot[], readBackDelaysMs: readonly number[] = defaultReadBackDelaysMs): Promise<FolderEdit> {
  const local = requireLocal(instance);
  const { change, confirm } = withoutConfirm(body);
  const problem = folderChangeProblem(change) ?? (confirm !== undefined && typeof confirm !== "string" ? confirmTypeProblem : null);
  if (problem) throw new RequestError(400, problem);
  const { devices: sharingChange, ...valid } = change as FolderSettingsChange;
  const confirmProblem = sharingChange?.share?.length ? arrayConfirmProblem(local, folderId, confirm, "share it") : null;
  if (confirmProblem) throw new RequestError(400, confirmProblem);
  const moved: SettingsChange = valid.path === undefined ? valid : { ...valid, path: guardedPath(local, valid.path, nodes) };
  const folders = await configuredFolders(local);
  const listed = folders.find((folder) => folder.id === folderId);
  if (!listed) throw new RequestError(404, `${local.name} has no folder ${folderId}`);
  const folderPath = moved.path ?? listed.path;
  const settings: SettingsChange = moved.versioning === undefined ? moved : { ...moved, versioning: guardedVersioning(local, moved.versioning, folderPath, nodes) };
  const versionsProblem = settings.versioning ? versionsPathFolderProblem(settings.versioning.fsPath, folders, folderId, folderPath, rooted(local).node) : null;
  if (versionsProblem) throw new RequestError(400, versionsProblem);
  const isMoved = settings.path !== undefined && !isSamePath(listed.path, settings.path, rooted(local).node);
  const movedProblem = isMoved ? movedFolderVersionsProblem(folderPath, folders, folderId, settings.versioning !== undefined, rooted(local).node) : null;
  if (movedProblem) throw new RequestError(400, movedProblem);
  const typeProblem = typeChangeProblem(listed, settings);
  if (typeProblem) throw new RequestError(400, typeProblem);
  const samePath = settings.path === undefined ? null : otherFolderAtPath(local, folders, folderId, settings.path);
  if (samePath) throw new RequestError(409, samePath);
  const { before, plan } = sharingChange ? await settledSharing(local, folderId, listed, sharingChange) : { before: listed, plan: noSharing };
  const { sharing, deviceNames } = plan;
  const sent = { ...settings, ...(hasSharing(sharing) ? { devices: sharedDevices(before.devices, sharing) } : {}) };
  if (Object.keys(sent).length === 0) return { settings: folderSettings(before), note: { nothingWritten: true } };
  await writeConfirmed(
    local,
    (client) => client.request("PATCH", `/config/folders/${encodeURIComponent(folderId)}`, sent),
    async () => isFolderChangeInPlace(local, await local.client.folderSettings(folderId), settings, sharing),
    readBackDelaysMs,
  );
  const done: FolderSettingsChange = { ...settings, ...(hasSharing(sharing) ? { devices: sharing } : {}) };
  const note: WriteNote = { nodeId: local.nodeId, nodeName: local.name, folderId, text: folderEditText(local.name, folderName(before), done, deviceNames) };
  return { settings: await settingsAfter(local, folderId, { ...before, ...sent }), note };
}

/** A folder ID from a directory's name, as Syncthing IDs usually look: `Dashboard Test A` becomes `dashboard-test-a`. */
export function folderIdFromLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** @implNote Syncthing's own page suggests `xxxxx-xxxxx` from the same random string. */
async function randomFolderId(instance: LocalInstance): Promise<string> {
  const answer = asObject(await callSyncthing(instance, (client) => client.request<unknown>("GET", "/svc/random/string?length=10")));
  const random = typeof answer.random === "string" ? answer.random.toLowerCase() : "";
  return random.length === 10 ? `${random.slice(0, 5)}-${random.slice(5)}` : random;
}

interface Placement {
  path: string;
  name: string;
  problem: string | null;
}

/** Where a tree path lies on the node: below its root, or the root itself, with the reason, when the guard refuses the directory. */
function placedPath(under: string, node: NodeRoot, nodes: NodeRoot[]): Placement {
  const segments = under.split("/").filter(Boolean);
  if (!segments.length || segments[0] === otherFoldersGroup) return { path: node.root, name: "", problem: null };
  const path = pathUnderRoot(node.root, segments.join("/"), node.os);
  const problem = folderPathProblem(path, node, nodes);
  if (problem) return { path: node.root, name: "", problem: `${under} cannot be a folder of ${node.name}: ${problem}` };
  return { path: checkedPath(path, node), name: segments.at(-1) as string, problem: null };
}

/** A new folder as the node's Syncthing would make it, at the tree path `under`, named and identified after that directory. */
export async function newFolderDefaults(instance: ResolvedInstance, under: string, nodes: NodeRoot[]): Promise<NewFolderDefaults> {
  const { instance: local, node } = rooted(instance);
  const [defaults, folders, ignores] = await Promise.all([syncthingDefaults(local), configuredFolders(local), defaultIgnoreLines(local)]);
  const placed = placedPath(under, node, nodes);
  const derived = folderIdFromLabel(placed.name);
  const id = derived && !folders.some((folder) => folder.id === derived) ? derived : await randomFolderId(local);
  const devices = Array.isArray(defaults.devices) ? defaults.devices : [];
  const settings = folderSettings({ ...defaults, devices, id, label: placed.name, path: placed.path } as unknown as SyncthingFolderSettings);
  return { settings, ignores, root: node.root, placementProblem: placed.problem, confirmRequired: isArrayInstance(local) };
}

/** The root with its separator, which Syncthing's browse lists the inside of rather than completing it as a name. */
function directoryOf(node: NodeRoot): string {
  return /[\\/]$/.test(node.root) ? node.root : `${node.root}${node.os === "windows" ? "\\" : "/"}`;
}

/**
 * The directories Syncthing completes `current` to, kept to the node's root and out of other nodes' roots.
 * @implNote A path outside the root is browsed as the root, so the list never shows what lies beyond it.
 */
export async function browseDirectories(instance: ResolvedInstance, current: string, nodes: NodeRoot[]): Promise<string[]> {
  const { instance: local, node } = rooted(instance);
  const start = current && isInsideRoot(current, node.root, node.os) ? current : directoryOf(node);
  const answer = await callSyncthing(local, (client) => client.request<unknown>("GET", `/system/browse?current=${encodeURIComponent(start)}`));
  const directories = Array.isArray(answer) ? answer.filter((entry): entry is string => typeof entry === "string") : [];
  return directories.filter((directory) => isInsideRoot(directory, node.root, node.os) && !isInsideOtherNode(directory, node, nodes));
}

export interface NodeFolderSources {
  resolve(nodeId: string): Promise<ResolvedInstance>;
  /** Every node of this host that has a root, the guard's view of where each keeps its data. */
  nodeRoots(): Promise<NodeRoot[]>;
  /** The waits between read-backs of an edit whose answer was lost; tests shorten them. */
  readBackDelaysMs?: readonly number[];
}

async function liveNodeRoots(): Promise<NodeRoot[]> {
  return (await localNodeInfos()).flatMap((info) => (info.root ? [{ nodeId: info.nodeId, name: info.name, root: info.root, os: info.os }] : []));
}

export const nodeFolderSources: NodeFolderSources = { resolve: (nodeId) => resolveInstance(nodeId), nodeRoots: liveNodeRoots };

export function nodeFolderRoutes(sources: NodeFolderSources = nodeFolderSources): AnyRoute[] {
  const node = (segment: string) => sources.resolve(decodedSegment(segment, "node ID"));
  return [
    {
      method: "GET",
      pattern: /^\/api\/nodes\/([^/]+)\/folder-defaults$/,
      handle: async ({ response, url, params: [nodeId] }) => sendJson(response, 200, await newFolderDefaults(await node(nodeId), url.searchParams.get("under") ?? "", await sources.nodeRoots())),
    },
    {
      method: "GET",
      pattern: /^\/api\/nodes\/([^/]+)\/browse$/,
      handle: async ({ response, url, params: [nodeId] }) => sendJson(response, 200, await browseDirectories(await node(nodeId), url.searchParams.get("current") ?? "", await sources.nodeRoots())),
    },
    {
      method: "GET",
      pattern: /^\/api\/nodes\/([^/]+)\/folder-path-check$/,
      handle: async ({ response, url, params: [nodeId] }) =>
        sendJson(response, 200, await checkFolderPath(await node(nodeId), url.searchParams.get("path") ?? "", await sources.nodeRoots(), url.searchParams.get("folder"), url.searchParams.get("versioning") === "changed")),
    },
    {
      method: "POST",
      pattern: /^\/api\/nodes\/([^/]+)\/folders$/,
      write: async ({ request, response, params: [nodeId] }) => {
        const instance = await node(nodeId);
        const addition = await addFolder(instance, await readBody(request), await sources.nodeRoots());
        sendJson(response, 201, addition.added);
        return addition.note;
      },
    },
    {
      method: "PATCH",
      pattern: /^\/api\/nodes\/([^/]+)\/folders\/([^/]+)$/,
      write: async ({ request, response, params: [nodeId, folderId] }) => {
        const instance = await node(nodeId);
        const edit = await editFolder(instance, decodedSegment(folderId, "folder ID"), await readBody(request), await sources.nodeRoots(), sources.readBackDelaysMs);
        sendJson(response, 200, edit.settings);
        return edit.note;
      },
    },
  ];
}
