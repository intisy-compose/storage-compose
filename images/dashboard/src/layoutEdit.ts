import { createHash } from "node:crypto";
import type { PriorityBand } from "./api/types.js";
import { RequestError } from "./http.js";
import { type SetupLayout, folderId, highestPriority, normaliseRelativePath, parseLayout, topDirectoryPath } from "./setupRepo.js";

/** Names the layout text a page was read from, so a save made from an older read is refused instead of undoing what came in since. */
export function layoutVersion(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

interface Section {
  start: number;
  /** One past the section's last line, before any comment lines that lead into the next header. */
  end: number;
}

const bareKey = /^[A-Za-z0-9_-]+$/;

/** The dotted key of a table header line (`[folders."Documents/GitHub"]` is `["folders", "Documents/GitHub"]`), or null for any other line. */
export function headerKeys(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("[") || trimmed.startsWith("[[")) return null;
  const keys: string[] = [];
  let index = 1;
  while (index < trimmed.length) {
    while (trimmed[index] === " " || trimmed[index] === "\t") index++;
    const quote = trimmed[index];
    if (quote === '"' || quote === "'") {
      let end = index + 1;
      while (end < trimmed.length && trimmed[end] !== quote) end += quote === '"' && trimmed[end] === "\\" ? 2 : 1;
      const raw = trimmed.slice(index, end + 1);
      keys.push(quote === '"' ? (JSON.parse(raw) as string) : raw.slice(1, -1));
      index = end + 1;
    } else {
      const match = /^[A-Za-z0-9_-]+/.exec(trimmed.slice(index));
      if (!match) return null;
      keys.push(match[0]);
      index += match[0].length;
    }
    while (trimmed[index] === " " || trimmed[index] === "\t") index++;
    if (trimmed[index] === "]") return keys;
    if (trimmed[index] !== ".") return null;
    index++;
  }
  return null;
}

function tomlKey(key: string): string {
  return bareKey.test(key) ? key : JSON.stringify(key);
}

/** A TOML string: literal while it can be, so a Windows path stays readable, else basic. */
export function tomlString(value: string): string {
  if (value.includes("'") || /[\u0000-\u001f]/.test(value)) return JSON.stringify(value);
  return value.includes("\\") ? `'${value}'` : JSON.stringify(value);
}

function isHeader(line: string): boolean {
  return line.trim().startsWith("[");
}

function sectionAt(lines: string[], start: number): Section {
  let end = start + 1;
  while (end < lines.length && !isHeader(lines[end])) end++;
  while (end > start + 1 && (lines[end - 1].trim().startsWith("#") || lines[end - 1].trim() === "")) end--;
  return { start, end };
}

function findSection(lines: string[], matches: (keys: string[]) => boolean): Section | null {
  const start = lines.findIndex((line) => {
    const keys = headerKeys(line);
    return keys !== null && matches(keys);
  });
  return start < 0 ? null : sectionAt(lines, start);
}

/** Whether a value's text closes on its line: brackets outside strings balance. */
function bracketDepth(text: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quote) {
      if (quote === '"' && character === "\\") index++;
      else if (character === quote) quote = null;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === "#") break;
    else if (character === "[" || character === "{") depth++;
    else if (character === "]" || character === "}") depth--;
  }
  return depth;
}

/** The lines `key = ...` spans inside the section, a multi-line array included, or null when the key is not set there. */
function keyLines(lines: string[], section: Section, key: string): { from: number; to: number } | null {
  const pattern = new RegExp(`^\\s*(${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|"${key}")\\s*=`);
  for (let index = section.start + 1; index < section.end; index++) {
    if (!pattern.test(lines[index])) continue;
    let depth = bracketDepth(lines[index].slice(lines[index].indexOf("=") + 1));
    let to = index;
    while (depth > 0 && to + 1 < lines.length) depth += bracketDepth(lines[++to]);
    return { from: index, to };
  }
  return null;
}

/** Sets or, with null, removes `key` in the section in place, keeping the line's indent and alignment; returns how many lines the section grew by. */
function setKey(lines: string[], section: Section, key: string, value: string | null): number {
  const found = keyLines(lines, section, key);
  if (found) {
    const indent = lines[found.from].match(/^\s*/)?.[0] ?? "";
    const alignment = lines[found.from].match(/^\s*\S+(\s*)=/)?.[1] ?? " ";
    const replacement = value === null ? [] : [`${indent}${key}${alignment}= ${value}`];
    lines.splice(found.from, found.to - found.from + 1, ...replacement);
    return replacement.length - (found.to - found.from + 1);
  }
  if (value === null) return 0;
  lines.splice(section.end, 0, `${key} = ${value}`);
  return 1;
}

/** The section's own keys, as written. */
function keysOf(lines: string[], section: Section): string[] {
  return lines
    .slice(section.start + 1, section.end)
    .map((line) => /^\s*("[^"]*"|[A-Za-z0-9_-]+)\s*=/.exec(line)?.[1])
    .filter((key): key is string => key !== undefined)
    .map((key) => (key.startsWith('"') ? (JSON.parse(key) as string) : key));
}

function removeSection(lines: string[], section: Section): void {
  let start = section.start;
  let end = section.end;
  while (end < lines.length && lines[end].trim() === "") end++;
  if (end >= lines.length) while (start > 0 && lines[start - 1].trim() === "") start--;
  lines.splice(start, end - start);
}

/** Inserts a section after `after` (a line index, -1 for the end of the file), with one blank line around it. */
function insertSection(lines: string[], at: number, section: string[]): void {
  let position = at < 0 ? lines.length : at;
  while (position > 0 && lines[position - 1].trim() === "") position--;
  const block = [...(position > 0 ? [""] : []), ...section];
  if (position < lines.length) block.push("");
  lines.splice(position, 0, ...block);
}

function lastSectionEnd(lines: string[], matches: (keys: string[]) => boolean): number {
  let end = -1;
  lines.forEach((line, index) => {
    const keys = headerKeys(line);
    if (keys && matches(keys)) end = sectionAt(lines, index).end;
  });
  return end;
}

function joined(lines: string[]): string {
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** A priority edit's path as the layout keys it; `..` never names a place inside the tree. */
export function editablePath(path: unknown): string {
  if (typeof path !== "string") throw new RequestError(400, "the path is missing");
  if (path.split(/[\\/]+/).includes("..")) throw new RequestError(400, `${path} leaves the tree`);
  return normaliseRelativePath(path);
}

export function validPriority(value: unknown, what = "the priority"): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > highestPriority) throw new RequestError(400, `${what} must be a whole number from 0 to ${highestPriority}`);
  return value;
}

/** `created` and `removed` are a new or a dropped layout entry, which is a new or a dropped Syncthing folder (call 1); the top directory is never one. */
export type BoundaryChange = "created" | "removed" | null;

export interface PriorityEdit {
  text: string;
  path: string;
  boundary: BoundaryChange;
  folderId: string;
}

const priorityKeys = new Set(["priority", "category"]);

function isFolderSection(path: string): (keys: string[]) => boolean {
  return (keys) => keys.length === 2 && keys[0] === "folders" && normaliseRelativePath(keys[1]) === path;
}

/**
 * The layout with `path`'s priority set, or with null its entry removed so the path inherits again.
 * @implNote An entry that also sets ignores or versions is not removed by a clear, since that would drop them too; it is refused for a person to edit.
 * C-30's `category` stays beside a `priority` for drive-sync, which reads the same file; the priority wins for the layered sync.
 */
export function editFolderPriority(text: string, rawPath: unknown, priority: number | null): PriorityEdit {
  const path = editablePath(rawPath);
  if (priority !== null) validPriority(priority);
  const lines = text.split("\n");
  const section = findSection(lines, isFolderSection(path));
  const isTop = path === topDirectoryPath;
  const result = (boundary: BoundaryChange): PriorityEdit => ({ text: joined(lines), path, boundary: isTop ? null : boundary, folderId: folderId(path) });
  if (priority === null) {
    if (!section) return { text, path, boundary: null, folderId: folderId(path) };
    const others = keysOf(lines, section).filter((key) => !priorityKeys.has(key));
    if (others.length) throw new RequestError(409, `${path} also sets ${others.join(", ")} in the layout, so its entry is not removed here; edit it in the setup repo`);
    removeSection(lines, section);
    return result("removed");
  }
  if (section) {
    setKey(lines, section, "priority", String(priority));
    return result(null);
  }
  const header = `[folders.${tomlKey(path)}]`;
  insertSection(lines, lastSectionEnd(lines, (keys) => keys[0] === "folders"), [header, `priority = ${priority}`]);
  return result("created");
}

export interface NodePolicyChange {
  threshold?: number;
  assigned?: string[];
  pins?: Record<string, number>;
  apply?: boolean;
  enabled?: boolean;
  admitted?: boolean;
  /** When a person refused the node's admission; null takes a refusal back. */
  refused?: string | null;
}

/** A new `[nodes.<id>]` entry's identity, for an admission of a node the layout does not list. */
export interface NewNodeEntry {
  name: string;
  device: string;
}

function isNodeSection(nodeId: string, sub?: string): (keys: string[]) => boolean {
  return (keys) => keys[0] === "nodes" && keys[1] === nodeId && (sub === undefined ? keys.length === 2 : keys.length === 3 && keys[2] === sub);
}

function arrayText(values: string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

function setPins(lines: string[], nodeId: string, pins: Record<string, number>): void {
  const existing = findSection(lines, isNodeSection(nodeId, "pins"));
  if (existing) removeSection(lines, existing);
  const node = findSection(lines, isNodeSection(nodeId));
  if (!node) return;
  setKey(lines, node, "pins", null);
  const entries = Object.entries(pins).sort(([left], [right]) => left.localeCompare(right));
  if (!entries.length) return;
  const after = findSection(lines, isNodeSection(nodeId)) as Section;
  insertSection(lines, after.end, [`[nodes.${nodeId}.pins]`, ...entries.map(([path, value]) => `${JSON.stringify(path)} = ${value}`)]);
}

/**
 * The layout with the node's policy changed in place, its comments and order kept; with `create`, a node the layout does not list yet gets its entry.
 * @implNote Pins are rewritten as the node's `[nodes.<id>.pins]` table, sorted by path, so an inline `pins = {...}` is replaced by it.
 */
export function editNodePolicy(text: string, nodeId: string, change: NodePolicyChange, create?: NewNodeEntry): string {
  const lines = text.split("\n");
  let section = findSection(lines, isNodeSection(nodeId));
  if (!section) {
    if (!create) throw new RequestError(404, `the layout has no node ${nodeId}`);
    insertSection(lines, lastSectionEnd(lines, (keys) => keys[0] === "nodes"), [`[nodes.${nodeId}]`, `name = ${JSON.stringify(create.name)}`, `device = ${JSON.stringify(create.device)}`]);
    section = findSection(lines, isNodeSection(nodeId)) as Section;
  }
  const scalars: [string, string | null | undefined][] = [
    ["threshold", change.threshold === undefined ? undefined : String(change.threshold)],
    ["assigned", change.assigned === undefined ? undefined : arrayText(change.assigned)],
    ["admitted", change.admitted === undefined ? undefined : String(change.admitted)],
    ["apply", change.apply === undefined ? undefined : String(change.apply)],
    ["enabled", change.enabled === undefined ? undefined : String(change.enabled)],
    ["refused", change.refused === undefined ? undefined : change.refused === null ? null : JSON.stringify(change.refused)],
  ];
  for (const [key, value] of scalars) {
    if (value === undefined) continue;
    const grown = setKey(lines, section, key, value);
    section = { start: section.start, end: section.end + grown };
  }
  if (change.pins) setPins(lines, nodeId, change.pins);
  return joined(lines);
}

const bandNamePattern = /^[a-z][a-z0-9-]*$/;

/** The bands as a layout may hold them: named, distinct, whole numbers from 0, one of them from 0 so every priority has a band; highest first. */
export function validBands(value: unknown): PriorityBand[] {
  if (!Array.isArray(value) || value.length === 0) throw new RequestError(400, "the bands are missing");
  const bands = value.map((band, index) => {
    const entry = band as Partial<PriorityBand> | null;
    if (typeof entry?.name !== "string" || !bandNamePattern.test(entry.name)) throw new RequestError(400, `band ${index + 1}'s name must be lowercase letters, digits and dashes`);
    return { name: entry.name, from: validPriority(entry.from, `${entry.name}'s start`) };
  });
  if (new Set(bands.map((band) => band.name)).size !== bands.length) throw new RequestError(400, "two bands have the same name");
  if (new Set(bands.map((band) => band.from)).size !== bands.length) throw new RequestError(400, "two bands start at the same priority");
  if (!bands.some((band) => band.from === 0)) throw new RequestError(400, "one band must start at 0, so every priority has a band");
  return bands.sort((left, right) => right.from - left.from);
}

/** The layout with its `[bands]` table replaced in place, or added before the folders when it has none. */
export function editBands(text: string, bands: PriorityBand[]): string {
  const lines = text.split("\n");
  const section = findSection(lines, (keys) => keys.length === 1 && keys[0] === "bands");
  const body = ["[bands]", ...bands.map((band) => `${tomlKey(band.name)} = ${band.from}`)];
  if (section) {
    lines.splice(section.start, section.end - section.start, ...body);
    return joined(lines);
  }
  const firstFolder = lines.findIndex((line) => headerKeys(line)?.[0] === "folders");
  insertSection(lines, firstFolder, body);
  return joined(lines);
}

/** Refuses an edit whose result the layout parser does not read back as meant, so nothing unreadable is ever committed. */
export function checkedLayout(text: string, check: (layout: SetupLayout) => boolean, what: string): string {
  if (!check(parseLayout(text))) throw new Error(`the edited layout does not read back with ${what}`);
  return text;
}
