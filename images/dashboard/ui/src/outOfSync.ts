import type { FolderCopy } from "./api.js";
import { formatBytes, formatPercent, normaliseCompletion, plural } from "./format.js";

type NeedFields = Pick<FolderCopy, "needTotalItems" | "needBytes" | "completion">;

/** Every item the copy's node still has to fetch, directories and deletes included, as the override form counts them. */
export function outOfSyncCount(copy: NeedFields): number {
  return copy.needTotalItems;
}

export function outOfSyncText(copy: NeedFields): string {
  const count = outOfSyncCount(copy);
  if (!count && !copy.needBytes) return "nothing";
  return `${plural(count, "item")}, ${formatBytes(copy.needBytes)} (${formatPercent(normaliseCompletion(copy.completion))} done)`;
}
