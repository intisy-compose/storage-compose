import { type FolderItem, type ItemsPage, type NeedItem, type NeedStage, type RemoteNeedPage, defaultItemsPerPage, fetchNeedItems, fetchRemoteNeed, maxItemsPerPage } from "./api.js";
import { button, element } from "./dom.js";
import { formatBytes, formatCount, formatDate, plural } from "./format.js";
import { requestRender } from "./renderRequest.js";
import { type ItemListState, type ItemListTarget, appState } from "./state.js";

const pageSizes = [...new Set([25, defaultItemsPerPage, maxItemsPerPage])].sort((left, right) => left - right);

const stageTexts: Record<NeedStage, string> = { progress: "being fetched", queued: "next", rest: "waiting" };

export function isItemListOpen(target: ItemListTarget): boolean {
  const list = appState.itemList;
  return list !== null && list.nodeId === target.nodeId && list.folderId === target.folderId && list.deviceId === target.deviceId;
}

function readPage(list: ItemListState) {
  if (list.deviceId === null) return fetchNeedItems(list.nodeId, list.folderId, list.page, list.perPage);
  return fetchRemoteNeed(list.nodeId, list.folderId, list.deviceId, list.page, list.perPage);
}

/** @implNote An answer for a page the person has since left, or for a list since closed, is dropped. */
async function load(list: ItemListState): Promise<void> {
  const asked = { page: list.page, perPage: list.perPage };
  list.loading = true;
  requestRender();
  const answer = await readPage(list);
  if (appState.itemList !== list || list.page !== asked.page || list.perPage !== asked.perPage) return;
  list.answer = answer;
  list.loading = false;
  requestRender();
}

export function openItemList(target: ItemListTarget): void {
  const list: ItemListState = { ...target, page: 1, perPage: appState.itemsPerPage, loading: false, answer: null };
  appState.itemList = list;
  void load(list);
}

export function closeItemList(): void {
  appState.itemList = null;
  requestRender();
}

export function toggleItemList(target: ItemListTarget): void {
  if (isItemListOpen(target)) closeItemList();
  else openItemList(target);
}

function goToPage(list: ItemListState, page: number): void {
  list.page = page;
  void load(list);
}

function sizeText(item: FolderItem): string {
  return item.deleted ? "deleted" : formatBytes(item.size);
}

function itemRow(item: NeedItem | FolderItem): HTMLElement {
  const changedBy = item.modifiedBy ? `, by ${item.modifiedBy}` : "";
  return element(
    "li",
    { className: "item-row" },
    element("span", { className: `item-name${item.deleted ? " item-deleted" : ""}`, title: item.name }, item.name),
    element("small", { className: "item-meta" }, `${sizeText(item)}, changed ${formatDate(item.modified)}${changedBy}`),
    "stage" in item ? element("span", { className: `chip item-stage stage-${item.stage}` }, stageTexts[item.stage]) : null,
  );
}

function pageCount(total: number | null, perPage: number): number | null {
  return total === null ? null : Math.max(1, Math.ceil(total / perPage));
}

function sizeChoice(list: ItemListState): HTMLElement {
  const select = element("select", { attributes: { id: "item-list-per-page", "aria-label": "Items per page" } });
  for (const size of pageSizes) {
    const option = element("option", { attributes: { value: String(size) } }, `${size} a page`);
    option.selected = option.defaultSelected = size === list.perPage;
    select.append(option);
  }
  select.addEventListener("change", () => {
    appState.itemsPerPage = Number(select.value);
    list.perPage = appState.itemsPerPage;
    goToPage(list, 1);
  });
  return select;
}

function pager(list: ItemListState, page: ItemsPage<NeedItem | FolderItem>): HTMLElement {
  const pages = pageCount(page.total, list.perPage);
  const hasNext = pages === null ? page.items.length === list.perPage : list.page < pages;
  const previous = button("Previous", () => goToPage(list, list.page - 1), "button ghost");
  previous.disabled = list.loading || list.page <= 1;
  const next = button("Next", () => goToPage(list, list.page + 1), "button ghost");
  next.disabled = list.loading || !hasNext;
  const position = list.loading ? "Reading…" : pages === null ? `Page ${formatCount(list.page)}` : `Page ${formatCount(list.page)} of ${formatCount(pages)}`;
  const again = button("Read again", () => void load(list), "button ghost");
  again.disabled = list.loading;
  return element("div", { className: "item-pager" }, previous, element("span", { className: "muted" }, position), next, sizeChoice(list), again);
}

function totalText(list: ItemListState, page: ItemsPage<NeedItem | FolderItem>): string {
  if (page.total === null) return "How many in all could not be read.";
  const device = list.deviceId === null ? null : (page as RemoteNeedPage).device;
  return device ? `${device.name} still needs ${plural(page.total, "item")} of this folder.` : `${plural(page.total, "item")} still to fetch.`;
}

function readingText(): string {
  return "Reading the items… for a folder with many items Syncthing can take up to 30 s.";
}

function listBody(list: ItemListState): HTMLElement[] {
  const answer = list.answer;
  if (!answer) return [element("p", { className: "muted" }, readingText())];
  if (!answer.ok) {
    const isRefusal = answer.status >= 400 && answer.status < 500;
    return [element("p", { className: isRefusal ? "muted" : "tone-text-bad", attributes: { role: "status" } }, isRefusal ? `${answer.message}.` : `Could not be read: ${answer.message}`)];
  }
  const page = answer.value;
  if (!page.items.length) return [element("p", { className: "muted" }, list.page > 1 ? "No items on this page." : "Nothing is out of sync."), pager(list, page)];
  return [element("p", { className: "muted" }, totalText(list, page)), element("ol", { className: "item-list" }, ...page.items.map(itemRow)), pager(list, page)];
}

/** The open list under `title`, with any `controls` above its items, such as the folder a device's need is read for. */
export function itemListPanel(list: ItemListState, title: string, ...controls: HTMLElement[]): HTMLElement {
  return element(
    "div",
    { className: "item-list-panel" },
    element("div", { className: "item-list-head" }, element("strong", {}, title), button("Close", closeItemList, "button ghost")),
    ...controls,
    ...listBody(list),
  );
}
