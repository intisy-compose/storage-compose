import type { NodesResponse } from "./api.js";
import { button, element } from "./dom.js";
import { warningBanner } from "./nodesPage.js";
import { applyTheme, storeInventoryItemUrl } from "./preferences.js";
import { requestRender } from "./renderRequest.js";
import { type PageId, appState } from "./state.js";

const upcoming: Record<Exclude<PageId, "nodes" | "attention" | "settings">, { title: string; summary: string }> = {
  folders: {
    title: "Folders",
    summary: "The whole folder tree with priorities, where each folder is kept, conflicts and the Syncthing folder settings.",
  },
  activity: {
    title: "Activity",
    summary: "One timeline of parity jobs, Syncthing events, hand-offs and notifications, filtered by node or folder.",
  },
  requests: {
    title: "Requests",
    summary: "Devices and folders asking to join, accepted or refused here.",
  },
};

function pageHeader(title: string, summary: string): HTMLElement {
  return element("header", { className: "page-header" }, element("h1", {}, title), element("p", { className: "page-summary" }, summary));
}

function comingState(): HTMLElement {
  return element(
    "div",
    { className: "coming" },
    element("strong", {}, "Comes with the layered sync"),
    element("p", {}, "This page is built together with priorities, thresholds and hand-off. Nodes works today."),
  );
}

export function renderUpcomingPage(page: keyof typeof upcoming): HTMLElement {
  const { title, summary } = upcoming[page];
  return element("div", { className: "page" }, pageHeader(title, summary), comingState());
}

export function renderAttentionPage(response: NodesResponse): HTMLElement {
  const warnings = response.warnings;
  return element(
    "div",
    { className: "page" },
    pageHeader("Attention", "Everything that needs a person, newest first. Each entry opens its node."),
    warnings.length
      ? element("div", { className: "warnings attention-list" }, ...warnings.map(warningBanner))
      : element("div", { className: "coming" }, element("strong", {}, "Nothing needs attention"), element("p", {}, "Every node is healthy.")),
    element("p", { className: "muted small" }, "Sync failures, conflicts and hand-offs join this list with the layered sync."),
  );
}

function themeSetting(): HTMLElement {
  const chooser = element("select", { attributes: { id: "setting-theme" } });
  for (const [value, label] of [["system", "Follow the system"], ["light", "Light"], ["dark", "Dark"]]) {
    const option = element("option", {}, label);
    option.value = value;
    chooser.append(option);
  }
  chooser.value = appState.theme;
  chooser.addEventListener("change", () => {
    appState.theme = chooser.value as typeof appState.theme;
    applyTheme(appState.theme);
    requestRender();
  });
  return element("label", { className: "setting" }, element("span", {}, "Theme"), chooser);
}

function inventorySetting(): HTMLElement {
  const input = element("input", {
    attributes: { id: "setting-inventory", type: "url", placeholder: "https://inventree.example/web/stock?search={asset}" },
  });
  input.value = appState.inventoryItemUrl;
  const save = button("Save", () => {
    appState.inventoryItemUrl = input.value.trim();
    storeInventoryItemUrl(appState.inventoryItemUrl);
    appState.notice = { text: "Saved for this browser.", tone: "ok" };
    requestRender();
  });
  const serverValue = appState.data?.settings?.inventoryItemUrl;
  return element(
    "div",
    { className: "setting" },
    element("span", {}, "Inventory link (optional)"),
    element("div", { className: "setting-input" }, input, save),
    element(
      "small",
      { className: "muted" },
      serverValue
        ? `The host links assets to ${serverValue}; a value here overrides it in this browser.`
        : "Drive assets link to your inventory when set. {asset} is replaced by the asset code.",
    ),
  );
}

export function renderSettingsPage(): HTMLElement {
  const notice = appState.page === "settings" && appState.notice ? element("p", { className: `notice tone-text-${appState.notice.tone}` }, appState.notice.text) : null;
  return element(
    "div",
    { className: "page" },
    pageHeader("Settings", "Preferences for this browser. Host settings come with the layered sync."),
    element("div", { className: "settings-card" }, themeSetting(), inventorySetting(), notice),
    comingState(),
  );
}
