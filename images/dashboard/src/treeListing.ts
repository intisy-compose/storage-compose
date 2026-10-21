import type { NodeEntryState, TreeEntry, TreeListing } from "./api/types.js";
import { entryStatus, type StatusInput } from "./explorerStatus.js";
import { type FolderLists, PathSet, browseFor, errorTotalOf, listsWithStatus, needTotalOf, treeFingerprint } from "./folderLists.js";
import { RequestError } from "./http.js";
import { overridesBelow, priorityAt } from "./priorityTree.js";
import type { SetupLayout } from "./setupRepo.js";
import { type BrowseEntry, type FolderStatus, type SyncthingClient, type SyncthingFolderConfig, SyncthingUnavailable } from "./syncthing.js";
import { type FolderPlacement, type FolderToPlace, type NodeOs, directoriesAbove, folderAt, placeFolders } from "./treePaths.js";

export const entriesPerPage = 200;
export const fileReadsAtOnce = 8;

/** One node of this host as the explorer reads it; `client` is null while its Syncthing cannot be addressed. */
export interface TreeNode {
  nodeId: string;
  name: string;
  host: string;
  root: string | null;
  os: NodeOs;
  threshold: number;
  /** False while the node's drive or array is not attached to this host. */
  present: boolean;
  client: SyncthingClient | null;
}

/** Where a listing reads from; tests hand in a fake node. */
export interface TreeSources {
  node: (nodeId: string) => Promise<TreeNode>;
  layout: () => Promise<SetupLayout | null>;
  needLimit: number;
  /** How long a listing waits for a folder's first lists before it shows the folder's counts instead. */
  firstListsWaitMs: number;
}

/** What a node's tree is read with; the node itself is handed in separately. */
export type ListingSources = Omit<TreeSources, "node">;

/** A folder's lists, or only its counts while the first read of them has not finished (`stillReading`). */
type ListsView = FolderLists & { stillReading: boolean };

/** A Syncthing folder placed in the tree: one the node holds (`config` set) or one only offered to it. */
interface PlacedFolder {
  placement: FolderPlacement;
  config: SyncthingFolderConfig | null;
}

export interface NodeTree {
  node: TreeNode;
  answering: boolean;
  ownId: string;
  folders: PlacedFolder[];
  deviceNames: Map<string, string>;
  statuses: Map<string, Promise<FolderStatus | null>>;
  lists: Map<string, Promise<ListsView | null>>;
  sources: ListingSources;
}

export type RowBase = { name: string; path: string; kind: TreeEntry["kind"]; size: number | null; modified: string | null };

/** A row as one node sees it: in its index, outside any index, or inside a folder it is only offered or has paused. */
export type Row = RowBase &
  (
    | { source: "index"; folder: PlacedFolder; inside: string }
    | { source: "tree" }
    | { source: "offered" }
    | { source: "paused"; folder: PlacedFolder }
  );

type Count = number | "too-many";

function segmentsOf(relativePath: string): string[] {
  return relativePath.split("/").filter(Boolean);
}

/** The requested path with `/` separators and no outer slashes; "" is the top directory. */
export function treePath(raw: string): string {
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

export async function readNodeTree(node: TreeNode, layout: SetupLayout | null, sources: ListingSources): Promise<NodeTree> {
  const tree: NodeTree = { node, answering: false, ownId: "", folders: [], deviceNames: new Map(), statuses: new Map(), lists: new Map(), sources };
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

async function browse(tree: NodeTree, folder: PlacedFolder, prefix: string): Promise<BrowseEntry[]> {
  const status = await folderStatus(tree, folder);
  return browseFor(instanceKeyOf(tree), tree.node.client!, folder.config!.id, prefix, status ? treeFingerprint(status) : "");
}

/** Starts reading the root of every held folder whose row is shown, so opening one does not wait for Syncthing's walk. */
export function warmFolderRoots(tree: NodeTree, rows: Row[]): void {
  for (const row of rows) {
    const root = row.source === "tree" ? rootFolderAt(tree, row.path) : null;
    if (root?.config && !root.config.paused) void browse(tree, root, "").catch(() => undefined);
  }
}

function countsOnly(status: FolderStatus): ListsView {
  const placed = (count: number) => (count > 0 ? ("too-many" as const) : new PathSet([]));
  return { sequence: status.sequence ?? 0, need: placed(needTotalOf(status)), errors: placed(errorTotalOf(status)), localChanged: placed(status.receiveOnlyTotalItems ?? 0), stillReading: true };
}

async function withinWait(waitMs: number, status: FolderStatus, lists: Promise<FolderLists>): Promise<ListsView> {
  let timer: NodeJS.Timeout | undefined;
  const waited = new Promise<ListsView>((resolve) => {
    timer = setTimeout(() => resolve(countsOnly(status)), waitMs);
    timer.unref();
  });
  try {
    return await Promise.race([lists.then((read) => ({ ...read, stillReading: false })), waited]);
  } catch {
    return countsOnly(status);
  } finally {
    clearTimeout(timer);
  }
}

function folderLists(tree: NodeTree, folder: PlacedFolder): Promise<ListsView | null> {
  const config = folder.config;
  const client = tree.node.client;
  if (!config || !client) return Promise.resolve(null);
  let lists = tree.lists.get(config.id);
  if (!lists) {
    lists = folderStatus(tree, folder).then((status) =>
      status ? withinWait(tree.sources.firstListsWaitMs, status, listsWithStatus(instanceKeyOf(tree), client, config.id, status, tree.sources.needLimit)) : null,
    );
    tree.lists.set(config.id, lists);
  }
  return lists;
}

function heldFolders(tree: NodeTree): PlacedFolder[] {
  return tree.folders.filter((folder) => folder.config !== null);
}

export function rootFolderAt(tree: NodeTree, path: string): PlacedFolder | null {
  const atPath = tree.folders.filter((folder) => samePath(folder.placement.relativePath, path));
  return atPath.find((folder) => folder.config !== null) ?? atPath[0] ?? null;
}

export function byDirectoryThenName(left: RowBase, right: RowBase): number {
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
export async function directoryRows(tree: NodeTree, layout: SetupLayout | null, path: string): Promise<DirectoryRows> {
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

function add(left: Count, right: Count): Count {
  return left === "too-many" || right === "too-many" ? "too-many" : left + right;
}

function hasAny(count: Count): boolean {
  return count === "too-many" || count > 0;
}

/** What the folders whose roots lie at or below the path (all but `except`) add to its counts. */
async function rootCounts(tree: NodeTree, path: string, except: PlacedFolder | null, strictlyBelow: boolean) {
  const roots = heldFolders(tree).filter(
    (folder) => folder !== except && isAtOrBelow(folder.placement.relativePath, path) && !(strictlyBelow && samePath(folder.placement.relativePath, path)),
  );
  const statuses = await Promise.all(roots.map((folder) => folderStatus(tree, folder)));
  let outstanding: Count = 0;
  let failed: Count = 0;
  for (const status of statuses) {
    outstanding = add(outstanding, status ? needTotalOf(status) : 0);
    failed = add(failed, status ? errorTotalOf(status) : 0);
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

function countUnder(list: PathSet | "too-many" | undefined, inside: string): Count {
  if (list === undefined) return 0;
  return list === "too-many" ? "too-many" : list.countUnder(inside);
}

/** The row as this node sees its path, or null where the node neither holds nor is offered a folder at, above or below it. */
export function rowOn(tree: NodeTree, row: RowBase): Row | null {
  const base: RowBase = { name: row.name, path: row.path, kind: row.kind, size: row.size, modified: row.modified };
  if (!tree.answering || rootFolderAt(tree, row.path)) return { ...base, source: "tree" };
  const location = folderAt(
    tree.folders.map((folder) => folder.placement),
    row.path,
  );
  const folder = location && tree.folders.find((candidate) => candidate.placement === location.placement);
  if (location && folder) {
    if (!folder.config) return { ...base, source: "offered" };
    if (folder.config.paused) return { ...base, source: "paused", folder };
    return { ...base, source: "index", folder, inside: location.inside };
  }
  return tree.folders.some((candidate) => isAtOrBelow(candidate.placement.relativePath, row.path)) ? { ...base, source: "tree" } : null;
}

function outsideFolderInput(tree: NodeTree, layout: SetupLayout | null, path: string, folder: PlacedFolder | null): StatusInput {
  return {
    ...baseInput(tree, layout, path),
    hasFolder: folder !== null,
    offered: folder === null,
    folderPaused: folder !== null,
    folderState: "",
    local: folder && { deleted: false, ignored: false },
    outstandingBelow: 0,
    failedBelow: 0,
    locallyChanged: false,
    sharedWithOthers: folder?.config ? sharesWithOthers(tree, folder.config) : false,
  };
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
    locallyChanged: hasAny(countUnder(lists?.localChanged, row.inside)),
    sharedWithOthers: sharesWithOthers(tree, config),
  };
}

function nodeState(tree: NodeTree, state: Pick<NodeEntryState, "status" | "detail">): NodeEntryState {
  return { nodeId: tree.node.nodeId, nodeName: tree.node.name, host: tree.node.host, ...state };
}

/** One node's state of a row and the devices its index says hold the entry. */
export interface NodeRowState {
  state: NodeEntryState;
  availability: TreeEntry["availability"];
}

export async function nodeRowState(tree: NodeTree, layout: SetupLayout | null, row: Row): Promise<NodeRowState> {
  const judged = (input: StatusInput) => ({ state: nodeState(tree, entryStatus(input)), availability: [] });
  if (row.source === "tree") return judged(await treeRowInput(tree, layout, row));
  if (row.source === "offered") return judged(outsideFolderInput(tree, layout, row.path, null));
  if (row.source === "paused") return judged(outsideFolderInput(tree, layout, row.path, row.folder));
  let file;
  try {
    file = await tree.node.client!.file(row.folder.config!.id, row.inside);
  } catch (error) {
    return { state: nodeState(tree, { status: "unknown", detail: `its index entry could not be read: ${(error as Error).message}` }), availability: [] };
  }
  const local = file?.local ? { deleted: file.local.deleted, ignored: file.local.ignored } : null;
  return {
    state: nodeState(tree, entryStatus(await indexRowInput(tree, layout, row, local))),
    availability: (file?.availability ?? []).map((device) => ({ deviceId: device.id, name: tree.deviceNames.get(device.id) ?? device.id.slice(0, 7) })),
  };
}

export function folderChipAt(tree: NodeTree, path: string): TreeEntry["folder"] {
  const root = rootFolderAt(tree, path);
  return root && { id: root.placement.folderId, label: root.placement.label };
}

async function entryOf(tree: NodeTree, layout: SetupLayout | null, row: Row): Promise<TreeEntry> {
  const { state, availability } = await nodeRowState(tree, layout, row);
  return {
    name: row.name,
    path: row.path,
    kind: row.kind,
    size: row.size,
    modified: row.modified,
    folder: folderChipAt(tree, row.path),
    priority: priorityAt(layout, row.path),
    nodes: [state],
    availability,
  };
}

export async function mapAtMost<Item, Result>(items: Item[], atOnce: number, map: (item: Item) => Promise<Result>): Promise<Result[]> {
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

function listNotes(label: string, status: FolderStatus | null, lists: ListsView | null): string[] {
  if (!status || !lists) return [];
  if (lists.stillReading) return [`${label}: ${needTotalOf(status)} items outstanding and ${errorTotalOf(status)} failed in this folder; where they are is still being read`];
  if (lists.need === "too-many") return [`${label}: ${needTotalOf(status)} items outstanding in this folder, too many to place`];
  return [];
}

export async function folderNotes(tree: NodeTree, rows: Row[]): Promise<string[]> {
  const folders = [...new Set(rows.flatMap((row) => (row.source === "index" ? [row.folder] : [])))];
  const notes = await Promise.all(
    folders.map(async (folder) => {
      const [status, lists] = await Promise.all([folderStatus(tree, folder), folderLists(tree, folder)]);
      return listNotes(folder.placement.label, status, lists);
    }),
  );
  return notes.flat();
}

/** One page of a directory as one node of this host sees it. */
export async function treeListing(nodeId: string, rawPath: string, page: number, sources: TreeSources): Promise<TreeListing> {
  const path = treePath(rawPath);
  const [node, layout] = await Promise.all([sources.node(nodeId), sources.layout()]);
  const tree = await readNodeTree(node, layout, sources);
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
    notes: [...notes, ...(await folderNotes(tree, shown))],
  };
}
