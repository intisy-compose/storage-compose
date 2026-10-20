import { fetchNodes } from "./api.js";
import { element } from "./dom.js";
import { renderEmptyDetail, renderNodeDetail } from "./nodeDetail.js";
import { renderNodesPage } from "./nodesPage.js";
import { renderAttentionPage, renderSettingsPage, renderUpcomingPage } from "./otherPages.js";
import { applyTheme } from "./preferences.js";
import { onRenderRequested } from "./renderRequest.js";
import { renderMenu } from "./shell.js";
import { appState, locationFor, readLocation } from "./state.js";

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
  if (!data) return element("div", { className: "page loading" }, appState.loadError ? "" : "Loading nodes…");
  if (appState.page === "nodes") return renderNodesPage(data);
  if (appState.page === "attention") return renderAttentionPage(data);
  return renderUpcomingPage(appState.page);
}

function renderDetail(): HTMLElement | null {
  const data = appState.data;
  if (appState.page !== "nodes" || !data) return null;
  const node = data.nodes.find((candidate) => candidate.id === appState.selectedNodeId);
  return node ? renderNodeDetail(data, node) : renderEmptyDetail(data);
}

function render(): void {
  const focus = rememberFocus();
  const root = document.getElementById("app") as HTMLElement;
  const detailScroll = document.querySelector(".detail")?.scrollTop ?? 0;
  const mainScroll = document.querySelector(".main")?.scrollTop ?? 0;
  const detail = renderDetail();
  const hasSelection = appState.page === "nodes" && appState.selectedNodeId !== null && detail !== null;
  root.className = `app page-${appState.page}${hasSelection ? " has-selection" : ""}`;
  const regions: HTMLElement[] = [renderMenu(), element("main", { className: "main" }, connectionBanner(), renderPage())];
  if (detail) regions.push(element("aside", { className: "detail", attributes: { "aria-label": "Node detail" } }, detail));
  root.replaceChildren(...regions);
  const newDetail = document.querySelector(".detail");
  if (newDetail) newDetail.scrollTop = detailScroll;
  (document.querySelector(".main") as HTMLElement).scrollTop = mainScroll;
  restoreFocus(focus);
}

/** A poll must not rebuild a form the user is typing into or choosing from. */
function isEditingDetail(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLElement && active.closest(".detail, .settings-card") !== null && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName);
}

async function poll(): Promise<void> {
  try {
    appState.data = await fetchNodes();
    appState.lastLoaded = Date.now();
    appState.loadError = null;
  } catch (error) {
    appState.loadError = error instanceof Error ? error.message : String(error);
  }
  if (!isEditingDetail()) render();
}

function onLocationChange(): void {
  const previousNode = appState.selectedNodeId;
  const previousPage = appState.page;
  readLocation();
  if (previousNode !== appState.selectedNodeId || previousPage !== appState.page) {
    appState.openForm = null;
    appState.notice = null;
    appState.showCandidates = false;
  }
  render();
  if (previousNode !== appState.selectedNodeId) document.querySelector(".detail")?.scrollTo(0, 0);
}

function onKey(event: KeyboardEvent): void {
  if (event.key === "Escape" && appState.selectedNodeId && !isEditingDetail()) location.hash = locationFor("nodes");
}

applyTheme(appState.theme);
readLocation();
onRenderRequested(render);
window.addEventListener("hashchange", onLocationChange);
window.addEventListener("keydown", onKey);
render();
void poll();
setInterval(() => void poll(), pollMilliseconds);
