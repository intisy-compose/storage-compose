import type { NodeEntryState, TreeEntry, TreeListing } from "../api/types.js";
import { entryStatus, type StatusInput } from "../explorerStatus.js";
import { type FolderLists, browseFor, listsWithStatus } from "../folderLists.js";
import { RequestError, sendJson } from "../http.js";
import { type ResolverSources, defaultResolverSources, findLocalNode, requireLocal, resolveInstance } from "../instanceResolver.js";
import { overridesBelow, priorityAt } from "../priorityTree.js";
import type { Route } from "../routes.js";
import { explorerSettings, hostName } from "../settings.js";
import { type SetupLayout, readLayout } from "../setupRepo.js";
import { type BrowseEntry, type FolderStatus, type SyncthingClient, type SyncthingFolderConfig, SyncthingUnavailable } from "../syncthing.js";
import { type FolderPlacement, type FolderToPlace, type NodeOs, directoriesAbove, folderAt, placeFolders } from "../treePaths.js";

export const entriesPerPage = 200;
const fileReadsAtOnce = 8;

/** One node of this host as the explorer reads it; `client` is null while its Syncthing cannot be addressed. */
export interface TreeNode {
  nodeId: string;
  name: string;
  host: string;
  root: string | null;
  os: NodeOs;
  threshold: number;
  client: SyncthingClient | null;
}

/** Where a listing reads from; tests hand in a fake node. */
export interface TreeSources {
  node: (nodeId: string) => Promise<TreeNode>;
  layout: () => Promise<SetupLayout | null>;
  needLimit: number;
}

/** A Syncthing folder placed in the tree: one the node holds (`config` set) or one only offered to it. */
interface PlacedFolder {
  placement: FolderPlacement;
  config: SyncthingFolderConfig | null;
}

interface NodeTree {
  node: TreeNode;
  answering: boolean;
  ownId: string;
  folders: PlacedFolder[];
  deviceNames: Map<string, string>;
  statuses: Map<string, Promise<FolderStatus | null>>;
  lists: Map<string, Promise<FolderLists | null>>;
  needLimit: number;
}

type Row = { name: string; path: string; kind: TreeEntry["kind"]; size: number | null; modified: string | null } & (
  | { source: "index"; folder: PlacedFolder; inside: string }
  | { source: "tree" }
);

function segmentsOf(relativePath: string): string[] {
  return relativePath.split("/").filter(Boolean);
}

/** The requested path with `/` separators and no outer slashes; "" is the top directory. */
function treePath(raw: string): string {
  const segments = raw.split(/[\\/]+/).filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) throw new RequestError(400, `${raw} climbs out of the tree`);
  return segments.join("/");
}

function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function samePath(left: string, right: string): boolean {
  return segmentsOf(left).join("/").toLowerCase() === segmentsOf(right).join("/").toLowerCase();
}

function isAtOrBelow(path: string, ancestor: string): boolean {
  const pathSegments = segmentsOf(path.toLowerCase());
  const ancestorSegments = segmentsOf(ancestor.toLowerCase());
  return ancestorSegments.length <= pathSegments.length && ancestorSegments.every((segment, index) => segment === pathSegments[index]);
}

function offeredOnly(configs: SyncthingFolderConfig[], pending: Record<string, { offeredBy: Record<string, { label: string }> }>): FolderToPlace[] {
  return Object.entries(pending)
    .filter(([folderId]) => !configs.some((config) => config.id === folderId))
    .map(([folderId, entry]) => ({ id: folderId, label: Object.values(entry.offeredBy)[0]?.label || folderId, path: "" }));
}

async function readNodeTree(node: TreeNode, layout: SetupLayout | null, needLimit: number): Promise<NodeTree> {
  const tree: NodeTree = { node, answering: false, ownId: "", folders: [], deviceNames: new Map(), statuses: new Map(), lists: new Map(), needLimit };
  if (!node.client) return tree;
  try {
    const client = node.client;
    const [ownId, configs, devices, pending] = await Promise.all([client.myId(), client.folders(), client.devices(), client.pendingFolders().catch(() => ({}))]);
    const offered = offeredOnly(configs, pending);
    const placements = placeFolders([...configs, ...offered], node.root, node.os, layout);
    return {
      ...tree,
      answering: true,
      ownId,
      folders: placements.map((placement, index) => ({ placement, config: configs[index] ?? null })),
      deviceNames: new Map(devices.map((device) => [device.deviceID, device.name || device.deviceID.slice(0, 7)])),
    };
  } catch (error) {
    if (error instanceof SyncthingUnavailable) return tree;
    throw error;
  }
}

function instanceKeyOf(tree: NodeTree): string {
  return `${tree.node.nodeId}@${tree.node.client?.endpoint.url ?? ""}`;
}

async function browse(tree: NodeTree, folder: PlacedFolder, prefix: string): Promise<BrowseEntry[]> {
  const status = await folderStatus(tree, folder);
  return browseFor(instanceKeyOf(tree), tree.node.client!, folder.config!.id, prefix, status?.sequence ?? -1);
}

/** Starts reading the root of every held folder whose row is shown, so opening one does not wait for Syncthing's walk. */
function warmFolderRoots(tree: NodeTree, rows: Row[]): void {
  for (const row of rows) {
    const root = row.source === "tree" ? rootFolderAt(tree, row.path) : null;
    if (root?.config && !root.config.paused) void browse(tree, root, "").catch(() => undefined);
  }
}

function folderStatus(tree: NodeTree, folder: PlacedFolder): Promise<FolderStatus | null> {
  const config = folder.config;
  if (!config || config.paused || !tree.node.client) return Promise.resolve(null);
  const client = tree.node.client;
  let status = tree.statuses.get(config.id);
  if (!status) {
    status = client.folderStatus(config.id).catch(() => null);
    tree.statuses.set(config.id, status);
  }
  return status;
}

function folderLists(tree: NodeTree, folder: PlacedFolder): Promise<FolderLists | null> {
  const config = folder.config;
  const client = tree.node.client;
  if (!config || !client) return Promise.resolve(null);
  let lists = tree.lists.get(config.id);
  if (!lists) {
    lists = folderStatus(tree, folder).then((status) => (status ? listsWithStatus(instanceKeyOf(tree), client, config.id, status, tree.needLimit) : null));
    tree.lists.set(config.id, lists);
  }
  return lists;
}

function heldFolders(tree: NodeTree): PlacedFolder[] {
  return tree.folders.filter((folder) => folder.config !== null);
}

function rootFolderAt(tree: NodeTree, path: string): PlacedFolder | null {
  const atPath = tree.folders.filter((folder) => samePath(folder.placement.relativePath, path));
  return atPath.find((folder) => folder.config !== null) ?? atPath[0] ?? null;
}

function byDirectoryThenName(left: Row, right: Row): number {
  if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
  return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
}

function indexRow(folder: PlacedFolder, inside: string, parent: string, entry: BrowseEntry): Row {
  return {
    source: "index",
    folder,
    inside: joinPath(inside, entry.name),
    name: entry.name,
    path: joinPath(parent, entry.name),
    kind: entry.type === "FILE_INFO_TYPE_DIRECTORY" ? "directory" : "file",
    size: entry.type === "FILE_INFO_TYPE_DIRECTORY" ? null : entry.size,
    modified: entry.modTime || null,
  };
}

function treeRow(parent: string, name: string): Row {
  return { source: "tree", name, path: joinPath(parent, name), kind: "directory", size: null, modified: null };
}

interface DirectoryRows {
  rows: Row[];
  notes: string[];
}

async function indexRows(tree: NodeTree, path: string): Promise<DirectoryRows & { inIndex: boolean }> {
  const location = folderAt(
    tree.folders.map((folder) => folder.placement),
    path,
  );
  const folder = location && tree.folders.find((candidate) => candidate.placement === location.placement);
  if (!location || !folder) return { rows: [], notes: [], inIndex: false };
  const label = folder.placement.label;
  if (!folder.config) return { rows: [], notes: [`${label} is offered to ${tree.node.name} and not accepted, so its contents are not on this node yet`], inIndex: false };
  if (folder.config.paused) return { rows: [], notes: [`${label} is paused on ${tree.node.name}`], inIndex: false };
  const entries = await browse(tree, folder, location.inside);
  return { rows: entries.map((entry) => indexRow(folder, location.inside, path, entry)), notes: [], inIndex: true };
}

/** Index entries of the folder holding the path, with the folder roots and layout paths that lead further down. */
async function directoryRows(tree: NodeTree, layout: SetupLayout | null, path: string): Promise<DirectoryRows> {
  if (!tree.answering) return { rows: directoriesAbove([], layout, path).map((name) => treeRow(path, name)), notes: [`${tree.node.name}'s Syncthing is not answering`] };
  const fromIndex = await indexRows(tree, path);
  const leadingNames = directoriesAbove(
    tree.folders.map((folder) => folder.placement),
    fromIndex.inIndex ? null : layout,
    path,
  );
  const rows = [...fromIndex.rows];
  for (const name of leadingNames) {
    const existing = rows.findIndex((row) => row.name.toLowerCase() === name.toLowerCase());
    const isFolderRoot = rootFolderAt(tree, joinPath(path, name)) !== null;
    if (existing < 0) rows.push(treeRow(path, name));
    else if (isFolderRoot) rows[existing] = { ...treeRow(path, rows[existing].name), modified: rows[existing].modified };
  }
  return { rows, notes: fromIndex.notes };
}

interface Counts {
  outstanding: number | "too-many";
  failed: number | "too-many";
}

function add(left: number | "too-many", right: number | "too-many"): number | "too-many" {
  return left === "too-many" || right === "too-many" ? "too-many" : left + right;
}

/** What the folders whose roots lie at or below the path (all but `except`) add to its counts. */
async function rootCounts(tree: NodeTree, path: string, except: PlacedFolder | null, strictlyBelow: boolean): Promise<Counts & { roots: PlacedFolder[]; statuses: (FolderStatus | null)[] }> {
  const roots = heldFolders(tree).filter(
    (folder) => folder !== except && isAtOrBelow(folder.placement.relativePath, path) && !(strictlyBelow && samePath(folder.placement.relativePath, path)),
  );
  const statuses = await Promise.all(roots.map((folder) => folderStatus(tree, folder)));
  let outstanding: number | "too-many" = 0;
  let failed: number | "too-many" = 0;
  for (const status of statuses) {
    outstanding = add(outstanding, status?.needTotalItems ?? status?.needFiles ?? 0);
    failed = add(failed, status?.errors ?? status?.pullErrors ?? 0);
  }
  return { outstanding, failed, roots, statuses };
}

function sharesWithOthers(tree: NodeTree, config: SyncthingFolderConfig): boolean {
  return config.devices.some((device) => device.deviceID !== tree.ownId);
}

function baseInput(tree: NodeTree, layout: SetupLayout | null, path: string): Pick<StatusInput, "answering" | "effectivePriority" | "threshold"> {
  return { answering: tree.answering, effectivePriority: priorityAt(layout, path).effective, threshold: tree.node.threshold };
}

/** A row outside any index: a folder root or a directory above folder roots, judged by the folders at or below it. */
async function treeRowInput(tree: NodeTree, layout: SetupLayout | null, row: Row): Promise<StatusInput> {
  const base = baseInput(tree, layout, row.path);
  const counts = await rootCounts(tree, row.path, null, false);
  const offered = tree.folders.some((folder) => !folder.config && isAtOrBelow(folder.placement.relativePath, row.path));
  if (!counts.roots.length) {
    return { ...base, hasFolder: false, offered, folderPaused: false, folderState: "", local: null, outstandingBelow: 0, failedBelow: 0, locallyChanged: false, sharedWithOthers: false };
  }
  const configs = counts.roots.map((folder) => folder.config!);
  const states = counts.statuses.map((status) => status?.state ?? "");
  const ownRoot = counts.roots.findIndex((folder) => samePath(folder.placement.relativePath, row.path));
  return {
    ...base,
    hasFolder: true,
    offered,
    folderPaused: ownRoot >= 0 ? configs[ownRoot].paused : configs.every((config) => config.paused),
    folderState: ownRoot >= 0 ? states[ownRoot] : (states.find((state) => state === "syncing") ?? states[0] ?? ""),
    local: { deleted: false, ignored: false },
    outstandingBelow: counts.outstanding,
    failedBelow: counts.failed,
    locallyChanged: counts.statuses.some((status) => (status?.receiveOnlyTotalItems ?? 0) > 0),
    sharedWithOthers: configs.some((config) => sharesWithOthers(tree, config)),
  };
}

function countUnder(list: FolderLists["need"] | undefined, inside: string): number | "too-many" {
  if (list === undefined) return 0;
  return list === "too-many" ? "too-many" : list.countUnder(inside);
}

async function indexRowInput(tree: NodeTree, layout: SetupLayout | null, row: Extract<Row, { source: "index" }>, local: StatusInput["local"]): Promise<StatusInput> {
  const config = row.folder.config!;
  const [status, lists, nested] = await Promise.all([folderStatus(tree, row.folder), folderLists(tree, row.folder), rootCounts(tree, row.path, row.folder, true)]);
  return {
    ...baseInput(tree, layout, row.path),
    hasFolder: true,
    offered: false,
    folderPaused: config.paused,
    folderState: status?.state ?? "",
    local,
    outstandingBelow: add(countUnder(lists?.need, row.inside), nested.outstanding),
    failedBelow: add(countUnder(lists?.errors, row.inside), nested.failed),
    locallyChanged: (lists?.localChanged.countUnder(row.inside) ?? 0) > 0,
    sharedWithOthers: sharesWithOthers(tree, config),
  };
}

function nodeState(tree: NodeTree, input: StatusInput): NodeEntryState {
  return { nodeId: tree.node.nodeId, nodeName: tree.node.name, host: tree.node.host, ...entryStatus(input) };
}

async function entryOf(tree: NodeTree, layout: SetupLayout | null, row: Row): Promise<TreeEntry> {
  const root = rootFolderAt(tree, row.path);
  const entry: TreeEntry = {
    name: row.name,
    path: row.path,
    kind: row.kind,
    size: row.size,
    modified: row.modified,
    folder: root && { id: root.placement.folderId, label: root.placement.label },
    priority: priorityAt(layout, row.path),
    nodes: [],
    availability: [],
  };
  if (row.source === "tree") return { ...entry, nodes: [nodeState(tree, await treeRowInput(tree, layout, row))] };
  const file = await tree.node.client!.file(row.folder.config!.id, row.inside);
  const local = file?.local ? { deleted: file.local.deleted, ignored: file.local.ignored } : null;
  return {
    ...entry,
    nodes: [nodeState(tree, await indexRowInput(tree, layout, row, local))],
    availability: (file?.availability ?? []).map((device) => ({ deviceId: device.id, name: tree.deviceNames.get(device.id) ?? device.id.slice(0, 7) })),
  };
}

async function mapAtMost<Item, Result>(items: Item[], atOnce: number, map: (item: Item) => Promise<Result>): Promise<Result[]> {
  const results: Result[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await map(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(atOnce, items.length) }, worker));
  return results;
}

async function tooManyNotes(tree: NodeTree, rows: Row[]): Promise<string[]> {
  const folders = [...new Set(rows.flatMap((row) => (row.source === "index" ? [row.folder] : [])))];
  const notes = await Promise.all(
    folders.map(async (folder) => {
      const [status, lists] = await Promise.all([folderStatus(tree, folder), folderLists(tree, folder)]);
      return lists?.need === "too-many" ? [`${folder.placement.label}: ${status?.needTotalItems ?? status?.needFiles ?? 0} items outstanding in this folder, too many to place`] : [];
    }),
  );
  return notes.flat();
}

/** One page of a directory as one node of this host sees it. */
export async function treeListing(nodeId: string, rawPath: string, page: number, sources: TreeSources): Promise<TreeListing> {
  const path = treePath(rawPath);
  const [node, layout] = await Promise.all([sources.node(nodeId), sources.layout()]);
  const tree = await readNodeTree(node, layout, sources.needLimit);
  const { rows, notes } = await directoryRows(tree, layout, path);
  const sorted = rows.sort(byDirectoryThenName);
  const shown = sorted.slice((page - 1) * entriesPerPage, page * entriesPerPage);
  const entries = await mapAtMost(shown, fileReadsAtOnce, (row) => entryOf(tree, layout, row));
  warmFolderRoots(tree, shown);
  return {
    path,
    view: node.nodeId,
    priority: priorityAt(layout, path),
    overridesBelow: overridesBelow(layout, path),
    entries,
    nextPage: page * entriesPerPage < sorted.length ? page + 1 : null,
    notes: [...notes, ...(await tooManyNotes(tree, shown))],
  };
}

/** A node of this host whether or not its Syncthing answers; another host's node is refused until the all-nodes view reads it. */
export async function liveTreeNode(nodeId: string, resolver: ResolverSources = defaultResolverSources): Promise<TreeNode> {
  const local = await findLocalNode(nodeId, resolver);
  if (local) return { nodeId, name: local.name, host: hostName, root: local.root, os: local.os, threshold: local.threshold, client: local.instance?.client ?? null };
  const instance = requireLocal(await resolveInstance(nodeId, resolver));
  return { nodeId, name: instance.name, host: hostName, root: instance.root, os: instance.os, threshold: instance.threshold, client: instance.client };
}

const liveSources: TreeSources = { node: (nodeId) => liveTreeNode(nodeId), layout: readLayout, needLimit: explorerSettings.needLimit };

function pageOf(url: URL): number {
  const raw = url.searchParams.get("page");
  if (raw === null || raw === "") return 1;
  const page = Number(raw);
  if (!Number.isInteger(page) || page < 1) throw new RequestError(400, `page must be 1 or more, not ${raw}`);
  return page;
}

export const treeRoutes: Route[] = [
  {
    method: "GET",
    pattern: /^\/api\/tree$/,
    handle: async ({ response, url }) => {
      const nodeId = url.searchParams.get("node");
      if (!nodeId) throw new RequestError(400, "name a node with ?node=");
      sendJson(response, 200, await treeListing(nodeId, url.searchParams.get("path") ?? "", pageOf(url), liveSources));
    },
  },
];
