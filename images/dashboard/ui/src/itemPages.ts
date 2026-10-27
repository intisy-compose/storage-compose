import type { FailedItem, FolderItem, ItemsPage, NeedItem, RemoteNeedPage } from "./api.js";
import { formatCount, plural } from "./format.js";
import type { ItemListState } from "./state.js";

type ShownPage = ItemsPage<NeedItem | FolderItem | FailedItem>;

export function pageCount(total: number | null, perPage: number): number | null {
  return total === null ? null : Math.max(1, Math.ceil(total / perPage));
}

/**
 * A full page may be followed by another even past the count: Syncthing pages the items being fetched or queued apart from the rest,
 * and lists them again among the rest of a later page.
 */
export function hasNextPage(list: Pick<ItemListState, "page" | "perPage">, page: ShownPage): boolean {
  const pages = pageCount(page.total, list.perPage);
  return page.items.length === list.perPage || (pages !== null && list.page < pages);
}

export function positionText(list: Pick<ItemListState, "page" | "perPage" | "loading">, total: number | null): string {
  if (list.loading) return "Reading…";
  const pages = pageCount(total, list.perPage);
  return pages !== null && list.page <= pages ? `Page ${formatCount(list.page)} of ${formatCount(pages)}` : `Page ${formatCount(list.page)}`;
}

export function totalText(list: Pick<ItemListState, "page" | "perPage" | "deviceId" | "failed">, page: ShownPage): string {
  if (page.total === null) return "How many in all could not be read.";
  if (list.failed) return `${plural(page.total, "item")} Syncthing could not sync.`;
  const device = list.deviceId === null ? null : (page as RemoteNeedPage).device;
  const total = device ? `${device.name} still needs ${plural(page.total, "item")} of this folder.` : `${plural(page.total, "item")} still to fetch.`;
  const pages = pageCount(page.total, list.perPage);
  return pages !== null && list.page > pages ? `${total} This page lies past that count: Syncthing lists items it is fetching or has queued again here.` : total;
}
