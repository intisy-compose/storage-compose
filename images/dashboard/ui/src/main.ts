import { activityScrollAnchor, renderActivityPage, restoreActivityScroll } from "./activityPage.js";
import { fetchActivity, fetchFolderDetail, fetchNodes } from "./api.js";
import { renderAttentionPage } from "./attentionPage.js";
import { element } from "./dom.js";
import { folderRootPriority, renderExplorerDetail } from "./explorerDetail.js";
import { loadExplorer, placeAtFolder, renderExplorerPage } from "./explorerPage.js";
import { renderFolderDetail, renderFolderLoading, renderFolderNotFound } from "./folderDetail.js";
import { isFormOpen } from "./forms.js";
import { renderEmptyDetail, renderNodeDetail } from "./nodeDetail.js";
import { renderNodesPage } from "./nodesPage.js";
import { renderSettingsPage, renderUpcomingPage } from "./otherPages.js";
import { applyTheme } from "./preferences.js";
import { onRenderRequested } from "./renderRequest.js";
import { renderMenu } from "./shell.js";
import { activityPageSize, appState, explorerLocation, locationFor, readLocation, selectedItemId } from "./state.js";

const pollMilliseconds = 5000;

interface FocusMemory {
  id: string;
  selectionStart: number | null;
}

function rememberFocus(): FocusMemory | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !active.id) return null;
  const selectionStart = active instanceof HTMLInputElement ? active.selectionStart : null;
  return { id: active.id, selectionStart };
}

function restoreFocus(memory: FocusMemory | null): void {
  if (!memory) return;
  const target = document.getElementById(memory.id);
  if (!target) return;
  target.focus();
  if (target instanceof HTMLInputElement && memory.selectionStart !== null) target.setSelectionRange(memory.selectionStart, memory.selectionStart);
}

function connectionBanner(): HTMLElement | null {
  if (!appState.loadError) return null;
  const since = appState.lastLoaded ? ` Showing what it said at ${new Date(appState.lastLoaded).toLocaleTimeString()}.` : "";
  return element("div", { className: "warning level-error connection-lost" }, `The dashboard is not answering.${since}`);
}

function renderPage(): HTMLElement {
  const data = appState.data;
  if (appState.page === "settings") return renderSettingsPage();
  if (appState.page === "folders") return renderExplorerPage();
  if (appState.page === "activity") return renderActivityPage(activityActions);
  if (!data) return element("div", { className: "page loading" }, appState.loadError ? "" : "Loading nodes…");
  if (appState.page === "nodes") return renderNodesPage(data);
  if (appState.page === "attention") return renderAttentionPage(data);
  return renderUpcomingPage(appState.page);
}

function renderFolderPanel(): HTMLElement {
  const folderId = appState.selectedFolderId;
  if (!folderId) return renderExplorerDetail();
  const detail = appState.folderDetail?.summary.id === folderId ? appState.folderDetail : null;
  if (detail) return renderFolderDetail(detail.summary, detail, folderRootPriority(folderId));
  return appState.folderDetailError ? renderFolderNotFound(folderId, appState.folderDetailError) : renderFolderLoading(folderId);
}

function renderDetail(): HTMLElement | null {
  if (appState.page === "folders") return renderFolderPanel();
  const data = appState.data;
  if (appState.page !== "nodes" || !data) return null;
  const node = data.nodes.find((candidate) => candidate.id === appState.selectedNodeId);
  return node ? renderNodeDetail(data, node) : renderEmptyDetail(data);
}

function render(): void {
  const focus = rememberFocus();
  const root = document.getElementById("app") as HTMLElement;
  const detailScroll = document.querySelector(".detail")?.scrollTop ?? 0;
  const oldMain = document.querySelector<HTMLElement>(".main");
  const mainScroll = oldMain?.scrollTop ?? 0;
  const activityAnchor = oldMain && appState.page === "activity" ? activityScrollAnchor(oldMain) : null;
  const detail = renderDetail();
  const hasDetail = appState.page === "nodes" || appState.page === "folders";
  const hasSelection = hasDetail && selectedItemId() !== null && detail !== null;
  root.className = `app page-${appState.page}${hasDetail ? " with-detail" : ""}${hasSelection ? " has-selection" : ""}`;
  const regions: HTMLElement[] = [renderMenu(), element("main", { className: "main" }, connectionBanner(), renderPage())];
  if (detail) regions.push(element("aside", { className: "detail", attributes: { "aria-label": appState.page === "folders" ? "Directory detail" : "Node detail" } }, detail));
  root.replaceChildren(...regions);
  const newDetail = document.querySelector(".detail");
  if (newDetail) newDetail.scrollTop = detailScroll;
  const main = document.querySelector(".main") as HTMLElement;
  main.scrollTop = mainScroll;
  restoreActivityScroll(main, activityAnchor);
  restoreFocus(focus);
}

/** A poll must not rebuild a form the user is typing into or choosing from. */
function isEditingDetail(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLElement && active.closest(".detail, .settings-card") !== null && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName);
}

function isInUse(): boolean {
  return isEditingDetail() || isFormOpen();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadNodes(): Promise<void> {
  try {
    appState.data = await fetchNodes();
    appState.lastLoaded = Date.now();
    appState.loadError = null;
  } catch (error) {
    appState.loadError = messageOf(error);
  }
}

async function loadFolderDetail(): Promise<void> {
  const folderId = appState.selectedFolderId;
  if (!folderId) return;
  try {
    const detail = await fetchFolderDetail(folderId);
    if (folderId !== appState.selectedFolderId) return;
    appState.folderDetail = detail;
    appState.folderDetailError = null;
  } catch (error) {
    if (folderId === appState.selectedFolderId) appState.folderDetailError = messageOf(error);
  }
}

async function loadFolders(): Promise<void> {
  await Promise.all([loadExplorer(), loadFolderDetail()]);
  const detail = appState.folderDetail;
  if (detail?.summary.id === appState.selectedFolderId && placeAtFolder(detail.summary)) await loadExplorer();
}

async function loadActivity(): Promise<void> {
  const filters = appState.activityFilters;
  const limit = appState.activityLimit;
  try {
    const activity = await fetchActivity(filters, limit);
    if (filters !== appState.activityFilters || limit !== appState.activityLimit) return;
    appState.activity = activity;
    appState.activityError = null;
  } catch (error) {
    appState.activityError = messageOf(error);
  }
}

/** The current page's own data besides the nodes every page shows in its menu. */
async function loadPageData(): Promise<void> {
  if (appState.page === "folders") await loadFolders();
  if (appState.page === "activity") await loadActivity();
}

async function poll(): Promise<void> {
  await Promise.all([loadNodes(), loadPageData()]);
  if (!isInUse()) render();
}

async function refreshPage(): Promise<void> {
  await loadPageData();
  if (!isInUse()) render();
}

const activityActions = {
  /** @implNote Renders even while the chosen filter keeps focus, which the poll waits out, so the new answer shows at once. */
  onFiltersChanged: () => {
    appState.activityLimit = activityPageSize;
    render();
    void loadPageData().then(render);
  },
  onMore: () => {
    appState.activityLimit += activityPageSize;
    void refreshPage();
  },
};

function onLocationChange(): void {
  const previousItem = selectedItemId();
  const previousPage = appState.page;
  readLocation();
  const isNewItem = previousItem !== selectedItemId() || previousPage !== appState.page;
  if (isNewItem) {
    appState.openForm = null;
    appState.notice = null;
    appState.showCandidates = false;
    appState.folderDetailError = null;
  }
  render();
  if (previousItem !== selectedItemId()) document.querySelector(".detail")?.scrollTo(0, 0);
  if (appState.page === "folders") void loadPageData().then(render);
  else if (isNewItem) void refreshPage();
}

function closeSelection(): void {
  if (appState.page !== "folders") {
    location.hash = locationFor(appState.page);
    return;
  }
  appState.explorer.selectedPath = null;
  if (appState.selectedFolderId) location.hash = explorerLocation(null);
  else render();
}

function onKey(event: KeyboardEvent): void {
  if (event.key === "Escape" && selectedItemId() && !isInUse()) closeSelection();
}

applyTheme(appState.theme);
readLocation();
onRenderRequested(render);
window.addEventListener("hashchange", onLocationChange);
window.addEventListener("keydown", onKey);
render();
void poll();
setInterval(() => void poll(), pollMilliseconds);
