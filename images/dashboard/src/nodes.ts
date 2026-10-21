import type { NodeArray, NodeRegistryEntry, NodesResponse, StorageNode, Warning } from "./api/types.js";
import { type ArrayStatus, arrayIds, arrayStatus } from "./arrayStatus.js";
import { folderErrorWarnings, fullWarnings, offlineWarnings, pendingWarnings, systemErrorWarnings, warning } from "./attention.js";
import { type BlockDevice, listBlockDevices, replacementCandidates } from "./blockDevices.js";
import { agentProblem, readHeartbeat } from "./hostAgent.js";
import { registryEntries, registryWarnings, syncthingEndpoint } from "./instances.js";
import { type JoinRecords } from "./join.js";
import { arrayMembers, isSerialMismatch, mountSources } from "./members.js";
import { parityState } from "./parity.js";
import { attentionSettings, hostName, peerDashboards, poolPath } from "./settings.js";
import { type InstanceView, instanceView } from "./syncthing.js";
import { fetchTailnetJson } from "./tailnet.js";
import { statfs } from "node:fs/promises";

async function space(path: string): Promise<{ size: number; used: number } | null> {
  try {
    const stats = await statfs(path);
    return { size: stats.blocks * stats.bsize, used: (stats.blocks - stats.bfree) * stats.bsize };
  } catch {
    return null;
  }
}

function offlineSync(lastSeen: string | null = null) {
  return { state: "offline" as const, completion: 0, lastSeen };
}

function arrayHealth(status: ArrayStatus): NodeArray["state"] {
  return status.state === "stopped" ? "frozen" : status.state;
}

async function arrayNode(status: ArrayStatus, devices: BlockDevice[], sources: Map<string, string>, view: InstanceView | null): Promise<StorageNode> {
  const description = status.description?.node;
  return {
    id: status.id,
    name: status.name,
    kind: "array",
    threshold: description?.threshold ?? 0,
    assigned: description?.assigned ?? [],
    local: true,
    online: status.present,
    host: hostName,
    space: status.present ? await space(poolPath(status.id)) : null,
    sync: view?.sync ?? offlineSync(),
    array: {
      state: arrayHealth(status),
      members: await arrayMembers(status, devices, sources),
      parity: await parityState(status.id),
      candidates: replacementCandidates(devices),
      reasons: status.reasons,
    },
    syncthing: view?.device ?? null,
    instance: view?.instance ?? null,
    peers: view?.peers ?? [],
    folders: view?.folders ?? [],
    dashboardUrl: null,
  };
}

function registryNode(entry: NodeRegistryEntry, view: InstanceView | null): StorageNode {
  const hasSpace = entry.space.size !== null && entry.space.used !== null;
  return {
    id: entry.id,
    name: entry.name,
    kind: entry.kind,
    threshold: entry.threshold,
    assigned: entry.assigned,
    local: true,
    online: entry.present,
    host: hostName,
    space: hasSpace ? { size: entry.space.size!, used: entry.space.used! } : null,
    sync: entry.present ? (view?.sync ?? offlineSync()) : offlineSync(entry.updated),
    syncthing: view?.device ?? null,
    instance: view?.instance ?? null,
    peers: view?.peers ?? [],
    folders: view?.folders ?? [],
    dashboardUrl: null,
  };
}

function arrayWarnings(status: ArrayStatus, node: StorageNode): Warning[] {
  const warnings: Warning[] = [];
  const nodeId = status.id;
  if (status.state !== "healthy" || !status.complete) {
    const level = status.state === "stopped" ? "error" : "warning";
    for (const reason of status.reasons) warnings.push(warning({ id: `array:${status.id}:${reason.split(" is ")[0]}`, level, kind: "array", text: `${status.name}: ${reason}`, nodeId }));
  }
  if (status.state === "stopped") warnings.push(warning({ id: `array:${status.id}:frozen`, level: "error", kind: "array", text: `${status.name} is frozen: the share is read-only and Syncthing paused`, nodeId }));
  for (const folder of status.splitFolders) {
    const text = `Syncthing folder ${folder.id} lies on ${folder.drives.join(", ")}; move it onto one drive`;
    warnings.push(warning({ id: `split:${status.id}:${folder.id}`, level: "warning", kind: "array", text, nodeId, folderId: folder.id }));
  }
  for (const member of node.array?.members ?? []) {
    if (member.smart?.state === "fail") warnings.push(warning({ id: `smart:${member.label}`, level: "error", kind: "smart", text: `${member.label}: ${member.smart.detail}`, nodeId }));
    const recorded = status.description?.array?.members.find((entry) => entry.label === member.label)?.serial;
    if (member.present && isSerialMismatch(recorded, member.serial)) {
      const text = `${member.label} has serial ${member.serial}, the array's description says ${recorded}`;
      warnings.push(warning({ id: `serial:${member.label}`, level: "warning", kind: "array", text, nodeId }));
    }
  }
  if (node.array?.parity.refused) warnings.push(warning({ id: `refused:${status.id}`, level: "warning", kind: "array", text: `${status.name}: sync refused, ${node.array.parity.refused}`, nodeId }));
  return warnings;
}

/** What a node's own Syncthing and its space say needs a person. */
function nodeWarnings(node: StorageNode, view: InstanceView | null): Warning[] {
  const warnings = [...folderErrorWarnings(node), ...fullWarnings(node, attentionSettings)];
  if (view) warnings.push(...systemErrorWarnings(node, view.systemErrors), ...pendingWarnings(node, view.pendingDevices, view.pendingFolders));
  return warnings;
}

async function localNodes(warnings: Warning[], views: InstanceView[]): Promise<StorageNode[]> {
  const [devices, sources, entries] = await Promise.all([listBlockDevices(), mountSources(), registryEntries()]);
  const nodes: StorageNode[] = [];
  for (const id of await arrayIds()) {
    const status = await arrayStatus(id);
    if (!status) continue;
    const endpoint = await syncthingEndpoint(id);
    const view = endpoint && status.present ? await instanceView(id, endpoint) : null;
    if (view) views.push(view);
    const node = await arrayNode(status, devices, sources, view);
    nodes.push(node);
    warnings.push(...arrayWarnings(status, node), ...nodeWarnings(node, view));
  }
  for (const entry of entries) {
    const endpoint = entry.present ? await syncthingEndpoint(entry.id, entry) : null;
    const view = endpoint ? await instanceView(entry.id, endpoint) : null;
    if (view) views.push(view);
    const node = registryNode(entry, view);
    nodes.push(node);
    warnings.push(...nodeWarnings(node, view));
    if (!entry.present) warnings.push(warning({ id: `absent:${entry.id}`, level: "info", kind: "offline", text: `${entry.name} is not attached to this host`, nodeId: entry.id }));
  }
  for (const text of await registryWarnings()) warnings.push(warning({ id: `registry:${text}`, level: "warning", kind: "registry", text, nodeId: null }));
  const heartbeat = await readHeartbeat();
  const problem = agentProblem(heartbeat);
  if (problem) warnings.push(warning({ id: "host-agent", level: "error", kind: "agent", text: problem, nodeId: null }));
  for (const text of heartbeat?.problems ?? []) warnings.push(warning({ id: `host-agent:${text}`, level: "warning", kind: "agent", text: `host agent: ${text}`, nodeId: null }));
  return nodes;
}

/** @implNote A host on an older dashboard sends warnings without a kind or folder. */
function fromOtherHost(entry: Warning): Warning {
  return { ...entry, kind: entry.kind ?? "peer", folderId: entry.folderId ?? null };
}

function withoutDuplicates(warnings: Warning[]): Warning[] {
  return [...new Map(warnings.map((entry) => [entry.id, entry])).values()];
}

async function remoteNodes(warnings: Warning[]): Promise<StorageNode[]> {
  const answers = await Promise.all(
    peerDashboards.map(async (peer) => {
      try {
        const dashboardUrl = peer.replace(/\/$/, "");
        const answer = await fetchTailnetJson<NodesResponse>(`${dashboardUrl}/api/nodes?scope=local`);
        warnings.push(...answer.warnings.map(fromOtherHost));
        return answer.nodes.map((node) => ({ ...node, local: false, host: node.host || answer.host.name, dashboardUrl }));
      } catch (error) {
        const text = `${peer} could not be reached (${(error as Error).message}); its nodes show Syncthing's view`;
        warnings.push(warning({ id: `peer:${peer}`, level: "warning", kind: "peer", text, nodeId: null }));
        return [];
      }
    }),
  );
  return answers.flat();
}

/**
 * Devices this host's Syncthing instances know that no dashboard reported: a joined device without a
 * dashboard, or a host that could not be reached. Their nodes come from the join record when there is
 * one; the state is what Syncthing sees.
 */
async function syncthingOnlyNodes(known: StorageNode[], views: InstanceView[], records: JoinRecords): Promise<StorageNode[]> {
  const reported = new Set(known.map((node) => node.syncthing?.deviceId).filter(Boolean));
  const joined = Object.values(await records.all());
  const nodes = new Map<string, StorageNode>();
  for (const view of views) {
    for (const peer of view.peers) {
      if (reported.has(peer.deviceId) || nodes.has(peer.deviceId)) continue;
      const record = joined.find((device) => device.syncthingDeviceId === peer.deviceId);
      const node = record?.nodes[0];
      nodes.set(peer.deviceId, {
        id: `device-${peer.deviceId.slice(0, 7).toLowerCase()}`,
        name: record?.name ?? (peer.name || peer.deviceId.slice(0, 7)),
        kind: node?.kind ?? "drive",
        threshold: node?.threshold ?? 0,
        assigned: [],
        local: false,
        online: peer.connected,
        host: record?.tailnetName || peer.name || "unknown",
        space: null,
        sync: peer.connected ? { state: peer.completion < 100 ? "syncing" : "idle", completion: peer.completion, lastSeen: new Date().toISOString() } : offlineSync(peer.lastSeen),
        syncthing: { deviceId: peer.deviceId, addresses: peer.address ? [peer.address] : [], connectionType: peer.connectionType, inRate: peer.inRate, outRate: peer.outRate, version: peer.version },
        instance: null,
        peers: [],
        folders: [],
        dashboardUrl: null,
      });
    }
  }
  return [...nodes.values()];
}

let lastOtherHostNodes: { at: number; nodes: StorageNode[] } | null = null;
const otherHostNodesMaxAgeMilliseconds = 60_000;

export async function nodesResponse(scope: "all" | "local", records: JoinRecords): Promise<NodesResponse> {
  const warnings: Warning[] = [];
  const views: InstanceView[] = [];
  const nodes = await localNodes(warnings, views);
  if (scope === "all") {
    nodes.push(...(await remoteNodes(warnings)));
    nodes.push(...(await syncthingOnlyNodes(nodes, views, records)));
    lastOtherHostNodes = { at: Date.now(), nodes: nodes.filter((node) => !node.local) };
  }
  warnings.push(...offlineWarnings(nodes, attentionSettings));
  return { host: { name: hostName }, nodes, warnings: withoutDuplicates(warnings) };
}

/**
 * The nodes of other hosts and those only Syncthing knows, as the last full `/api/nodes` built them.
 * @implNote The page polls `/api/nodes` every 5 s, so the list is nearly always fresh; only a stale or
 * missing one costs a full build, which reads every peer dashboard and every local instance.
 */
export async function otherHostNodes(records: JoinRecords): Promise<StorageNode[]> {
  if (lastOtherHostNodes && Date.now() - lastOtherHostNodes.at < otherHostNodesMaxAgeMilliseconds) return lastOtherHostNodes.nodes;
  return (await nodesResponse("all", records)).nodes.filter((node) => !node.local);
}
