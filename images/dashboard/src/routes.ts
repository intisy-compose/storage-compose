import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import type { ArrayAction, ArrayActionBody } from "./api/types.js";
import { type ArrayStatus, arrayStatus } from "./arrayStatus.js";
import { isReplacementCandidate, listBlockDevices } from "./blockDevices.js";
import { recordDashboardActivity, refreshEventFeeds } from "./eventFeed.js";
import { RequestError, readBody, sendJson } from "./http.js";
import { fileJoinRecords } from "./join.js";
import { invalidateLocalNodes, nodesResponse } from "./nodes.js";
import { type Job, isJobRunning, parityState, recentLog, startJob } from "./parity.js";
import { activityRoutes } from "./routes/activity.js";
import { deviceIndexRoutes } from "./routes/deviceIndex.js";
import { deviceRoutes } from "./routes/devices.js";
import { folderRoutes } from "./routes/folders.js";
import { optionsRoutes } from "./routes/options.js";
import { pendingRoutes } from "./routes/pending.js";
import { treeRoutes } from "./routes/tree.js";
import { arrayStatusDirectory, clusterArrayId, joinsFile, publicDirectory, tailnetHost } from "./settings.js";
import { SyncthingError, SyncthingUnavailable } from "./syncthing.js";

export const joinRecords = fileJoinRecords(joinsFile);

export interface RouteContext {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  /** The route pattern's capture groups. */
  params: string[];
}

/** What a write changed, in words, for Activity: `pc: renamed device dashboard-test-peer to backup`. */
export interface WriteNote {
  nodeId: string;
  nodeName: string;
  folderId: string | null;
  text: string;
}

export interface Route {
  /** Any method when absent. */
  method?: string;
  pattern: RegExp;
  handle: (context: RouteContext) => Promise<void>;
}

/** A write to a node: it must answer with the note Activity records, so a write that names nothing does not compile. */
export interface NodeWriteRoute {
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  pattern: RegExp;
  write: (context: RouteContext) => Promise<WriteNote>;
}

export type AnyRoute = Route | NodeWriteRoute;

async function knownArray(arrayId: string): Promise<ArrayStatus> {
  const status = /^[a-z0-9]+$/.test(arrayId) ? await arrayStatus(arrayId) : null;
  if (!status) throw new RequestError(404, `no array ${arrayId} on this host`);
  return status;
}

function memberDrive(status: ArrayStatus, role: string | undefined) {
  const drive = status.drives.find((entry) => entry.role === role);
  if (!drive) throw new RequestError(404, `${status.name} has no drive with the role ${role}`);
  return drive;
}

/** @implNote Destructive actions repeat the role (or "add") as typed confirmation, so a stray click cannot erase a drive. */
function requireConfirmation(body: ArrayActionBody, expected: string): void {
  if (body.confirm !== expected) throw new RequestError(400, `type ${expected} to confirm`);
}

async function requireCandidate(device: string | undefined): Promise<string> {
  if (!device || !isReplacementCandidate(await listBlockDevices({ fresh: true }), device)) throw new RequestError(400, `${device} is not an unused drive that may be erased`);
  return device;
}

async function jobFor(status: ArrayStatus, action: ArrayAction, body: ArrayActionBody): Promise<Job> {
  switch (action) {
    case "sync":
      return { kind: "sync", anyway: body.anyway === true };
    case "scrub":
      return { kind: "scrub" };
    case "add":
      requireConfirmation(body, "add");
      return { kind: "add", device: await requireCandidate(body.device) };
    default: {
      const drive = memberDrive(status, body.role);
      if (drive.mounted) throw new RequestError(409, `${drive.label} is mounted; only a missing drive can be replaced or removed`);
      requireConfirmation(body, drive.role);
      if (action === "remove") return { kind: "remove", role: drive.role };
      return { kind: "rebuild", role: drive.role, device: await requireCandidate(body.device) };
    }
  }
}

async function acceptSmart(status: ArrayStatus, body: ArrayActionBody, response: ServerResponse): Promise<void> {
  const drive = memberDrive(status, body.role);
  if (!drive.mounted) throw new RequestError(409, `${drive.label} is not mounted, so its SMART counts cannot be read`);
  await writeFile(`${arrayStatusDirectory(status.id)}/accept-smart.request`, `${drive.role}\n`);
  sendJson(response, 202, { started: { kind: "accept-smart", role: drive.role } });
}

async function handleArrayAction(arrayId: string, action: ArrayAction, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const status = await knownArray(arrayId);
  if (!status.present) throw new RequestError(409, `${status.name} is not connected`);
  const body = (await readBody(request)) as ArrayActionBody;
  if (action === "accept-smart") return acceptSmart(status, body, response);
  if (isJobRunning(arrayId) || (await parityState(arrayId)).job) throw new RequestError(409, `a job is running on ${status.name}`);
  const job = await jobFor(status, action, body);
  startJob(arrayId, job);
  sendJson(response, 202, { started: job });
}

/** The local site hands on only a loopback address, so the caller cannot be told. */
function joinElsewhere(): never {
  const joinUrl = `https://${tailnetHost || "storage.<tailnet>.ts.net"}/api/join`;
  throw new RequestError(421, `a device joins at ${joinUrl}, where tailscale names the caller`);
}

async function serveIndex(response: ServerResponse): Promise<void> {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(await readFile(`${publicDirectory}index.html`));
}

async function legacyState(): Promise<unknown> {
  return { array: await arrayStatus(clusterArrayId), parity: await parityState(clusterArrayId), log: await recentLog(clusterArrayId) };
}

const routes: AnyRoute[] = [
  { method: "GET", pattern: /^\/$/, handle: ({ response }) => serveIndex(response) },
  {
    method: "GET",
    pattern: /^\/api\/nodes$/,
    handle: async ({ response, url }) => {
      sendJson(response, 200, await nodesResponse(url.searchParams.get("scope") === "local" ? "local" : "all", joinRecords));
      void refreshEventFeeds();
    },
  },
  { method: "GET", pattern: /^\/api\/state$/, handle: async ({ response }) => sendJson(response, 200, await legacyState()) },
  {
    method: "GET",
    pattern: /^\/api\/arrays\/([^/]+)\/log$/,
    handle: async ({ response, params: [arrayId] }) => {
      await knownArray(arrayId);
      sendJson(response, 200, { lines: await recentLog(arrayId) });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/arrays\/([^/]+)\/(sync|scrub|add|rebuild|remove|accept-smart)$/,
    handle: ({ request, response, params: [arrayId, action] }) => handleArrayAction(arrayId, action as ArrayAction, request, response),
  },
  {
    method: "POST",
    pattern: /^\/api\/(sync|scrub|rebuild|remove)$/,
    handle: ({ request, response, params: [action] }) => handleArrayAction(clusterArrayId, action as ArrayAction, request, response),
  },
  ...folderRoutes,
  ...activityRoutes,
  ...treeRoutes,
  ...deviceIndexRoutes(joinRecords),
  ...pendingRoutes(joinRecords),
  ...optionsRoutes,
  ...deviceRoutes(),
  { pattern: /^\/api\/join$/, handle: async () => joinElsewhere() },
];

export interface WriteEffects {
  invalidate(): void;
  record(note: WriteNote): void;
}

const liveWriteEffects: WriteEffects = {
  invalidate: invalidateLocalNodes,
  record: (note) => recordDashboardActivity(note.nodeId, note.folderId, note.text),
};

function withText(note: WriteNote): WriteNote {
  return note.text.trim() ? note : { ...note, text: `${note.nodeName}: changed through the dashboard` };
}

/** After a successful write: the shared local nodes build is dropped so the next read shows it, and a node write's note enters Activity. */
export function settleWrite(method: string, statusCode: number, note: WriteNote | null, effects: WriteEffects = liveWriteEffects): void {
  if (method === "GET" || method === "HEAD" || statusCode >= 400) return;
  effects.invalidate();
  if (note) effects.record(withText(note));
}

async function runRoute(candidate: AnyRoute, context: RouteContext): Promise<WriteNote | null> {
  if ("write" in candidate) return candidate.write(context);
  await candidate.handle(context);
  return null;
}

async function route(routeList: AnyRoute[], effects: WriteEffects, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://dashboard");
  for (const candidate of routeList) {
    if (candidate.method && candidate.method !== request.method) continue;
    const match = url.pathname.match(candidate.pattern);
    if (!match) continue;
    const note = await runRoute(candidate, { request, response, url, params: match.slice(1) });
    return settleWrite(request.method ?? "GET", response.statusCode, note, effects);
  }
  throw new RequestError(404, "not found");
}

function errorStatus(error: unknown): number {
  if (error instanceof RequestError) return error.status;
  if (error instanceof SyncthingUnavailable) return 503;
  if (error instanceof SyncthingError) return 502;
  return 500;
}

/** Answers a request from `routeList`; a refusal or failure becomes `{ error }` with its status. */
export function requestHandler(routeList: AnyRoute[], effects: WriteEffects = liveWriteEffects): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    try {
      await route(routeList, effects, request, response);
    } catch (error) {
      const status = errorStatus(error);
      if (status === 500) console.error(error);
      sendJson(response, status, { error: error instanceof Error ? error.message : String(error) });
    }
  };
}

export const handleRequest = requestHandler(routes);
