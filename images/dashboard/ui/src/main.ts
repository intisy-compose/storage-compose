import { activityScrollAnchor, renderActivityPage, restoreActivityScroll } from "./activityPage.js";
import type { NodesResponse } from "./api.js";
import { fetchActivity, fetchDeviceSettings, fetchDevices, fetchFolderDetail, fetchHostSettings, fetchNodeOptions, fetchNodes, fetchRequests, savedWriteCount } from "./api.js";
import { renderAttentionPage } from "./attentionPage.js";
import { renderDeviceDetail } from "./deviceDetail.js";
import { loadAddDeviceForm, renderAddDeviceForm } from "./addDeviceForm.js";
import { renderDeviceForm } from "./deviceForm.js";
import { element } from "./dom.js";
import { renderDriveDetail } from "./driveDetail.js";
import { folderRootPriority, renderExplorerDetail } from "./explorerDetail.js";
import { isNodeSelectorOpen, loadExplorer, placeAtFolder, renderExplorerPage } from "./explorerPage.js";
import { renderFolderDetail, renderFolderLoading, renderFolderNotFound } from "./folderDetail.js";
import { openEditFolderForm, renderEditFolderForm } from "./folderEditForm.js";
import { loadAddFolderForm, renderAddFolderForm } from "./folderForm.js";
import { isFormOpen } from "./forms.js";
import { renderItemNotFound } from "./itemNotFound.js";
import { renderEmptyDetail, renderNodeDetail } from "./nodeDetail.js";
import { renderNodesPage } from "./nodesPage.js";
import { applyTheme } from "./preferences.js";
import { coalesceWhileRunning, readUntilSettled } from "./pollGuard.js";
import { onRefreshRequested, onRenderRequested } from "./renderRequest.js";
import { forgetLastAnswer, renderRequestsPage } from "./requestsPage.js";
import { readableLocalNodes, renderSettingsPage } from "./settingsPage.js";
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
  if (appState.page === "requests") return renderRequestsPage();
  if (!data) return element("div", { className: "page loading" }, appState.loadError ? "" : "Loading nodes…");
  if (appState.page === "nodes") return renderNodesPage(data, appState.devices);
  return renderAttentionPage(data);
}

function renderFolderPanel(): HTMLElement {
  const folderId = appState.selectedFolderId;
  if (appState.addFolderForm) return renderAddFolderForm(appState.addFolderForm);
  if (!folderId) return renderExplorerDetail();
  const detail = appState.folderDetail?.summary.id === folderId ? appState.folderDetail : null;
  if (detail && appState.editFolderForm) return renderEditFolderForm(appState.editFolderForm, detail);
  if (detail) return renderFolderDetail(detail.summary, detail, folderRootPriority(folderId));
  return appState.folderDetailError ? renderFolderNotFound(folderId, appState.folderDetailError) : renderFolderLoading(folderId);
}

function renderDevicesPanel(data: NodesResponse): HTMLElement | null {
  const devices = appState.devices;
  const readError = devices === null ? appState.devicesError : null;
  if (appState.selectedDeviceKey !== null) {
    const device = devices?.devices.find((candidate) => candidate.key === appState.selectedDeviceKey);
    return devices && device ? renderDeviceDetail(data, devices, device) : renderItemNotFound("device", appState.selectedDeviceKey, devices !== null, readError);
  }
  if (appState.selectedDriveKey !== null) {
    const drive = devices?.drives.find((candidate) => candidate.key === appState.selectedDriveKey);
    return devices && drive ? renderDriveDetail(data, devices, drive) : renderItemNotFound("drive", appState.selectedDriveKey, devices !== null, readError);
  }
  return null;
}

function renderDetail(): HTMLElement | null {
  if (appState.page === "folders") return renderFolderPanel();
  const data = appState.data;
  if (appState.page !== "nodes" || !data) return null;
  const devicePanel = renderDevicesPanel(data);
  if (devicePanel) return devicePanel;
  const node = data.nodes.find((candidate) => candidate.id === appState.selectedNodeId);
  if (node && appState.deviceForm) return renderDeviceForm(node, appState.deviceForm);
  if (node && appState.addDeviceForm) return renderAddDeviceForm(node, appState.addDeviceForm);
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
  if (detail) regions.push(element("aside", { className: "detail", attributes: { "aria-label": appState.page === "folders" ? "Directory detail" : "Detail" } }, detail));
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
  return isEditingDetail() || isFormOpen() || isNodeSelectorOpen();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** An answer that started before a write was saved is read again, so a row the write changed never flicks back to how it was. */
function readAfterSavedWrites<T>(read: () => Promise<T>): Promise<T> {
  return readUntilSettled(read, savedWriteCount);
}

async function loadNodes(): Promise<void> {
  try {
    appState.data = await readAfterSavedWrites(fetchNodes);
    appState.lastLoaded = Date.now();
    appState.loadError = null;
  } catch (error) {
    appState.loadError = messageOf(error);
  }
}

async function loadDevices(): Promise<void> {
  try {
    appState.devices = await readAfterSavedWrites(fetchDevices);
    appState.devicesError = null;
  } catch (error) {
    appState.devicesError = messageOf(error);
  }
}

/** Reads the device once per opening, so a later read never moves what the form's changes are measured against. */
async function loadDeviceForm(): Promise<void> {
  const form = appState.deviceForm;
  if (!form || form.saved) return;
  try {
    const settings = await fetchDeviceSettings(form.nodeId, form.deviceId);
    if (form !== appState.deviceForm || form.saved) return;
    form.saved = settings;
    form.draft = structuredClone(settings);
    form.loadError = null;
  } catch (error) {
    form.loadError = messageOf(error);
  }
}

/** @implNote Waits for the nodes, as they say whether the form's node is this host's. */
async function loadAddDevice(nodesLoaded: Promise<void>): Promise<void> {
  const form = appState.addDeviceForm;
  if (!form) return;
  await nodesLoaded;
  await loadAddDeviceForm(form, appState.data?.nodes.find((node) => node.id === form.nodeId));
}

async function loadFolderDetail(): Promise<void> {
  const folderId = appState.selectedFolderId;
  if (!folderId) return;
  try {
    const detail = await fetchFolderDetail(folderId);
    if (folderId !== appState.selectedFolderId) return;
    appState.folderDetail = detail;
    appState.folderDetailError = null;
    if (appState.editFolderForm) openEditFolderForm(appState.editFolderForm, detail);
  } catch (error) {
    if (folderId === appState.selectedFolderId) appState.folderDetailError = messageOf(error);
  }
}

/** @implNote Waits for the nodes, as they say which nodes can take a folder. */
async function loadAddFolder(nodesLoaded: Promise<void>): Promise<void> {
  const form = appState.addFolderForm;
  if (!form) return;
  await nodesLoaded;
  await loadAddFolderForm(form);
}

async function loadFolders(nodesLoaded: Promise<void>): Promise<void> {
  await Promise.all([loadExplorer(), loadFolderDetail(), loadAddFolder(nodesLoaded)]);
  const detail = appState.folderDetail;
  if (detail?.summary.id === appState.selectedFolderId && placeAtFolder(detail)) await loadExplorer();
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

async function loadRequests(): Promise<void> {
  try {
    appState.requests = await readAfterSavedWrites(fetchRequests);
    appState.requestsError = null;
  } catch (error) {
    appState.requestsError = messageOf(error);
  }
}

async function loadHostSettings(): Promise<void> {
  try {
    appState.hostSettings = await fetchHostSettings();
    appState.hostSettingsError = null;
  } catch (error) {
    appState.hostSettingsError = messageOf(error);
  }
}

async function loadNodeOptions(nodeId: string): Promise<void> {
  try {
    appState.nodeOptions.set(nodeId, await fetchNodeOptions(nodeId));
  } catch (error) {
    appState.nodeOptions.set(nodeId, { error: messageOf(error) });
  }
}

/** @implNote Waits for the nodes, as they say which nodes are this host's. */
async function loadSettings(nodesLoaded: Promise<void>): Promise<void> {
  await Promise.all([loadHostSettings(), nodesLoaded.then(() => Promise.all(readableLocalNodes().map((node) => loadNodeOptions(node.id))))]);
}

/** The current page's own data besides the nodes every page shows in its menu; `nodesLoaded` settles when a running nodes read does. */
async function loadPageData(nodesLoaded: Promise<void> = Promise.resolve()): Promise<void> {
  if (appState.page === "nodes") await Promise.all([loadDevices(), loadDeviceForm(), loadAddDevice(nodesLoaded)]);
  if (appState.page === "folders") await loadFolders(nodesLoaded);
  if (appState.page === "activity") await loadActivity();
  if (appState.page === "requests") await loadRequests();
  if (appState.page === "settings") await loadSettings(nodesLoaded);
}

const poll = coalesceWhileRunning(async () => {
  const nodesLoaded = loadNodes();
  await Promise.all([nodesLoaded, loadPageData(nodesLoaded)]);
  if (!isInUse()) render();
});

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
  if (previousPage === "requests" && appState.page !== "requests") forgetLastAnswer();
  const isNewItem = previousItem !== selectedItemId() || previousPage !== appState.page;
  if (isNewItem) {
    appState.openForm = null;
    appState.notice = null;
    appState.showCandidates = false;
    appState.folderDetailError = null;
    appState.itemList = null;
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
onRefreshRequested(() => void poll());
window.addEventListener("hashchange", onLocationChange);
window.addEventListener("keydown", onKey);
render();
void poll();
setInterval(() => void poll(), pollMilliseconds);
