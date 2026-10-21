import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { PathSet, browseFor, listsFor } from "../src/folderLists.js";
import { SyncthingClient } from "../src/syncthing.js";

const fixtures = new URL("../../test/fixtures/syncthing-tree/", import.meta.url);

async function fixture(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(new URL(name, fixtures), "utf8")) as Record<string, unknown>;
}

function reply(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function pageOf<Item>(items: Item[], url: URL): Item[] {
  const page = Number(url.searchParams.get("page"));
  const perPage = Number(url.searchParams.get("perpage"));
  return items.slice((page - 1) * perPage, page * perPage);
}

describe("folder lists", () => {
  let server: Server;
  let client: SyncthingClient;
  let baseStatus: Record<string, unknown>;
  let baseErrors: Record<string, unknown>;
  let status: Record<string, unknown>;
  let need: string[];
  let errors: { path: string; error: string }[];
  let changed: string[];
  let browsed: { name: string; modTime: string; size: number; type: string }[];
  const hits: Record<string, number> = {};
  const perPages: number[] = [];
  let instanceCount = 0;

  before(async () => {
    baseStatus = await fixture("status-documents.json");
    baseErrors = await fixture("errors-documents.json");
    server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://fake");
      hits[url.pathname] = (hits[url.pathname] ?? 0) + 1;
      if (url.searchParams.has("perpage")) perPages.push(Number(url.searchParams.get("perpage")));
      switch (url.pathname) {
        case "/rest/db/status":
          return reply(response, status);
        case "/rest/db/need": {
          const names = pageOf(need, url).map((name) => ({ name }));
          return reply(response, { page: 1, perpage: 100, progress: names.slice(0, 1), queued: names.slice(1, 2), rest: names.slice(2) });
        }
        case "/rest/folder/errors":
          return reply(response, { ...baseErrors, errors: pageOf(errors, url) });
        case "/rest/db/browse":
          return reply(response, browsed);
        case "/rest/db/localchanged":
          return reply(response, { files: pageOf(changed, url).map((name) => ({ name })), page: 1, perpage: 100 });
        default:
          response.writeHead(404);
          response.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    client = new SyncthingClient({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, apiKey: "key" });
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  beforeEach(() => {
    status = { ...baseStatus };
    need = [];
    errors = (baseErrors.errors as { path: string; error: string }[]).slice();
    changed = [];
    browsed = [];
    for (const key of Object.keys(hits)) delete hits[key];
    perPages.length = 0;
    instanceCount += 1;
  });

  it("places a list's items under each directory above them", () => {
    const set = new PathSet(["Taxes\\2025\\locked.xlsx", "Recipes/cake/session.lock", "Recipes/pie.txt"]);
    assert.equal(set.countUnder(""), 3);
    assert.equal(set.countUnder("Recipes"), 2);
    assert.equal(set.countUnder("Recipes/cake"), 1);
    assert.equal(set.countUnder("Taxes/2025/locked.xlsx"), 1);
    assert.equal(set.countUnder("Garden Plans"), 0);
    assert.equal(set.countUnder("Rec"), 0);
  });

  it("lists are read once per sequence", async () => {
    need = ["Recipes\\new.txt", "Taxes\\2026\\a.pdf", "Taxes\\2026\\b.pdf"];
    status = { ...status, needFiles: 3, needTotalItems: 3, sequence: 5 };
    const key = `pc-${instanceCount}`;
    const [first, concurrent] = await Promise.all([listsFor(key, client, "documents"), listsFor(key, client, "documents")]);
    const second = await listsFor(key, client, "documents");
    assert.equal(first, concurrent);
    assert.equal(first, second);
    assert.equal(hits["/rest/db/need"], 1);
    assert.equal(hits["/rest/folder/errors"], 1);
    assert.equal(first.sequence, 5);
    assert.ok(first.need !== "too-many" && first.errors !== "too-many");
    assert.equal(first.need.countUnder("Taxes"), 2);
    assert.equal(first.errors.countUnder("Recipes/cake"), 1);

    status = { ...status, sequence: 6 };
    const third = await listsFor(key, client, "documents");
    assert.notEqual(third, first);
    assert.equal(hits["/rest/db/need"], 2);
    assert.equal(hits["/rest/folder/errors"], 2);
  });

  it("no need list is read while needFiles is 0", async () => {
    status = { ...status, errors: 0, pullErrors: 0, needFiles: 0, needTotalItems: 0, receiveOnlyTotalItems: 0 };
    const lists = await listsFor(`pc-${instanceCount}`, client, "documents");
    assert.equal(hits["/rest/db/need"], undefined);
    assert.equal(hits["/rest/folder/errors"], undefined);
    assert.equal(hits["/rest/db/localchanged"], undefined);
    assert.ok(lists.need !== "too-many");
    assert.equal(lists.need.countUnder(""), 0);
  });

  it("reads long lists in pages of at most 100", async () => {
    need = Array.from({ length: 250 }, (_, index) => `Recipes/${index}.txt`);
    changed = ["Garden Plans/beds.txt"];
    status = { ...status, needFiles: 250, needTotalItems: 250, receiveOnlyTotalItems: 1 };
    const lists = await listsFor(`pc-${instanceCount}`, client, "documents");
    assert.equal(hits["/rest/db/need"], 3);
    assert.ok(perPages.every((perPage) => perPage <= 100));
    assert.ok(lists.need !== "too-many");
    assert.equal(lists.need.countUnder("Recipes"), 250);
    assert.equal(lists.localChanged.countUnder("Garden Plans"), 1);
  });

  it("a directory is browsed once per sequence and the last answer is served while the folder changes", async () => {
    const key = `pc-${instanceCount}`;
    browsed = [{ name: "Recipes", modTime: "2026-10-21T10:00:00Z", size: 0, type: "FILE_INFO_TYPE_DIRECTORY" }];
    const first = await browseFor(key, client, "documents", "", 5);
    assert.deepEqual(await browseFor(key, client, "documents", "", 5), first);
    assert.equal(hits["/rest/db/browse"], 1);
    browsed = [...browsed, { name: "Taxes", modTime: "2026-10-21T10:00:00Z", size: 0, type: "FILE_INFO_TYPE_DIRECTORY" }];
    assert.deepEqual(await browseFor(key, client, "documents", "", 6), first);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual((await browseFor(key, client, "documents", "", 6)).map((entry) => entry.name), ["Recipes", "Taxes"]);
    assert.equal(hits["/rest/db/browse"], 2);
  });

  it("above the limit the folder is too many to place", async () => {
    status = { ...status, needFiles: 25, needTotalItems: 25, errors: 30, pullErrors: 30 };
    const lists = await listsFor(`pc-${instanceCount}`, client, "documents", 20);
    assert.equal(lists.need, "too-many");
    assert.equal(lists.errors, "too-many");
    assert.equal(hits["/rest/db/need"], undefined);
    assert.equal(hits["/rest/folder/errors"], undefined);
  });
});
