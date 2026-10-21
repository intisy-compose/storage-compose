import { type ActivityEntry, type ActivityLevel, type ActivityResponse, type ActivitySource, type ParityJob, routineActivityTypes } from "./api/types.js";
import { arrayIds, arrayStatus } from "./arrayStatus.js";
import { localInstances } from "./instanceResolver.js";
import { recentLog, runningJob } from "./parity.js";
import { activitySettings } from "./settings.js";
import type { SyncthingClient, SyncthingEvent } from "./syncthing.js";

export type NewActivityEntry = Omit<ActivityEntry, "id">;

export interface ActivityQuery {
  after?: string | null;
  node?: string | null;
  folder?: string | null;
  types?: string[];
  source?: ActivitySource | null;
  /** False leaves out scans and file changes. */
  routine?: boolean;
  limit?: number;
}

interface StoredEntry {
  entry: ActivityEntry;
  sequence: number;
}

const defaultLimit = 200;

function timeOf(at: string): number {
  const time = Date.parse(at);
  return Number.isFinite(time) ? time : 0;
}

function newestFirst(left: StoredEntry, right: StoredEntry): number {
  return timeOf(right.entry.at) - timeOf(left.entry.at) || right.sequence - left.sequence;
}

/**
 * The Activity entries in memory: ring buffers for each Syncthing instance (see `feedBufferKey`), each array and the dashboard.
 * @implNote An entry ID is `<start>-<sequence>`; a cursor from before the dashboard restarted names
 * another start, so `after` then returns everything rather than nothing.
 */
export class ActivityLog {
  private readonly start = Date.now().toString(36);
  private sequence = 0;
  private readonly buffers = new Map<string, StoredEntry[]>();

  constructor(readonly bufferSize: number) {}

  append(bufferKey: string, entry: NewActivityEntry): ActivityEntry {
    this.sequence += 1;
    const stored = { entry: { id: `${this.start}-${this.sequence}`, ...entry }, sequence: this.sequence };
    const buffer = this.buffers.get(bufferKey) ?? [];
    buffer.push(stored);
    if (buffer.length > this.bufferSize) buffer.splice(0, buffer.length - this.bufferSize);
    this.buffers.set(bufferKey, buffer);
    return stored.entry;
  }

  /** Drops the oldest entries of the buffer that match, so at most `count` of them stay. */
  keepNewest(bufferKey: string, matches: (entry: ActivityEntry) => boolean, count: number): void {
    const buffer = this.buffers.get(bufferKey);
    if (!buffer) return;
    let excess = buffer.filter((stored) => matches(stored.entry)).length - count;
    if (excess <= 0) return;
    this.buffers.set(
      bufferKey,
      buffer.filter((stored) => {
        if (excess <= 0 || !matches(stored.entry)) return true;
        excess -= 1;
        return false;
      }),
    );
  }

  entriesOf(bufferKey: string): readonly ActivityEntry[] {
    return (this.buffers.get(bufferKey) ?? []).map((stored) => stored.entry);
  }

  private sequenceAfter(cursor: string | null | undefined): number {
    const [start, sequence] = (cursor ?? "").split("-");
    return start === this.start ? Number(sequence) || 0 : 0;
  }

  query(query: ActivityQuery): ActivityResponse {
    const after = this.sequenceAfter(query.after);
    const types = query.types?.length ? new Set(query.types) : null;
    const matches = [...this.buffers.values()].flat().filter(({ entry, sequence }) =>
      sequence > after &&
      (!query.node || entry.nodeId === query.node) &&
      (!query.folder || entry.folderId === query.folder) &&
      (!query.source || entry.source === query.source) &&
      (!types || types.has(entry.type)) &&
      (query.routine !== false || !routineTypes.has(entry.type)),
    );
    const entries = matches.sort(newestFirst).slice(0, query.limit ?? defaultLimit).map((stored) => stored.entry);
    return { entries, cursor: `${this.start}-${this.sequence}` };
  }
}

/** A Syncthing instance the feeds follow; a `LocalInstance` is one. */
export interface FeedInstance {
  nodeId: string;
  name: string;
  client: SyncthingClient;
}

export interface FeedOptions {
  /** How long Syncthing holds a long poll open without events. */
  waitSeconds: number;
  /** Above `waitSeconds`, so a quiet poll is not taken for an instance that went away. */
  requestTimeoutMs: number;
  /** The pause before asking an instance that did not answer again. */
  retryMs: number;
}

export const defaultFeedOptions: FeedOptions = { waitSeconds: 50, requestTimeoutMs: 60_000, retryMs: 5_000 };

export const followedEventTypes = [
  "StateChanged",
  "FolderCompletion",
  "FolderErrors",
  "FolderPaused",
  "FolderResumed",
  "ItemFinished",
  "LocalChangeDetected",
  "RemoteChangeDetected",
  "DeviceConnected",
  "DeviceDisconnected",
  "DevicePaused",
  "DeviceResumed",
  "PendingDevicesChanged",
  "PendingFoldersChanged",
  "ConfigSaved",
  "Failure",
] as const;

/** Names and memory one instance's events are read with. */
interface EventContext {
  nodeName: string;
  deviceNames: Map<string, string>;
  folderLabels: Map<string, string>;
  /** The last completion seen per `<folder>/<device>`. */
  completions: Map<string, number>;
}

type EventData = Record<string, unknown>;
type Described = Pick<NewActivityEntry, "folderId" | "type" | "level" | "text">;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function deviceName(context: EventContext, deviceId: unknown): string {
  const id = text(deviceId);
  const known = context.deviceNames.get(id) ?? [...context.deviceNames].find(([fullId]) => fullId.startsWith(`${id}-`))?.[1];
  return known || id.slice(0, 7) || "a device";
}

function folderName(context: EventContext, folderId: unknown, label?: unknown): string {
  return context.folderLabels.get(text(folderId)) || text(label) || text(folderId);
}

/** The states a folder passes through on its way to the next real one; they are left out. */
const waitingStates = new Set(["scan-waiting", "sync-waiting", "sync-preparing", "clean-waiting"]);

const stateWords: Record<string, string> = {
  idle: "is idle",
  scanning: "is scanning",
  syncing: "is syncing",
  cleaning: "is cleaning up",
  error: "stopped with an error",
};

function stateChanged(context: EventContext, data: EventData): Described | null {
  const to = text(data.to);
  if (waitingStates.has(to)) return null;
  const folder = folderName(context, data.folder);
  const error = text(data.error);
  const words = error ? `stopped: ${error}` : (stateWords[to] ?? `is ${to}`);
  return { folderId: text(data.folder), type: "state-changed", level: error || to === "error" ? "error" : "info", text: `${folder} ${words}` };
}

function folderCompletion(context: EventContext, data: EventData): Described | null {
  const key = `${text(data.folder)}/${text(data.device)}`;
  const completion = Number(data.completion);
  const previous = context.completions.get(key);
  context.completions.set(key, completion);
  if (previous === undefined || (previous >= 100) === (completion >= 100)) return null;
  const folder = folderName(context, data.folder);
  const device = deviceName(context, data.device);
  const words = completion >= 100 ? `${folder} is complete on ${device}` : `${device} fell behind on ${folder} (${Math.floor(completion)}%)`;
  return { folderId: text(data.folder), type: "folder-completion", level: "info", text: words };
}

function folderErrors(context: EventContext, data: EventData): Described | null {
  const errors = Array.isArray(data.errors) ? (data.errors as { error?: unknown; path?: unknown }[]) : [];
  if (!errors.length) return null;
  const [first] = errors;
  const count = errors.length === 1 ? "1 item" : `${errors.length} items`;
  const words = `${folderName(context, data.folder)} failed to sync ${count}, first ${text(first.path)} (${text(first.error)})`;
  return { folderId: text(data.folder), type: "folder-errors", level: "warning", text: words };
}

function itemFinished(context: EventContext, data: EventData): Described | null {
  const error = text(data.error);
  if (!error) return null;
  return { folderId: text(data.folder), type: "item-failed", level: "warning", text: `${folderName(context, data.folder)} failed to sync ${text(data.item)} (${error})` };
}

function change(context: EventContext, data: EventData, remote: boolean): Described {
  const folderId = text(data.folderID) || text(data.folder);
  const by = remote ? ` by ${deviceName(context, data.modifiedBy)}` : "";
  const where = remote ? "" : " here";
  return { folderId, type: remote ? "remote-change" : "local-change", level: "info", text: `${text(data.path)} ${text(data.action)}${where} in ${folderName(context, folderId, data.label)}${by}` };
}

function pendingDevices(context: EventContext, data: EventData): Described | null {
  const added = (Array.isArray(data.added) ? data.added : []) as { deviceID?: unknown; name?: unknown }[];
  const removed = (Array.isArray(data.removed) ? data.removed : []) as { deviceID?: unknown }[];
  const parts = [
    ...added.map((device) => `${text(device.name) || deviceName(context, device.deviceID)} asks to connect`),
    ...removed.map((device) => `${deviceName(context, device.deviceID)} no longer asks to connect`),
  ];
  return parts.length ? { folderId: null, type: "pending-devices", level: "info", text: parts.join("; ") } : null;
}

function pendingFolders(context: EventContext, data: EventData): Described | null {
  const added = (Array.isArray(data.added) ? data.added : []) as { deviceID?: unknown; folderID?: unknown; folderLabel?: unknown }[];
  const removed = (Array.isArray(data.removed) ? data.removed : []) as { deviceID?: unknown; folderID?: unknown }[];
  const parts = [
    ...added.map((offer) => `${deviceName(context, offer.deviceID)} offers ${text(offer.folderLabel) || text(offer.folderID)}`),
    ...removed.map((offer) => `${deviceName(context, offer.deviceID)} no longer offers ${text(offer.folderID)}`),
  ];
  const folders = new Set([...added, ...removed].map((offer) => text(offer.folderID)));
  return parts.length ? { folderId: folders.size === 1 ? [...folders][0] : null, type: "pending-folders", level: "info", text: parts.join("; ") } : null;
}

function describeEvent(event: SyncthingEvent, context: EventContext): Described | null {
  const data = (event.data && typeof event.data === "object" ? event.data : {}) as EventData;
  const device = () => deviceName(context, data.device ?? data.id);
  const folderEntry = (type: string, words: string): Described => ({ folderId: text(data.id), type, level: "info", text: `${folderName(context, data.id, data.label)} ${words}` });
  switch (event.type) {
    case "StateChanged":
      return stateChanged(context, data);
    case "FolderCompletion":
      return folderCompletion(context, data);
    case "FolderErrors":
      return folderErrors(context, data);
    case "FolderPaused":
      return folderEntry("folder-paused", "paused");
    case "FolderResumed":
      return folderEntry("folder-resumed", "resumed");
    case "ItemFinished":
      return itemFinished(context, data);
    case "LocalChangeDetected":
      return change(context, data, false);
    case "RemoteChangeDetected":
      return change(context, data, true);
    case "DeviceConnected":
      return { folderId: null, type: "device-connected", level: "info", text: `connected to ${context.deviceNames.get(text(data.id)) || text(data.deviceName) || device()} (${text(data.addr)})` };
    case "DeviceDisconnected":
      return { folderId: null, type: "device-disconnected", level: "info", text: `lost ${device()}${text(data.error) ? ` (${text(data.error)})` : ""}` };
    case "DevicePaused":
      return { folderId: null, type: "device-paused", level: "info", text: `${device()} paused` };
    case "DeviceResumed":
      return { folderId: null, type: "device-resumed", level: "info", text: `${device()} resumed` };
    case "PendingDevicesChanged":
      return pendingDevices(context, data);
    case "PendingFoldersChanged":
      return pendingFolders(context, data);
    case "ConfigSaved":
      return { folderId: null, type: "config-saved", level: "info", text: "configuration saved" };
    case "Failure":
      return { folderId: null, type: "failure", level: "error", text: `failure: ${typeof event.data === "string" ? event.data : JSON.stringify(event.data)}` };
    default:
      return null;
  }
}

/** One Syncthing event as an entry, or null for one Activity leaves out. */
export function eventEntry(event: SyncthingEvent, nodeId: string, context: EventContext): NewActivityEntry | null {
  const described = describeEvent(event, context);
  if (!described) return null;
  const at = Number.isFinite(Date.parse(event.time)) ? new Date(event.time).toISOString() : new Date().toISOString();
  return { at, source: "syncthing", nodeId, ...described, text: `${context.nodeName}: ${described.text}` };
}

/** Failures Syncthing repeats on every pull; one entry per failure is kept while it is in the buffer. */
const repeatedTypes = new Set(["item-failed", "folder-errors"]);

/**
 * Scans and file changes, which a busy folder produces every few seconds.
 * @implNote They fill a buffer of their own, so they never push a failure, a device or a request out of the instance's history.
 */
const routineTypes = new Set<string>(routineActivityTypes);

export function feedBufferKey(nodeId: string, type: string): string {
  return routineTypes.has(type) ? `${nodeId}:routine` : nodeId;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function namesFrom(list: unknown, key: string, value: string): Map<string, string> {
  const entries = (Array.isArray(list) ? list : []) as Record<string, unknown>[];
  return new Map(entries.map((entry) => [text(entry[key]), text(entry[value])]));
}

/**
 * Where an instance's events were read up to, kept by `EventFeeds` beyond the life of one feed.
 * @implNote A feed started again for the same instance would otherwise read the instance's whole event buffer a second time.
 */
interface FeedPosition {
  since: number;
  startTime: string | null;
  /** The last completion seen per `<folder>/<device>`. */
  completions: Map<string, number>;
}

/** How many failed items of one folder the instance's buffer keeps besides the folder's summary entry. */
export const failedItemsPerFolder = 20;

/** The long poll of one instance's events into its buffer. */
class InstanceFeed {
  private stopped = false;
  private namesRead = false;
  private readonly context: EventContext;

  constructor(
    private instance: FeedInstance,
    private readonly position: FeedPosition,
    private readonly log: ActivityLog,
    private readonly options: FeedOptions,
  ) {
    this.context = { nodeName: instance.name, deviceNames: new Map(), folderLabels: new Map(), completions: position.completions };
  }

  update(instance: FeedInstance): void {
    this.instance = instance;
    this.context.nodeName = instance.name;
  }

  stop(): void {
    this.stopped = true;
  }

  async run(): Promise<void> {
    let mayHaveRestarted = true;
    while (!this.stopped) {
      try {
        if (mayHaveRestarted) await this.followRestart();
        const events = await this.instance.client.events(this.position.since, followedEventTypes, this.options.waitSeconds, this.options.requestTimeoutMs);
        if (this.stopped) return;
        this.take(events);
        mayHaveRestarted = events.length === 0;
      } catch {
        mayHaveRestarted = true;
        await delay(this.options.retryMs);
      }
    }
  }

  /** @implNote A restarted instance numbers its events from 1 again, so a `since` from before would skip them all. */
  private async followRestart(): Promise<void> {
    const client = this.instance.client;
    const startTime = await client.startTime();
    const isNewRun = this.position.startTime !== startTime;
    if (isNewRun && this.position.startTime !== null) this.forgetRun();
    this.position.startTime = startTime;
    if (!isNewRun && this.namesRead) return;
    this.namesRead = true;
    const [devices, folders] = await Promise.all([client.devices().catch(() => []), client.folders().catch(() => [])]);
    this.context.deviceNames = namesFrom(devices, "deviceID", "name");
    this.context.folderLabels = namesFrom(folders, "id", "label");
  }

  private forgetRun(): void {
    this.position.since = 0;
    this.context.completions.clear();
  }

  private take(events: SyncthingEvent[]): void {
    if (events.some((event) => event.id <= this.position.since)) this.forgetRun();
    for (const event of events) {
      if (event.type === "ConfigSaved") this.learnNames(event.data);
      const entry = eventEntry(event, this.instance.nodeId, this.context);
      if (entry && !this.isRepeat(entry)) this.enter(entry);
      this.position.since = Math.max(this.position.since, event.id);
    }
  }

  private enter(entry: NewActivityEntry): void {
    const bufferKey = feedBufferKey(this.instance.nodeId, entry.type);
    this.log.append(bufferKey, entry);
    if (entry.type === "item-failed") this.log.keepNewest(bufferKey, (known) => known.type === "item-failed" && known.folderId === entry.folderId, failedItemsPerFolder);
  }

  private learnNames(config: unknown): void {
    const { devices, folders } = (config ?? {}) as { devices?: unknown; folders?: unknown };
    if (Array.isArray(devices)) this.context.deviceNames = namesFrom(devices, "deviceID", "name");
    if (Array.isArray(folders)) this.context.folderLabels = namesFrom(folders, "id", "label");
  }

  private isRepeat(entry: NewActivityEntry): boolean {
    return repeatedTypes.has(entry.type) && this.log.entriesOf(feedBufferKey(this.instance.nodeId, entry.type)).some((known) => known.type === entry.type && known.text === entry.text);
  }
}

/** One feed per Syncthing instance of this host, kept in step with the instances that exist. */
export class EventFeeds {
  private readonly feeds = new Map<string, InstanceFeed>();
  private readonly positions = new Map<string, FeedPosition>();

  constructor(
    private readonly log: ActivityLog,
    private readonly options: FeedOptions = defaultFeedOptions,
  ) {}

  reconcile(instances: FeedInstance[]): void {
    const current = new Set(instances.map((instance) => instance.nodeId));
    for (const [nodeId, feed] of this.feeds) {
      if (current.has(nodeId)) continue;
      feed.stop();
      this.feeds.delete(nodeId);
    }
    for (const instance of instances) {
      const known = this.feeds.get(instance.nodeId);
      if (known) {
        known.update(instance);
        continue;
      }
      const position = this.positions.get(instance.nodeId) ?? { since: 0, startTime: null, completions: new Map() };
      this.positions.set(instance.nodeId, position);
      const feed = new InstanceFeed(instance, position, this.log, this.options);
      this.feeds.set(instance.nodeId, feed);
      void feed.run();
    }
  }

  nodeIds(): string[] {
    return [...this.feeds.keys()];
  }

  stop(): void {
    this.reconcile([]);
  }
}

export interface ParitySources {
  arrays: () => Promise<{ id: string; name: string }[]>;
  log: (arrayId: string) => Promise<string[]>;
  job: (arrayId: string) => Promise<ParityJob | null>;
}

const jobStartPattern = /^((sync|scrub) started\b|rebuild of \S+ onto |adding \S+ as |removing \S+ from the array)/;
const jobEndPattern = /^((sync|scrub) done$|scrub: the array is empty|rebuild of \S+ done$|added \S+;|removed \S+ from the array$)|FAILED|refused/;
/** The SnapRAID runs worth an entry; a `diff` or `status` the scripts run on the way is not. */
const jobKinds = new Set(["sync", "scrub", "fix", "check", "add", "rebuild", "remove"]);
/** How far a logged start may lie before the job state's own start time and still be the same job. */
const sameJobMilliseconds = 120_000;

function logLevel(message: string): ActivityLevel {
  if (message.includes("FAILED")) return "error";
  return message.includes("refused") ? "warning" : "info";
}

interface PendingJob {
  job: ParityJob;
  phase: "start" | "end";
}

interface ArrayWatch {
  seen: Set<string>;
  lastJob: ParityJob | null;
  pending: PendingJob[];
}

/**
 * Parity job starts and ends: the lines snapraid.sh logs, and a run the job state shows that the log
 * does not mention (one started by hand).
 * @implNote A job seen in the job state waits one tick before it is entered, because snapraid.sh writes
 * its log line and the run file a moment apart, in either order.
 */
export class ParityWatcher {
  private readonly arrays = new Map<string, ArrayWatch>();

  constructor(
    private readonly log: ActivityLog,
    private readonly sources: ParitySources,
  ) {}

  async tick(): Promise<void> {
    for (const array of await this.sources.arrays()) {
      const watch = this.arrays.get(array.id) ?? { seen: new Set<string>(), lastJob: null, pending: [] };
      this.arrays.set(array.id, watch);
      this.readLog(array, watch, await this.sources.log(array.id));
      this.settlePending(array, watch);
      this.followJob(watch, await this.sources.job(array.id));
    }
  }

  private bufferKey(arrayId: string): string {
    return `parity:${arrayId}`;
  }

  private append(array: { id: string; name: string }, at: string, type: string, level: ActivityLevel, message: string): void {
    this.log.append(this.bufferKey(array.id), { at, source: "parity", nodeId: array.id, folderId: null, type, level, text: `${array.name}: ${message}` });
  }

  private readLog(array: { id: string; name: string }, watch: ArrayWatch, lines: string[]): void {
    const jobLines = lines.filter((line) => {
      const message = line.slice(line.indexOf(" ") + 1);
      return jobStartPattern.test(message) || jobEndPattern.test(message);
    });
    for (const line of jobLines) {
      if (watch.seen.has(line)) continue;
      const [stamp, ...words] = line.split(" ");
      const message = words.join(" ");
      const at = Number.isFinite(Date.parse(stamp)) ? new Date(stamp).toISOString() : new Date().toISOString();
      this.append(array, at, jobStartPattern.test(message) ? "parity-start" : "parity-end", logLevel(message), message);
    }
    watch.seen = new Set(jobLines);
  }

  /**
   * @implNote A logged start must name the job's kind (`sync started`, `adding`, `removing`: the kind's first
   * four letters); a logged end counts only from the job's own start, less the log's whole seconds. Either
   * way the previous job's lines are not taken for this one.
   */
  private isLogged(arrayId: string, type: string, job: ParityJob): boolean {
    const isStart = type === "parity-start";
    const from = timeOf(job.startedAt) - (isStart ? sameJobMilliseconds : 1000);
    const namesKind = (entry: ActivityEntry) => !isStart || entry.text.includes(`: ${job.kind.slice(0, 4)}`);
    return this.log.entriesOf(this.bufferKey(arrayId)).some((entry) => entry.type === type && timeOf(entry.at) >= from && namesKind(entry));
  }

  private settlePending(array: { id: string; name: string }, watch: ArrayWatch): void {
    for (const { job, phase } of watch.pending.splice(0)) {
      const type = phase === "start" ? "parity-start" : "parity-end";
      if (this.isLogged(array.id, type, job)) continue;
      const at = phase === "start" ? job.startedAt : new Date().toISOString();
      this.append(array, at, type, "info", `${job.kind} ${phase === "start" ? "running" : "ended"}`);
    }
  }

  private followJob(watch: ArrayWatch, job: ParityJob | null): void {
    const current = job && jobKinds.has(job.kind) ? job : null;
    const last = watch.lastJob;
    const isSame = current && last && current.kind === last.kind && current.startedAt === last.startedAt;
    if (last && !isSame) watch.pending.push({ job: last, phase: "end" });
    if (current && !isSame) watch.pending.push({ job: current, phase: "start" });
    watch.lastJob = current;
  }
}

export const activityLog = new ActivityLog(activitySettings.bufferSize);
const eventFeeds = new EventFeeds(activityLog);
const reconcileMilliseconds = 60_000;
const parityTickMilliseconds = 15_000;

let reconciling: Promise<void> | null = null;

/** Starts a feed for each instance that appeared since the last call and stops the feed of each one gone. */
export function refreshEventFeeds(): Promise<void> {
  reconciling ??= localInstances()
    .then((instances) => eventFeeds.reconcile(instances))
    .catch((error: Error) => console.error(`activity: the instances could not be listed: ${error.message}`))
    .finally(() => {
      reconciling = null;
    });
  return reconciling;
}

const liveParitySources: ParitySources = {
  arrays: async () => {
    const statuses = await Promise.all((await arrayIds()).map((id) => arrayStatus(id)));
    return statuses.flatMap((status) => (status ? [{ id: status.id, name: status.name }] : []));
  },
  log: recentLog,
  job: runningJob,
};

/** Follows every local Syncthing instance's events and every array's parity jobs into `activityLog`. */
export function startEventFeeds(): void {
  const watcher = new ParityWatcher(activityLog, liveParitySources);
  const tick = () => void watcher.tick().catch((error: Error) => console.error(`activity: parity jobs could not be read: ${error.message}`));
  void refreshEventFeeds();
  tick();
  setInterval(() => void refreshEventFeeds(), reconcileMilliseconds);
  setInterval(tick, parityTickMilliseconds);
}

/** Enters a write made through this dashboard, naming what changed. */
export function recordDashboardActivity(nodeId: string | null, folderId: string | null, text: string): void {
  activityLog.append("dashboard", { at: new Date().toISOString(), source: "dashboard", nodeId, folderId, type: "dashboard-write", level: "info", text });
}
