import { type NodeOs, relativeToRoot } from "./treePaths.js";

/** Where a node of this host keeps its data, as the guard judges a folder path against it. */
export interface NodeRoot {
  nodeId: string;
  name: string;
  root: string;
  os: NodeOs;
}

/**
 * @implNote Only a path that names its drive and starts at that drive's top counts on Windows: `F:foo`
 * is relative to F:'s current directory, and a UNC or `\\?\` path names no drive letter the root can match.
 */
function isAbsolutePath(path: string, os: NodeOs): boolean {
  return os === "windows" ? /^[A-Za-z]:[\\/]/.test(path) : path.startsWith("/");
}

/** Whether `path` is the root or below it once `..` is resolved; case-insensitive and either slash on Windows. */
export function isInsideRoot(path: string, root: string, os: NodeOs): boolean {
  return isAbsolutePath(path, os) && relativeToRoot(path, root, os) !== null;
}

/** Another node whose root lies strictly below this node's, the only kind a folder of this node can reach into. */
function nestedNodes(node: NodeRoot, nodes: NodeRoot[]): NodeRoot[] {
  return nodes.filter((other) => other.nodeId !== node.nodeId && other.os === node.os && isStrictlyBelow(other.root, node.root, node.os));
}

/** Whether `path` lies below `root` and is not the root itself. */
export function isStrictlyBelow(path: string, root: string, os: NodeOs): boolean {
  const relative = relativeToRoot(path, root, os);
  return relative !== null && relative !== "";
}

/** The other node of this host whose root holds `path`, or null. */
export function isInsideOtherNode(path: string, node: NodeRoot, nodes: NodeRoot[]): NodeRoot | null {
  return nestedNodes(node, nodes).find((other) => isInsideRoot(path, other.root, other.os)) ?? null;
}

function holdsOtherNode(path: string, node: NodeRoot, nodes: NodeRoot[]): NodeRoot | null {
  return nestedNodes(node, nodes).find((other) => isInsideRoot(other.root, path, node.os)) ?? null;
}

/** Why `path` cannot be a folder of `node`, or null: outside its root, inside another node's root, or holding one. */
export function folderPathProblem(path: string, node: NodeRoot, nodes: NodeRoot[]): string | null {
  if (!path.trim()) return "the folder path is missing";
  if (!isInsideRoot(path, node.root, node.os)) return `${path} is outside ${node.name}'s root ${node.root}`;
  const inside = isInsideOtherNode(path, node, nodes);
  if (inside) return `${path} is inside ${inside.name}'s root ${inside.root}`;
  const held = holdsOtherNode(path, node, nodes);
  return held ? `${path} holds ${held.name}'s root ${held.root}` : null;
}

/** The absolute path `relative` (with `/` separators) names below `root`, written with the node's separator. */
export function pathUnderRoot(root: string, relative: string, os: NodeOs): string {
  if (!relative) return root;
  const separator = os === "windows" ? "\\" : "/";
  const base = root.replace(os === "windows" ? /[\\/]+$/ : /\/+$/, "");
  return `${base}${separator}${relative.split("/").join(separator)}`;
}
