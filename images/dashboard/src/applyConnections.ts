import type { ConnectionProfile, NodeAddresses, PeerTable } from "./api/types.js";
import { type ApplyReport, recordDrift } from "./connectionsDrift.js";
import { type LocalInstance, callSyncthing, defaultReadBackDelaysMs, localInstances, writeConfirmed } from "./instanceResolver.js";
import { localPeerTable, readRemoteTable } from "./peerSources.js";
import { type NodeConnections, buildPeerTable, resolveNode, writeConnectionsFile } from "./peerTable.js";
import { connectionsFile, hostAgentConnectionsFile, peerDashboards } from "./settings.js";
import { pullDataRepo, readProfile } from "./setupRepo.js";
import { isChangeInPlace } from "./syncthingConfig.js";

export type { ApplyReport } from "./connectionsDrift.js";

/** Where a round reads and writes; tests replace each with a fake. */
export interface ApplyDependencies {
  pull: () => Promise<void>;
  profile: () => Promise<ConnectionProfile>;
  localTable: () => Promise<PeerTable>;
  dashboards: string[];
  /** Null for a dashboard that could not be read. */
  remoteTable: (dashboardUrl: string) => Promise<PeerTable | null>;
  instances: () => Promise<LocalInstance[]>;
  /** The same content to each: `/status/connections.json` for the nodes service and the cluster, and the host agent's copy. */
  connectionsFiles: string[];
  readBackDelaysMs: readonly number[];
}

type SyncthingObject = Record<string, unknown>;

interface LastRound {
  profile: ConnectionProfile;
  table: PeerTable;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function configuredOptions(instance: LocalInstance): Promise<SyncthingObject> {
  return (await callSyncthing(instance, (client) => client.request<SyncthingObject | null>("GET", "/config/options"))) ?? {};
}

async function configuredDevices(instance: LocalInstance): Promise<SyncthingObject[]> {
  return (await callSyncthing(instance, (client) => client.request<SyncthingObject[] | null>("GET", "/config/devices"))) ?? [];
}

function pendingOptions(current: SyncthingObject, wanted: SyncthingObject): SyncthingObject {
  return Object.fromEntries(Object.entries(wanted).filter(([key, value]) => !isChangeInPlace(current, { [key]: value })));
}

/**
 * Every round over this host's nodes, and what the last one built.
 * @implNote A remote dashboard's table is kept from the last round that read it, for as long as this process runs, and replaced
 * whenever that dashboard answers again: a passing network failure must never strip a peer's addresses down to `dynamic`.
 */
export class ConnectionsRound {
  private readonly remoteTables = new Map<string, PeerTable>();
  private last: LastRound | null = null;

  constructor(private readonly dependencies: ApplyDependencies) {}

  async run(): Promise<ApplyReport> {
    await this.dependencies.pull().catch(() => undefined);
    const profile = await this.dependencies.profile();
    const local = await this.dependencies.localTable();
    const table = buildPeerTable(local.nodes, local.bridges, await this.readRemoteTables(), local.builtAt);
    const byNode = Object.fromEntries(local.nodes.map((node) => [node.nodeId, resolveNode(profile, table, node.nodeId)]));
    for (const path of this.dependencies.connectionsFiles) {
      await writeConnectionsFile(path, byNode).catch((error) => console.error(`connections: ${path} not written: ${reasonOf(error)}`));
    }
    this.last = { profile, table };
    const report = await this.applyAll(byNode);
    recordDrift(report);
    return report;
  }

  /** The last round's table, null before the first round. */
  lastTable(): PeerTable | null {
    return this.last?.table ?? null;
  }

  /** A node's entry from the last round's profile and table, with `node` in place of any entry of the same ID; null before the first round. */
  connectionsFor(node: NodeAddresses): NodeConnections | null {
    if (!this.last) return null;
    const table = { ...this.last.table, nodes: [...this.last.table.nodes.filter((entry) => entry.nodeId !== node.nodeId), node] };
    return resolveNode(this.last.profile, table, node.nodeId);
  }

  private async readRemoteTables(): Promise<PeerTable[]> {
    const { dashboards, remoteTable } = this.dependencies;
    const answers = await Promise.all(dashboards.map((dashboardUrl) => remoteTable(dashboardUrl).catch(() => null)));
    answers.forEach((answer, index) => {
      if (answer) this.remoteTables.set(dashboards[index], answer);
    });
    return dashboards.flatMap((dashboardUrl) => this.remoteTables.get(dashboardUrl) ?? []);
  }

  private async applyAll(byNode: Record<string, NodeConnections>): Promise<ApplyReport> {
    const report: ApplyReport = { applied: [], notYet: [], failed: {} };
    const instances = await this.dependencies.instances();
    for (const instance of instances) {
      const entry = byNode[instance.nodeId];
      if (!entry) {
        report.notYet.push(instance.nodeId);
        continue;
      }
      try {
        await this.applyOne(instance, entry);
        report.applied.push(instance.nodeId);
      } catch (error) {
        report.failed[instance.nodeId] = reasonOf(error);
      }
    }
    const answered = new Set(instances.map((instance) => instance.nodeId));
    report.notYet.push(...Object.keys(byNode).filter((nodeId) => !answered.has(nodeId)));
    return report;
  }

  /** @implNote Only `addresses` of devices the node already has: never a device added, never introducer or auto-accept, never a folder, so an array's pending folders stay pending. */
  private async applyOne(instance: LocalInstance, entry: NodeConnections): Promise<void> {
    const delays = this.dependencies.readBackDelaysMs;
    const options = pendingOptions(await configuredOptions(instance), { ...entry.options, listenAddresses: entry.listenAddresses });
    if (Object.keys(options).length > 0) {
      await writeConfirmed(
        instance,
        (client) => client.request("PATCH", "/config/options", options),
        async () => isChangeInPlace(await configuredOptions(instance), options),
        delays,
      );
    }
    for (const device of await configuredDevices(instance)) {
      const deviceId = String(device.deviceID);
      const addresses = entry.deviceAddresses[deviceId];
      if (!addresses || isChangeInPlace(device, { addresses })) continue;
      await writeConfirmed(
        instance,
        (client) => client.request("PATCH", `/config/devices/${encodeURIComponent(deviceId)}`, { addresses }),
        async () => isChangeInPlace((await configuredDevices(instance)).find((entry) => entry.deviceID === deviceId) ?? {}, { addresses }),
        delays,
      );
    }
  }
}

export const connectionsRound = new ConnectionsRound({
  pull: () => pullDataRepo(),
  profile: async () => (await readProfile()).profile,
  localTable: () => localPeerTable(),
  dashboards: peerDashboards,
  remoteTable: readRemoteTable,
  instances: () => localInstances(),
  connectionsFiles: [connectionsFile, hostAgentConnectionsFile],
  readBackDelaysMs: defaultReadBackDelaysMs,
});

export function applyRound(): Promise<ApplyReport> {
  return connectionsRound.run();
}

/** A round now and then every `seconds`, one at a time; the returned function stops them. */
export function startConnectionRounds(seconds: number, round: () => Promise<ApplyReport> = applyRound): () => void {
  let running = false;
  const once = async () => {
    if (running) return;
    running = true;
    try {
      const report = await round();
      for (const [nodeId, reason] of Object.entries(report.failed)) console.error(`connections: ${nodeId} not brought onto the profile: ${reason}`);
    } catch (error) {
      console.error(`connections: round failed: ${reasonOf(error)}`);
    } finally {
      running = false;
    }
  };
  void once();
  const timer = setInterval(() => void once(), seconds * 1000);
  return () => clearInterval(timer);
}
