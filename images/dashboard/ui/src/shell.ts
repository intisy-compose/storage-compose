import { element } from "./dom.js";
import { icon } from "./icons.js";
import { applyTheme, nextTheme } from "./preferences.js";
import { requestRender } from "./renderRequest.js";
import { type PageId, appState, locationFor } from "./state.js";

interface MenuEntry {
  page: PageId;
  label: string;
}

const menuEntries: MenuEntry[] = [
  { page: "nodes", label: "Nodes" },
  { page: "folders", label: "Folders" },
  { page: "attention", label: "Attention" },
  { page: "activity", label: "Activity" },
  { page: "requests", label: "Requests" },
  { page: "settings", label: "Settings" },
];

const themeLabels = { system: "Theme: system", light: "Theme: light", dark: "Theme: dark" };

function attentionCount(): number {
  return appState.data?.warnings.filter((warning) => warning.level !== "info").length ?? 0;
}

function badgeFor(page: PageId): HTMLElement | null {
  if (page !== "attention") return null;
  const count = attentionCount();
  return count > 0 ? element("span", { className: "badge" }, String(count)) : null;
}

function menuLink(entry: MenuEntry): HTMLElement {
  const isCurrent = appState.page === entry.page;
  const link = element(
    "a",
    { className: isCurrent ? "menu-link current" : "menu-link", attributes: { href: locationFor(entry.page) } },
    icon(entry.page),
    element("span", { className: "menu-label" }, entry.label),
    badgeFor(entry.page),
  );
  if (isCurrent) link.setAttribute("aria-current", "page");
  return link;
}

function themeButton(): HTMLElement {
  const toggle = element(
    "button",
    { className: "menu-link theme-toggle", title: "Switch between system, light and dark", attributes: { type: "button" } },
    icon("theme"),
    element("span", { className: "menu-label" }, themeLabels[appState.theme]),
  );
  toggle.addEventListener("click", () => {
    appState.theme = nextTheme(appState.theme);
    applyTheme(appState.theme);
    requestRender();
  });
  return toggle;
}

export function renderMenu(): HTMLElement {
  const hostName = appState.data?.host.name ?? "";
  return element(
    "nav",
    { className: "menu", attributes: { "aria-label": "Pages" } },
    element(
      "div",
      { className: "brand" },
      element("span", { className: "brand-mark" }),
      element("span", { className: "brand-text" }, element("strong", {}, "Storage"), element("small", {}, hostName)),
    ),
    element("div", { className: "menu-links" }, ...menuEntries.map(menuLink)),
    element("div", { className: "menu-footer" }, themeButton()),
  );
}
