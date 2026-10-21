import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import type { ArrayAction, ArrayActionBody } from "./api/types.js";
import { type ArrayStatus, arrayStatus } from "./arrayStatus.js";
import { isReplacementCandidate, listBlockDevices } from "./blockDevices.js";
import { registryEntries, syncthingEndpoint } from "./instances.js";
import { type JoinDependencies, type JoinInstance, JoinError, fileJoinRecords, handleJoin } from "./join.js";
import { createJoinListener } from "./joinListener.js";
import { nodesResponse } from "./nodes.js";
import { type Job, isJobRunning, parityState, recentLog, startJob } from "./parity.js";
import type { ProxySource } from "./proxyProtocol.js";
import {
  arrayStatusDirectory,
  clusterArrayId,
  joinAllowedUsers,
  joinPort,
  joinTag,
  joinsFile,
  port,
  publicDirectory,
  registryDirectory,
  setupRepoDirectory,
  tailnetHost,
} from "./settings.js";
import { readLayout, recordDevice } from "./setupRepo.js";
import { SyncthingClient } from "./syncthing.js";
import { ownLogin, whois } from "./tailnet.js";

class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const arrayActions: ArrayAction[] = ["sync", "scrub", "add", "rebuild", "remove", "accept-smart"];
const joinRecords = fileJoinRecords(joinsFile);

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new RequestError(400, "the request body is not JSON");
  }
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
  const body = (await readBody(request)) as ArrayActionBody;
  if (action === "accept-smart") return acceptSmart(status, body, response);
  if (isJobRunning(arrayId) || (await parityState(arrayId)).job) throw new RequestError(409, `a job is running on ${status.name}`);
  const job = await jobFor(status, action, body);
  startJob(arrayId, job);
  sendJson(response, 202, { started: job });
}

async function syncPortOf(nodeId: string): Promise<number | null> {
  try {
    return (JSON.parse(await readFile(`${registryDirectory}/${nodeId}.syncthing.json`, "utf8")) as { syncPort?: number }).syncPort ?? null;
  } catch {
    return null;
  }
}

function instanceFor(name: string, client: SyncthingClient, syncPort: number | null): JoinInstance {
  const addresses = [...(tailnetHost && syncPort ? [`tcp://${tailnetHost}:${syncPort}`] : []), "dynamic"];
  return {
    name,
    addresses,
    myId: () => client.myId(),
    addDevice: (device) => client.addDevice(device),
    shareFolder: (folderId, deviceId) => client.shareFolder(folderId, deviceId),
  };
}

async function joinInstances(): Promise<JoinInstance[]> {
  const instances: JoinInstance[] = [];
  const cluster = await syncthingEndpoint(clusterArrayId);
  const clusterStatus = await arrayStatus(clusterArrayId);
  if (cluster) instances.push(instanceFor(clusterStatus?.name ?? clusterArrayId, new SyncthingClient(cluster), 22000));
  for (const entry of await registryEntries()) {
    if (!entry.present) continue;
    const endpoint = await syncthingEndpoint(entry.id, entry);
    if (endpoint) instances.push(instanceFor(entry.name, new SyncthingClient(endpoint), await syncPortOf(entry.id)));
  }
  return instances;
}

const joinDependencies: JoinDependencies = {
  whois,
  allowedUsers: async () => {
    const owner = await ownLogin().catch(() => null);
    return owner ? [owner, ...joinAllowedUsers] : joinAllowedUsers;
  },
  requiredTag: joinTag,
  instances: joinInstances,
  layout: readLayout,
  records: joinRecords,
  recordInSetup: setupRepoDirectory ? recordDevice : null,
  now: () => new Date(),
};

async function handleJoinRequest(request: IncomingMessage, response: ServerResponse, caller: ProxySource): Promise<void> {
  try {
    const { response: answer, setup } = await handleJoin(joinDependencies, [caller.address], await readBody(request));
    if (setup) console.log(`join: ${setup.message}`);
    sendJson(response, 200, answer);
  } catch (error) {
    if (error instanceof JoinError || error instanceof RequestError) return sendJson(response, error.status, { error: error.message });
    throw error;
  }
}

/** On 443 and the local site Caddy hands on only a loopback address, so the caller cannot be told. */
function joinElsewhere(): never {
  const joinUrl = `https://${tailnetHost || "storage.<tailnet>.ts.net"}:${joinPort}/api/join`;
  throw new RequestError(421, `a device joins at ${joinUrl}, where tailscale names the caller`);
}

async function serveIndex(response: ServerResponse): Promise<void> {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(await readFile(`${publicDirectory}index.html`));
}

async function legacyState(): Promise<unknown> {
  return { array: await arrayStatus(clusterArrayId), parity: await parityState(clusterArrayId), log: await recentLog(clusterArrayId) };
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://dashboard");
  const path = url.pathname;
  if (request.method === "GET" && path === "/") return serveIndex(response);
  if (request.method === "GET" && path === "/api/nodes") {
    return sendJson(response, 200, await nodesResponse(url.searchParams.get("scope") === "local" ? "local" : "all", joinRecords));
  }
  if (request.method === "GET" && path === "/api/state") return sendJson(response, 200, await legacyState());
  const logMatch = path.match(/^\/api\/arrays\/([^/]+)\/log$/);
  if (request.method === "GET" && logMatch) {
    await knownArray(logMatch[1]);
    return sendJson(response, 200, { lines: await recentLog(logMatch[1]) });
  }
  const actionMatch = path.match(/^\/api\/arrays\/([^/]+)\/([a-z-]+)$/);
  if (request.method === "POST" && actionMatch && arrayActions.includes(actionMatch[2] as ArrayAction)) {
    return handleArrayAction(actionMatch[1], actionMatch[2] as ArrayAction, request, response);
  }
  const legacyAction = path.match(/^\/api\/(sync|scrub|rebuild|remove)$/)?.[1];
  if (request.method === "POST" && legacyAction) return handleArrayAction(clusterArrayId, legacyAction as ArrayAction, request, response);
  if (path === "/api/join") joinElsewhere();
  throw new RequestError(404, "not found");
}

createServer((request, response) => {
  route(request, response).catch((error: unknown) => {
    const status = error instanceof RequestError ? error.status : 500;
    if (status === 500) console.error(error);
    sendJson(response, status, { error: error instanceof Error ? error.message : String(error) });
  });
}).listen(port, () => console.log(`dashboard listening on ${port}`));

createJoinListener(handleJoinRequest).listen(joinPort, () => console.log(`join API listening on ${joinPort}, behind tailscale's PROXY protocol`));

void listBlockDevices().catch(() => undefined);
