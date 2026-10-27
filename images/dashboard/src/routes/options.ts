import { connectionOptionLabels, listenPort } from "../api/optionsText.js";
import type { ConnectionOptionKey, ConnectionOptionsChange, HostSettings, InstanceOptions, NodeOptionsEdit, NodeOptionsResponse, OptionsEditOutcome, OptionsEditResponse } from "../api/types.js";
import { RequestError, UnconfirmedWrite, readBody, sendJson } from "../http.js";
import { type LocalInstance, type LocalNodeInfo, type ResolvedInstance, callSyncthing, defaultReadBackDelaysMs, forwardRead, localNodeInfos, requireLocal, resolveInstance, writeConfirmed } from "../instanceResolver.js";
import type { AnyRoute, WriteNote, WriteOutcome } from "../routes.js";
import { hostName, ntfyTopicSet, ntfyUrl, peerDashboards, setupRepoDirectory, tailnetHost } from "../settings.js";
import { type SetupLayout, readLayout } from "../setupRepo.js";
import { instanceGui, instanceOptions, isChangeInPlace, optionsChangeProblem, redactConfig } from "../syncthingConfig.js";

type SyncthingObject = Record<string, unknown>;

function asObject(value: unknown): SyncthingObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as SyncthingObject) : {};
}

/** Another dashboard's answer, redacted and rebuilt field by field, as an older or newer one may send more. */
function fromOtherDashboard(answer: unknown): NodeOptionsResponse {
  const redacted = asObject(redactConfig(answer));
  const options = asObject(redacted.options);
  return { options: instanceOptions(options, typeof options.deviceName === "string" ? options.deviceName : ""), gui: instanceGui(asObject(redacted.gui)) };
}

/**
 * A node's options and GUI, from its own Syncthing or, for another host's node, from that host's dashboard.
 */
export async function nodeOptions(instance: ResolvedInstance): Promise<NodeOptionsResponse> {
  if (instance.kind === "remote") return fromOtherDashboard(await forwardRead(instance, `/api/nodes/${encodeURIComponent(instance.nodeId)}/options`));
  return callSyncthing(instance, async (client) => {
    const [options, gui, ownId, devices] = await Promise.all([
      client.request<SyncthingObject>("GET", "/config/options"),
      client.request<SyncthingObject>("GET", "/config/gui"),
      client.myId(),
      client.devices(),
    ]);
    const deviceName = devices.find((device) => device.deviceID === ownId)?.name ?? "";
    return { options: instanceOptions(options ?? {}, deviceName), gui: instanceGui(gui ?? {}) };
  });
}

/** This host's settings; the bands are the layout's own, null when it has none or there is no setup repo. */
export function hostSettings(layout: SetupLayout | null): HostSettings {
  return {
    name: hostName,
    tailnetName: tailnetHost || null,
    peerDashboards,
    ntfy: { url: ntfyUrl, topicSet: ntfyTopicSet },
    priorityBands: layout?.bands.length ? layout.bands : null,
    setupRepo: setupRepoDirectory !== "",
  };
}

async function layoutOrNull(): Promise<SetupLayout | null> {
  return readLayout().catch(() => null);
}

function decodedNodeId(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new RequestError(400, `${segment} is not a valid node ID`);
  }
}

async function syncthingOptions(instance: LocalInstance): Promise<SyncthingObject> {
  return asObject(await callSyncthing(instance, (client) => client.request<unknown>("GET", "/config/options")));
}

/** The part of `change` the node does not have yet, so an option already set is never sent. */
function pendingPart(current: SyncthingObject, change: ConnectionOptionsChange): ConnectionOptionsChange {
  return Object.fromEntries(Object.entries(change).filter(([key, value]) => !isChangeInPlace(current, { [key]: value })));
}

function labelWords(key: ConnectionOptionKey): string {
  return connectionOptionLabels[key].replace(/^[A-Z](?=[a-z])/, (letter) => letter.toLowerCase());
}

function valueWords(key: ConnectionOptionKey, value: unknown): string {
  if (typeof value === "boolean") return value ? "on" : "off";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "none";
  if (key === "maxSendKbps" || key === "maxRecvKbps") return value === 0 ? "unlimited" : `${value} KiB/s`;
  return String(value);
}

/** What an options edit changed on one node, in words: `pc: changed connection options; relays on; send limit 1000 KiB/s`. */
export function optionsEditText(nodeName: string, change: ConnectionOptionsChange): string {
  const details = (Object.entries(change) as [ConnectionOptionKey, unknown][]).map(([key, value]) => `${labelWords(key)} ${valueWords(key, value)}`);
  return [`${nodeName}: changed connection options`, ...details].join("; ");
}

/** The node's options as they now stand; null when the node stops answering after the write, as Syncthing restarts after some changes. */
async function optionsNow(instance: LocalInstance): Promise<InstanceOptions | null> {
  return nodeOptions(instance).then(
    (answer) => answer.options,
    () => null,
  );
}

interface NodeEditDone {
  result: NodeOptionsEdit;
  note: WriteNote | null;
}

async function editNodeOptions(instance: LocalInstance, change: ConnectionOptionsChange, readBackDelaysMs: readonly number[]): Promise<NodeEditDone> {
  const pending = pendingPart(await syncthingOptions(instance), change);
  const named = { nodeId: instance.nodeId, name: instance.name, problem: null };
  if (Object.keys(pending).length === 0) return { result: { ...named, outcome: "unchanged", options: await optionsNow(instance) }, note: null };
  await writeConfirmed(
    instance,
    (client) => client.request("PATCH", "/config/options", pending),
    async () => isChangeInPlace(await syncthingOptions(instance), pending),
    readBackDelaysMs,
  );
  const note: WriteNote = { nodeId: instance.nodeId, nodeName: instance.name, folderId: null, text: optionsEditText(instance.name, pending) };
  return { result: { ...named, outcome: "saved", options: await optionsNow(instance) }, note };
}

function notChanged(node: Pick<HostNode, "nodeId" | "name">, outcome: OptionsEditOutcome, problem: string): NodeEditDone {
  return { result: { nodeId: node.nodeId, name: node.name, outcome, problem, options: null }, note: null };
}

/**
 * Another node of an edit applied to the whole host; an array is left out.
 * @implNote An array's options are changed only on its own card: the private array holds the PC's pending folders (HANDOFF decision 1),
 * so no click on another node's card may change it.
 */
async function editOtherHostNode(node: HostNode, change: ConnectionOptionsChange, readBackDelaysMs: readonly number[]): Promise<NodeEditDone> {
  if (node.source === "array") return notChanged(node, "skipped", `${node.name} is an array: change its options on its own card`);
  return editHostNode(node, change, readBackDelaysMs);
}

/** One node of an edit applied to the whole host: its failure is reported in the answer and does not stop the other nodes. */
async function editHostNode(node: HostNode, change: ConnectionOptionsChange, readBackDelaysMs: readonly number[]): Promise<NodeEditDone> {
  if (!node.present) return notChanged(node, "not connected", `${node.name} is not connected, so it was not changed`);
  if (!node.instance) return notChanged(node, "failed", `${node.name}'s Syncthing is not answering`);
  try {
    return await editNodeOptions(node.instance, change, readBackDelaysMs);
  } catch (error) {
    return notChanged(node, error instanceof UnconfirmedWrite ? "maybe saved" : "failed", (error as Error).message);
  }
}

export type HostNode = Pick<LocalNodeInfo, "nodeId" | "name" | "source" | "instance" | "present">;

interface ListedAddress {
  nodeName: string;
  address: string;
}

/** The listen addresses each other answering node of this host lists now; a node that cannot be read is left out. */
async function otherNodesAddresses(instance: LocalInstance, hostNodes: HostNode[]): Promise<ListedAddress[]> {
  const others = hostNodes.filter((node) => node.nodeId !== instance.nodeId && node.instance !== null);
  const listed = await Promise.all(
    others.map(async (node) => {
      const options = await syncthingOptions(node.instance as LocalInstance).catch(() => ({}) as SyncthingObject);
      return instanceOptions(options, "").listenAddresses.map((address) => ({ nodeName: node.name, address }));
    }),
  );
  return listed.flat();
}

/**
 * Refuses a listen address on a port another node of this host lists, `default` counting as 22000.
 * @implNote The nodes share the host's ports (the gateway's namespace for container nodes), so a second node on one would fail to listen.
 */
async function refuseTakenPorts(instance: LocalInstance, addresses: string[], hostNodes: HostNode[]): Promise<void> {
  const listed = await otherNodesAddresses(instance, hostNodes);
  for (const address of addresses) {
    const port = listenPort(address);
    const taken = port === null ? undefined : listed.find((entry) => listenPort(entry.address) === port);
    if (taken) throw new RequestError(400, `${address} listens on port ${port}, which ${taken.nodeName} already lists (${taken.address})`);
  }
}

export interface OptionsEdit {
  answer: OptionsEditResponse;
  outcome: WriteOutcome;
}

function editOutcome(done: NodeEditDone[]): WriteOutcome {
  const notes = done.flatMap((entry) => (entry.note ? [entry.note] : []));
  return notes.length ? (notes as [WriteNote, ...WriteNote[]]) : { nothingWritten: true };
}

/**
 * Sends the connection options the person changed to the node's Syncthing, or, with `hostNodes`, to every node of this host,
 * the node in the path first; each node is sent only the options it does not have yet. The host's nodes are listed only once the change is valid.
 * @implNote An edit for the whole host never carries listen addresses: each node listens on its own port from `access/PORTS.md`.
 */
export async function editOptions(
  instance: ResolvedInstance,
  change: unknown,
  hostNodes: () => Promise<HostNode[]>,
  applyToHost: boolean,
  readBackDelaysMs: readonly number[] = defaultReadBackDelaysMs,
): Promise<OptionsEdit> {
  const local = requireLocal(instance);
  const problem = optionsChangeProblem(change, applyToHost);
  if (problem) throw new RequestError(400, problem);
  const valid = change as ConnectionOptionsChange;
  if (!applyToHost) {
    if (valid.listenAddresses) await refuseTakenPorts(local, valid.listenAddresses, await hostNodes());
    const done = await editNodeOptions(local, valid, readBackDelaysMs);
    return { answer: { nodes: [done.result] }, outcome: editOutcome([done]) };
  }
  const done = [await editHostNode({ nodeId: local.nodeId, name: local.name, source: local.source, instance: local, present: true }, valid, readBackDelaysMs)];
  for (const node of (await hostNodes()).filter((candidate) => candidate.nodeId !== local.nodeId)) done.push(await editOtherHostNode(node, valid, readBackDelaysMs));
  return { answer: { nodes: done.map((entry) => entry.result) }, outcome: editOutcome(done) };
}

function isAppliedToHost(url: URL): boolean {
  const applyTo = url.searchParams.get("applyTo");
  if (applyTo !== null && applyTo !== "host") throw new RequestError(400, `applyTo takes only host, not ${applyTo}`);
  return applyTo === "host";
}

export interface OptionsRouteSources {
  resolve(nodeId: string): Promise<ResolvedInstance>;
  /** Every node of this host, for an edit applied to all of them. */
  hostNodes(): Promise<HostNode[]>;
  /** The waits between read-backs of an edit whose answer was lost; tests shorten them. */
  readBackDelaysMs?: readonly number[];
}

const liveSources: OptionsRouteSources = { resolve: (nodeId) => resolveInstance(nodeId), hostNodes: () => localNodeInfos() };

export function optionsRoutes(sources: OptionsRouteSources = liveSources): AnyRoute[] {
  const optionsPattern = /^\/api\/nodes\/([^/]+)\/options$/;
  return [
    { method: "GET", pattern: /^\/api\/settings$/, handle: async ({ response }) => sendJson(response, 200, hostSettings(await layoutOrNull())) },
    {
      method: "GET",
      pattern: optionsPattern,
      handle: async ({ response, params: [nodeId] }) => sendJson(response, 200, await nodeOptions(await sources.resolve(decodedNodeId(nodeId)))),
    },
    {
      method: "PATCH",
      pattern: optionsPattern,
      write: async ({ request, response, url, params: [nodeId] }) => {
        const appliedToHost = isAppliedToHost(url);
        const instance = await sources.resolve(decodedNodeId(nodeId));
        const edit = await editOptions(instance, await readBody(request), sources.hostNodes, appliedToHost, sources.readBackDelaysMs);
        sendJson(response, 200, edit.answer);
        return edit.outcome;
      },
    },
  ];
}
