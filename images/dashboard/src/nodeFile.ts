import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
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
  /** `apply` is written only while true, as the executors read a missing line as false. */
  node: { id: string; name: string; kind: NodeFileKind; threshold: number; assigned: string[]; access: NodeAccess; apply?: true };
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
  const file: NodeFile = { node: { id, name, kind, threshold: integer(node, "threshold"), assigned, access, ...(node.apply === true ? { apply: true as const } : {}) } };
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
  const lines = ["[node]", ...formatPairs({ ...file.node }, ["id", "name", "kind", "threshold", "assigned", "access", "apply"])];
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

/**
 * The node file with the policy the layout commits for it; identity and membership stay the node's own.
 * @implNote `apply` follows the layout too, the executors' own second check (phase 3), so it is written only for an admitted node the layout lets act.
 */
export function nodeFileFromLayout(file: NodeFile, policy: LayoutNode): NodeFile {
  const node: NodeFile["node"] = { id: file.node.id, name: file.node.name, kind: file.node.kind, threshold: policy.threshold, assigned: [...policy.assigned], access: policy.access };
  return { ...file, node: policy.apply && policy.admitted ? { ...node, apply: true } : node };
}

/** An array's node file describes its membership on every member, so nothing here ever rewrites one. */
function isArrayFile(file: NodeFile): boolean {
  return file.node.kind === "array" || file.array !== undefined;
}

/** Why the node file at `path` may not be rewritten in place: a link at `.storage` or at the file, or no regular file there. */
async function placeProblem(path: string): Promise<string | null> {
  const directory = await lstat(dirname(path)).catch(() => null);
  if (!directory?.isDirectory()) return `${dirname(path)} is not a plain directory`;
  const target = await lstat(path).catch(() => null);
  if (!target?.isFile()) return `${path} is not a regular file`;
  return null;
}

/**
 * Replaces the node file through a temporary file opened with `O_EXCL` and `O_NOFOLLOW`, synced, renamed over it, and the directory synced.
 * @implNote A temporary file left by an earlier crash is removed first only when it is a regular file; a link in its place refuses the write.
 */
async function replaceNodeFile(path: string, text: string): Promise<void> {
  const temporary = `${path}.new`;
  const left = await lstat(temporary).catch(() => null);
  if (left && !left.isFile()) throw new Error(`${temporary} is not a regular file, so the node file is not rewritten`);
  if (left) await unlink(temporary);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o644);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r").catch(() => null);
  await directory?.sync().catch(() => undefined);
  await directory?.close();
}

/**
 * Rewrites the node file at `path` with the layout's policy for it, and reports whether it wrote.
 * @implNote A missing or unreadable file, one of another node, an array's, or one reached through a link is left alone: the node file is the
 * node's identity, which only a join creates.
 */
export async function followLayout(path: string, policy: LayoutNode): Promise<boolean> {
  if (await placeProblem(path)) return false;
  const file = await readNodeFile(path);
  if (file === null || file.node.id !== policy.id || isArrayFile(file)) return false;
  const followed = nodeFileFromLayout(file, policy);
  if (formatNodeFile(followed) === formatNodeFile(file)) return false;
  await replaceNodeFile(path, formatNodeFile(followed));
  return true;
}

/** An `apply` key of the `[node]` table, bare or quoted, and the same key dotted at the top level. */
const applyInNode = /^\s*(apply|"apply"|'apply')\s*=/;
const applyDotted = /^\s*(node|"node"|'node')\s*\.\s*(apply|"apply"|'apply')\s*=/;
const inlineNode = /^\s*(node|"node"|'node')\s*=\s*\{/;

/**
 * The node file's text without any `apply` key of its node, every other line as it was: a line in `[node]` and a dotted `node.apply` at
 * the top level; null when an inline `node = {...}` table holds it, which no line edit can take out safely.
 */
export function withoutApply(text: string): string | null {
  let table: string | null = "";
  let unsafe = false;
  const kept = text.split(/(?<=\n)/).filter((line) => {
    const bare = line.replace(/\r?\n$/, "");
    if (/^\s*\[/.test(bare)) table = /^\s*\[\s*node\s*\]\s*(#.*)?$/.test(bare) ? "node" : null;
    if (table === "" && inlineNode.test(bare) && /\bapply\b/.test(bare)) unsafe = true;
    return !((table === "node" && applyInNode.test(bare)) || (table === "" && applyDotted.test(bare)));
  });
  return unsafe ? null : kept.join("");
}

function looksLikeArray(text: string): boolean {
  return /^\s*kind\s*=\s*["']?array["']?\s*(#.*)?$/m.test(text) || /^\s*\[\s*array\s*\]/m.test(text);
}

/**
 * Takes the node's `apply` key out of the node file at `path`, whatever its value, and reports whether it did; nothing else of the file changes.
 * @implNote Line based, so a file that does not parse loses its `apply` line too; the executors read `apply = true` with any quoting. An
 * array's file, a link and a file without the key are left alone; an inline `node = {...}` holding it is reported, since a line edit could
 * break the table and this parser cannot rewrite one.
 */
export async function withdrawApply(path: string): Promise<boolean> {
  if (await placeProblem(path)) return false;
  const text = await readFile(path, "utf8");
  let file: NodeFile | null = null;
  try {
    file = parseNodeFile(text);
  } catch {
    file = null;
  }
  if (file ? isArrayFile(file) : looksLikeArray(text)) return false;
  const withdrawn = withoutApply(text);
  if (withdrawn === null) throw new Error(`${path} holds apply in an inline node table, which is not rewritten here; take it out by hand`);
  if (withdrawn === text) return false;
  await replaceNodeFile(path, withdrawn);
  return true;
}

/** The description of the array `id` with the highest revision among the given copies. */
export function newestDescription(id: string, files: (NodeFile | null)[]): NodeFile | null {
  return files
    .filter((file): file is NodeFile => file !== null && file.node.id === id && file.array !== undefined)
    .reduce<NodeFile | null>((best, file) => (best === null || file.array!.revision > best.array!.revision ? file : best), null);
}
