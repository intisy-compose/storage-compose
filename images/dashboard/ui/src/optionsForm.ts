import {
  type BandwidthLimits,
  type ConnectionProfile,
  type ConnectionsState,
  type InstanceOptions,
  type ProfileRead,
  type StorageNode,
  changedFields,
  connectionOptionLabels,
  nodeLimitsOf,
  profileOwnedText,
  untrustedNetworksText,
  fetchConnectionProfile,
  profileChangedText,
  saveConnectionProfile,
  withNodeLimits,
} from "./api.js";
import { isProfileChangedRefusal } from "./connectionsForm.js";
import { editFailureNotice, resultLine } from "./deviceForm.js";
import { button, element, keyValueList } from "./dom.js";
import { type FieldForm, numberControl, setting, toggleControl } from "./fieldKit.js";
import { registerForm } from "./forms.js";
import { requestRender } from "./renderRequest.js";
import { type Notice, appState } from "./state.js";

interface LimitsFormState extends FieldForm<BandwidthLimits> {
  result: Notice | null;
  /** The profile read the form last took, so only a newer one replaces what a save left. */
  followed: ProfileRead;
}

const forms = new Map<string, LimitsFormState>();

function hasUnsavedChange(form: LimitsFormState): boolean {
  return Object.keys(changedFields(form.saved, form.draft)).length > 0;
}

/** The node's limits form, following each new read of the profile while it holds nothing unsaved. */
export function limitsFormFor(nodeId: string, read: ProfileRead): LimitsFormState {
  const limits = nodeLimitsOf(read.profile, nodeId);
  const form = forms.get(nodeId);
  if (!form) {
    const formId = `limits-form-${nodeId}`;
    registerForm(formId);
    const created: LimitsFormState = { formId, saved: limits, draft: { ...limits }, saving: false, result: null, followed: read };
    forms.set(nodeId, created);
    return created;
  }
  if (read !== form.followed && !form.saving && !hasUnsavedChange(form)) {
    form.saved = limits;
    form.draft = { ...limits };
    form.followed = read;
  }
  return form;
}

/** Takes the profile another host saved after this form was opened, keeping only the limits the person changed over it. */
export function followChangedLimits(nodeId: string, form: LimitsFormState, latest: ProfileRead): void {
  const changed = changedFields(form.saved, form.draft);
  form.followed = latest;
  form.saved = nodeLimitsOf(latest.profile, nodeId);
  form.draft = { ...form.saved, ...changed };
  form.result = { text: `Not saved: ${profileChangedText}. Your changes are kept: save again.`, tone: "warn" };
}

function onOff(value: boolean): string {
  return value ? "on" : "off";
}

function listText(values: string[]): string {
  return values.length ? values.join(", ") : "none";
}

const stateWords: Record<ConnectionsState, string> = {
  "on-profile": "on the profile",
  "not-yet": "not yet on the profile",
  unknown: "not known yet",
};

/** The options the profile sets, as this node's Syncthing has them now; none is changed here. */
function profileOwnedList(node: StorageNode, options: InstanceOptions): HTMLElement {
  const row = (key: keyof typeof connectionOptionLabels, value: string, why = profileOwnedText(key)): [string, HTMLElement] => [
    connectionOptionLabels[key],
    element("span", {}, value, element("small", { className: "muted" }, ` read only: ${why}`)),
  ];
  const untrustedWhy = node.untrustedNetworks ? untrustedNetworksText : undefined;
  return keyValueList([
    ["This node", element("span", { className: node.connections === "not-yet" ? "tone-text-warn" : "" }, stateWords[node.connections])],
    row("listenAddresses", listText(options.listenAddresses)),
    row("localAnnounceEnabled", onOff(options.localAnnounceEnabled), untrustedWhy),
    row("globalAnnounceEnabled", onOff(options.globalAnnounceEnabled)),
    row("globalAnnounceServers", listText(options.globalAnnounceServers)),
    row("relaysEnabled", onOff(options.relaysEnabled)),
    row("natEnabled", onOff(options.natEnabled), untrustedWhy),
  ]);
}

function limitWords(value: number): string {
  return value === 0 ? "unlimited" : `${value} KiB/s`;
}

function defaultHint(profile: ConnectionProfile, key: "maxSendKbps" | "maxRecvKbps", nodeId: string): string {
  const overridden = profile.nodeLimits[nodeId]?.[key] !== undefined;
  return `KiB/s, 0 is unlimited. Cluster default ${limitWords(profile.limits[key])}${overridden ? ", which this node overrides" : ""}.`;
}

function limitFields(form: LimitsFormState, profile: ConnectionProfile, nodeId: string): HTMLElement {
  const lanOverridden = profile.nodeLimits[nodeId]?.limitLan !== undefined;
  return element(
    "div",
    { className: "form-fields device-fields" },
    element(
      "div",
      { className: "number-fields" },
      setting(form.formId, "maxSendKbps", connectionOptionLabels.maxSendKbps, numberControl(form, "maxSendKbps"), defaultHint(profile, "maxSendKbps", nodeId)),
      setting(form.formId, "maxRecvKbps", connectionOptionLabels.maxRecvKbps, numberControl(form, "maxRecvKbps"), defaultHint(profile, "maxRecvKbps", nodeId)),
    ),
    element(
      "div",
      { className: "toggles" },
      toggleControl(form, "limitLan", connectionOptionLabels.limitBandwidthInLan, `applies the limits on the local network too; cluster default ${onOff(profile.limits.limitLan)}${lanOverridden ? ", which this node overrides" : ""}`),
    ),
  );
}

async function saveLimits(nodeId: string, form: LimitsFormState, limits: BandwidthLimits): Promise<void> {
  const base = form.followed.profile;
  const profile = withNodeLimits(base, nodeId, limits);
  if (JSON.stringify(profile.nodeLimits) === JSON.stringify(base.nodeLimits)) {
    form.result = { text: "Nothing changed.", tone: "ok" };
    return requestRender();
  }
  form.saving = true;
  form.result = null;
  requestRender();
  const result = await saveConnectionProfile(profile, base, false);
  form.saving = false;
  if (!result.ok && !result.maybeSaved && isProfileChangedRefusal(result.message)) {
    await followLatestLimits(nodeId, form);
  } else if (result.ok) {
    appState.connectionProfile = result.value;
    form.followed = result.value;
    form.saved = nodeLimitsOf(result.value.profile, nodeId);
    form.draft = { ...form.saved };
    form.result = { text: "Saved in the connection profile; this host applies it within a minute.", tone: "ok" };
  } else {
    form.result = editFailureNotice(result);
  }
  requestRender();
}

async function followLatestLimits(nodeId: string, form: LimitsFormState): Promise<void> {
  try {
    appState.connectionProfile = await fetchConnectionProfile();
    followChangedLimits(nodeId, form, appState.connectionProfile);
  } catch (error) {
    form.result = { text: `Not saved: ${profileChangedText}, but it could not be read again: ${(error as Error).message}`, tone: "bad" };
  }
}

function revert(form: LimitsFormState): void {
  form.draft = { ...form.saved };
  form.result = null;
  requestRender();
}

function limitsForm(node: StorageNode, read: ProfileRead): HTMLElement {
  const form = limitsFormFor(node.id, read);
  const hasOverride = read.profile.nodeLimits[node.id] !== undefined;
  return element(
    "div",
    { className: "device-form options-form", attributes: { id: form.formId } },
    element("h3", { className: "settings-subheading" }, "Bandwidth"),
    element("p", { className: "muted" }, hasOverride ? "This node's own limits, saved as its override in the connection profile." : "This node runs the cluster's limits; a change here saves it an override in the connection profile."),
    limitFields(form, read.profile, node.id),
    resultLine(form.result),
    element(
      "div",
      { className: "button-row" },
      Object.assign(button(form.saving ? "Saving…" : "Save", () => void saveLimits(node.id, form, form.draft), "button primary"), { disabled: form.saving }),
      Object.assign(button("Revert", () => revert(form), "button ghost"), { disabled: form.saving }),
      hasOverride ? Object.assign(button("Use the cluster's limits", () => void saveLimits(node.id, form, read.profile.limits), "button ghost"), { disabled: form.saving }) : null,
    ),
  );
}

/** A local node's connection options: the ones the connection profile sets, read only, and its bandwidth limits as its override in the profile. */
export function connectionOptionsForm(node: StorageNode, options: InstanceOptions): HTMLElement {
  const read = appState.connectionProfile;
  return element(
    "div",
    { className: "options-form" },
    element("h3", { className: "settings-subheading" }, "Connections"),
    profileOwnedList(node, options),
    read ? limitsForm(node, read) : element("p", { className: appState.connectionProfileError ? "warning" : "muted" }, appState.connectionProfileError ?? "Reading the connection profile…"),
  );
}
