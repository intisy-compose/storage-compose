import { type DeviceSummary, type DevicesResponse, type DriveSummary, type InstanceConnection, type NodesResponse, type StorageNode, addressLabel, connectionKindText, deviceStateText, driveLastSeenHereText, driveWhereText, reachTone, seenTimeText } from "./api.js";
import { driveKindLabel, isDeviceHost } from "./deviceList.js";
import { element, keyValueList, section } from "./dom.js";
import { icon } from "./icons.js";
import { kindChipText, shortSyncState } from "./nodeStatus.js";
import { driveLocation, locationFor } from "./state.js";

const sourceText: Record<DeviceSummary["sources"][number], string> = {
  dashboard: "its dashboard",
  syncthing: "a Syncthing configuration here",
  join: "a join request",
  history: "this host's history",
};

function nodeName(response: NodesResponse, nodeId: string): string {
  return response.nodes.find((node) => node.id === nodeId)?.name ?? nodeId;
}

function connectionNow(response: NodesResponse, device: DeviceSummary): string {
  if (device.thisHost) return "this device";
  const connection = device.connection;
  if (!connection) return device.online ? "its dashboard answers; no Syncthing connection" : "not connected";
  return `${connectionKindText(connection.kind)} through ${nodeName(response, connection.nodeId)}, ${addressLabel(connection.address)} (${connection.type})`;
}

function connectionLast(device: DeviceSummary, now: Date): string {
  const last = device.lastConnection;
  if (!last) return "none recorded";
  const address = last.address ? `, ${addressLabel(last.address)}` : "";
  return `${connectionKindText(last.kind)}${address}, ${seenTimeText(last.at, now)}`;
}

function connectionSection(response: NodesResponse, device: DeviceSummary, now: Date): HTMLElement {
  const history: [string, string][] = [
    ["Last time", connectionLast(device, now)],
    ["Last seen", device.lastSeen ? seenTimeText(device.lastSeen, now) : "never"],
  ];
  return section("Connection", keyValueList([["Now", connectionNow(response, device)], ...(device.thisHost ? [] : history)]));
}

function instanceRow(instance: InstanceConnection): HTMLElement {
  return element(
    "div",
    { className: "peer-row" },
    element("span", { className: `dot tone-${instance.connected ? "ok" : "muted"}`, title: instance.connected ? "connected" : "not connected" }),
    element(
      "span",
      { className: "peer-name" },
      element("span", { className: "peer-title" }, element("strong", {}, instance.nodeName), instance.kind ? element("span", { className: "chip" }, connectionKindText(instance.kind)) : null),
      element("small", {}, instance.connected ? (instance.address ? addressLabel(instance.address) : "connected") : "not connected"),
    ),
  );
}

function instancesSection(device: DeviceSummary): HTMLElement | null {
  if (!device.perInstance.length) return null;
  return section(`How this host's nodes reach it (${device.perInstance.length})`, element("div", { className: "peer-list" }, ...device.perInstance.map(instanceRow)));
}

function deviceIdsSection(device: DeviceSummary): HTMLElement | null {
  if (!device.deviceIds.length) return null;
  return section(
    `Syncthing device IDs (${device.deviceIds.length})`,
    element("div", { className: "device-id-list" }, ...device.deviceIds.map((deviceId) => element("code", {}, deviceId))),
  );
}

function nodeLink(response: NodesResponse, node: StorageNode): HTMLElement {
  const state = shortSyncState(node, response);
  return element(
    "a",
    { className: "link-row", attributes: { href: locationFor("nodes", node.id) } },
    element("span", { className: `dot tone-${reachTone(node)}` }),
    element("strong", {}, node.name),
    element("span", { className: "chip" }, kindChipText(node)),
    element("small", { className: `tone-text-${state.tone}` }, state.label),
  );
}

function nodesSection(response: NodesResponse, device: DeviceSummary): HTMLElement {
  const nodes = response.nodes.filter((node) => device.nodeIds.includes(node.id));
  return section(
    `Nodes (${nodes.length})`,
    nodes.length ? element("div", { className: "link-list" }, ...nodes.map((node) => nodeLink(response, node))) : element("p", { className: "muted" }, "No nodes known on this device."),
  );
}

function driveLink(drive: DriveSummary, device: DeviceSummary, now: Date): HTMLElement {
  const isLastHere = !drive.present && isDeviceHost(device, drive.lastHost);
  return element(
    "a",
    { className: `link-row${drive.present ? "" : " offline"}`, attributes: { href: driveLocation(drive.key) } },
    element("span", { className: `dot tone-${drive.present ? "ok" : "muted"}` }),
    element("strong", {}, drive.label),
    element("span", { className: "chip" }, driveKindLabel(drive)),
    element("small", {}, isLastHere ? driveLastSeenHereText(drive, now) : driveWhereText(drive, now)),
  );
}

function drivesSection(title: string, drives: DriveSummary[], device: DeviceSummary, now: Date): HTMLElement | null {
  if (!drives.length) return null;
  return section(`${title} (${drives.length})`, element("div", { className: "link-list" }, ...drives.map((drive) => driveLink(drive, device, now))));
}

function deviceDrives(devices: DevicesResponse, device: DeviceSummary): DriveSummary[] {
  return devices.drives.filter((drive) => device.driveKeys.includes(drive.key));
}

function detailHeader(device: DeviceSummary, now: Date): HTMLElement {
  return element(
    "header",
    { className: "detail-header" },
    element("a", { className: "icon-button close-detail", title: "Close", attributes: { href: locationFor("nodes"), "aria-label": "Close detail" } }, icon("close")),
    element("h2", {}, device.name),
    element("p", { className: "detail-status" }, element("span", { className: `dot tone-${device.online ? "ok" : "muted"}` }), deviceStateText(device, now)),
  );
}

export function renderDeviceDetail(response: NodesResponse, devices: DevicesResponse, device: DeviceSummary): HTMLElement {
  const now = new Date();
  const drives = deviceDrives(devices, device);
  const attached = drives.filter((drive) => drive.present && isDeviceHost(device, drive.currentHost));
  const lastHere = drives.filter((drive) => !attached.includes(drive));
  return element(
    "div",
    { className: "detail-inner" },
    detailHeader(device, now),
    connectionSection(response, device, now),
    instancesSection(device),
    nodesSection(response, device),
    drivesSection("Drives here", attached, device, now),
    drivesSection("Drives last seen here", lastHere, device, now),
    deviceIdsSection(device),
    element("p", { className: "muted small" }, `Known from ${device.sources.map((source) => sourceText[source]).join(", ")}.`),
  );
}

export function renderItemNotFound(what: string, key: string, isLoading: boolean): HTMLElement {
  return element(
    "div",
    { className: "detail-inner detail-empty" },
    element("p", {}, isLoading ? `Reading ${what}s…` : `No ${what} ${key} is known.`),
    element("a", { attributes: { href: locationFor("nodes") } }, "Back to all devices"),
  );
}
