import type { ServerResponse } from "node:http";
import { type ActivitySource, type DebugChange, type DebugFacilities, type DebugFacility, type LogLevel, type LogMessage, type NodeError, type NodeErrors, type NodeLog, activitySources, changeActivityTypes, changesActivityType } from "../api/types.js";
import { type ActivityQuery, activityLog } from "../eventFeed.js";
import { RequestError, readBody, sendJson } from "../http.js";
import { type LocalInstance, type ResolvedInstance, callSyncthing, defaultReadBackDelaysMs, forwardRead, requireLocal, resolveInstance, writeConfirmed } from "../instanceResolver.js";
import type { AnyRoute, NothingWritten, Route, WriteNote } from "../routes.js";
import { shownUnscopedText } from "../shownSyncthingError.js";
import { type KnownSecrets, allSecretsKnown, knownNodeSecrets, nodeSecrets as readNodeSecrets, shownNodeText } from "../nodeSecrets.js";
import { filesHoldingSecrets, holdsSecret, UnreadableZip, zipEntries } from "../supportBundle.js";
import { AnswerTooLarge, type SystemError, boundedBytes } from "../syncthing.js";
import { decodedSegment } from "./devices.js";

function sourceOf(value: string | null): ActivitySource | null {
  if (!value) return null;
  if (!(activitySources as readonly string[]).includes(value)) throw new RequestError(400, `source is one of ${activitySources.join(", ")}`);
  return value as ActivitySource;
}

function typesOf(value: string | null): string[] {
  const named = (value ?? "").split(",").map((type) => type.trim()).filter(Boolean);
  return [...new Set(named.flatMap((type): string[] => (type === changesActivityType ? [...changeActivityTypes] : [type])))];
}

function limitOf(value: string | null): number | undefined {
  if (!value) return undefined;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) throw new RequestError(400, "limit is a whole number above 0");
  return limit;
}

export function activityQuery(url: URL): ActivityQuery {
  const parameter = (name: string) => url.searchParams.get(name) || null;
  return {
    after: parameter("after"),
    node: parameter("node"),
    folder: parameter("folder"),
    types: typesOf(parameter("type")),
    source: sourceOf(parameter("source")),
    routine: parameter("routine") !== "false",
    limit: limitOf(parameter("limit")),
  };
}

export const activityRoutes: Route[] = [
  {
    method: "GET",
    pattern: /^\/api\/activity$/,
    handle: async ({ response, url }) => sendJson(response, 200, activityLog.query(activityQuery(url))),
  },
];

type Fields = Record<string, unknown>;

function fieldsOf(value: unknown): Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Fields) : {};
}

function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

const syncthingLevels: Record<string, LogLevel> = { DBG: "debug", DEBUG: "debug", INF: "info", INFO: "info", WRN: "warning", WARN: "warning", ERR: "error", ERROR: "error" };

/** A level as Syncthing 2.1.6 writes it (`INF`, `WRN`), as its log levels name it (`WARN`), or as a slog number; anything else is info. */
export function logLevelOf(level: unknown): LogLevel {
  if (typeof level === "number") return level >= 8 ? "error" : level >= 4 ? "warning" : level >= 0 ? "info" : "debug";
  if (typeof level !== "string") return "info";
  if (["debug", "info", "warning", "error"].includes(level)) return level as LogLevel;
  return syncthingLevels[level.toUpperCase()] ?? "info";
}

function logMessageOf(value: unknown, secrets: KnownSecrets = allSecretsKnown([])): LogMessage {
  const fields = fieldsOf(value);
  return { when: String(fields.when ?? ""), level: logLevelOf(fields.level), message: shownNodeText(String(fields.message ?? ""), secrets) };
}

function nodeErrorOf(value: unknown, secrets: KnownSecrets = allSecretsKnown([])): NodeError {
  const fields = fieldsOf(value);
  return { when: String(fields.when ?? ""), message: shownNodeText(String(fields.message ?? ""), secrets) };
}

/**
 * The `since` asked for, checked to be an instant and passed on as written.
 * @implNote Syncthing 2.1.6 writes times to a tenth of a microsecond and compares `since` at that precision, so one cut to milliseconds
 * would answer the newest line again on every poll.
 */
function sinceOf(url: URL): string | null {
  const since = url.searchParams.get("since");
  if (!since) return null;
  if (!Number.isFinite(Date.parse(since))) throw new RequestError(400, "since is an instant, such as 2026-10-27T12:00:00Z");
  return since;
}

/** The node's secrets (`nodeSecrets.ts`); a node that does not answer is a 503, so nothing is shown unchecked. */
function nodeSecrets(local: LocalInstance): Promise<string[]> {
  return callSyncthing(local, (client) => readNodeSecrets(local.nodeId, client));
}

function nodePath(nodeId: string, rest: string): string {
  return `/api/nodes/${encodeURIComponent(nodeId)}${rest}`;
}

/**
 * What the node's Syncthing keeps of its log, after `since` when given.
 * @implNote Every line has the node's secrets replaced and passes `shownUnscopedText`, here and again when another host's dashboard
 * answered it, as the log can quote an ignore file and holds what the support bundle is searched for.
 */
export async function readNodeLog(instance: ResolvedInstance, since: string | null): Promise<NodeLog> {
  const query = since ? `?since=${encodeURIComponent(since)}` : "";
  if (instance.kind === "remote") return { messages: listOf(fieldsOf(await forwardRead(instance, nodePath(instance.nodeId, `/log${query}`))).messages).map((message) => logMessageOf(message)) };
  const [answer, secrets] = await Promise.all([callSyncthing(instance, (client) => client.request<{ messages?: unknown } | null>("GET", `/system/log${query}`)), nodeSecrets(instance)]);
  return { messages: listOf(answer?.messages).map((message) => logMessageOf(message, allSecretsKnown(secrets))) };
}

async function localErrors(instance: LocalInstance): Promise<SystemError[]> {
  return callSyncthing(instance, (client) => client.systemErrors());
}

export async function readNodeErrors(instance: ResolvedInstance): Promise<NodeErrors> {
  if (instance.kind === "remote") return { errors: listOf(fieldsOf(await forwardRead(instance, nodePath(instance.nodeId, "/errors"))).errors).map((error) => nodeErrorOf(error)) };
  const [errors, secrets] = await Promise.all([localErrors(instance), nodeSecrets(instance)]);
  return { errors: errors.map((error) => nodeErrorOf(error, allSecretsKnown(secrets))) };
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export interface NodeWrite<T> {
  answer: T;
  note: WriteNote | NothingWritten;
}

function errorKey(error: SystemError): string {
  return `${error.when}\u0000${error.message}`;
}

/**
 * Clears the errors the node's Syncthing reports; with none reported nothing is sent.
 * @implNote A lost answer counts as a clear once none of the errors reported before it are left; a failure that recurs is reported again at once.
 */
export async function clearNodeErrors(instance: ResolvedInstance, readBackDelaysMs: readonly number[] = defaultReadBackDelaysMs): Promise<NodeWrite<NodeErrors>> {
  const local = requireLocal(instance);
  const before = await localErrors(local);
  if (!before.length) return { answer: { errors: [] }, note: { nothingWritten: true } };
  await writeConfirmed(
    local,
    (client) => client.request("POST", "/system/error/clear"),
    async () => {
      const cleared = new Set(before.map(errorKey));
      return !(await local.client.systemErrors()).some((error) => cleared.has(errorKey(error)));
    },
    readBackDelaysMs,
  );
  const [after, secrets] = await Promise.all([localErrors(local).catch(() => [] as SystemError[]), knownNodeSecrets(local.nodeId, local.client)]);
  return { answer: { errors: after.map((error) => nodeErrorOf(error, secrets)) }, note: { nodeId: local.nodeId, nodeName: local.name, folderId: null, text: `${local.name}: cleared ${plural(before.length, "Syncthing error")}` } };
}

/** `/rest/system/loglevels` of Syncthing 2.1.6: each facility's level (`INFO`, `DEBUG`) and its description. */
interface SyncthingLogLevels {
  levels?: Record<string, unknown> | null;
  packages?: Record<string, unknown> | null;
}

const debugLevel = "DEBUG";
const defaultLevel = "INFO";

function isDebugLevel(level: unknown): boolean {
  return typeof level === "string" && level.toUpperCase().startsWith(debugLevel);
}

function facilitiesOf(answer: SyncthingLogLevels | null): DebugFacility[] {
  const levels = answer?.levels ?? {};
  const descriptions = answer?.packages ?? {};
  const names = [...new Set([...Object.keys(descriptions), ...Object.keys(levels)])].sort((left, right) => left.localeCompare(right));
  return names.map((name) => ({ name, description: typeof descriptions[name] === "string" ? descriptions[name] : "", debug: isDebugLevel(levels[name]) }));
}

function readLogLevels(local: LocalInstance): Promise<DebugFacility[]> {
  return callSyncthing(local, (client) => client.request<SyncthingLogLevels | null>("GET", "/system/loglevels")).then(facilitiesOf);
}

function forwardedFacility(value: unknown): DebugFacility {
  const fields = fieldsOf(value);
  return { name: String(fields.name ?? ""), description: shownUnscopedText(String(fields.description ?? "")), debug: fields.debug === true };
}

export async function readDebugFacilities(instance: ResolvedInstance): Promise<DebugFacilities> {
  if (instance.kind === "remote") return { facilities: listOf(fieldsOf(await forwardRead(instance, nodePath(instance.nodeId, "/debug"))).facilities).map(forwardedFacility) };
  return { facilities: await readLogLevels(instance) };
}

function isNameList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((name) => typeof name === "string" && name.trim() !== "");
}

/** Why `body` is no debug change, or null; checked before anything is asked of the node. */
export function debugChangeProblem(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "a debug change names the facilities to enable and to disable";
  const fields = body as Fields;
  const unknown = Object.keys(fields).find((key) => key !== "enable" && key !== "disable");
  if (unknown) return `${unknown} is not part of a debug change`;
  if (!isNameList(fields.enable ?? []) || !isNameList(fields.disable ?? [])) return "enable and disable are lists of facility names";
  const enable = (fields.enable ?? []) as string[];
  const disable = (fields.disable ?? []) as string[];
  if (!enable.length && !disable.length) return "name at least one facility to enable or disable";
  const both = enable.find((name) => disable.includes(name));
  return both ? `${both} cannot be enabled and disabled at once` : null;
}

function debugChangeText(nodeName: string, enabled: string[], disabled: string[]): string {
  const parts = [enabled.length ? `turned on debug logging for ${enabled.join(", ")}` : "", disabled.length ? `turned off debug logging for ${disabled.join(", ")}` : ""].filter(Boolean);
  return `${nodeName}: ${parts.join("; ")}`;
}

/**
 * Turns debug logging on (`DEBUG`) or off (`INFO`, Syncthing's own level) for the named facilities; one already as asked is left alone.
 * @implNote Syncthing 2.1.6 replaced `/rest/system/debug` with `/rest/system/loglevels` and takes any name there, so a name the node does not list is refused here.
 */
export async function changeDebugFacilities(instance: ResolvedInstance, body: unknown, readBackDelaysMs: readonly number[] = defaultReadBackDelaysMs): Promise<NodeWrite<DebugFacilities>> {
  const local = requireLocal(instance);
  const problem = debugChangeProblem(body);
  if (problem) throw new RequestError(400, problem);
  const change = body as Partial<DebugChange>;
  const before = await readLogLevels(local);
  const known = new Map(before.map((facility) => [facility.name, facility]));
  const unknownName = [...(change.enable ?? []), ...(change.disable ?? [])].find((name) => !known.has(name));
  if (unknownName) throw new RequestError(400, `${local.name} has no log facility ${unknownName}`);
  const enabled = (change.enable ?? []).filter((name) => !known.get(name)?.debug);
  const disabled = (change.disable ?? []).filter((name) => known.get(name)?.debug);
  if (!enabled.length && !disabled.length) return { answer: { facilities: before }, note: { nothingWritten: true } };
  const levels = Object.fromEntries([...enabled.map((name) => [name, debugLevel]), ...disabled.map((name) => [name, defaultLevel])]);
  const isInPlace = (facilities: DebugFacility[]) => facilities.every((facility) => (enabled.includes(facility.name) ? facility.debug : disabled.includes(facility.name) ? !facility.debug : true));
  await writeConfirmed(local, (client) => client.request("POST", "/system/loglevels", levels), async () => isInPlace(facilitiesOf(await local.client.request<SyncthingLogLevels | null>("GET", "/system/loglevels"))), readBackDelaysMs);
  const after = await readLogLevels(local).catch(() => before.map((facility) => ({ ...facility, debug: enabled.includes(facility.name) || (facility.debug && !disabled.includes(facility.name)) })));
  return { answer: { facilities: after }, note: { nodeId: local.nodeId, nodeName: local.name, folderId: null, text: debugChangeText(local.name, enabled, disabled) } };
}

/** Syncthing gathers a CPU profile for the bundle, so it answers in seconds rather than at once. */
export const supportBundleTimeoutMs = 60_000;
export const defaultMaxBundleBytes = 64 * 1024 * 1024;

function bundleFileName(nodeName: string, at: Date): string {
  const stamp = at.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `support-bundle-${nodeName.replace(/[^A-Za-z0-9._-]/g, "_") || "node"}-${stamp}.zip`;
}

function refusedBundle(nodeName: string, why: string): RequestError {
  return new RequestError(501, `the support bundle of ${nodeName} is not handed out: ${why}`);
}

/**
 * The node's Syncthing support bundle, handed out only once the archive and every file in it were read and found free of the node's
 * secrets; downloads asked for while one is read share it.
 * @implNote Syncthing 2.1.6 writes `REDACTED` for the API key, the GUI's user and password and every folder encryption password in the
 * bundle's configuration (checked on the test peer with all of them set). The bundle is still held whole and searched, its gzipped
 * profiles unpacked, so a version that redacts less is refused (501) instead of passed on.
 */
export function supportBundle(instance: ResolvedInstance, maxBytes: number = defaultMaxBundleBytes): Promise<SupportBundle> {
  const local = requireLocal(instance);
  const key = `${local.nodeId}\u0000${local.client.endpoint.url}\u0000${maxBytes}`;
  const running = bundlesBeingRead.get(key);
  if (running) return running;
  const read = readSupportBundle(local, maxBytes).finally(() => bundlesBeingRead.delete(key));
  bundlesBeingRead.set(key, read);
  return read;
}

interface SupportBundle {
  fileName: string;
  zip: Buffer;
}

const bundlesBeingRead = new Map<string, Promise<SupportBundle>>();

async function readSupportBundle(local: LocalInstance, maxBytes: number): Promise<SupportBundle> {
  const secrets = await nodeSecrets(local);
  const answer = await callSyncthing(local, (client) => client.raw("GET", "/rest/debug/support", supportBundleTimeoutMs));
  if (!answer.ok) {
    await answer.body?.cancel().catch(() => {});
    throw new RequestError(502, `${local.name}'s Syncthing answered HTTP ${answer.status} for its support bundle`);
  }
  let zip: Buffer;
  try {
    zip = await callSyncthing(local, () => boundedBytes(answer, maxBytes, "GET /rest/debug/support"));
  } catch (error) {
    if (error instanceof AnswerTooLarge) throw refusedBundle(local.name, `it is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
    throw error;
  }
  let holding: string[];
  try {
    holding = filesHoldingSecrets(zipEntries(zip, maxBytes), secrets, maxBytes);
  } catch (error) {
    if (error instanceof UnreadableZip) throw refusedBundle(local.name, `it could not be checked (${error.message})`);
    throw error;
  }
  if (secrets.some((secret) => holdsSecret(zip, secret))) holding.push("the archive itself");
  if (holding.length) throw refusedBundle(local.name, `${holding.join(", ")} holds a password or the API key, or could not be searched`);
  return { fileName: bundleFileName(local.name, new Date()), zip };
}

function sendZip(response: ServerResponse, fileName: string, zip: Buffer): void {
  response.writeHead(200, { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${fileName}"`, "Content-Length": String(zip.length), "Cache-Control": "no-store" });
  response.end(zip);
}

export interface NodeLogSources {
  resolve(nodeId: string): Promise<ResolvedInstance>;
  /** The waits between read-backs of a write whose answer was lost; tests shorten them. */
  readBackDelaysMs?: readonly number[];
  /** The largest support bundle read; tests make it small. */
  maxBundleBytes?: number;
}

const liveSources: NodeLogSources = { resolve: (nodeId) => resolveInstance(nodeId) };

/** Each node's log, errors, debug facilities and support bundle; changing facilities and clearing errors are local node writes. */
export function nodeLogRoutes(routeSources: NodeLogSources = liveSources): AnyRoute[] {
  const node = async (segment: string, url: URL): Promise<ResolvedInstance> => {
    const nodeId = decodedSegment(segment, "node ID");
    const instance = await routeSources.resolve(nodeId);
    if (instance.kind === "remote" && url.searchParams.get("scope") === "local") throw new RequestError(404, `no node ${nodeId} on this host`);
    return instance;
  };
  const delays = routeSources.readBackDelaysMs;
  return [
    {
      method: "GET",
      pattern: /^\/api\/nodes\/([^/]+)\/log$/,
      handle: async ({ response, url, params: [nodeId] }) => sendJson(response, 200, await readNodeLog(await node(nodeId, url), sinceOf(url))),
    },
    {
      method: "GET",
      pattern: /^\/api\/nodes\/([^/]+)\/errors$/,
      handle: async ({ response, url, params: [nodeId] }) => sendJson(response, 200, await readNodeErrors(await node(nodeId, url))),
    },
    {
      method: "POST",
      pattern: /^\/api\/nodes\/([^/]+)\/errors\/clear$/,
      write: async ({ response, url, params: [nodeId] }) => {
        const cleared = await clearNodeErrors(await node(nodeId, url), delays);
        sendJson(response, 200, cleared.answer);
        return cleared.note;
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/nodes\/([^/]+)\/debug$/,
      handle: async ({ response, url, params: [nodeId] }) => sendJson(response, 200, await readDebugFacilities(await node(nodeId, url))),
    },
    {
      method: "POST",
      pattern: /^\/api\/nodes\/([^/]+)\/debug$/,
      write: async ({ request, response, url, params: [nodeId] }) => {
        const instance = await node(nodeId, url);
        const changed = await changeDebugFacilities(instance, await readBody(request), delays);
        sendJson(response, 200, changed.answer);
        return changed.note;
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/nodes\/([^/]+)\/support-bundle$/,
      handle: async ({ response, url, params: [nodeId] }) => {
        const bundle = await supportBundle(await node(nodeId, url), routeSources.maxBundleBytes);
        sendZip(response, bundle.fileName, bundle.zip);
      },
    },
  ];
}
