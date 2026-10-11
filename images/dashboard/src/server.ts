import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { isReplacementCandidate, listBlockDevices, replacementCandidates } from "./blockDevices.js";
import { type DriveRow, driveRows } from "./drives.js";
import { type Job, isJobRunning, parityStatus, recentLog, startJob } from "./jobs.js";
import { port, publicDirectory } from "./settings.js";

interface ActionRequest {
  role?: string;
  device?: string;
  confirm?: string;
  anyway?: boolean;
}

class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<ActionRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? (JSON.parse(text) as ActionRequest) : {};
  } catch {
    throw new RequestError(400, "the request body is not JSON");
  }
}

async function state(): Promise<unknown> {
  const devices = await listBlockDevices();
  return {
    drives: await driveRows(devices),
    candidates: replacementCandidates(devices),
    parity: await parityStatus(),
    log: await recentLog(),
  };
}

function missingDrive(drives: DriveRow[], role: string | undefined): DriveRow {
  const drive = drives.find((row) => row.role === role);
  if (!drive) throw new RequestError(404, `no drive with the role ${role}`);
  if (drive.mounted) throw new RequestError(409, `${drive.label} is mounted; only a missing drive can be replaced or removed`);
  return drive;
}

/** @implNote Destructive actions repeat the role as typed confirmation, so a stray click cannot erase a drive. */
function requireConfirmation(body: ActionRequest, drive: DriveRow): void {
  if (body.confirm !== drive.role) throw new RequestError(400, `type ${drive.role} to confirm`);
}

async function jobFor(action: string, body: ActionRequest): Promise<Job> {
  if (action === "sync") return { kind: "sync", anyway: body.anyway === true };
  if (action === "scrub") return { kind: "scrub" };
  const devices = await listBlockDevices();
  const drive = missingDrive(await driveRows(devices), body.role);
  requireConfirmation(body, drive);
  if (action === "remove") return { kind: "remove", role: drive.role };
  if (action === "rebuild") {
    if (!body.device || !isReplacementCandidate(devices, body.device)) {
      throw new RequestError(400, `${body.device} is not an unused drive that may be erased`);
    }
    return { kind: "rebuild", role: drive.role, device: body.device };
  }
  throw new RequestError(404, `unknown action ${action}`);
}

async function handleAction(action: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (isJobRunning()) throw new RequestError(409, "another job is running");
  const job = await jobFor(action, await readBody(request));
  startJob(job);
  sendJson(response, 202, { started: job });
}

async function serveIndex(response: ServerResponse): Promise<void> {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(await readFile(`${publicDirectory}index.html`));
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const path = new URL(request.url ?? "/", "http://dashboard").pathname;
  if (request.method === "GET" && path === "/") return serveIndex(response);
  if (request.method === "GET" && path === "/api/state") return sendJson(response, 200, await state());
  const action = path.match(/^\/api\/(sync|scrub|rebuild|remove)$/)?.[1];
  if (request.method === "POST" && action) return handleAction(action, request, response);
  throw new RequestError(404, "not found");
}

createServer((request, response) => {
  route(request, response).catch((error: unknown) => {
    const status = error instanceof RequestError ? error.status : 500;
    sendJson(response, status, { error: error instanceof Error ? error.message : String(error) });
  });
}).listen(port, () => console.log(`dashboard listening on ${port}`));
