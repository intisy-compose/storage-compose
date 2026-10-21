import { element } from "./dom.js";
import { applyTheme } from "./preferences.js";
import { requestRender } from "./renderRequest.js";
import { type PageId, appState } from "./state.js";

const upcoming: Record<Exclude<PageId, "nodes" | "folders" | "attention" | "settings">, { title: string; summary: string }> = {
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

export function renderSettingsPage(): HTMLElement {
  const notice = appState.page === "settings" && appState.notice ? element("p", { className: `notice tone-text-${appState.notice.tone}` }, appState.notice.text) : null;
  return element(
    "div",
    { className: "page" },
    pageHeader("Settings", "Preferences for this browser. Host settings come with the layered sync."),
    element("div", { className: "settings-card" }, themeSetting(), notice),
    comingState(),
  );
}
