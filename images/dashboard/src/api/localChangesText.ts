import type { FolderType, Versioning } from "./types.js";
import { versioningWords } from "./versioningText.js";

/** Revert undoes what was changed on a receive only node; override pushes a send only node's files over what other devices changed. */
export type LocalChangesAction = "revert" | "override";

/** The folder type each action is for; Syncthing offers neither on any other. */
export const localChangesFolderType: Record<LocalChangesAction, FolderType> = { revert: "receiveonly", override: "sendonly" };

function itemCount(count: number | null): string {
  if (count === null) return "an unknown number of items";
  return `${count.toLocaleString("en-US")} ${count === 1 ? "item" : "items"}`;
}

/** What a revert deletes or replaces, and whether the folder's versioning keeps it, in the words the form and the server's refusals use. */
export function revertLossText(nodeName: string, folderName: string, changedHere: number | null, versioning: Versioning): string[] {
  const kept = versioning.type
    ? `Versioning is on for ${folderName} on ${nodeName} (${versioningWords(versioning)}), so Syncthing keeps what it deletes or replaces as that versioning keeps it.`
    : `Versioning is off for ${folderName} on ${nodeName}, so what is deleted or replaced cannot be restored.`;
  return [
    `${itemCount(changedHere)} changed on ${nodeName} will be lost: a file added here is deleted, and a file changed or deleted here is replaced by the version the other devices have.`,
    kept,
  ];
}

/** What an override replaces on the other devices, and that this node's versioning does not keep it. */
export function overrideLossText(nodeName: string, folderName: string, changedElsewhere: number | null, versioning: Versioning): string[] {
  return [
    `${itemCount(changedElsewhere)} that other devices changed will be lost: each device replaces its version with the one ${nodeName} has, and deletes what ${nodeName} does not have.`,
    `Each device keeps the versions it replaces only if its own copy of ${folderName} has versioning on; versioning on ${nodeName} (${versioningWords(versioning)}) does not keep them.`,
  ];
}

/** What a revert or override did, for Activity and the answer: `pc: reverted 2 items changed here in folder Test A`. */
export function localChangesDoneText(action: LocalChangesAction, nodeName: string, folderName: string, items: number | null, versioning: Versioning): string {
  const versioningText = `versioning ${versioningWords(versioning)}`;
  if (action === "revert") return `${nodeName}: reverted ${itemCount(items)} changed here in folder ${folderName}, deleted or replaced by the other devices' versions; ${versioningText}`;
  return `${nodeName}: overrode ${itemCount(items)} other devices changed in folder ${folderName} with ${nodeName}'s versions; ${versioningText} on ${nodeName}`;
}
