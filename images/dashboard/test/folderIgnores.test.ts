import assert from "node:assert/strict";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { ignoreLinesOf, ignoreLinesProblem, ignoresChangeWords } from "../src/api/ignorePatterns.js";
import type { FolderIgnores } from "../src/api/types.js";
import { RequestError } from "../src/http.js";
import type { LocalInstance, RemoteInstance, ResolvedInstance } from "../src/instanceResolver.js";
import { type WriteEffects, type WriteNote, requestHandler } from "../src/routes.js";
import { folderIgnoreRoutes, readIgnores, saveIgnores } from "../src/routes/folderIgnores.js";
import { SyncthingClient } from "../src/syncthing.js";
import { until } from "./until.js";

const apiKey = "folder-ignores-test-key";
const fastReadBacks = [5, 10, 20];

interface Received {
  method: string;
  path: string;
  body: unknown;
}

function reply(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

async function bodyOf(request: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of request) text += chunk;
  return text ? JSON.parse(text) : null;
}

/** As Syncthing 2.1.6 expands a line: prefixes kept, an unrooted pattern four ways, a rooted one two ways. */
function expandedLine(line: string): string[] {
  const [, prefix = "", pattern = ""] = line.match(/^((?:!|\(\?[di]\))*)(.*)$/) ?? [];
  if (pattern.startsWith("/")) return [`${prefix}${pattern}`, `${prefix}${pattern}/**`];
  return [`${prefix}${pattern}`, `${prefix}**/${pattern}`, `${prefix}${pattern}/**`, `${prefix}**/${pattern}/**`];
}

describe("a folder's ignore patterns", () => {
  const received: Received[] = [];
  let openRequests = 0;
  let syncthingUrl = "";
  let folders: { id: string; label: string; path: string; type: string; paused: boolean; devices: unknown[] }[] = [];
  let lines: string[] | null = null;
  /** Files an `#include` reads, by the name the line gives; Syncthing reads them from anywhere. */
  let includedFiles: Record<string, string[]> = {};
  /** Lines another browser writes at the next read of the patterns, as a change racing the form. */
  let concurrentLines: string[] | null = null;
  let loseWriteAnswer = false;

  function syncthingError(): string | null {
    const all = (lines ?? []).flatMap((line) => (line.startsWith("#include ") ? (includedFiles[line.slice(9)] ?? []) : [line]));
    const invalid = all.find((line) => line.includes("[") && !line.includes("]"));
    return invalid ? `invalid pattern ${JSON.stringify(invalid)} in ignore file: parse error: unexpected end of input` : null;
  }

  function expanded(): string[] | null {
    if (lines === null) return null;
    const patterns = lines.flatMap((line) => (line.startsWith("#include ") ? (includedFiles[line.slice(9)] ?? []) : [line]));
    return patterns.filter((line) => line.trim() && !line.startsWith("//")).flatMap(expandedLine);
  }

  function ignoresAnswer(): unknown {
    return { ignore: lines, expanded: expanded(), error: syncthingError() };
  }

  const syncthing = createServer(async (request, response) => {
    openRequests += 1;
    response.on("close", () => (openRequests -= 1));
    if (request.headers["x-api-key"] !== apiKey) return reply(response, { error: "forbidden" }, 403);
    const url = new URL(request.url ?? "/", "http://fake");
    const body = request.method === "POST" ? await bodyOf(request) : null;
    received.push({ method: request.method ?? "", path: `${url.pathname}${url.search}`, body });
    if (request.method === "GET" && url.pathname === "/rest/config/folders") return reply(response, folders);
    if (url.pathname === "/rest/db/ignores" && !folders.some((folder) => folder.id === url.searchParams.get("folder"))) return reply(response, { ignore: null, expanded: null, error: `folder ${url.searchParams.get("folder")} does not exist` });
    if (request.method === "GET" && url.pathname === "/rest/db/ignores") {
      if (concurrentLines) [lines, concurrentLines] = [concurrentLines, null];
      return reply(response, ignoresAnswer());
    }
    if (request.method === "POST" && url.pathname === "/rest/db/ignores") {
      lines = (body as { ignore: string[] }).ignore;
      if (loseWriteAnswer) return request.socket.destroy();
      return reply(response, ignoresAnswer());
    }
    reply(response, { error: "not faked" }, 404);
  });

  function peer(): LocalInstance {
    return { kind: "local", nodeId: "d7e5", name: "dashboard-test-peer", client: new SyncthingClient({ url: syncthingUrl, apiKey }), root: "/var/syncthing/data", os: "linux", threshold: 0 };
  }

  function posts(): unknown[] {
    return received.filter((entry) => entry.method === "POST").map((entry) => entry.body);
  }

  function noteText(note: WriteNote | { nothingWritten: true }): string {
    assert.ok("text" in note, "the save wrote something");
    return note.text;
  }

  before(async () => {
    syncthingUrl = await listen(syncthing);
  });

  beforeEach(async () => {
    await until(() => openRequests === 0, "the fake Syncthing to finish the last test's requests");
    received.length = 0;
    folders = [
      { id: "dashboard-test-a", label: "Test A", path: "/var/syncthing/data/dashboard-test-a", type: "sendreceive", paused: false, devices: [] },
      { id: "dashboard-test-x", label: "", path: "/var/syncthing/data/dashboard-test-x", type: "receiveencrypted", paused: false, devices: [] },
    ];
    lines = null;
    includedFiles = {};
    concurrentLines = null;
    loseWriteAnswer = false;
  });

  after(() => {
    syncthing.close();
  });

  it("ignores round-trip", async () => {
    assert.deepEqual(await readIgnores(peer(), "dashboard-test-a"), { lines: [], expanded: [], hiddenIncluded: 0, error: null });
    const saved = await saveIgnores(peer(), "dashboard-test-a", { lines: ["*.tmp", "// scratch files", "/build"], opened: [] }, fastReadBacks);
    assert.deepEqual(posts(), [{ ignore: ["*.tmp", "// scratch files", "/build"] }]);
    assert.deepEqual(saved.ignores, { lines: ["*.tmp", "// scratch files", "/build"], expanded: ["*.tmp", "**/*.tmp", "*.tmp/**", "**/*.tmp/**", "/build", "/build/**"], hiddenIncluded: 0, error: null });
    assert.equal(noteText(saved.note), "dashboard-test-peer: changed ignore patterns of folder Test A; added *.tmp, // scratch files, /build");
    assert.deepEqual(await readIgnores(peer(), "dashboard-test-a"), saved.ignores);

    const removed = await saveIgnores(peer(), "dashboard-test-a", { lines: ["*.tmp"], opened: saved.ignores.lines }, fastReadBacks);
    assert.equal(noteText(removed.note), "dashboard-test-peer: changed ignore patterns of folder Test A; removed // scratch files, /build");
    const unchanged = await saveIgnores(peer(), "dashboard-test-a", { lines: ["*.tmp"], opened: ["*.tmp"] }, fastReadBacks);
    assert.deepEqual(unchanged.note, { nothingWritten: true });
    assert.equal(posts().length, 2, "the same lines write nothing");
  });

  it("syncthing's parse error is shown, not swallowed", async () => {
    const saved = await saveIgnores(peer(), "dashboard-test-a", { lines: ["*.tmp", "[abc"], opened: [] }, fastReadBacks);
    assert.equal(saved.ignores.error, 'invalid pattern "[abc" in ignore file: parse error: unexpected end of input');
    assert.deepEqual(saved.ignores.lines, ["*.tmp", "[abc"], "the file was written as typed");
    assert.equal((await readIgnores(peer(), "dashboard-test-a")).error, saved.ignores.error);
  });

  it("an #include of a file outside the folder is refused before anything is read", async () => {
    for (const include of ["#include ../../config/config.xml", "#include /etc/passwd", "#include C:\\Windows\\win.ini", "#include ..\\..\\config.xml", "  #include sub/../../x", "#include \\\\server\\share\\x"]) {
      await assert.rejects(saveIgnores(peer(), "dashboard-test-a", { lines: ["*.tmp", include], opened: [] }), (error: Error & { status?: number }) => error.status === 400 && error.message === `${include.trim()} refers to a file outside the folder; an included file must lie inside it`, include);
    }
    assert.deepEqual(received, []);
    for (const include of ["#include .stignore-shared", "#include sub/../shared.txt", "#include ./a/b/c.txt"]) assert.equal(ignoreLinesProblem([include]), null, include);
  });

  it("patterns from an included file are counted, never shown, and its invalid pattern is not quoted", async () => {
    lines = ["*.tmp", "#include shared.txt"];
    includedFiles = { "shared.txt": ["<apikey>secret-api-key</apikey>", "<password>$2a$10$hash</password>"] };
    const read = await readIgnores(peer(), "dashboard-test-a");
    assert.deepEqual(read.expanded, ["*.tmp", "**/*.tmp", "*.tmp/**", "**/*.tmp/**"]);
    assert.equal(read.hiddenIncluded, 8);
    assert.doesNotMatch(JSON.stringify(read), /secret-api-key|hash/);
    includedFiles = { "shared.txt": ["[secret-api-key"] };
    const broken = await readIgnores(peer(), "dashboard-test-a");
    assert.equal(broken.error, "invalid pattern in an included file: parse error: unexpected end of input");
  });

  it("patterns changed on the node since the form opened are 409 and nothing is written", async () => {
    lines = ["*.tmp"];
    concurrentLines = ["*.tmp", "*.log"];
    await assert.rejects(saveIgnores(peer(), "dashboard-test-a", { lines: ["*.tmp", "*.bak"], opened: ["*.tmp"] }), {
      status: 409,
      message: "the ignore patterns changed on the node since the form opened; nothing was written",
    });
    assert.deepEqual(posts(), []);
    assert.deepEqual(lines, ["*.tmp", "*.log"]);
  });

  it("a remote node, an unknown folder, a receive encrypted folder and a malformed change are refused, none writing", async () => {
    const remote: RemoteInstance = { kind: "remote", nodeId: "a1b2", name: "p53-data", host: "p53", dashboardUrl: "http://127.0.0.1:1" };
    await assert.rejects(saveIgnores(remote, "dashboard-test-a", { lines: [], opened: [] }), { status: 409, message: "act on p53's dashboard" });
    await assert.rejects(readIgnores(remote, "dashboard-test-a"), { status: 409 });
    for (const body of [null, [], {}, { lines: "*.tmp", opened: [] }, { lines: ["*.tmp"] }, { lines: [1], opened: [] }, { lines: ["a\nb"], opened: [] }, { lines: [], opened: [], folder: "x" }]) {
      await assert.rejects(saveIgnores(peer(), "dashboard-test-a", body), { status: 400 }, JSON.stringify(body));
    }
    assert.deepEqual(received, []);
    await assert.rejects(readIgnores(peer(), "nope"), { status: 404, message: "dashboard-test-peer has no folder nope" });
    await assert.rejects(saveIgnores(peer(), "nope", { lines: ["*.tmp"], opened: [] }), { status: 404 });
    await assert.rejects(saveIgnores(peer(), "dashboard-test-x", { lines: ["*.tmp"], opened: [] }), { status: 400, message: "dashboard-test-x is receive encrypted, which takes no ignore patterns" });
    assert.deepEqual(posts(), []);
  });

  it("a lost answer whose patterns are in place is saved", async () => {
    loseWriteAnswer = true;
    const saved = await saveIgnores(peer(), "dashboard-test-a", { lines: ["*.tmp"], opened: [] }, fastReadBacks);
    assert.deepEqual(saved.ignores.lines, ["*.tmp"]);
    assert.equal(noteText(saved.note), "dashboard-test-peer: changed ignore patterns of folder Test A; added *.tmp");
  });

  it("a save goes through the router as a node write and enters Activity once", async () => {
    const notes: WriteNote[] = [];
    const effects: WriteEffects = { invalidate: () => {}, record: (note) => void notes.push(note) };
    const resolve = async (nodeId: string): Promise<ResolvedInstance> => (nodeId === "d7e5" ? peer() : Promise.reject(new RequestError(404, `no node ${nodeId}`)));
    const handle = requestHandler(folderIgnoreRoutes({ resolve, readBackDelaysMs: fastReadBacks }), effects);
    const dashboard = createServer((request, response) => void handle(request, response));
    const url = `${await listen(dashboard)}/api/nodes/d7e5/folders/dashboard-test-a/ignores`;
    const put = (body: unknown) => fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    try {
      const opened = (await (await fetch(url)).json()) as FolderIgnores;
      const saved = await put({ lines: ["*.tmp"], opened: opened.lines });
      assert.equal(saved.status, 200);
      assert.deepEqual(((await saved.json()) as FolderIgnores).lines, ["*.tmp"]);
      assert.equal((await put({ lines: ["*.tmp"], opened: ["*.tmp"] })).status, 200);
      const stale = await put({ lines: ["*.bak"], opened: [] });
      assert.equal(stale.status, 409);
      assert.equal((await put({ lines: ["#include ../../config/config.xml"], opened: ["*.tmp"] })).status, 400);
      assert.deepEqual(notes.map((note) => note.text), ["dashboard-test-peer: changed ignore patterns of folder Test A; added *.tmp"]);
      assert.equal(notes[0]?.folderId, "dashboard-test-a");
    } finally {
      dashboard.close();
    }
  });
});

describe("ignore lines in words", () => {
  it("a typed text becomes lines without the empty lines at its end", () => {
    assert.deepEqual(ignoreLinesOf("*.tmp\r\n\n// keep\n/build\n\n"), ["*.tmp", "", "// keep", "/build"]);
    assert.deepEqual(ignoreLinesOf(""), []);
  });

  it("a change names what was added and removed, or that only the order changed", () => {
    assert.deepEqual(ignoresChangeWords(["a", "b"], ["b", "c"]), ["added c", "removed a"]);
    assert.deepEqual(ignoresChangeWords(["a", "b"], ["b", "a"]), ["reordered the patterns"]);
    assert.deepEqual(ignoresChangeWords([], ["1", "2", "3", "4", "5", "6", "7"]), ["added 1, 2, 3, 4, 5 and 2 more"]);
    assert.deepEqual(ignoresChangeWords(["x", ""], ["x"]), ["removed an empty line"]);
  });
});
