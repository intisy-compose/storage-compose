import { type DebugFacility, type LogLevel, type LogMessage, type StorageNode, clearNodeErrors, keptLogLines, fetchDebugFacilities, fetchNodeErrors, fetchNodeLog, logLevels, saveDebugFacilities, supportBundleUrl } from "./api.js";
import { button, element } from "./dom.js";
import { controlId, registerForm } from "./forms.js";
import type { Tone } from "./nodeStatus.js";
import { requestRender } from "./renderRequest.js";
import { type NodeLogState, appState, emptyNodeLog, logLocation } from "./state.js";

/** How many log lines the tab keeps while it reads only what is new; Syncthing itself keeps fewer. */
const mostLogLines = 2000;

const levelTones: Record<LogLevel, Tone> = { error: "bad", warning: "warn", info: "muted", debug: "muted" };
const levelChoices: Record<LogLevel, string> = { debug: "Debug and above", info: "Info and above", warning: "Warnings and errors", error: "Errors only" };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Nodes whose Syncthing the dashboard can read: this host's, and another host's through that host's dashboard. */
export function loggedNodes(): StorageNode[] {
  return (appState.data?.nodes ?? []).filter((node) => node.syncthing !== null && (node.local || node.dashboardUrl !== null));
}

function chosenNode(): StorageNode | null {
  const nodeId = appState.nodeLog?.nodeId;
  return loggedNodes().find((node) => node.id === nodeId) ?? null;
}

/** The tab's node: the one chosen before, else the first of this host's. */
function ensureNodeLog(): NodeLogState | null {
  const nodes = loggedNodes();
  const current = appState.nodeLog;
  if (!appState.data || (current && nodes.some((node) => node.id === current.nodeId))) return current;
  const first = nodes.find((node) => node.local) ?? nodes[0];
  appState.nodeLog = first ? emptyNodeLog(first.id, current?.minimumLevel) : null;
  return appState.nodeLog;
}

async function loadLog(state: NodeLogState): Promise<void> {
  const since = state.messages?.at(-1)?.when ?? null;
  try {
    const log = await fetchNodeLog(state.nodeId, since);
    if (appState.nodeLog !== state) return;
    state.messages = keptLogLines(since ? state.messages : null, log.messages, mostLogLines);
    state.logError = null;
  } catch (error) {
    if (appState.nodeLog === state) state.logError = messageOf(error);
  }
}

async function loadErrors(state: NodeLogState): Promise<void> {
  try {
    const errors = await fetchNodeErrors(state.nodeId);
    if (appState.nodeLog !== state) return;
    state.errors = errors;
    state.errorsError = null;
  } catch (error) {
    if (appState.nodeLog === state) state.errorsError = messageOf(error);
  }
}

async function loadDebug(state: NodeLogState): Promise<void> {
  try {
    const debug = await fetchDebugFacilities(state.nodeId);
    if (appState.nodeLog !== state) return;
    state.debug = debug;
    state.debugError = null;
  } catch (error) {
    if (appState.nodeLog === state) state.debugError = messageOf(error);
  }
}

/** Reads what is new in the chosen node's log, and its errors and facilities again; the poll calls it while the tab is open. */
export async function loadNodeLog(): Promise<void> {
  const state = ensureNodeLog();
  if (!state) return;
  await Promise.all([loadLog(state), loadErrors(state), loadDebug(state)]);
}

function chooseNode(nodeId: string): void {
  appState.nodeLog = emptyNodeLog(nodeId, appState.nodeLog?.minimumLevel);
  history.replaceState(null, "", logLocation(nodeId));
  requestRender();
  void loadNodeLog().then(requestRender);
}

const logControlsId = "node-log-controls";
registerForm(logControlsId);

function select(id: string, label: string, choices: [string, string][], current: string, choose: (value: string) => void): HTMLElement {
  const control = element("select", { attributes: { id, "aria-label": label } });
  for (const [value, text] of choices) {
    const option = element("option", {}, text);
    option.value = value;
    option.defaultSelected = value === current;
    control.append(option);
  }
  control.value = current;
  control.addEventListener("change", () => choose(control.value));
  return control;
}

function controls(state: NodeLogState): HTMLElement {
  const nodes = loggedNodes().map((node): [string, string] => [node.id, node.local ? node.name : `${node.name} (${node.host})`]);
  return element(
    "div",
    { className: "filter-bar activity-filters", attributes: { id: logControlsId } },
    select("node-log-node", "Node", nodes, state.nodeId, chooseNode),
    select("node-log-level", "Least level shown", logLevels.map((level): [string, string] => [level, levelChoices[level]]), state.minimumLevel, (value) => {
      state.minimumLevel = value as LogLevel;
      requestRender();
    }),
  );
}

function timeText(when: string): string {
  const date = new Date(when);
  return Number.isNaN(date.getTime()) ? when : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function logLine(message: LogMessage): HTMLElement {
  return element(
    "div",
    { className: `activity-entry log-line level-${message.level}` },
    element("time", { className: "activity-time", attributes: { datetime: message.when } }, timeText(message.when)),
    element("span", { className: `dot tone-${levelTones[message.level]}`, title: message.level }),
    element("span", { className: "activity-text" }, message.message),
    element("span", { className: "chip activity-source" }, message.level),
  );
}

function logSection(state: NodeLogState, node: StorageNode): HTMLElement {
  const heading = element("h2", { className: "group-heading" }, "Log");
  if (!state.messages) {
    const text = state.logError ? `The log could not be read: ${state.logError}` : "Reading the log…";
    return element("section", { className: "activity-day" }, heading, element("p", { className: state.logError ? "tone-text-bad" : "muted" }, text));
  }
  const least = logLevels.indexOf(state.minimumLevel);
  const shown = state.messages.filter((message) => logLevels.indexOf(message.level) >= least).reverse();
  const empty = state.messages.length ? `No line at ${levelChoices[state.minimumLevel].toLowerCase()} level.` : `${node.name}'s Syncthing keeps no log lines yet.`;
  return element(
    "section",
    { className: "activity-day" },
    heading,
    element("p", { className: "muted" }, `What ${node.name}'s Syncthing keeps of its log in memory, newest first.`),
    state.logError ? element("p", { className: "tone-text-bad" }, `The log could not be refreshed: ${state.logError}`) : null,
    shown.length ? element("div", { className: "activity-list" }, ...shown.map(logLine)) : element("p", { className: "empty-line" }, empty),
  );
}

function notice(state: NodeLogState): HTMLElement | null {
  return state.result ? element("p", { className: `notice tone-text-${state.result.tone}`, attributes: { role: "status" } }, state.result.text) : null;
}

async function runClear(state: NodeLogState, node: StorageNode): Promise<void> {
  state.busy = true;
  state.result = null;
  requestRender();
  const result = await clearNodeErrors(node.id);
  state.busy = false;
  if (result.ok) {
    state.errors = result.value;
    state.result = { text: `Cleared the errors of ${node.name}.`, tone: "ok" };
  } else state.result = { text: result.maybeSaved ? `${result.message}.` : `Not cleared: ${result.message}`, tone: result.maybeSaved ? "warn" : "bad" };
  requestRender();
}

function errorsSection(state: NodeLogState, node: StorageNode): HTMLElement {
  const heading = element("h2", { className: "group-heading" }, "Errors");
  if (!state.errors) {
    const text = state.errorsError ? `The errors could not be read: ${state.errorsError}` : "Reading the errors…";
    return element("section", { className: "activity-day" }, heading, element("p", { className: state.errorsError ? "tone-text-bad" : "muted" }, text));
  }
  const errors = state.errors.errors;
  const clear = node.local && errors.length ? button(state.busy ? "Clearing…" : `Clear ${errors.length === 1 ? "the error" : `${errors.length} errors`}`, () => void runClear(state, node)) : null;
  if (clear) clear.disabled = state.busy;
  return element(
    "section",
    { className: "activity-day" },
    heading,
    errors.length
      ? element("div", { className: "activity-list" }, ...errors.map((error) => logLine({ when: error.when, level: "error", message: error.message })))
      : element("p", { className: "empty-line" }, `${node.name}'s Syncthing reports no errors.`),
    clear ? element("div", { className: "button-row" }, clear) : null,
    !node.local && errors.length ? element("p", { className: "muted" }, `They are cleared on ${node.host}'s dashboard.`) : null,
    notice(state),
  );
}

const debugFormId = "node-log-debug";
registerForm(debugFormId);

function facilityBox(facility: DebugFacility, disabled: boolean): HTMLElement {
  const box = element("input", { attributes: { type: "checkbox", id: controlId(debugFormId, facility.name), "data-facility": facility.name } });
  box.checked = facility.debug;
  box.defaultChecked = facility.debug;
  box.disabled = disabled;
  return element("label", { className: "debug-facility" }, box, element("span", {}, element("code", {}, facility.name), facility.description ? ` ${facility.description}` : ""));
}

async function saveDebug(state: NodeLogState, node: StorageNode, form: HTMLElement): Promise<void> {
  const boxes = [...form.querySelectorAll<HTMLInputElement>("input[data-facility]")];
  const enable = boxes.filter((box) => box.checked && !box.defaultChecked).map((box) => box.dataset.facility ?? "");
  const disable = boxes.filter((box) => !box.checked && box.defaultChecked).map((box) => box.dataset.facility ?? "");
  if (!enable.length && !disable.length) return;
  state.busy = true;
  state.result = null;
  requestRender();
  const result = await saveDebugFacilities(node.id, { enable, disable });
  state.busy = false;
  if (result.ok) {
    state.debug = result.value;
    state.result = { text: `Saved the debug logging of ${node.name}.`, tone: "ok" };
  } else state.result = { text: result.maybeSaved ? `${result.message}.` : `Not saved: ${result.message}`, tone: result.maybeSaved ? "warn" : "bad" };
  requestRender();
}

function debugSection(state: NodeLogState, node: StorageNode): HTMLElement {
  const heading = element("h2", { className: "group-heading" }, "Debug logging");
  if (!state.debug) {
    const text = state.debugError ? `The facilities could not be read: ${state.debugError}` : "Reading the facilities…";
    return element("section", { className: "activity-day" }, heading, element("p", { className: state.debugError ? "tone-text-bad" : "muted" }, text));
  }
  const form = element("div", { className: "debug-facilities", attributes: { id: debugFormId } }, ...state.debug.facilities.map((facility) => facilityBox(facility, !node.local || state.busy)));
  const save = node.local ? button(state.busy ? "Saving…" : "Save debug logging", () => void saveDebug(state, node, form)) : null;
  if (save) save.disabled = state.busy;
  const words = node.local
    ? "A ticked facility logs at debug level, which is very verbose; Syncthing goes back to its own levels when it restarts."
    : `Changed on ${node.host}'s dashboard.`;
  return element("section", { className: "activity-day" }, heading, element("p", { className: "muted" }, words), form, save ? element("div", { className: "button-row" }, save) : null);
}

function bundleSection(node: StorageNode): HTMLElement {
  const heading = element("h2", { className: "group-heading" }, "Support bundle");
  if (!node.local) return element("section", { className: "activity-day" }, heading, element("p", { className: "muted" }, `It is downloaded on ${node.host}'s dashboard.`));
  const link = element("a", { className: "button", attributes: { href: supportBundleUrl(node.id), download: "" } }, `Download ${node.name}'s support bundle`);
  return element(
    "section",
    { className: "activity-day" },
    heading,
    element(
      "p",
      { className: "muted" },
      "A zip file for a Syncthing bug report: its configuration with the API key taken out, its recent log, metrics and performance profiles. Syncthing takes several seconds to gather it, and the dashboard hands it out only after finding no password or API key in it.",
    ),
    element("div", { className: "button-row" }, link),
  );
}

export function renderLogTab(): HTMLElement {
  const state = ensureNodeLog();
  const node = chosenNode();
  if (!state || !node) {
    const text = appState.data ? "No node's Syncthing can be read from here." : "Loading nodes…";
    return element("p", { className: "muted" }, text);
  }
  return element("div", { className: "node-log" }, controls(state), errorsSection(state, node), logSection(state, node), debugSection(state, node), bundleSection(node));
}
