import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { NodeAccess } from "./api/types.js";
import type { LayoutNode } from "./setupRepo.js";
import { type TomlTable, TomlError, formatPairs, parseToml } from "./toml.js";

export type NodeFileKind = "array" | "drive" | "folder";

export interface MemberDescription {
  role: string;
  label: string;
  serial: string;
  size: number;
  asset?: string;
}

/** `.storage/node.toml`; for an array the whole membership is on every member, the highest revision wins. */
export interface NodeFile {
  node: { id: string; name: string; kind: NodeFileKind; threshold: number; assigned: string[]; access: NodeAccess };
  array?: { revision: number; members: MemberDescription[] };
}

const nodeIdPattern = /^[0-9a-f]{4}$/;
const nodeNamePattern = /^[a-z0-9][a-z0-9-]*$/;
const kinds: NodeFileKind[] = ["array", "drive", "folder"];

export function nodeFilePath(root: string): string {
  return `${root}/.storage/node.toml`;
}

function text(table: TomlTable, key: string, fallback = ""): string {
  const value = table[key];
  return typeof value === "string" ? value : fallback;
}

function integer(table: TomlTable, key: string, fallback = 0): number {
  const value = table[key];
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

function member(table: TomlTable): MemberDescription {
  const description: MemberDescription = {
    role: text(table, "role"),
    label: text(table, "label"),
    serial: text(table, "serial"),
    size: integer(table, "size"),
  };
  const asset = text(table, "asset");
  return asset ? { ...description, asset } : description;
}

export function parseNodeFile(source: string): NodeFile {
  const toml = parseToml(source);
  const node = toml.node;
  if (typeof node !== "object" || Array.isArray(node)) throw new TomlError("no [node] table");
  const id = text(node, "id");
  const name = text(node, "name");
  const kind = text(node, "kind") as NodeFileKind;
  if (!nodeIdPattern.test(id)) throw new TomlError(`node id '${id}' is not 4 lowercase hex digits`);
  if (!nodeNamePattern.test(name)) throw new TomlError(`node name '${name}' does not match [a-z0-9-]`);
  if (!kinds.includes(kind)) throw new TomlError(`node kind '${kind}' is not array, drive or folder`);
  const assigned = Array.isArray(node.assigned) ? node.assigned.filter((entry): entry is string => typeof entry === "string") : [];
  const access: NodeAccess = text(node, "access") === "closed" ? "closed" : "open";
  const file: NodeFile = { node: { id, name, kind, threshold: integer(node, "threshold"), assigned, access } };
  const array = toml.array;
  if (kind === "array" && typeof array === "object" && !Array.isArray(array)) {
    const members = Array.isArray(array.members) ? array.members : [];
    file.array = {
      revision: integer(array, "revision"),
      members: members.filter((entry): entry is TomlTable => typeof entry === "object" && !Array.isArray(entry)).map(member),
    };
  }
  return file;
}

export function formatNodeFile(file: NodeFile): string {
  const lines = ["[node]", ...formatPairs({ ...file.node }, ["id", "name", "kind", "threshold", "assigned", "access"])];
  if (file.array) {
    lines.push("", "[array]", `revision = ${file.array.revision}`);
    for (const entry of file.array.members) {
      lines.push("", "[[array.members]]", ...formatPairs({ ...entry }, ["role", "label", "serial", "size", "asset"]));
    }
  }
  return `${lines.join("\n")}\n`;
}

export async function readNodeFile(path: string): Promise<NodeFile | null> {
  try {
    return parseNodeFile(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

export async function writeNodeFile(path: string, file: NodeFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.new`, formatNodeFile(file));
  await rename(`${path}.new`, path);
}

/** The node file with the policy the layout commits for it; identity and membership stay the node's own. */
export function nodeFileFromLayout(file: NodeFile, policy: LayoutNode): NodeFile {
  return { ...file, node: { ...file.node, threshold: policy.threshold, assigned: [...policy.assigned], access: policy.access } };
}

/**
 * Rewrites the node file at `path` with the layout's policy for it, and reports whether it wrote.
 * @implNote A missing or unreadable file, or one of another node, is left alone: the node file is the node's identity, which only a join creates.
 */
export async function followLayout(path: string, policy: LayoutNode): Promise<boolean> {
  const file = await readNodeFile(path);
  if (file === null || file.node.id !== policy.id) return false;
  const followed = nodeFileFromLayout(file, policy);
  if (formatNodeFile(followed) === formatNodeFile(file)) return false;
  await writeNodeFile(path, followed);
  return true;
}

/** The description of the array `id` with the highest revision among the given copies. */
export function newestDescription(id: string, files: (NodeFile | null)[]): NodeFile | null {
  return files
    .filter((file): file is NodeFile => file !== null && file.node.id === id && file.array !== undefined)
    .reduce<NodeFile | null>((best, file) => (best === null || file.array!.revision > best.array!.revision ? file : best), null);
}
