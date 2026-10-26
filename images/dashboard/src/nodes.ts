import type { NodeArray, NodeRegistryEntry, NodesResponse, StorageNode, Warning } from "./api/types.js";
import { type ArrayStatus, arrayIds, arrayStatus, listedArrayIds } from "./arrayStatus.js";
import { folderErrorWarnings, fromOtherHost, fullWarnings, hostWarnings, offlineWarnings, pendingWarnings, pruneFirstSeen, systemErrorWarnings, warning, withoutDuplicates } from "./attention.js";
import { type BlockDevice, listBlockDevices, replacementCandidates } from "./blockDevices.js";
import { type UnreadSources, recordPresentDrives } from "./driveHistory.js";
import { agentProblem, readHeartbeat } from "./hostAgent.js";
import { registryEntries, registryWarnings, syncthingEndpoint } from "./instances.js";
import { type JoinRecords } from "./join.js";
import { arrayMembers, isSerialMismatch, mountSources } from "./members.js";
import { parityState } from "./parity.js";
import { attentionSettings, hostName, peerDashboards, poolPath, registryDirectory } from "./settings.js";
import { deviceSeenStore, localDeviceIds, recordDevices, rememberedLocalNodes } from "./seenStore.js";
import { type InstanceView, classifyConnections, instanceView, peerSync } from "./syncthing.js";
import { fetchTailnetJson } from "./tailnet.js";
import { readdir, statfs } from "node:fs/promises";

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

export function arrayHealth(status: ArrayStatus): NodeArray["state"] {
  if (!status.present) return "absent";
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
    sync: view?.sync ?? offlineSync(status.present ? null : status.updated),
    offersWaiting: view?.offersWaiting ?? 0,
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
    offersWaiting: view?.offersWaiting ?? 0,
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
  if (!status.present) {
    const text = [`${status.name} is not connected to this host`, ...status.reasons].join(": ");
    warnings.push(warning({ id: `absent:${status.id}`, level: "info", kind: "offline", text, nodeId }));
  } else if (status.state !== "healthy" || !status.complete) {
    const level = status.state === "stopped" ? "error" : "warning";
    for (const reason of status.reasons) warnings.push(warning({ id: `array:${status.id}:${reason.split(" is ")[0]}`, level, kind: "array", text: `${status.name}: ${reason}`, nodeId }));
  }
  if (status.present && status.state === "stopped") warnings.push(warning({ id: `array:${status.id}:frozen`, level: "error", kind: "array", text: `${status.name} is frozen: the share is read-only and Syncthing paused`, nodeId }));
  for (const folder of status.present ? status.splitFolders : []) {
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

/**
 * @param agentNodes filled with device ID to node ID of each local node the host agent names, so an
 * offline node is not listed a second time as an offline device.
 * @param unread filled with what could not be read, so its drives are not taken as gone.
 */
async function localNodes(warnings: Warning[], views: InstanceView[], agentNodes: Map<string, string>, unread: UnreadSources): Promise<StorageNode[]> {
  const [devices, sources, entries, listed, registryListed] = await Promise.all([
    listBlockDevices(),
    mountSources(),
    registryEntries(),
    listedArrayIds(),
    readdir(registryDirectory).then(() => true, () => false),
  ]);
  unread.allArrays = listed === null;
  unread.nodes = !registryListed;
  const nodes: StorageNode[] = [];
  for (const id of await arrayIds(listed)) {
    const status = await arrayStatus(id);
    if (!status && listed?.includes(id)) unread.arrayIds.push(id);
    if (!status) continue;
    const endpoint = await syncthingEndpoint(id);
    const view = endpoint && status.present ? await instanceView(id, endpoint, status.name) : null;
    if (view) views.push(view);
    const node = await arrayNode(status, devices, sources, view);
    nodes.push(node);
    warnings.push(...arrayWarnings(status, node), ...nodeWarnings(node, view));
  }
  for (const entry of entries) {
    const endpoint = entry.present ? await syncthingEndpoint(entry.id, entry) : null;
    const view = endpoint ? await instanceView(entry.id, endpoint, entry.name) : null;
    if (view) views.push(view);
    const node = registryNode(entry, view);
    nodes.push(node);
    warnings.push(...nodeWarnings(node, view));
    if (!entry.present) warnings.push(warning({ id: `absent:${entry.id}`, level: "info", kind: "offline", text: `${entry.name} is not attached to this host`, nodeId: entry.id }));
  }
  const heartbeat = await readHeartbeat();
  for (const agentNode of heartbeat?.nodes ?? []) if (agentNode.syncthing?.deviceId) agentNodes.set(agentNode.syncthing.deviceId, agentNode.id);
  warnings.push(...hostWarnings(hostName, await registryWarnings(), agentProblem(heartbeat), heartbeat?.problems ?? []));
  return nodes;
}

async function remoteNodes(warnings: Warning[]): Promise<StorageNode[]> {
  const answers = await Promise.all(
    peerDashboards.map(async (peer) => {
      try {
        const dashboardUrl = peer.replace(/\/$/, "");
        const answer = await fetchTailnetJson<NodesResponse>(`${dashboardUrl}/api/nodes?scope=local`);
        warnings.push(...answer.warnings.map((entry) => fromOtherHost(entry, answer.host.name)));
        return answer.nodes.map((node) => ({ ...node, offersWaiting: node.offersWaiting ?? 0, local: false, host: node.host || answer.host.name, dashboardUrl }));
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
 * one; the state is what Syncthing sees. An instance of this host, running or not, is never one: it
 * is a node of this host already.
 */
export async function syncthingOnlyNodes(known: StorageNode[], views: InstanceView[], records: JoinRecords, localDeviceIds: ReadonlySet<string>): Promise<StorageNode[]> {
  const reported = new Set([...known.map((node) => node.syncthing?.deviceId).filter(Boolean), ...localDeviceIds]);
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
        sync: peerSync(peer),
        offersWaiting: 0,
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

async function rememberDevices(views: InstanceView[], running: ReadonlyMap<string, string>): Promise<void> {
  try {
    await recordDevices(views, running, new Date());
  } catch (error) {
    console.error(`devices seen file not written: ${(error as Error).message}`);
  }
}

async function rememberDrives(nodes: StorageNode[], unread: UnreadSources): Promise<void> {
  try {
    await recordPresentDrives(nodes, hostName, new Date(), undefined, unread);
  } catch (error) {
    console.error(`drives seen file not written: ${(error as Error).message}`);
  }
}

/** A local node without a running instance carries the device ID it is remembered by, so its peer rows fold into it. */
export function withRememberedDevice(node: StorageNode, remembered: ReadonlyMap<string, string>, local: ReadonlySet<string>): StorageNode {
  if (node.syncthing) return node;
  const deviceId = [...remembered].find(([candidate, nodeId]) => nodeId === node.id && local.has(candidate))?.[0];
  return deviceId ? { ...node, syncthing: { deviceId, addresses: [], connectionType: null, inRate: 0, outRate: 0, version: null } } : node;
}

/**
 * @implNote Other hosts are read before peers are classified, because a remembered instance stops
 * being this host's once another dashboard reports its node; a local-scope build uses the last
 * full build's answers.
 */
export async function nodesResponse(scope: "all" | "local", records: JoinRecords): Promise<NodesResponse> {
  const warnings: Warning[] = [];
  const views: InstanceView[] = [];
  const agentNodes = new Map<string, string>();
  const unread: UnreadSources = { allArrays: false, arrayIds: [], nodes: false };
  if (scope === "local") refreshOtherHostNodes(records);
  const ownNodes = await localNodes(warnings, views, agentNodes, unread);
  const otherHostNodes = scope === "all" ? await remoteNodes(warnings) : cachedOtherHostNodes();
  const running = new Map([...views.map((view): [string, string] => [view.device.deviceId, view.nodeId]), ...agentNodes]);
  const remembered = rememberedLocalNodes(await deviceSeenStore.load());
  const local = localDeviceIds({ running, remembered, localNodeIds: new Set(ownNodes.map((node) => node.id)), otherHostNodes });
  classifyConnections(views, local);
  await rememberDevices(views, running);
  await rememberDrives(ownNodes, unread);
  const nodes = ownNodes.map((node) => withRememberedDevice(node, remembered, local));
  if (scope === "all") {
    nodes.push(...otherHostNodes);
    nodes.push(...(await syncthingOnlyNodes(nodes, views, records, local)));
    lastOtherHostNodes = { at: Date.now(), nodes: nodes.filter((node) => !node.local) };
  }
  warnings.push(...offlineWarnings(nodes, attentionSettings, Date.now(), local));
  const unique = withoutDuplicates(warnings);
  if (scope === "all") pruneFirstSeen(unique);
  return { host: { name: hostName }, nodes, warnings: unique };
}

function isOtherHostNodesFresh(): boolean {
  return lastOtherHostNodes !== null && Date.now() - lastOtherHostNodes.at < otherHostNodesMaxAgeMilliseconds;
}

let otherHostRefresh: Promise<void> | null = null;

/**
 * Starts a full build when the other hosts' nodes are missing or stale, so a local-scope build, which
 * reads only the cache, stops counting a moved array as this host's soon after a restart.
 * @implNote Never awaited: another host's full build reads this host's local scope, and waiting here
 * would have two hosts wait on each other; the in-flight build is shared, so a burst starts one.
 */
export function refreshOtherHostNodes(records: JoinRecords): void {
  if (peerDashboards.length === 0 || otherHostRefresh || isOtherHostNodesFresh()) return;
  otherHostRefresh = nodesResponse("all", records)
    .then(
      () => undefined,
      (error: Error) => console.error(`other hosts' nodes not refreshed: ${error.message}`),
    )
    .finally(() => {
      otherHostRefresh = null;
    });
}

/** The other hosts' nodes as the last full `/api/nodes` built them, however old; never builds them. */
export function cachedOtherHostNodes(): StorageNode[] {
  return lastOtherHostNodes?.nodes ?? [];
}

/**
 * The nodes of other hosts and those only Syncthing knows, as the last full `/api/nodes` built them.
 * @implNote The page polls `/api/nodes` every 5 s, so the list is nearly always fresh; only a stale or
 * missing one costs a full build, which reads every peer dashboard and every local instance.
 */
export async function otherHostNodes(records: JoinRecords): Promise<StorageNode[]> {
  if (lastOtherHostNodes && isOtherHostNodesFresh()) return lastOtherHostNodes.nodes;
  return (await nodesResponse("all", records)).nodes.filter((node) => !node.local);
}
