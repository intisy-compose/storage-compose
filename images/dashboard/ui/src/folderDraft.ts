import type { FolderSettings, NewFolder } from "../../src/api/types.js";
import type { FolderDraft } from "./state.js";

export function draftOf(settings: FolderSettings): FolderDraft {
  return { id: settings.id, label: settings.label, path: settings.path, type: settings.type, paused: settings.paused };
}

/**
 * The new folder as sent: ID, label and path always, the other settings only where they differ from the offered defaults.
 * @implNote The offered label is the directory's name, not Syncthing's default (empty), so it is always sent like the ID.
 */
export function newFolderBody(offered: FolderSettings, draft: FolderDraft): NewFolder {
  const defaults = draftOf(offered);
  return {
    id: draft.id.trim(),
    label: draft.label,
    path: draft.path.trim(),
    ...(draft.type !== defaults.type ? { type: draft.type } : {}),
    ...(draft.paused !== defaults.paused ? { paused: draft.paused } : {}),
  };
}
