import { ignoreLinesOf } from "../../src/api/ignorePatterns.js";
import type { FolderSettings, NewFolder, Versioning, VersioningType } from "../../src/api/types.js";
import { type VersioningParam, versioningParamKeys } from "../../src/api/versioningText.js";
import type { FolderDraft } from "./state.js";

export function draftOf(settings: FolderSettings, ignores: readonly string[] = []): FolderDraft {
  return { id: settings.id, label: settings.label, path: settings.path, type: settings.type, paused: settings.paused, ignores: ignores.join("\n") };
}

/** Whether the typed patterns differ from the node's file as last read or saved; nothing is unsaved before it was read. */
export function areIgnoresUnsaved(text: string, opened: readonly string[] | null): boolean {
  return opened !== null && !isSameLines(ignoreLinesOf(text), opened);
}

function isSameLines(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

/**
 * The explorer's tree path of a folder path the node answered, or null when it is not below `root`.
 * @implNote The server sends a new folder's path as the root followed by the node's separator, so a prefix match suffices.
 */
export function treePathOf(path: string, root: string): string | null {
  const base = root.replace(/[\\/]+$/, "");
  if (!root || path === root || path === base) return root ? "" : null;
  if (!path.startsWith(base) || !/^[\\/]/.test(path.slice(base.length))) return null;
  return path.slice(base.length).split(/[\\/]+/).filter(Boolean).join("/");
}

/**
 * The new folder as sent: ID, label and path always, the other settings only where they differ from the offered defaults;
 * ignore patterns left as offered are not sent, so the node applies its own defaults.
 * @implNote The offered label is the directory's name, not Syncthing's default (empty), so it is always sent like the ID.
 */
export function newFolderBody(offered: FolderSettings, draft: FolderDraft, offeredIgnores: readonly string[] = []): NewFolder {
  const defaults = draftOf(offered);
  const ignores = ignoreLinesOf(draft.ignores);
  return {
    id: draft.id.trim(),
    label: draft.label,
    path: draft.path.trim(),
    ...(draft.type !== defaults.type ? { type: draft.type } : {}),
    ...(draft.paused !== defaults.paused ? { paused: draft.paused } : {}),
    ...(isSameLines(ignores, offeredIgnores) ? {} : { ignores }),
  };
}

/** What Syncthing's own page offers for a newly chosen versioning type; shown in the fields, where the person changes them. */
const syncthingVersioningDefaults: Record<VersioningParam, string> = { cleanoutDays: "0", keep: "5", maxAge: "31536000", command: "" };

/**
 * The draft's versioning once `type` is chosen: the saved versioning when it is the saved type, otherwise the type's params
 * as typed so far, else as saved, else Syncthing's defaults; the cleanup interval and versions path carry over.
 */
export function versioningOfType(saved: Versioning, draft: Versioning, type: VersioningType): Versioning {
  if (type === saved.type) return structuredClone(saved);
  const params = Object.fromEntries(versioningParamKeys[type].map((key) => [key, draft.params[key] ?? saved.params[key] ?? syncthingVersioningDefaults[key]]));
  return { type, params, cleanupIntervalS: draft.cleanupIntervalS, fsPath: type === "" ? "" : draft.fsPath };
}
