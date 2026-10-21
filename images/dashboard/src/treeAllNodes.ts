import type { NodeEntryState, TreeEntry, TreeListing } from "./api/types.js";
import { RequestError } from "./http.js";
import { overridesBelow, priorityAt } from "./priorityTree.js";
import type { SetupLayout } from "./setupRepo.js";
import { directoriesAbove, folderAt } from "./treePaths.js";
import {
  type ListingSources,
  type NodeRowState,
  type NodeTree,
  type Row,
  type RowBase,
  type TreeNode,
  byDirectoryThenName,
  directoryRows,
  entriesPerPage,
  fileReadsAtOnce,
  folderChipAt,
  folderNotes,
  mapAtMost,
  nodeRowState,
  readNodeTree,
  rootFolderAt,
  rowOn,
  treePath,
  warmFolderRoots,
} from "./treeListing.js";

/** Another host's dashboard, asked once per listing for its own nodes. */
export interface OtherHost {
  host: string;
  dashboardUrl: string;
}

export interface AllNodesSources extends ListingSources {
  /** This host's nodes, the cluster first. */
  localNodes: () => Promise<TreeNode[]>;
  otherHosts: OtherHost[];
  /** A GET of the host's dashboard with `scope=local`; a 504 means it is slow, anything else that it cannot be reached. */
  readHost: (host: OtherHost, path: string) => Promise<unknown>;
  /** The nodes last reported for a host, from what is cached; never reads anything. */
  hostNodes: (host: OtherHost) => { nodeId: string; name: string }[];
  /** How long one node's states may take before its rows show it as still being read. */
  nodeWaitMs: number;
  /** How long this host's whole part of a listing may take, the supplying node's directory read included. */
  listingBudgetMs: number;
}

type HostAnswer = { host: OtherHost; listing: TreeListing } | { host: OtherHost; slow: true } | { host: OtherHost; error: string };

const stillBeingRead = "still being read";
const notConnected = "not connected";

/** The folders each node held the last time its Syncthing answered, so a node that is not attached still shows where it takes part. */
const lastFolders = new Map<string, NodeTree["folders"]>();

function isTreeListing(answer: unknown): answer is TreeListing {
  return Array.isArray((answer as TreeListing | null)?.entries);
}

async function askHost(host: OtherHost, path: string, page: number, sources: AllNodesSources): Promise<HostAnswer> {
  const query = new URLSearchParams({ node: "all", path, page: String(page) });
  try {
    const answer = await sources.readHost(host, `/api/tree?${query.toString()}`);
    return isTreeListing(answer) ? { host, listing: answer } : { host, error: "it did not answer with a listing" };
  } catch (error) {
    if (error instanceof RequestError && error.status === 504) return { host, slow: true };
    return { host, error: (error as Error).message };
  }
}

function withinDeadline<Value>(work: Promise<Value>, waitMs: number, late: () => Value): Promise<Value> {
  let timer: NodeJS.Timeout | undefined;
  const waited = new Promise<Value>((resolve) => {
    timer = setTimeout(() => resolve(late()), waitMs);
    timer.unref();
  });
  return Promise.race([work, waited]).finally(() => clearTimeout(timer));
}

/** A node as this listing sees it: read in time, still being read, or not attached. */
interface NodeView {
  tree: NodeTree;
  condition: "read" | "late" | "absent";
}

function treeWithout(node: TreeNode, sources: ListingSources, folders: NodeTree["folders"] = []): NodeTree {
  return { node, answering: false, ownId: "", folders, deviceNames: new Map(), statuses: new Map(), lists: new Map(), sources };
}

async function viewOf(node: TreeNode, layout: SetupLayout | null, sources: ListingSources, waitMs: number): Promise<NodeView> {
  if (!node.present) return { tree: { ...treeWithout(node, sources, lastFolders.get(node.nodeId)), answering: true }, condition: "absent" };
  const read = readNodeTree(node, layout, sources).then((tree): NodeView => {
    if (tree.answering) lastFolders.set(node.nodeId, tree.folders);
    return { tree, condition: "read" };
  });
  return withinDeadline(read, waitMs, (): NodeView => ({ tree: treeWithout(node, sources), condition: "late" }));
}

function holdsIndexAt(tree: NodeTree, path: string): boolean {
  const location = folderAt(
    tree.folders.map((folder) => folder.placement),
    path,
  );
  const folder = location && tree.folders.find((candidate) => candidate.placement === location.placement);
  return Boolean(folder?.config && !folder.config.paused);
}

function pathKey(path: string): string {
  return path.toLowerCase();
}

function addMissing(rows: RowBase[], more: RowBase[]): RowBase[] {
  const known = new Set(rows.map((row) => pathKey(row.path)));
  return [...rows, ...more.filter((row) => !known.has(pathKey(row.path)) && known.add(pathKey(row.path)))];
}

function rowOf(entry: TreeEntry): RowBase {
  return { name: entry.name, path: entry.path, kind: entry.kind, size: entry.size, modified: entry.modified };
}

function directoryRowsNamed(path: string, names: string[]): RowBase[] {
  return names.map((name) => ({ name, path: path ? `${path}/${name}` : name, kind: "directory", size: null, modified: null }));
}

function folderRootsBelow(tree: NodeTree, path: string): RowBase[] {
  return directoryRowsNamed(
    path,
    directoriesAbove(
      tree.folders.map((folder) => folder.placement),
      null,
      path,
    ),
  );
}

interface ShownRows {
  rows: RowBase[];
  nextPage: number | null;
  notes: string[];
}

/** Milliseconds left of the listing's budget. */
type Remaining = () => number;

/**
 * The rows of the page from the first node whose index holds the path (the cluster first), with the
 * other nodes' folder roots and the other hosts' rows added.
 * @implNote The supplying node's directory read is bounded by the listing's budget: past it the page
 * shows the other nodes' rows and says the directory is still being read, while the read goes on and
 * is served from the cache next time.
 */
async function sourcedRows(source: NodeTree, others: NodeTree[], layout: SetupLayout | null, path: string, page: number, remoteRows: RowBase[], remaining: Remaining): Promise<ShownRows> {
  const late = { rows: [] as Row[], notes: [`${source.node.name} is still reading ${path || "the top directory"}`] };
  const own = await withinDeadline(directoryRows(source, layout, path), remaining(), () => late);
  const sorted = addMissing(
    addMissing(
      own.rows,
      others.flatMap((tree) => folderRootsBelow(tree, path)),
    ),
    remoteRows,
  ).sort(byDirectoryThenName);
  const rows = sorted.slice((page - 1) * entriesPerPage, page * entriesPerPage);
  const shownPaths = new Set(rows.map((row) => pathKey(row.path)));
  const ownShown = own.rows.filter((row) => shownPaths.has(pathKey(row.path)));
  warmFolderRoots(source, ownShown);
  const notes = await withinDeadline(folderNotes(source, ownShown), remaining(), () => []);
  return { rows, nextPage: page * entriesPerPage < sorted.length ? page + 1 : null, notes: [...own.notes, ...notes] };
}

/**
 * The rows of the page when no node of this host holds an index at the path.
 * @implNote The other hosts' answers are already one page, so this host's own directories are added
 * to the first page only.
 */
async function unsourcedRows(views: NodeView[], layout: SetupLayout | null, path: string, page: number, answers: HostAnswer[], remoteRows: RowBase[]): Promise<ShownRows> {
  const read = views.filter((view) => view.condition === "read").map((view) => view.tree);
  const local = await Promise.all(read.map((tree) => directoryRows(tree, layout, path)));
  const absentRows = views.filter((view) => view.condition === "absent").flatMap((view) => folderRootsBelow(view.tree, path));
  const layoutRows = directoryRowsNamed(path, directoriesAbove([], layout, path));
  const firstPage = page === 1 ? [...local.flatMap((listing) => listing.rows), ...absentRows, ...layoutRows] : [];
  const remoteNext = answers.flatMap((answer) => ("listing" in answer && answer.listing.nextPage !== null ? [answer.listing.nextPage] : []));
  return {
    rows: addMissing(addMissing([], firstPage), remoteRows).sort(byDirectoryThenName),
    nextPage: remoteNext[0] ?? null,
    notes: local.flatMap((listing, index) => (read[index].answering ? listing.notes : [])),
  };
}

function stateOf(tree: NodeTree, status: NodeEntryState["status"], detail: string): NodeRowState {
  return { state: { nodeId: tree.node.nodeId, nodeName: tree.node.name, host: tree.node.host, status, detail }, availability: [] };
}

/** One node's state per row, null where the node has nothing to do with it. */
function statesOf(view: NodeView, layout: SetupLayout | null, rows: RowBase[], waitMs: number): Promise<(NodeRowState | null)[]> {
  const { tree } = view;
  if (view.condition === "late") return Promise.resolve(rows.map(() => stateOf(tree, "unknown", stillBeingRead)));
  if (view.condition === "absent") return Promise.resolve(rows.map((row) => (rowOn(tree, row) ? stateOf(tree, "unknown", notConnected) : null)));
  const read = mapAtMost(rows, fileReadsAtOnce, async (row) => {
    const located = rowOn(tree, row);
    return located && nodeRowState(tree, layout, located);
  });
  return withinDeadline(read, waitMs, () => rows.map((row) => (rowOn(tree, row) ? stateOf(tree, "unknown", stillBeingRead) : null)));
}

/** The states of one host's nodes on a row its answer did not cover. */
function hostStatesOff(answer: HostAnswer, row: RowBase, page: number, hostNodes: (host: OtherHost) => { nodeId: string; name: string }[]): NodeEntryState[] {
  const host = answer.host.host;
  const unknown = (nodes: { nodeId: string; name: string }[], detail: string): NodeEntryState[] => nodes.map((node) => ({ nodeId: node.nodeId, nodeName: node.name, host, status: "unknown", detail }));
  if ("slow" in answer) return unknown(hostNodes(answer.host), `${host}'s dashboard is slow, ${stillBeingRead}`);
  if ("error" in answer) return unknown(hostNodes(answer.host), `${host}'s dashboard could not be reached`);
  const listing = answer.listing;
  if (listing.entries.some((entry) => pathKey(entry.path) === pathKey(row.path))) return [];
  if (page === 1 && listing.nextPage === null) return [];
  const seen = new Map(listing.entries.flatMap((entry) => entry.nodes).map((state) => [state.nodeId, { nodeId: state.nodeId, name: state.nodeName }]));
  return unknown([...seen.values()], `not on this page of ${host}'s listing`);
}

function remoteEntries(answers: HostAnswer[], path: string): TreeEntry[] {
  return answers.flatMap((answer) => ("listing" in answer ? answer.listing.entries.filter((entry) => pathKey(entry.path) === pathKey(path)) : []));
}

function uniqueDevices(lists: TreeEntry["availability"][]): TreeEntry["availability"] {
  const devices = new Map<string, TreeEntry["availability"][number]>();
  for (const device of lists.flat()) if (!devices.has(device.deviceId)) devices.set(device.deviceId, device);
  return [...devices.values()];
}

/** The folder whose root the row is, named as a node that holds it names it; an offer's label is the offering device's. */
function folderChip(trees: NodeTree[], path: string): TreeEntry["folder"] {
  const tree = trees.find((candidate) => rootFolderAt(candidate, path)?.config) ?? trees.find((candidate) => rootFolderAt(candidate, path));
  return tree ? folderChipAt(tree, path) : null;
}

function nodeNotes(views: NodeView[]): string[] {
  return views.flatMap(({ tree, condition }) => {
    if (condition === "late") return [`${tree.node.name} is ${stillBeingRead}`];
    if (condition === "absent") return [`${tree.node.name} is ${notConnected}`];
    return tree.answering ? [] : [`${tree.node.name}'s Syncthing is not answering`];
  });
}

function hostNotes(answers: HostAnswer[]): string[] {
  return answers.flatMap((answer) => {
    if ("listing" in answer) return answer.listing.notes.map((note) => `${answer.host.host}: ${note}`);
    if ("slow" in answer) return [`${answer.host.host}'s dashboard is slow, ${stillBeingRead}; its nodes show as unknown`];
    return [`${answer.host.host}'s dashboard could not be reached (${answer.error}); its nodes show as unknown`];
  });
}

/**
 * One page of a directory with every node's state per entry: this host's nodes, then each other
 * host's (asked with `scope=local`, so it fills only its own) unless `scope` is local.
 */
export async function allNodesListing(rawPath: string, page: number, scope: "all" | "local", sources: AllNodesSources): Promise<TreeListing> {
  const path = treePath(rawPath);
  const deadline = Date.now() + sources.listingBudgetMs;
  const remaining: Remaining = () => Math.max(0, deadline - Date.now());
  const asked = Promise.all((scope === "all" ? sources.otherHosts : []).map((host) => askHost(host, path, page, sources)));
  const [nodes, layout] = await Promise.all([sources.localNodes(), sources.layout()]);
  const views = await Promise.all(nodes.map((node) => viewOf(node, layout, sources, Math.min(sources.nodeWaitMs, remaining()))));
  const trees = views.map((view) => view.tree);
  const answers = await asked;
  const remoteRows = answers.flatMap((answer) => ("listing" in answer ? answer.listing.entries.map(rowOf) : []));
  const source = views.find((view) => view.condition === "read" && view.tree.answering && holdsIndexAt(view.tree, path))?.tree;
  const shown = source
    ? await sourcedRows(
        source,
        trees.filter((tree) => tree !== source),
        layout,
        path,
        page,
        remoteRows,
        remaining,
      )
    : await unsourcedRows(views, layout, path, page, answers, remoteRows);
  const states = await Promise.all(views.map((view) => statesOf(view, layout, shown.rows, Math.min(sources.nodeWaitMs, remaining()))));
  const entries = shown.rows.map((row, index): TreeEntry => {
    const local = states.map((perRow) => perRow[index]).filter((state): state is NodeRowState => state !== null);
    const remote = remoteEntries(answers, row.path);
    return {
      ...row,
      folder: folderChip(trees, row.path) ?? remote.find((entry) => entry.folder)?.folder ?? null,
      priority: priorityAt(layout, row.path),
      nodes: [...local.map((state) => state.state), ...remote.flatMap((entry) => entry.nodes), ...answers.flatMap((answer) => hostStatesOff(answer, row, page, sources.hostNodes))],
      availability: uniqueDevices([...local.map((state) => state.availability), ...remote.map((entry) => entry.availability)]),
    };
  });
  return { path, view: "all", priority: priorityAt(layout, path), overridesBelow: overridesBelow(layout, path), entries, nextPage: shown.nextPage, notes: [...nodeNotes(views), ...shown.notes, ...hostNotes(answers)] };
}
