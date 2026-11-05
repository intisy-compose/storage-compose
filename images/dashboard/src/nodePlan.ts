import { type LayoutDevice, type LayoutFolder, type LayoutNode, type SetupLayout, blockedNodeIds, topDirectoryPath } from "./setupRepo.js";

export type PlannedType = "sendreceive" | "sendonly";

/** Why a node keeps a folder both ways. */
export type KeptBy = "threshold" | "assigned" | "pin";

export interface PlannedVersioning {
  type: "staggered";
  maxAgeDays: number;
}

/** One Syncthing folder of a node's plan. */
export interface PlannedFolder {
  id: string;
  label: string;
  /** The layout path whose content the folder carries. */
  relativePath: string;
  path: string;
  type: PlannedType;
  /** The folder's priority for this node, its pin included. */
  priority: number;
  /** Null for a folder the node only sends. */
  keptBy: KeptBy | null;
  /** Whether what the node holds here leaves it once a keeper has confirmed it. */
  handsOff: boolean;
  /** A priority 0 entry, kept apart per node under `Nodes/<name>/` on the cluster. */
  local: boolean;
  ignores: string[];
  versioning: PlannedVersioning | null;
  devices: string[];
  paused: boolean;
}

export interface NodePlan {
  nodeId: string;
  admitted: boolean;
  /** The threshold the layout commits for the node, before any raise for space. */
  threshold: number;
  folders: PlannedFolder[];
  /** Layout paths below the threshold that the node holds nothing in, so it does not share them. */
  notShared: string[];
  /** Pins and assigned paths without a layout entry at or below them, which no folder can carry. */
  unplaced: string[];
  /** The layout's blocking problems with this node, which leave its plan empty. */
  problems: string[];
}

/** The cluster's deletions stay in its version store this long (section 5, item 2). */
export const clusterVersionsDays = 90;

/** The file of hand-off ignore entries, which `.stignore` pulls in. */
export const handoffIgnoreFile = ".stignore-handoff";

/** @implNote First, so a `!` line of the folder's own can never bring back a handed-off path; the list itself is ignored or it would sync to every keeper. */
export const handoffIgnoreLines = [`#include ${handoffIgnoreFile}`, `/${handoffIgnoreFile}`];

const windowsRoot = /^[A-Za-z]:/;

/** @implNote Case-insensitive, as `folderId()` is. */
function pathKey(relativePath: string): string {
  return relativePath === topDirectoryPath ? "" : relativePath.toLowerCase();
}

function covers(ancestor: string, relativePath: string): boolean {
  const ancestorKey = pathKey(ancestor);
  const key = pathKey(relativePath);
  return ancestorKey === "" || key === ancestorKey || key.startsWith(`${ancestorKey}/`);
}

/** drive-sync's `_join`: the root's own separator, which a drive letter makes a backslash. */
function joinPath(root: string, ...parts: string[]): string {
  const separator = windowsRoot.test(root) ? "\\" : "/";
  return root.replace(/[\\/]+$/, "") + separator + parts.flatMap((part) => part.split("/")).join(separator);
}

function pinOf(node: LayoutNode, folder: LayoutFolder): number | null {
  const key = pathKey(folder.relativePath);
  const pin = Object.entries(node.pins).find(([path]) => pathKey(path) === key);
  return pin ? pin[1] : null;
}

function isAssigned(node: LayoutNode, folder: LayoutFolder): boolean {
  return node.assigned.some((path) => covers(path, folder.relativePath));
}

interface Network {
  layout: SetupLayout;
  folders: LayoutFolder[];
  cluster: LayoutNode | null;
}

function deviceOf(layout: SetupLayout, node: LayoutNode): LayoutDevice | null {
  return layout.devices.find((device) => device.name === node.device) ?? null;
}

/** An admitted node that others share with: its device is listed and joined, as drive-sync's `joined` gate has it. */
function shareableDevice(layout: SetupLayout, node: LayoutNode): string | null {
  const device = deviceOf(layout, node);
  return node.admitted && device?.joined && device.id ? device.id : null;
}

function isCluster(network: Network, node: LayoutNode): boolean {
  return network.cluster?.id === node.id;
}

function ownPriority(node: LayoutNode, folder: LayoutFolder): number {
  return Math.max(folder.priority, pinOf(node, folder) ?? folder.priority);
}

/** Whether the node carries the folder's shared Syncthing folder at all; a priority 0 entry is the node's own and goes to `Nodes/`. */
function carriesShared(network: Network, node: LayoutNode, folder: LayoutFolder): boolean {
  if (ownPriority(node, folder) > 0 || isAssigned(node, folder)) return true;
  if (!isCluster(network, node)) return false;
  return network.layout.nodes.some((other) => other.admitted && other.id !== node.id && (ownPriority(other, folder) > 0 || isAssigned(other, folder)));
}

/**
 * The folder's priority for the node.
 * @implNote The cluster keeps all data whatever its priority, so a pin any admitted node sets counts on the cluster too.
 */
function priorityFor(network: Network, node: LayoutNode, folder: LayoutFolder): number {
  if (!isCluster(network, node)) return ownPriority(node, folder);
  return Math.max(ownPriority(node, folder), ...network.layout.nodes.filter((other) => other.admitted).map((other) => ownPriority(other, folder)));
}

function keptBy(network: Network, node: LayoutNode, folder: LayoutFolder): KeptBy | null {
  if (isAssigned(node, folder)) return "assigned";
  if (folder.priority >= node.threshold) return "threshold";
  return priorityFor(network, node, folder) >= node.threshold ? "pin" : null;
}

/** The nearest layout entry above each entry, which ignores it. */
function childLines(folders: LayoutFolder[], parent: LayoutFolder): string[] {
  const parentKey = pathKey(parent.relativePath);
  return folders
    .filter((child) => child !== parent && pathKey(child.relativePath).startsWith(`${parentKey}/`))
    .filter((child) => nearestParent(folders, child) === parent)
    .map((child) => `/${child.relativePath.slice(parent.relativePath.length + 1)}`);
}

function nearestParent(folders: LayoutFolder[], child: LayoutFolder): LayoutFolder | null {
  const key = pathKey(child.relativePath);
  return folders
    .filter((candidate) => candidate !== child && key.startsWith(`${pathKey(candidate.relativePath)}/`))
    .reduce<LayoutFolder | null>((nearest, candidate) => (nearest === null || candidate.relativePath.length > nearest.relativePath.length ? candidate : nearest), null);
}

function ignoresOf(folders: LayoutFolder[], folder: LayoutFolder): string[] {
  const lines = [...handoffIgnoreLines, ...childLines(folders, folder)];
  return [...lines, ...folder.ignore.filter((line) => !lines.includes(line))];
}

function sortedDevices(ids: (string | null)[]): string[] {
  return [...new Set(ids.filter((id): id is string => id !== null))].sort();
}

function sharedFolder(network: Network, node: LayoutNode, device: LayoutDevice | null, folder: LayoutFolder, kept: KeptBy | null): PlannedFolder {
  const cluster = isCluster(network, node);
  const devices = network.layout.nodes
    .filter((other) => other.id !== node.id && carriesShared(network, other, folder))
    .map((other) => shareableDevice(network.layout, other));
  return {
    id: folder.id,
    label: folder.relativePath,
    relativePath: folder.relativePath,
    path: device?.paths[folder.relativePath] ?? joinPath(device?.root ?? "", folder.relativePath),
    type: kept ? "sendreceive" : "sendonly",
    priority: priorityFor(network, node, folder),
    keptBy: kept,
    handsOff: kept === null,
    local: false,
    ignores: ignoresOf(network.folders, folder),
    versioning: kept ? { type: "staggered", maxAgeDays: cluster ? clusterVersionsDays : folder.versionsDays } : null,
    devices: sortedDevices([device?.id ?? null, ...devices]),
    paused: !node.enabled,
  };
}

function localFolderId(node: LayoutNode, folder: LayoutFolder): string {
  return `${node.id}-${folder.id}`;
}

function sentToCluster(network: Network, node: LayoutNode, device: LayoutDevice | null, folder: LayoutFolder): PlannedFolder {
  return {
    id: localFolderId(node, folder),
    label: `Nodes/${node.name}/${folder.relativePath}`,
    relativePath: folder.relativePath,
    path: device?.paths[folder.relativePath] ?? joinPath(device?.root ?? "", folder.relativePath),
    type: "sendonly",
    priority: 0,
    keptBy: null,
    handsOff: false,
    local: true,
    ignores: ignoresOf(network.folders, folder),
    versioning: null,
    devices: sortedDevices([device?.id ?? null, network.cluster ? shareableDevice(network.layout, network.cluster) : null]),
    paused: !node.enabled,
  };
}

function keptForNode(network: Network, cluster: LayoutNode, clusterDevice: LayoutDevice | null, node: LayoutNode, folder: LayoutFolder): PlannedFolder {
  const label = `Nodes/${node.name}/${folder.relativePath}`;
  return {
    id: localFolderId(node, folder),
    label,
    relativePath: label,
    path: joinPath(clusterDevice?.root ?? "", label),
    type: "sendreceive",
    priority: 0,
    keptBy: "threshold",
    handsOff: false,
    local: true,
    ignores: ignoresOf(network.folders, folder),
    versioning: { type: "staggered", maxAgeDays: clusterVersionsDays },
    devices: sortedDevices([clusterDevice?.id ?? null, shareableDevice(network.layout, node)]),
    paused: !cluster.enabled,
  };
}

/** Every other admitted node's priority 0 entries, one folder per node and entry on the cluster. */
function clusterNodeFolders(network: Network, cluster: LayoutNode, clusterDevice: LayoutDevice | null): PlannedFolder[] {
  return network.layout.nodes
    .filter((node) => node.id !== cluster.id && shareableDevice(network.layout, node) !== null)
    .flatMap((node) => network.folders.filter((folder) => !carriesShared(network, node, folder)).map((folder) => keptForNode(network, cluster, clusterDevice, node, folder)));
}

function hasEntryAtOrBelow(folders: LayoutFolder[], path: string): boolean {
  return folders.some((folder) => covers(path, folder.relativePath));
}

function unplacedPaths(folders: LayoutFolder[], node: LayoutNode): string[] {
  const pins = Object.keys(node.pins).filter((path) => !folders.some((folder) => pathKey(folder.relativePath) === pathKey(path)));
  const assigned = node.assigned.filter((path) => !hasEntryAtOrBelow(folders, path));
  return [...new Set([...pins, ...assigned])].sort((left, right) => left.localeCompare(right));
}

function holdsItems(localFolders: ReadonlySet<string>, folder: LayoutFolder): boolean {
  const key = pathKey(folder.relativePath);
  return [...localFolders].some((path) => pathKey(path) === key);
}

/** The private cluster: the admitted node on C-30's archive device. */
function clusterOf(layout: SetupLayout): LayoutNode | null {
  return layout.nodes.find((node) => node.admitted && deviceOf(layout, node)?.role === "archive") ?? null;
}

/** The layout without the nodes a blocking problem leaves out, so no plan shares with one, waits for one or takes one for the cluster. */
function networkOf(layout: SetupLayout): Network {
  const blocked = blockedNodeIds(layout);
  const usable = { ...layout, nodes: layout.nodes.filter((node) => !blocked.has(node.id)) };
  return { layout: usable, folders: layout.folders.filter((folder) => folder.relativePath !== topDirectoryPath), cluster: clusterOf(usable) };
}

/**
 * The Syncthing folders the node should have, from the shared layout alone.
 * One folder per layout entry (call 1); at or above the threshold, assigned or pinned there, send-receive;
 * below, send-only while the node holds items in it (`localFolders`, layout paths), else not shared.
 * Null for a node the layout does not list.
 */
export function nodePlan(layout: SetupLayout, nodeId: string, localFolders: ReadonlySet<string>): NodePlan | null {
  const node = layout.nodes.find((entry) => entry.id === nodeId);
  if (!node) return null;
  const network = networkOf(layout);
  const problems = layout.problems.filter((problem) => problem.blocksNode && problem.nodeId === nodeId).map((problem) => problem.text);
  const plan: NodePlan = { nodeId, admitted: node.admitted, threshold: node.threshold, folders: [], notShared: [], unplaced: unplacedPaths(network.folders, node), problems };
  if (!node.admitted || problems.length) return plan;
  const device = deviceOf(layout, node);
  for (const folder of network.folders) {
    if (!carriesShared(network, node, folder)) {
      if (!isCluster(network, node) && holdsItems(localFolders, folder)) plan.folders.push(sentToCluster(network, node, device, folder));
      continue;
    }
    const kept = keptBy(network, node, folder);
    if (kept || holdsItems(localFolders, folder)) plan.folders.push(sharedFolder(network, node, device, folder, kept));
    else plan.notShared.push(folder.relativePath);
  }
  if (isCluster(network, node)) plan.folders.push(...clusterNodeFolders(network, node, device));
  return plan;
}

/** Whether the node's policy keeps the shared folder both ways, which makes it a keeper a hand-off may wait for. */
export function keepsFolder(layout: SetupLayout, nodeId: string, folderId: string, threshold?: number): boolean {
  const network = networkOf(layout);
  const node = network.layout.nodes.find((entry) => entry.id === nodeId);
  const folder = network.folders.find((entry) => entry.id === folderId);
  if (!node?.admitted || !folder) return false;
  if (!carriesShared(network, node, folder)) return false;
  return keptBy(network, { ...node, threshold: threshold ?? node.threshold }, folder) !== null;
}
