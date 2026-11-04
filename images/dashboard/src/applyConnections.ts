import { profileFileProblemText } from "./api/profileText.js";
import type { ConnectionProfile, NodeAddresses, PeerTable } from "./api/types.js";
import { type ApplyReport, recordDrift, recordPeerTable } from "./connectionsDrift.js";
import { type LocalInstance, callSyncthing, defaultReadBackDelaysMs, localInstances, writeConfirmed } from "./instanceResolver.js";
import { localPeerTable, readRemoteTable } from "./peerSources.js";
import { type NodeConnections, buildPeerTable, resolveNode, writeConnectionsFile } from "./peerTable.js";
import { connectionsFile, hostAgentConnectionsFile, peerDashboards } from "./settings.js";
import { requiresRestart } from "./routes/nodeRestart.js";
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
  /** Nodes a round wrote to whose restart need is not yet known to be cleared. */
  private readonly awaitingRestart = new Set<string>();
  /** Nodes last read as needing a restart, each logged once when it started to. */
  private readonly knownWaiting = new Set<string>();
  private last: LastRound | null = null;
  private profileProblem: string | null = null;

  constructor(private readonly dependencies: ApplyDependencies) {}

  async run(): Promise<ApplyReport> {
    await this.dependencies.pull().catch(() => undefined);
    const profile = await this.readProfile();
    if (!profile) return { applied: [], restartNeeded: [], notYet: [], failed: {} };
    const local = await this.dependencies.localTable();
    const table = buildPeerTable(local.nodes, local.bridges, await this.readRemoteTables(), local.builtAt);
    const byNode = Object.fromEntries(local.nodes.map((node) => [node.nodeId, resolveNode(profile, table, node.nodeId)]));
    for (const path of this.dependencies.connectionsFiles) {
      await writeConnectionsFile(path, byNode).catch((error) => console.error(`connections: ${path} not written: ${reasonOf(error)}`));
    }
    this.last = { profile, table };
    recordPeerTable(table);
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

  /**
   * The profile, or the last one read while `connections.toml` cannot be (a hand edit with a value out of range, say); null
   * when none was ever read, so the round writes and sends nothing and every node keeps the settings and rules it has.
   * @implNote Rounds run every few seconds, so a lasting problem is logged once, when it starts or changes.
   */
  private async readProfile(): Promise<ConnectionProfile | null> {
    try {
      const profile = await this.dependencies.profile();
      this.noteProfileProblem(null);
      return profile;
    } catch (error) {
      this.noteProfileProblem(reasonOf(error));
      return this.last?.profile ?? null;
    }
  }

  private noteProfileProblem(problem: string | null): void {
    if (problem === this.profileProblem) return;
    if (problem) console.error(`connections: ${profileFileProblemText(problem, this.last !== null)}`);
    else console.error("connections: the profile can be read again");
    this.profileProblem = problem;
  }

  /** The profile the last round applied, null before the first round that could read one. */
  appliedProfile(): ConnectionProfile | null {
    return this.last?.profile ?? null;
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
    const report: ApplyReport = { applied: [], restartNeeded: [], notYet: [], failed: {} };
    const instances = await this.dependencies.instances();
    for (const instance of instances) {
      const entry = byNode[instance.nodeId];
      if (!entry) {
        report.notYet.push(instance.nodeId);
        continue;
      }
      try {
        await this.applyOne(instance, entry);
        const waits = await this.waitsForRestart(instance);
        (waits ? report.restartNeeded : report.applied).push(instance.nodeId);
      } catch (error) {
        report.failed[instance.nodeId] = reasonOf(error);
      }
    }
    const answered = new Set(instances.map((instance) => instance.nodeId));
    this.forgetWaitingOutside(answered);
    report.notYet.push(...Object.keys(byNode).filter((nodeId) => !answered.has(nodeId)));
    return report;
  }

  /** A node gone from this host's instances starts afresh when it answers again, as its Syncthing has started since. */
  private forgetWaitingOutside(instanceIds: ReadonlySet<string>): void {
    for (const nodeId of [...this.awaitingRestart]) if (!instanceIds.has(nodeId)) this.awaitingRestart.delete(nodeId);
    for (const nodeId of [...this.knownWaiting]) if (!instanceIds.has(nodeId)) this.knownWaiting.delete(nodeId);
  }

  /**
   * Whether the node holds the profile's values in its config but runs without them until its Syncthing restarts.
   * @implNote A round never restarts a node: a restart stops every folder of the node until it is back, and an array or the PC asks for its
   * name typed. The node's restart banner and Restart action, which read Syncthing's own flag, leave that to the person; the keepers also
   * apply the profile at the node's next start. The flag is read only when this round sent a write to the node or an earlier write's
   * need is still outstanding, so a restart left pending by some other change is never taken for the profile's. A read that fails keeps
   * what was known.
   */
  private async waitsForRestart(instance: LocalInstance): Promise<boolean> {
    if (!this.awaitingRestart.has(instance.nodeId)) return false;
    let required: boolean;
    try {
      required = await requiresRestart(instance);
    } catch {
      return this.knownWaiting.has(instance.nodeId);
    }
    if (!required) {
      this.awaitingRestart.delete(instance.nodeId);
      this.knownWaiting.delete(instance.nodeId);
      return false;
    }
    this.awaitingRestart.add(instance.nodeId);
    if (!this.knownWaiting.has(instance.nodeId)) console.error(`connections: ${instance.nodeId} has the profile's values saved; its Syncthing applies them after it restarts`);
    this.knownWaiting.add(instance.nodeId);
    return true;
  }

  /**
   * @implNote Only `addresses` of devices the node already has: never a device added, never introducer or auto-accept, never a folder, so an array's pending folders stay pending.
   * A node is marked as awaiting its restart need before each write is sent, as a write whose answer is lost may still have been applied.
   */
  private async applyOne(instance: LocalInstance, entry: NodeConnections): Promise<void> {
    const delays = this.dependencies.readBackDelaysMs;
    const options = pendingOptions(await configuredOptions(instance), { ...entry.options, listenAddresses: entry.listenAddresses });
    if (Object.keys(options).length > 0) {
      this.awaitingRestart.add(instance.nodeId);
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
      this.awaitingRestart.add(instance.nodeId);
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
