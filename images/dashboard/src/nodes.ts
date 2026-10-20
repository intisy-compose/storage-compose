import type { NodeArray, NodeRegistryEntry, NodesResponse, StorageNode, Warning, WarningLevel } from "./api/types.js";
import { type ArrayStatus, arrayIds, arrayStatus } from "./arrayStatus.js";
import { type BlockDevice, listBlockDevices, replacementCandidates } from "./blockDevices.js";
import { agentProblem, readHeartbeat } from "./hostAgent.js";
import { registryEntries, registryWarnings, syncthingEndpoint } from "./instances.js";
import { type JoinRecords } from "./join.js";
import { arrayMembers, isSerialMismatch, mountSources } from "./members.js";
import { parityState } from "./parity.js";
import { hostName, inventoryAssetUrl, peerDashboards, poolPath } from "./settings.js";
import { type InstanceView, instanceView } from "./syncthing.js";
import { fetchTailnetJson } from "./tailnet.js";
import { statfs } from "node:fs/promises";

const firstSeen = new Map<string, string>();

function warning(id: string, level: WarningLevel, text: string, nodeId: string | null): Warning {
  if (!firstSeen.has(id)) firstSeen.set(id, new Date().toISOString());
  return { id, at: firstSeen.get(id)!, level, text, nodeId };
}

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
    folders: view?.folders ?? [],
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
    folders: view?.folders ?? [],
  };
}

function arrayWarnings(status: ArrayStatus, node: StorageNode): Warning[] {
  const warnings: Warning[] = [];
  if (status.state !== "healthy" || !status.complete) {
    for (const reason of status.reasons) warnings.push(warning(`array:${status.id}:${reason.split(" is ")[0]}`, status.state === "stopped" ? "error" : "warning", `${status.name}: ${reason}`, status.id));
  }
  if (status.state === "stopped") warnings.push(warning(`array:${status.id}:frozen`, "error", `${status.name} is frozen: the share is read-only and Syncthing paused`, status.id));
  for (const folder of status.splitFolders) warnings.push(warning(`split:${status.id}:${folder.id}`, "warning", `Syncthing folder ${folder.id} lies on ${folder.drives.join(", ")}; move it onto one drive`, status.id));
  for (const member of node.array?.members ?? []) {
    if (member.smart?.state === "fail") warnings.push(warning(`smart:${member.label}`, "error", `${member.label}: ${member.smart.detail}`, status.id));
    const recorded = status.description?.array?.members.find((entry) => entry.label === member.label)?.serial;
    if (member.present && isSerialMismatch(recorded, member.serial)) {
      warnings.push(warning(`serial:${member.label}`, "warning", `${member.label} has serial ${member.serial}, the array's description says ${recorded}`, status.id));
    }
  }
  if (node.array?.parity.refused) warnings.push(warning(`refused:${status.id}`, "warning", `${status.name}: sync refused, ${node.array.parity.refused}`, status.id));
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
    warnings.push(...arrayWarnings(status, node));
  }
  for (const entry of entries) {
    const endpoint = entry.present ? await syncthingEndpoint(entry.id, entry) : null;
    const view = endpoint ? await instanceView(entry.id, endpoint) : null;
    if (view) views.push(view);
    nodes.push(registryNode(entry, view));
    if (!entry.present) warnings.push(warning(`absent:${entry.id}`, "info", `${entry.name} is not attached to this host`, entry.id));
  }
  for (const text of await registryWarnings()) warnings.push(warning(`registry:${text}`, "warning", text, null));
  const heartbeat = await readHeartbeat();
  const problem = agentProblem(heartbeat);
  if (problem) warnings.push(warning("host-agent", "error", problem, null));
  for (const text of heartbeat?.problems ?? []) warnings.push(warning(`host-agent:${text}`, "warning", `host agent: ${text}`, null));
  return nodes;
}

async function remoteNodes(warnings: Warning[]): Promise<StorageNode[]> {
  const answers = await Promise.all(
    peerDashboards.map(async (peer) => {
      try {
        const answer = await fetchTailnetJson<NodesResponse>(`${peer.replace(/\/$/, "")}/api/nodes?scope=local`);
        return answer.nodes.map((node) => ({ ...node, local: false, host: node.host || answer.host.name }));
      } catch (error) {
        warnings.push(warning(`peer:${peer}`, "warning", `${peer} could not be reached (${(error as Error).message}); its nodes show Syncthing's view`, null));
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
        folders: [],
      });
    }
  }
  return [...nodes.values()];
}

export async function nodesResponse(scope: "all" | "local", records: JoinRecords): Promise<NodesResponse> {
  const warnings: Warning[] = [];
  const views: InstanceView[] = [];
  const nodes = await localNodes(warnings, views);
  if (scope === "all") {
    nodes.push(...(await remoteNodes(warnings)));
    nodes.push(...(await syncthingOnlyNodes(nodes, views, records)));
  }
  return { host: { name: hostName }, nodes, warnings, settings: { inventoryItemUrl: inventoryAssetUrl || null } };
}
