import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { devicesFixture } from "./devices.mjs";
import { nodesFixture } from "./nodes.mjs";
import { acceptDefaultsFixture, requestsFixture } from "./requests.mjs";
import { treeFixture } from "./tree.mjs";

/** Serves the built page with made-up nodes, so the UI is tested without the storage stack. */
const port = Number(process.env.PORT ?? 8099);
const pageFile = new URL("../../public/index.html", import.meta.url);
const startedAt = Date.now();
const actionLog = [];

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

async function handleAction(nodeId, action, request, response) {
  const body = await readBody(request);
  const node = nodesFixture(startedAt).nodes.find((candidate) => candidate.id === nodeId);
  if (!node?.array || !node.local) return sendJson(response, 404, { error: `no local array ${nodeId}` });
  if (node.array.parity.job && (action === "sync" || action === "scrub")) return sendJson(response, 409, { error: "another job is running" });
  actionLog.push({ nodeId, action, body });
  return sendJson(response, 202, { started: { kind: action, ...body } });
}

async function route(request, response) {
  const url = new URL(request.url ?? "/", "http://fixture");
  const path = url.pathname;
  if (request.method === "GET" && path === "/") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return response.end(await readFile(pageFile));
  }
  if (request.method === "GET" && path === "/api/nodes") return sendJson(response, 200, nodesFixture(startedAt));
  if (request.method === "GET" && path === "/api/devices") return sendJson(response, 200, devicesFixture(startedAt));
  if (request.method === "GET" && path === "/api/tree") return sendJson(response, 200, treeFixture(url.searchParams.get("node") ?? "all", url.searchParams.get("path") ?? ""));
  if (request.method === "GET" && path === "/api/fixture/actions") return sendJson(response, 200, actionLog);
  if (request.method === "GET" && path === "/api/requests") return sendJson(response, 200, requestsFixture());
  const offerDefaults = path.match(/^\/api\/nodes\/([^/]+)\/pending\/folders\/([^/]+)\/defaults$/);
  if (request.method === "GET" && offerDefaults) {
    const defaults = acceptDefaultsFixture(decodeURIComponent(offerDefaults[1]), decodeURIComponent(offerDefaults[2]), url.searchParams.get("offeredBy"));
    return defaults ? sendJson(response, 200, defaults) : sendJson(response, 404, { error: "no such offer" });
  }
  const scoped = path.match(/^\/api\/arrays\/([^/]+)\/(sync|scrub|add|rebuild|remove|accept-smart)$/);
  if (request.method === "POST" && scoped) return handleAction(decodeURIComponent(scoped[1]), scoped[2], request, response);
  return sendJson(response, 404, { error: "not found" });
}

createServer((request, response) => {
  route(request, response).catch((error) => sendJson(response, 500, { error: String(error) }));
}).listen(port, "127.0.0.1", () => console.log(`fixture on http://127.0.0.1:${port}/`));
