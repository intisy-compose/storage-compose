import { type ConnectionProfile, type ProfileRead, changedFields, fetchConnectionProfile, newlyStrandedPairs, pairsText, profileChangedText, saveConnectionProfile } from "./api.js";
import { editFailureNotice, resultLine } from "./deviceForm.js";
import { button, element, keyValueList } from "./dom.js";
import { type FieldForm, listControl, numberControl, setting, toggleControl } from "./fieldKit.js";
import { formatAge } from "./format.js";
import { registerForm } from "./forms.js";
import { requestRender } from "./renderRequest.js";
import { type Notice, appState } from "./state.js";

/** The profile as the form edits it: global discovery as a list, empty for off. */
interface ProfileValues {
  lan: boolean;
  tailnet: boolean;
  nat: boolean;
  globalDiscovery: string[];
  publicRelays: boolean;
  bridges: boolean;
  bridgePort: number;
  maxSendKbps: number;
  maxRecvKbps: number;
  limitLan: boolean;
}

interface ClusterFormState extends FieldForm<ProfileValues> {
  result: Notice | null;
  /** The read the form last took, so only a newer one replaces what a save left; a save names its profile as its base. */
  followed: ProfileRead;
  /** The person's answer to saving although pairs of nodes would then share no method. */
  confirmUnreachable: boolean;
  /** Set once the server refused a save for the pairs it would strand, so the confirmation is offered even when this page's table names none. */
  refusedForPairs: boolean;
}

const formId = "connections-form";
let form: ClusterFormState | null = null;

function valuesOf(profile: ConnectionProfile): ProfileValues {
  const global = profile.discovery.global;
  return {
    ...profile.methods,
    globalDiscovery: Array.isArray(global) ? [...global] : global === "" ? [] : [global],
    publicRelays: profile.relays.public,
    bridges: profile.relays.bridges,
    bridgePort: profile.relays.bridgePort,
    ...profile.limits,
  };
}

/** The values as a profile, with the node overrides as `nodeLimits` holds them: this form never changes an override. */
function profileOf(values: ProfileValues, nodeLimits: ConnectionProfile["nodeLimits"]): ConnectionProfile {
  const servers = values.globalDiscovery;
  return {
    methods: { lan: values.lan, tailnet: values.tailnet, nat: values.nat },
    discovery: { global: servers.length === 0 ? "" : servers.length === 1 ? servers[0] : [...servers] },
    relays: { public: values.publicRelays, bridges: values.bridges, bridgePort: values.bridgePort },
    limits: { maxSendKbps: values.maxSendKbps, maxRecvKbps: values.maxRecvKbps, limitLan: values.limitLan },
    nodeLimits,
  };
}

function hasUnsavedChange(state: ClusterFormState): boolean {
  return Object.keys(changedFields(state.saved, state.draft)).length > 0;
}

/** The cluster's form, following each new read of the profile while it holds nothing unsaved. */
export function clusterFormFor(read: ProfileRead): ClusterFormState {
  if (!form) {
    registerForm(formId);
    const values = valuesOf(read.profile);
    form = { formId, saved: values, draft: structuredClone(values), saving: false, result: null, followed: read, confirmUnreachable: false, refusedForPairs: false };
    return form;
  }
  if (read !== form.followed && !form.saving && !hasUnsavedChange(form)) {
    form.saved = valuesOf(read.profile);
    form.draft = structuredClone(form.saved);
    form.followed = read;
  }
  return form;
}

function nodeName(nodeId: string): string {
  return appState.data?.nodes.find((node) => node.id === nodeId)?.name ?? nodeId;
}

function currentNodeLimits(): ConnectionProfile["nodeLimits"] {
  return appState.connectionProfile?.profile.nodeLimits ?? {};
}

/**
 * Takes the profile another host saved after this form was opened: its values become the saved ones, and the draft keeps only
 * the fields the person changed over them.
 */
export function followChangedProfile(state: ClusterFormState, latest: ProfileRead): void {
  const changed = changedFields(state.saved, state.draft);
  state.followed = latest;
  state.saved = valuesOf(latest.profile);
  state.draft = { ...structuredClone(state.saved), ...changed };
  state.refusedForPairs = false;
  state.result = { text: `Not saved: ${profileChangedText}. Your changes are kept: save again.`, tone: "warn" };
}

/** Whether a refused save was made from a profile that is no longer the one on disk, here or on another host. */
export function isProfileChangedRefusal(message: string): boolean {
  return message === profileChangedText || message.startsWith("another host saved the connection profile first");
}

/** The pairs the draft would leave without a common method that the saved profile still connects, by this host's last table. */
function strandedPairs(state: ClusterFormState): Array<[string, string]> {
  if (!appState.peerTable) return [];
  return newlyStrandedPairs(state.followed.profile, profileOf(state.draft, currentNodeLimits()), appState.peerTable);
}

/** A toggle that redraws the form, so the warning about stranded pairs follows each click. */
function liveToggle(state: ClusterFormState, key: "lan" | "tailnet" | "nat" | "publicRelays" | "bridges" | "limitLan", label: string, hint: string): HTMLElement {
  const toggle = toggleControl(state, key, label, hint);
  toggle.querySelector("input")?.addEventListener("change", () => requestRender());
  return toggle;
}

function methodFields(state: ClusterFormState): HTMLElement {
  return element(
    "div",
    { className: "toggles" },
    liveToggle(state, "lan", "LAN", "direct on the local network, found by local discovery"),
    liveToggle(state, "tailnet", "Tailnet", "direct on each node's tailnet address"),
    liveToggle(state, "nat", "NAT traversal", "opens a port on the router by UPnP or NAT-PMP, for direct connections from the internet"),
    liveToggle(state, "bridges", "Bridges", "a host on two networks relays between nodes that share neither"),
    liveToggle(state, "publicRelays", "Public relays", "Syncthing's relay pool, the last resort"),
  );
}

function limitFields(state: ClusterFormState): HTMLElement {
  return element(
    "div",
    { className: "form-fields device-fields" },
    element(
      "div",
      { className: "number-fields" },
      setting(formId, "maxSendKbps", "Send limit", numberControl(state, "maxSendKbps"), "KiB/s for every node, 0 is unlimited."),
      setting(formId, "maxRecvKbps", "Receive limit", numberControl(state, "maxRecvKbps"), "KiB/s for every node, 0 is unlimited."),
    ),
    element("div", { className: "toggles" }, liveToggle(state, "limitLan", "Limits in LAN", "applies the limits on the local network too")),
  );
}

function limitWords(value: number | undefined): string | null {
  if (value === undefined) return null;
  return value === 0 ? "unlimited" : `${value} KiB/s`;
}

function overrideText(limits: ConnectionProfile["nodeLimits"][string]): string {
  const parts = [
    limitWords(limits.maxSendKbps) && `send ${limitWords(limits.maxSendKbps)}`,
    limitWords(limits.maxRecvKbps) && `receive ${limitWords(limits.maxRecvKbps)}`,
    limits.limitLan === undefined ? null : `limits in LAN ${limits.limitLan ? "on" : "off"}`,
  ];
  return parts.filter(Boolean).join(", ") || "none";
}

function overridesList(): HTMLElement {
  const overrides = Object.entries(currentNodeLimits());
  if (!overrides.length) return element("p", { className: "muted" }, "No node overrides the cluster's limits. A node's own limits are set on its card below.");
  return element(
    "div",
    {},
    element("p", { className: "muted" }, "Nodes that override the cluster's limits, each set on its own card below:"),
    keyValueList(overrides.map(([nodeId, limits]): [string, string] => [nodeName(nodeId), overrideText(limits)])),
  );
}

/** Where the profile stands: the data repo's last pull, and the nodes that do not run it yet. */
function profileState(read: ProfileRead): HTMLElement {
  const behind = (appState.data?.nodes ?? []).filter((node) => node.connections === "not-yet").map((node) => node.name);
  return keyValueList([
    ["Kept in", "connections.toml in the data repo, pulled by every host's dashboard"],
    ["Last pull", read.pullProblem ? element("span", { className: "tone-text-bad" }, `failed: ${read.pullProblem}`) : read.pulledAt ? formatAge(read.pulledAt) : "not pulled yet"],
    ["Not yet on it", behind.length ? behind.join(", ") : "none"],
  ]);
}

function confirmToggle(state: ClusterFormState): HTMLElement {
  const id = `${formId}-confirm`;
  const box = element("input", { attributes: { id, type: "checkbox" } });
  box.defaultChecked = state.confirmUnreachable;
  box.checked = state.confirmUnreachable;
  box.addEventListener("change", () => {
    state.confirmUnreachable = box.checked;
    box.defaultChecked = box.checked;
  });
  box.disabled = state.saving;
  return element("label", { className: "toggle", attributes: { for: id } }, box, element("span", {}, "Save anyway", element("small", { className: "muted" }, " these pairs stop syncing with each other until a method connects them again")));
}

function strandedWarning(state: ClusterFormState): HTMLElement | null {
  const pairs = strandedPairs(state);
  if (!pairs.length && !state.refusedForPairs) return null;
  const text = pairs.length ? `With this change ${pairsText(pairs, nodeName)} would share no connection method.` : "The dashboard found pairs of nodes this change leaves without a common method.";
  return element("div", { className: "warning level-error stranded-warning" }, element("p", {}, text), confirmToggle(state));
}

function settle(state: ClusterFormState, read: ProfileRead): void {
  appState.connectionProfile = read;
  state.followed = read;
  state.saved = valuesOf(read.profile);
  state.draft = structuredClone(state.saved);
  state.confirmUnreachable = false;
  state.refusedForPairs = false;
  state.result = { text: "Saved for the whole cluster; each host applies it within a minute.", tone: "ok" };
}

async function save(state: ClusterFormState): Promise<void> {
  if (!hasUnsavedChange(state)) {
    state.result = { text: "Nothing changed.", tone: "ok" };
    return requestRender();
  }
  state.saving = true;
  state.result = null;
  requestRender();
  const base = state.followed.profile;
  const result = await saveConnectionProfile(profileOf(state.draft, base.nodeLimits), base, state.confirmUnreachable);
  state.saving = false;
  if (result.ok) settle(state, result.value);
  else if (!result.maybeSaved && isProfileChangedRefusal(result.message)) await followLatest(state);
  else {
    state.result = editFailureNotice(result);
    state.refusedForPairs = /would share no connection method/.test(result.message);
  }
  requestRender();
}

async function followLatest(state: ClusterFormState): Promise<void> {
  try {
    appState.connectionProfile = await fetchConnectionProfile();
    followChangedProfile(state, appState.connectionProfile);
  } catch (error) {
    state.result = { text: `Not saved: ${profileChangedText}, but it could not be read again: ${(error as Error).message}`, tone: "bad" };
  }
}

function revert(state: ClusterFormState): void {
  state.draft = structuredClone(state.saved);
  state.result = null;
  state.confirmUnreachable = false;
  state.refusedForPairs = false;
  requestRender();
}

function formBody(state: ClusterFormState, read: ProfileRead): HTMLElement {
  return element(
    "div",
    { className: "device-form options-form", attributes: { id: formId } },
    profileState(read),
    element("h3", { className: "settings-subheading" }, "Methods"),
    element("div", { className: "form-fields device-fields" }, methodFields(state), setting(formId, "globalDiscovery", "Global discovery servers", listControl(state, "globalDiscovery"), "One per line: default, or an https:// address; empty turns global discovery off.")),
    element("div", { className: "form-fields device-fields" }, setting(formId, "bridgePort", "Bridge port", numberControl(state, "bridgePort", 1), "Outside 22000-22099, the nodes' sync ports.")),
    element("h3", { className: "settings-subheading" }, "Bandwidth"),
    limitFields(state),
    overridesList(),
    strandedWarning(state),
    resultLine(state.result),
    element(
      "div",
      { className: "button-row" },
      Object.assign(button(state.saving ? "Saving…" : "Save for the cluster", () => void save(state), "button primary"), { disabled: state.saving }),
      Object.assign(button("Revert", () => revert(state), "button ghost"), { disabled: state.saving }),
    ),
  );
}

/** The cluster's connection profile as a form: every node of every host runs it, so this card sits above the nodes' own. */
export function connectionsCard(): HTMLElement {
  const read = appState.connectionProfile;
  const heading = element("h2", { className: "settings-heading" }, "Connections", element("small", {}, "how the cluster's nodes reach each other, for every host"));
  if (!read) return element("section", { className: "settings-card connections-card" }, heading, element("p", { className: appState.connectionProfileError ? "warning" : "muted" }, appState.connectionProfileError ?? "Reading the connection profile…"));
  return element("section", { className: "settings-card connections-card" }, heading, formBody(clusterFormFor(read), read));
}
