import { type FolderPathCheck, type FolderSettings, type FolderSettingsChange, type FolderType, type NewFolder, type NewFolderDefaults, folderSettingLabels, folderTypeTexts, pullOrderTexts } from "../api/types.js";
import { folderSettings } from "../folderIndex.js";
import { RequestError, readBody, sendJson } from "../http.js";
import { type LocalInstance, type ResolvedInstance, callSyncthing, localNodeInfos, requireLocal, resolveInstance, writeConfirmed } from "../instanceResolver.js";
import { type NodeRoot, folderPathProblem, isInsideOtherNode, isInsideRoot, isStrictlyBelow, pathUnderRoot } from "../pathGuard.js";
import type { AnyRoute, WriteNote } from "../routes.js";
import type { SyncthingFolderSettings } from "../syncthing.js";
import { folderChangeProblem, isChangeInPlace } from "../syncthingConfig.js";
import { otherFoldersGroup, relativeToRoot } from "../treePaths.js";
import { decodedSegment } from "./devices.js";

type SyncthingObject = Record<string, unknown>;

const folderTypes = Object.keys(folderTypeTexts) as FolderType[];

const newFolderKeys: readonly (keyof NewFolder)[] = ["id", "label", "path", "type", "paused"];

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
  return null;
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
 * Syncthing call, then the node's other folders.
 */
export async function checkFolderPath(instance: ResolvedInstance, typed: string, nodes: NodeRoot[], editedFolderId: string | null = null): Promise<FolderPathCheck> {
  const { instance: local, node } = rooted(instance);
  const problem = folderPathProblem(typed.trim(), node, nodes);
  if (problem) return { path: typed.trim(), problem, warning: null };
  const path = checkedPath(typed.trim(), node);
  const folders = (await configuredFolders(local)).filter((folder) => folder.id !== editedFolderId);
  return { path, problem: samePathProblem(local, folders, path, node), warning: overlapWarning(folders, path, node) };
}

function withOwnDevice(devices: unknown, ownId: string): unknown[] {
  const list = Array.isArray(devices) ? devices : [];
  return list.some((device) => asObject(device).deviceID === ownId) ? list : [...list, { deviceID: ownId, introducedBy: "", encryptionPassword: "" }];
}

function folderName(folder: Pick<SyncthingFolderSettings, "id" | "label">): string {
  return folder.label || folder.id;
}

/** What an add did, in words: `pc: added folder Projects (projects) at F:\Projects; send only`. */
export function folderAddText(nodeName: string, folder: NewFolder): string {
  const named = folder.label && folder.label !== folder.id ? `${folder.label} (${folder.id})` : folder.id;
  const details = [...(folder.type ? [folderTypeTexts[folder.type]] : []), ...(folder.paused ? ["paused"] : [])];
  return [`${nodeName}: added folder ${named} at ${folder.path}`, ...details].join("; ");
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

/**
 * Adds a folder to the node's Syncthing, every setting the person left out taken from Syncthing's own defaults.
 * @implNote The path is judged against the node's root and the other nodes' roots before any Syncthing call,
 * as adding a folder makes Syncthing create and scan its directory; the path sent is the one judged.
 */
export async function addFolder(instance: ResolvedInstance, body: unknown, nodes: NodeRoot[]): Promise<FolderAddition> {
  const problem = newFolderProblem(body);
  if (problem) throw new RequestError(400, problem);
  const { instance: local, node } = rooted(instance);
  const request = body as NewFolder;
  const pathProblem = folderPathProblem(request.path.trim(), node, nodes);
  if (pathProblem) throw new RequestError(400, pathProblem);
  const folder: NewFolder = { ...request, id: request.id.trim(), path: checkedPath(request.path.trim(), node) };
  const [folders, defaults, ownId] = await Promise.all([configuredFolders(local), syncthingDefaults(local), callSyncthing(local, (client) => client.myId())]);
  if (folders.some((existing) => existing.id === folder.id)) throw new RequestError(409, `${local.name} already has folder ${folder.id}`);
  const samePath = samePathProblem(local, folders, folder.path, node);
  if (samePath) throw new RequestError(409, samePath);
  const config: SyncthingObject = { ...defaults, label: "", ...folder, devices: withOwnDevice(defaults.devices, ownId) };
  await callSyncthing(local, (client) => client.request("POST", "/config/folders", config));
  const note: WriteNote = { nodeId: local.nodeId, nodeName: local.name, folderId: folder.id, text: folderAddText(local.name, folder) };
  return { added: await settingsAfter(local, folder.id, config), note };
}

function onOff(value: boolean): string {
  return value ? "on" : "off";
}

type ChangedSetting = keyof FolderSettingsChange;

function settingValueWords(key: ChangedSetting, change: Required<FolderSettingsChange>): string {
  const value = change[key];
  if (typeof value === "boolean") return onOff(value);
  if (key === "type") return folderTypeTexts[change.type];
  if (key === "order") return pullOrderTexts[change.order];
  if (key === "minDiskFree") return `${change.minDiskFree.value} ${change.minDiskFree.unit}`;
  if (key === "rescanIntervalS") return change.rescanIntervalS ? `${change.rescanIntervalS} s` : "off";
  if (key === "fsWatcherDelayS") return `${change.fsWatcherDelayS} s`;
  if (key === "maxConflicts") return change.maxConflicts < 0 ? "unlimited" : String(change.maxConflicts);
  return String(value) || "none";
}

function settingWords(key: ChangedSetting, change: FolderSettingsChange): string {
  const label = folderSettingLabels[key];
  return `${label.charAt(0).toLowerCase()}${label.slice(1)} ${settingValueWords(key, change as Required<FolderSettingsChange>)}`;
}

/** What a folder edit changed, in words: `pc: changed folder Documents; full rescan interval 60 s; pull order alphabetic`. */
export function folderEditText(nodeName: string, folderName: string, change: FolderSettingsChange): string {
  const details = (Object.keys(folderSettingLabels) as ChangedSetting[]).filter((key) => key in change).map((key) => settingWords(key, change));
  return [`${nodeName}: changed folder ${folderName}`, ...details].join("; ");
}

/** The new path as the guard reads it; judged before any Syncthing call, as Syncthing rescans the folder at whatever path it is given. */
function guardedPath(instance: LocalInstance, path: string, nodes: NodeRoot[]): string {
  const { node } = rooted(instance);
  const problem = folderPathProblem(path.trim(), node, nodes);
  if (problem) throw new RequestError(400, problem);
  return checkedPath(path.trim(), node);
}

function otherFolderAtPath(instance: LocalInstance, folders: SyncthingFolderSettings[], folderId: string, path: string): string | null {
  const { node } = rooted(instance);
  return samePathProblem(instance, folders.filter((folder) => folder.id !== folderId), path, node);
}

export interface FolderEdit {
  settings: FolderSettings;
  note: WriteNote;
}

/**
 * Sends exactly the fields of `change` to the node's Syncthing, so a setting the person did not touch is never written
 * back over a change made elsewhere meanwhile; a new path is judged like an add's and sent as checked.
 * @implNote Syncthing does not move the files: the folder rescans at the new path.
 */
export async function editFolder(instance: ResolvedInstance, folderId: string, change: unknown, nodes: NodeRoot[]): Promise<FolderEdit> {
  const local = requireLocal(instance);
  const problem = folderChangeProblem(change);
  if (problem) throw new RequestError(400, problem);
  const valid = change as FolderSettingsChange;
  const sent: FolderSettingsChange = valid.path === undefined ? valid : { ...valid, path: guardedPath(local, valid.path, nodes) };
  const folders = await configuredFolders(local);
  const before = folders.find((folder) => folder.id === folderId);
  if (!before) throw new RequestError(404, `${local.name} has no folder ${folderId}`);
  const samePath = sent.path === undefined ? null : otherFolderAtPath(local, folders, folderId, sent.path);
  if (samePath) throw new RequestError(409, samePath);
  await writeConfirmed(
    local,
    (client) => client.request("PATCH", `/config/folders/${encodeURIComponent(folderId)}`, sent),
    async () => isChangeInPlace(await local.client.folderSettings(folderId), sent),
  );
  const note: WriteNote = { nodeId: local.nodeId, nodeName: local.name, folderId, text: folderEditText(local.name, folderName(before), sent) };
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
  const [defaults, folders] = await Promise.all([syncthingDefaults(local), configuredFolders(local)]);
  const placed = placedPath(under, node, nodes);
  const derived = folderIdFromLabel(placed.name);
  const id = derived && !folders.some((folder) => folder.id === derived) ? derived : await randomFolderId(local);
  const devices = Array.isArray(defaults.devices) ? defaults.devices : [];
  return { settings: folderSettings({ ...defaults, devices, id, label: placed.name, path: placed.path } as unknown as SyncthingFolderSettings), root: node.root, placementProblem: placed.problem };
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
}

async function liveNodeRoots(): Promise<NodeRoot[]> {
  return (await localNodeInfos()).flatMap((info) => (info.root ? [{ nodeId: info.nodeId, name: info.name, root: info.root, os: info.os }] : []));
}

const liveSources: NodeFolderSources = { resolve: (nodeId) => resolveInstance(nodeId), nodeRoots: liveNodeRoots };

export function nodeFolderRoutes(sources: NodeFolderSources = liveSources): AnyRoute[] {
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
        sendJson(response, 200, await checkFolderPath(await node(nodeId), url.searchParams.get("path") ?? "", await sources.nodeRoots(), url.searchParams.get("folder"))),
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
        const edit = await editFolder(instance, decodedSegment(folderId, "folder ID"), await readBody(request), await sources.nodeRoots());
        sendJson(response, 200, edit.settings);
        return edit.note;
      },
    },
  ];
}
