import type { NodeEntryState, TreeEntry, TreeListing } from "./api/types.js";
import { overridesBelow, priorityAt } from "./priorityTree.js";
import type { SetupLayout } from "./setupRepo.js";
import { directoriesAbove, folderAt } from "./treePaths.js";
import {
  type NodeRowState,
  type NodeTree,
  type RowBase,
  type TreeNode,
  type TreeSources,
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

export interface AllNodesSources extends Omit<TreeSources, "node"> {
  /** This host's nodes, the cluster first. */
  localNodes: () => Promise<TreeNode[]>;
  otherHosts: OtherHost[];
  /** A GET of the host's dashboard with `scope=local`. */
  readHost: (host: OtherHost, path: string) => Promise<unknown>;
  /** The nodes last reported for a host, so one that cannot be reached still shows them. */
  hostNodes: (host: OtherHost) => Promise<{ nodeId: string; name: string }[]>;
  /** How long one node's states may take before its rows show it as unknown. */
  nodeWaitMs: number;
}

type HostAnswer = { host: OtherHost; listing: TreeListing } | { host: OtherHost; error: string };

function isTreeListing(answer: unknown): answer is TreeListing {
  return Array.isArray((answer as TreeListing | null)?.entries);
}

async function askHost(host: OtherHost, path: string, page: number, sources: AllNodesSources): Promise<HostAnswer> {
  const query = new URLSearchParams({ node: "all", path, page: String(page) });
  try {
    const answer = await sources.readHost(host, `/api/tree?${query.toString()}`);
    return isTreeListing(answer) ? { host, listing: answer } : { host, error: "it did not answer with a listing" };
  } catch (error) {
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

function unansweredTree(node: TreeNode, sources: TreeSources): NodeTree {
  return { node, answering: false, ownId: "", folders: [], deviceNames: new Map(), statuses: new Map(), lists: new Map(), sources };
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

function folderRootsBelow(tree: NodeTree, path: string): RowBase[] {
  const names = directoriesAbove(
    tree.folders.map((folder) => folder.placement),
    null,
    path,
  );
  return names.map((name) => ({ name, path: path ? `${path}/${name}` : name, kind: "directory", size: null, modified: null }));
}

interface ShownRows {
  rows: RowBase[];
  nextPage: number | null;
  notes: string[];
}

/**
 * The rows of the page: from the first node of this host whose index holds the path (the cluster
 * first), otherwise from the other hosts' answers, with every node's folder roots and layout paths added.
 * @implNote Without a local index the other hosts' answers are already one page, so this host's
 * own directories are added to the first page only.
 */
async function shownRows(trees: NodeTree[], layout: SetupLayout | null, path: string, page: number, answers: HostAnswer[]): Promise<ShownRows> {
  const remoteRows = answers.flatMap((answer) => ("listing" in answer ? answer.listing.entries.map(rowOf) : []));
  const source = trees.find((tree) => tree.answering && holdsIndexAt(tree, path));
  if (source) {
    const own = await directoryRows(source, layout, path);
    const others = trees.filter((tree) => tree !== source).flatMap((tree) => folderRootsBelow(tree, path));
    const sorted = addMissing(addMissing(own.rows, others), remoteRows).sort(byDirectoryThenName);
    warmFolderRoots(source, own.rows);
    return { rows: sorted.slice((page - 1) * entriesPerPage, page * entriesPerPage), nextPage: page * entriesPerPage < sorted.length ? page + 1 : null, notes: [...own.notes, ...(await folderNotes(source, own.rows))] };
  }
  const local = await Promise.all(trees.map((tree) => directoryRows(tree, layout, path)));
  const remoteNextPage = answers.find((answer) => "listing" in answer && answer.listing.nextPage !== null);
  const rows = addMissing(addMissing([], page === 1 ? local.flatMap((listing) => listing.rows) : []), remoteRows).sort(byDirectoryThenName);
  return { rows, nextPage: remoteNextPage && "listing" in remoteNextPage ? remoteNextPage.listing.nextPage : null, notes: local.flatMap((listing, index) => (trees[index].answering ? listing.notes : [])) };
}

function stillUnread(tree: NodeTree, rows: RowBase[]): (NodeRowState | null)[] {
  return rows.map((row) => (rowOn(tree, row) ? { state: { nodeId: tree.node.nodeId, nodeName: tree.node.name, host: tree.node.host, status: "unknown", detail: "still being read" }, availability: [] } : null));
}

/** One node's state per row, null where the node has nothing to do with it; a node past the wait shows unknown. */
function statesOf(tree: NodeTree, layout: SetupLayout | null, rows: RowBase[], waitMs: number): Promise<(NodeRowState | null)[]> {
  const read = mapAtMost(rows, fileReadsAtOnce, async (row) => {
    const located = rowOn(tree, row);
    return located && nodeRowState(tree, layout, located);
  });
  return withinDeadline(read, waitMs, () => stillUnread(tree, rows));
}

/** The folder whose root the row is, named as a node that holds it names it; an offer's label is the offering device's. */
function folderChip(trees: NodeTree[], path: string): TreeEntry["folder"] {
  const tree = trees.find((candidate) => rootFolderAt(candidate, path)?.config) ?? trees.find((candidate) => rootFolderAt(candidate, path));
  return tree ? folderChipAt(tree, path) : null;
}

function unreachableStates(answer: Extract<HostAnswer, { error: string }>, nodes: { nodeId: string; name: string }[]): NodeEntryState[] {
  return nodes.map((node) => ({ nodeId: node.nodeId, nodeName: node.name, host: answer.host.host, status: "unknown", detail: `${answer.host.host}'s dashboard could not be reached` }));
}

function remoteEntry(answers: HostAnswer[], path: string): TreeEntry[] {
  return answers.flatMap((answer) => ("listing" in answer ? answer.listing.entries.filter((entry) => pathKey(entry.path) === pathKey(path)) : []));
}

function uniqueDevices(lists: TreeEntry["availability"][]): TreeEntry["availability"] {
  const devices = new Map<string, TreeEntry["availability"][number]>();
  for (const device of lists.flat()) if (!devices.has(device.deviceId)) devices.set(device.deviceId, device);
  return [...devices.values()];
}

function hostNotes(answers: HostAnswer[]): string[] {
  return answers.flatMap((answer) =>
    "listing" in answer ? answer.listing.notes.map((note) => `${answer.host.host}: ${note}`) : [`${answer.host.host}'s dashboard could not be reached (${answer.error}); its nodes show as unknown`],
  );
}

/**
 * One page of a directory with every node's state per entry: this host's nodes, then each other
 * host's (asked with `scope=local`, so it fills only its own) unless `scope` is local.
 */
export async function allNodesListing(rawPath: string, page: number, scope: "all" | "local", sources: AllNodesSources): Promise<TreeListing> {
  const path = treePath(rawPath);
  const asked = Promise.all((scope === "all" ? sources.otherHosts : []).map((host) => askHost(host, path, page, sources)));
  const [nodes, layout] = await Promise.all([sources.localNodes(), sources.layout()]);
  const treeSources: TreeSources = { ...sources, node: async () => nodes[0] };
  const trees = await Promise.all(nodes.map((node) => withinDeadline(readNodeTree(node, layout, treeSources), sources.nodeWaitMs, () => unansweredTree(node, treeSources))));
  const answers = await asked;
  const shown = await shownRows(trees, layout, path, page, answers);
  const [states, unreachable] = await Promise.all([
    Promise.all(trees.map((tree) => statesOf(tree, layout, shown.rows, sources.nodeWaitMs))),
    Promise.all(answers.map(async (answer) => ("error" in answer ? unreachableStates(answer, await sources.hostNodes(answer.host).catch(() => [])) : []))),
  ]);
  const entries = shown.rows.map((row, index): TreeEntry => {
    const local = states.map((perRow) => perRow[index]).filter((state): state is NodeRowState => state !== null);
    const remote = remoteEntry(answers, row.path);
    return {
      ...row,
      folder: folderChip(trees, row.path) ?? remote.find((entry) => entry.folder)?.folder ?? null,
      priority: priorityAt(layout, row.path),
      nodes: [...local.map((state) => state.state), ...remote.flatMap((entry) => entry.nodes), ...unreachable.flat()],
      availability: uniqueDevices([...local.map((state) => state.availability), ...remote.map((entry) => entry.availability)]),
    };
  });
  const silent = trees.filter((tree) => !tree.answering).map((tree) => `${tree.node.name}'s Syncthing is not answering`);
  return { path, view: "all", priority: priorityAt(layout, path), overridesBelow: overridesBelow(layout, path), entries, nextPage: shown.nextPage, notes: [...silent, ...shown.notes, ...hostNotes(answers)] };
}
