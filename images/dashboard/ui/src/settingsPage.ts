import type { HostSettings, InstanceGui, InstanceOptions, NodeOptionsResponse, PriorityBand, StorageNode } from "./api.js";
import { element, keyValueList } from "./dom.js";
import { priorityUnsetText } from "./folderCondition.js";
import { isNotConnected } from "./nodeStatus.js";
import { defaultsSection } from "./defaultsSection.js";
import { generalSettingsForm } from "./generalForm.js";
import { ignoredSection } from "./ignoredSection.js";
import { connectionOptionsForm } from "./optionsForm.js";
import { applyTheme } from "./preferences.js";
import { requestRender } from "./renderRequest.js";
import { appState, locationFor } from "./state.js";

function onOff(value: boolean): string {
  return value ? "on" : "off";
}

function listText(values: string[], emptyText: string): string {
  return values.length ? values.join(", ") : emptyText;
}

function card(heading: string, subheading: string | null, ...children: (HTMLElement | null)[]): HTMLElement {
  return element(
    "section",
    { className: "settings-card" },
    element("h2", { className: "settings-heading" }, heading, subheading ? element("small", {}, subheading) : null),
    ...children,
  );
}

function bandsText(bands: PriorityBand[]): string {
  return bands.map((band, index) => (index === 0 ? `${band.name} from ${band.from}` : `${band.name} from ${band.from} to ${bands[index - 1].from - 1}`)).join(", ");
}

function dashboardLinks(peers: string[]): HTMLElement | string {
  if (!peers.length) return "none, this host shows only its own nodes";
  return element("span", {}, ...peers.flatMap((peer, index) => [index ? ", " : null, element("a", { attributes: { href: peer, target: "_blank", rel: "noreferrer" } }, peer)]));
}

function hostCard(settings: HostSettings): HTMLElement {
  return card(
    "This host",
    "from config.env and the setup repo",
    keyValueList([
      ["Name", settings.name],
      ["Tailnet name", settings.tailnetName ?? "not joined yet"],
      ["Reads", dashboardLinks(settings.peerDashboards)],
      ["ntfy", settings.ntfy.url ? `${settings.ntfy.url}, ${settings.ntfy.topicSet ? "topic set" : "no topic, notifications are only logged"}` : "not passed to the dashboard"],
      ["Setup repo", settings.setupRepo ? "configured" : "not configured"],
      ["Priority bands", settings.priorityBands ? bandsText(settings.priorityBands) : priorityUnsetText],
    ]),
  );
}

/** The options neither the connections nor the general form changes. */
function otherOptionsList(options: InstanceOptions): HTMLElement {
  return keyValueList([
    ["Always local", listText(options.alwaysLocalNets, "none")],
    ["Reconnect", `every ${options.reconnectionIntervalS} s`],
  ]);
}

function guiList(gui: InstanceGui): HTMLElement {
  return keyValueList([
    ["GUI address", gui.address],
    ["GUI TLS", onOff(gui.useTLS)],
    ["GUI login", gui.user ? `${gui.user} (${gui.authMode})` : `none (${gui.authMode})`],
    ["Managed by", "the stack, so it is not changed here"],
  ]);
}

function nodeBody(node: StorageNode, answer: NodeOptionsResponse | { error: string } | undefined): HTMLElement[] {
  if (isNotConnected(node)) return [element("p", { className: "muted" }, "Not connected, so its options cannot be read.")];
  if (!answer) return [element("p", { className: "muted" }, "Reading its options…")];
  if ("error" in answer) return [element("p", { className: "warning" }, answer.error)];
  return [connectionOptionsForm(node, answer.options, localNodes().length), generalSettingsForm(node, answer.options), otherOptionsList(answer.options), guiList(answer.gui), defaultsSection(node), ignoredSection(node)];
}

function nodeCard(node: StorageNode): HTMLElement {
  const title = element("a", { attributes: { href: locationFor("nodes", node.id) } }, node.name);
  return element(
    "section",
    { className: "settings-card" },
    element("h2", { className: "settings-heading" }, title, element("small", {}, `Syncthing options of node ${node.id}`)),
    ...nodeBody(node, appState.nodeOptions.get(node.id)),
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

/** The nodes of this host, whose options this page shows. */
function localNodes(): StorageNode[] {
  return appState.data?.nodes.filter((node) => node.local) ?? [];
}

/** The nodes of this host whose options can be read: one that is not connected has none to read. */
export function readableLocalNodes(): StorageNode[] {
  return localNodes().filter((node) => !isNotConnected(node));
}

function hostSection(): HTMLElement {
  if (appState.hostSettings) return hostCard(appState.hostSettings);
  return card("This host", null, element("p", { className: appState.hostSettingsError ? "warning" : "muted" }, appState.hostSettingsError ?? "Loading…"));
}

export function renderSettingsPage(): HTMLElement {
  const notice = appState.page === "settings" && appState.notice ? element("p", { className: `notice tone-text-${appState.notice.tone}` }, appState.notice.text) : null;
  const nodes = localNodes();
  return element(
    "div",
    { className: "page" },
    element(
      "header",
      { className: "page-header" },
      element("h1", {}, "Settings"),
      element("p", { className: "page-summary" }, "This host, the Syncthing options of each of its nodes, and this browser's preferences."),
    ),
    hostSection(),
    ...(nodes.length ? nodes.map(nodeCard) : [element("p", { className: "empty-line settings-card" }, appState.data ? "This host runs no node." : "Loading nodes…")]),
    card("This browser", null, themeSetting(), notice),
  );
}
