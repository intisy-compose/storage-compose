import { type PriorityInfo, topDirectoryDefault } from "./api/types.js";
import { type LayoutFolder, type SetupLayout, normaliseRelativePath, topDirectoryPath } from "./setupRepo.js";

export { topDirectoryDefault };

export interface PriorityOverride {
  path: string;
  priority: number;
  parent: number;
}

/** @implNote Case-insensitive, as `folderId()` is, so `Documents` and `documents` are one directory. */
function pathKey(relativePath: string): string {
  const normalised = normaliseRelativePath(relativePath);
  return normalised === topDirectoryPath ? "" : normalised.toLowerCase();
}

function parentKey(key: string): string | null {
  if (key === "") return null;
  const slash = key.lastIndexOf("/");
  return slash < 0 ? "" : key.slice(0, slash);
}

function entriesByKey(layout: SetupLayout | null): Map<string, LayoutFolder> {
  const entries = new Map<string, LayoutFolder>();
  for (const folder of layout?.folders ?? []) {
    const key = pathKey(folder.relativePath);
    if (!entries.has(key)) entries.set(key, folder);
  }
  return entries;
}

function inheritedAt(entries: Map<string, LayoutFolder>, key: string): Pick<PriorityInfo, "inherited" | "inheritedFrom"> {
  for (let ancestor = parentKey(key); ancestor !== null; ancestor = parentKey(ancestor)) {
    const entry = entries.get(ancestor);
    if (entry) return { inherited: entry.priority, inheritedFrom: entry.relativePath };
  }
  return { inherited: topDirectoryDefault, inheritedFrom: null };
}

function priorityOf(entries: Map<string, LayoutFolder>, key: string): PriorityInfo {
  const { inherited, inheritedFrom } = inheritedAt(entries, key);
  const setHere = entries.get(key)?.priority ?? null;
  if (setHere !== null) return { effective: setHere, setHere, inherited, inheritedFrom, source: "setup-repo", overridesParent: key !== "" && setHere !== inherited };
  return { effective: inherited, setHere, inherited, inheritedFrom, source: inheritedFrom === null ? "default" : "inherited", overridesParent: false };
}

/** `""` (or `.`) is the top directory; a path without an entry takes its nearest ancestor's. */
export function priorityAt(layout: SetupLayout | null, relativePath: string): PriorityInfo {
  return priorityOf(entriesByKey(layout), pathKey(relativePath));
}

function isBelow(key: string, ancestorKey: string): boolean {
  return ancestorKey === "" ? key !== "" : key.startsWith(`${ancestorKey}/`);
}

/** Every entry under the path whose priority differs from what it would inherit, by path. */
export function overridesBelow(layout: SetupLayout | null, relativePath: string): PriorityOverride[] {
  const entries = entriesByKey(layout);
  const ancestorKey = pathKey(relativePath);
  return [...entries]
    .filter(([key]) => isBelow(key, ancestorKey))
    .map(([key, entry]) => ({ entry, priority: priorityOf(entries, key) }))
    .filter(({ priority }) => priority.overridesParent)
    .map(({ entry, priority }) => ({ path: entry.relativePath, priority: entry.priority, parent: priority.inherited }))
    .sort((left, right) => left.path.localeCompare(right.path, undefined, { sensitivity: "base" }));
}
