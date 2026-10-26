import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import type { ArrayAction, ArrayActionBody } from "./api/types.js";
import { type ArrayStatus, arrayStatus } from "./arrayStatus.js";
import { isReplacementCandidate, listBlockDevices } from "./blockDevices.js";
import { recordDashboardActivity, refreshEventFeeds } from "./eventFeed.js";
import { RequestError, readBody, sendJson } from "./http.js";
import { fileJoinRecords } from "./join.js";
import { nodesResponse } from "./nodes.js";
import { type Job, isJobRunning, parityState, recentLog, startJob } from "./parity.js";
import { activityRoutes } from "./routes/activity.js";
import { folderRoutes } from "./routes/folders.js";
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

export interface Route {
  /** Any method when absent. */
  method?: string;
  pattern: RegExp;
  handle: (context: RouteContext) => Promise<void>;
}

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

const routes: Route[] = [
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
  { pattern: /^\/api\/join$/, handle: async () => joinElsewhere() },
];

const writeVerbs: Record<string, string> = { POST: "added", PUT: "set", PATCH: "changed", DELETE: "removed" };

function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Enters a successful write to a node in Activity, e.g. `pc: changed devices/ABCDEFG`. */
function recordNodeWrite(method: string, path: string, response: ServerResponse): void {
  const match = path.match(/^\/api\/nodes\/([^/]+)\/(.+)$/);
  if (!match || method === "GET" || response.statusCode >= 400) return;
  const [, nodeId, rest] = match;
  const folderId = rest.match(/^folders\/([^/]+)/)?.[1];
  recordDashboardActivity(decoded(nodeId), folderId ? decoded(folderId) : null, `${decoded(nodeId)}: ${writeVerbs[method] ?? method} ${decoded(rest)}`);
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://dashboard");
  for (const candidate of routes) {
    if (candidate.method && candidate.method !== request.method) continue;
    const match = url.pathname.match(candidate.pattern);
    if (!match) continue;
    await candidate.handle({ request, response, url, params: match.slice(1) });
    return recordNodeWrite(request.method ?? "GET", url.pathname, response);
  }
  throw new RequestError(404, "not found");
}

function errorStatus(error: unknown): number {
  if (error instanceof RequestError) return error.status;
  if (error instanceof SyncthingUnavailable) return 503;
  if (error instanceof SyncthingError) return 502;
  return 500;
}

export async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    await route(request, response);
  } catch (error) {
    const status = errorStatus(error);
    if (status === 500) console.error(error);
    sendJson(response, status, { error: error instanceof Error ? error.message : String(error) });
  }
}
