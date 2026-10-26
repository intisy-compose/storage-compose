import { type SetupLayout, normaliseRelativePath, topDirectoryPath } from "./setupRepo.js";

export type NodeOs = "linux" | "windows";

export interface FolderPlacement {
  folderId: string;
  label: string;
  relativePath: string;
  placedBy: "root" | "layout" | "other";
}

export interface FolderToPlace {
  id: string;
  label: string;
  path: string;
}

export const otherFoldersGroup = "Other folders";

function resolvedSegments(path: string, os: NodeOs): string[] {
  const separated = os === "windows" ? path.replace(/\\/g, "/") : path;
  const resolved: string[] = [];
  for (const segment of separated.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") resolved.pop();
    else resolved.push(segment);
  }
  return resolved;
}

function sameSegment(left: string, right: string, os: NodeOs): boolean {
  return os === "windows" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * @implNote `..` may climb out of a Windows drive, so `F:\..\x` is outside `F:\` rather than quietly
 * clamped to `F:\x`; one rule on both systems keeps the judgement identical everywhere.
 * @returns null outside the root, "" for the root itself, otherwise the path below it with `/` separators.
 */
export function relativeToRoot(path: string, root: string, os: NodeOs): string | null {
  const rootSegments = resolvedSegments(root, os);
  const pathSegments = resolvedSegments(path, os);
  if (pathSegments.length < rootSegments.length) return null;
  const insideRoot = rootSegments.every((segment, index) => sameSegment(segment, pathSegments[index], os));
  return insideRoot ? pathSegments.slice(rootSegments.length).join("/") : null;
}

function layoutPathOf(layout: SetupLayout | null, folderId: string): string | null {
  const entry = layout?.folders.find((candidate) => candidate.id === folderId);
  if (!entry || entry.relativePath === topDirectoryPath) return null;
  return entry.relativePath;
}

function placeFolder(folder: FolderToPlace, root: string | null, os: NodeOs, layout: SetupLayout | null): FolderPlacement {
  const base = { folderId: folder.id, label: folder.label };
  const underRoot = root === null ? null : relativeToRoot(folder.path, root, os);
  if (underRoot !== null) return { ...base, relativePath: underRoot, placedBy: "root" };
  const fromLayout = layoutPathOf(layout, folder.id);
  if (fromLayout !== null) return { ...base, relativePath: fromLayout, placedBy: "layout" };
  return { ...base, relativePath: `${otherFoldersGroup}/${folder.label}`, placedBy: "other" };
}

export function placeFolders(folders: FolderToPlace[], root: string | null, os: NodeOs, layout: SetupLayout | null): FolderPlacement[] {
  return folders.map((folder) => placeFolder(folder, root, os, layout));
}

function treeSegments(relativePath: string): string[] {
  const normalised = normaliseRelativePath(relativePath);
  return normalised === topDirectoryPath ? [] : normalised.split("/");
}

function startsWithSegments(segments: string[], prefix: string[]): boolean {
  return prefix.length <= segments.length && prefix.every((segment, index) => segment.toLowerCase() === segments[index].toLowerCase());
}

/** The innermost folder holding the path, so a nested folder wins below its own root. */
export function folderAt(placements: FolderPlacement[], relativePath: string): { placement: FolderPlacement; inside: string } | null {
  const segments = treeSegments(relativePath);
  let best: { placement: FolderPlacement; depth: number } | null = null;
  for (const placement of placements) {
    const rootSegments = treeSegments(placement.relativePath);
    if (!startsWithSegments(segments, rootSegments)) continue;
    if (best === null || rootSegments.length > best.depth) best = { placement, depth: rootSegments.length };
  }
  return best && { placement: best.placement, inside: segments.slice(best.depth).join("/") };
}

/** The names of the directories under the path that lead to a folder root or a layout entry. */
export function directoriesAbove(placements: FolderPlacement[], layout: SetupLayout | null, relativePath: string): string[] {
  const parent = treeSegments(relativePath);
  const candidates = [...placements.map((placement) => placement.relativePath), ...(layout?.folders.map((entry) => entry.relativePath) ?? [])];
  const names = new Map<string, string>();
  for (const candidate of candidates) {
    const segments = treeSegments(candidate);
    if (segments.length <= parent.length || !startsWithSegments(segments, parent)) continue;
    const name = segments[parent.length];
    if (!names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
  }
  return [...names.values()].sort((left, right) => left.localeCompare(right));
}
