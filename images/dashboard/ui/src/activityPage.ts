import { type ActivityEntry, type ActivityFilters, type ActivityLevel, type ActivitySource, routineActivityTypes } from "./api.js";
import { button, element } from "./dom.js";
import { registerForm } from "./forms.js";
import { renderLogTab } from "./logTab.js";
import type { Tone } from "./nodeStatus.js";
import { type ActivityTab, appState, locationFor, logTabSegment } from "./state.js";

const sourceLabels: Record<ActivitySource, string> = { syncthing: "Syncthing", parity: "Parity", dashboard: "Dashboard" };
const levelTones: Record<ActivityLevel, Tone> = { error: "bad", warning: "warn", info: "muted" };

function distinct(values: (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function nodeName(nodeId: string): string {
  return appState.data?.nodes.find((node) => node.id === nodeId)?.name ?? nodeId;
}

function chooser(id: string, label: string, choices: [string, string][], current: string, choose: (value: string) => void): HTMLElement {
  const select = element("select", { attributes: { id, "aria-label": label } });
  for (const [value, text] of [["", label], ...choices]) {
    const option = element("option", {}, text);
    option.value = value;
    option.defaultSelected = value === current;
    select.append(option);
  }
  select.value = current;
  select.addEventListener("change", () => choose(select.value));
  return select;
}

function nodeChoices(entries: ActivityEntry[]): [string, string][] {
  const ids = distinct([...(appState.data?.nodes.map((node) => node.id) ?? []), ...entries.map((entry) => entry.nodeId), appState.activityFilters.node]);
  return ids.map((id): [string, string] => [id, nodeName(id)]).sort((left, right) => left[1].localeCompare(right[1]));
}

function folderChoices(entries: ActivityEntry[]): [string, string][] {
  const fromNodes = appState.data?.nodes.flatMap((node) => node.folders.map((folder) => folder.id)) ?? [];
  return distinct([...fromNodes, ...entries.map((entry) => entry.folderId), appState.activityFilters.folder])
    .sort((left, right) => left.localeCompare(right))
    .map((id): [string, string] => [id, id]);
}

const filterBarId = "activity-filters";
registerForm(filterBarId);

function routineToggle(onChange: () => void): HTMLElement {
  const toggle = element("input", { attributes: { type: "checkbox", id: "activity-routine" } });
  toggle.checked = appState.activityFilters.routine;
  toggle.defaultChecked = appState.activityFilters.routine;
  toggle.addEventListener("change", () => {
    appState.activityFilters = { ...appState.activityFilters, routine: toggle.checked };
    onChange();
  });
  return element("label", { className: "activity-routine" }, toggle, element("span", {}, "Scans and file changes"));
}

function filterBar(entries: ActivityEntry[], onChange: () => void): HTMLElement {
  const set = (name: "node" | "folder" | "source") => (value: string) => {
    appState.activityFilters = { ...appState.activityFilters, [name]: value };
    onChange();
  };
  const filters = appState.activityFilters;
  const sources = Object.entries(sourceLabels) as [string, string][];
  return element(
    "div",
    { className: "filter-bar activity-filters", attributes: { id: filterBarId } },
    chooser("activity-node", "All nodes", nodeChoices(entries), filters.node, set("node")),
    chooser("activity-folder", "All folders", folderChoices(entries), filters.folder, set("folder")),
    chooser("activity-source", "All sources", sources, filters.source, set("source")),
    routineToggle(onChange),
  );
}

/** The filters applied here too, so a changed filter shows at once and the next answer only refreshes it. */
function matchesFilters(entry: ActivityEntry, filters: ActivityFilters): boolean {
  const isRoutine = (routineActivityTypes as readonly string[]).includes(entry.type);
  return (
    (!filters.node || entry.nodeId === filters.node) &&
    (!filters.folder || entry.folderId === filters.folder) &&
    (!filters.source || entry.source === filters.source) &&
    (filters.routine || !isRoutine)
  );
}

function entryHref(entry: ActivityEntry): string | null {
  if (entry.folderId) return locationFor("folders", entry.folderId);
  return entry.nodeId ? locationFor("nodes", entry.nodeId) : null;
}

function dayOf(at: string): string {
  const date = new Date(at);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

function timeOf(at: string): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function entryRow(entry: ActivityEntry): HTMLElement {
  const href = entryHref(entry);
  const row = element(
    href ? "a" : "div",
    { className: `activity-entry level-${entry.level}`, attributes: { "data-entry": entry.id } },
    element("time", { className: "activity-time", attributes: { datetime: entry.at } }, timeOf(entry.at)),
    element("span", { className: `dot tone-${levelTones[entry.level]}`, title: entry.level }),
    element("span", { className: "activity-text" }, entry.text),
    element("span", { className: "chip activity-source" }, sourceLabels[entry.source]),
  );
  if (href) row.setAttribute("href", href);
  return row;
}

function timeline(entries: ActivityEntry[]): HTMLElement {
  const days = new Map<string, ActivityEntry[]>();
  for (const entry of entries) days.set(dayOf(entry.at), [...(days.get(dayOf(entry.at)) ?? []), entry]);
  return element(
    "div",
    { className: "activity-timeline" },
    ...[...days].map(([day, dayEntries]) =>
      element("section", { className: "activity-day" }, element("h2", { className: "group-heading" }, day), element("div", { className: "activity-list" }, ...dayEntries.map(entryRow))),
    ),
  );
}

function moreButton(shown: number, onMore: () => void): HTMLElement | null {
  if (shown < appState.activityLimit) return null;
  return element("div", { className: "activity-more" }, button("Show older entries", onMore));
}

export interface ActivityPageActions {
  onFiltersChanged: () => void;
  onMore: () => void;
}

const tabSummaries: Record<ActivityTab, string> = {
  events: "Syncthing events, parity jobs and the changes made here, newest first. Each entry opens its folder or node.",
  log: "Each node's Syncthing log and errors, its debug logging and its support bundle.",
};

function tabs(): HTMLElement {
  const tab = (value: ActivityTab, label: string, href: string) =>
    element("a", { className: value === appState.activityTab ? "segment on" : "segment", attributes: { href, "aria-current": value === appState.activityTab ? "page" : "false" } }, label);
  return element("nav", { className: "segmented activity-tabs", attributes: { "aria-label": "Activity views" } }, tab("events", "Events", locationFor("activity")), tab("log", "Log", locationFor("activity", logTabSegment)));
}

export function renderActivityPage(actions: ActivityPageActions): HTMLElement {
  const header = element("header", { className: "page-header" }, element("h1", {}, "Activity"), element("p", { className: "page-summary" }, tabSummaries[appState.activityTab]), tabs());
  if (appState.activityTab === "log") return element("div", { className: "page activity-page" }, header, renderLogTab());
  const response = appState.activity;
  if (!response) {
    const status = appState.activityError ? element("div", { className: "warning level-error" }, `Activity could not be read: ${appState.activityError}`) : element("p", { className: "muted" }, "Loading activity…");
    return element("div", { className: "page activity-page" }, header, status);
  }
  const entries = response.entries.filter((entry) => matchesFilters(entry, appState.activityFilters));
  const { node, folder, source } = appState.activityFilters;
  const isFiltered = Boolean(node || folder || source);
  const empty = isFiltered ? "Nothing matches the filters." : "Nothing has happened since the dashboard started.";
  return element(
    "div",
    { className: "page activity-page" },
    header,
    appState.activityError ? element("div", { className: "warning level-error connection-lost" }, `Activity could not be refreshed: ${appState.activityError}`) : null,
    filterBar(response.entries, actions.onFiltersChanged),
    entries.length ? timeline(entries) : element("p", { className: "empty-line" }, empty),
    moreButton(response.entries.length, actions.onMore),
  );
}

export interface ScrollAnchor {
  entryId: string;
  offset: number;
}

/** The first entry in view, so new entries arriving above it do not move what a person is reading. */
export function activityScrollAnchor(main: HTMLElement): ScrollAnchor | null {
  if (main.scrollTop === 0) return null;
  const top = main.getBoundingClientRect().top;
  const first = [...main.querySelectorAll<HTMLElement>(".activity-entry")].find((row) => row.getBoundingClientRect().bottom > top);
  return first?.dataset.entry ? { entryId: first.dataset.entry, offset: first.getBoundingClientRect().top - top } : null;
}

export function restoreActivityScroll(main: HTMLElement, anchor: ScrollAnchor | null): void {
  const row = anchor ? main.querySelector<HTMLElement>(`.activity-entry[data-entry="${CSS.escape(anchor.entryId)}"]`) : null;
  if (!anchor || !row) return;
  main.scrollTop += row.getBoundingClientRect().top - main.getBoundingClientRect().top - anchor.offset;
}
