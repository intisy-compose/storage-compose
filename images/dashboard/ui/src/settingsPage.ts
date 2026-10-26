import type { HostSettings, InstanceGui, InstanceOptions, NodeOptionsResponse, PriorityBand, StorageNode } from "./api.js";
import { element, keyValueList } from "./dom.js";
import { applyTheme } from "./preferences.js";
import { requestRender } from "./renderRequest.js";
import { appState, locationFor } from "./state.js";

function onOff(value: boolean): string {
  return value ? "on" : "off";
}

function listText(values: string[], emptyText: string): string {
  return values.length ? values.join(", ") : emptyText;
}

function rateText(kibPerSecond: number): string {
  return kibPerSecond > 0 ? `${kibPerSecond} KiB/s` : "unlimited";
}

function usageReportingText(urAccepted: number): string {
  if (urAccepted < 0) return "declined";
  return urAccepted === 0 ? "not answered yet" : `accepted (version ${urAccepted})`;
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
    "from config.env",
    keyValueList([
      ["Name", settings.name],
      ["Tailnet name", settings.tailnetName ?? "not joined yet"],
      ["Reads", dashboardLinks(settings.peerDashboards)],
      ["ntfy", settings.ntfy.url ? `${settings.ntfy.url}, ${settings.ntfy.topicSet ? "topic set" : "no topic, notifications are only logged"}` : "not passed to the dashboard"],
      ["Setup repo", settings.setupRepo ? "configured" : "not configured"],
      ["Priority bands", [bandsText(settings.priorityBands), element("small", { className: "muted setting-note" }, "From the setup repo's folder categories; the layered sync has set no bands of its own yet.")]],
    ]),
  );
}

function optionsList(options: InstanceOptions): HTMLElement {
  return keyValueList([
    ["Device name", options.deviceName || "not set"],
    ["Listen on", listText(options.listenAddresses, "nothing")],
    ["Global discovery", `${onOff(options.globalAnnounceEnabled)}, servers ${listText(options.globalAnnounceServers, "none")}`],
    ["Local discovery", onOff(options.localAnnounceEnabled)],
    ["Relays", onOff(options.relaysEnabled)],
    ["NAT traversal", onOff(options.natEnabled)],
    ["Send limit", rateText(options.maxSendKbps)],
    ["Receive limit", rateText(options.maxRecvKbps)],
    ["Limits in LAN", onOff(options.limitBandwidthInLan)],
    ["Always local", listText(options.alwaysLocalNets, "none")],
    ["Reconnect", `every ${options.reconnectionIntervalS} s`],
    ["Keep free", `${options.minHomeDiskFree.value} ${options.minHomeDiskFree.unit} on its home disk`],
    ["Usage reports", usageReportingText(options.urAccepted)],
    ["Crash reports", onOff(options.crashReportingEnabled)],
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

function nodeBody(answer: NodeOptionsResponse | { error: string } | undefined): HTMLElement[] {
  if (!answer) return [element("p", { className: "muted" }, "Reading its options…")];
  if ("error" in answer) return [element("p", { className: "warning" }, answer.error)];
  return [optionsList(answer.options), guiList(answer.gui)];
}

function nodeCard(node: StorageNode): HTMLElement {
  const title = element("a", { attributes: { href: locationFor("nodes", node.id) } }, node.name);
  return element(
    "section",
    { className: "settings-card" },
    element("h2", { className: "settings-heading" }, title, element("small", {}, `Syncthing options of node ${node.id}`)),
    ...nodeBody(appState.nodeOptions.get(node.id)),
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
export function localNodes(): StorageNode[] {
  return appState.data?.nodes.filter((node) => node.local) ?? [];
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
