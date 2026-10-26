import { element } from "./dom.js";
import { applyTheme } from "./preferences.js";
import { requestRender } from "./renderRequest.js";
import { appState } from "./state.js";

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
