import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const actions: [string, Record<string, unknown>][] = [
  ["sync", {}],
  ["scrub", {}],
  ["add", { confirm: "add", device: "/dev/sdz" }],
  ["rebuild", { role: "data2", confirm: "data2", device: "/dev/sdz" }],
  ["remove", { role: "data2", confirm: "data2" }],
  ["accept-smart", { role: "data2" }],
];

describe("array actions", () => {
  let directory: string;
  let server: Server;
  let base: string;

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), "array-routes-"));
    process.env.STATUS_DIRECTORY = directory;
    const arrayDirectory = join(directory, "arrays", "5784");
    await mkdir(arrayDirectory, { recursive: true });
    const drive = (role: string) => ({ label: `5784-${role}`, role, condition: "present", detail: "", asset: null, mounted: true, size: 1000, used: 10, serial: null });
    const silentForDays = {
      id: "5784", name: "private-array", node: "finn", updated: "2026-10-21T12:35:32Z", state: "healthy", since: "2026-10-21T00:43:49Z",
      complete: true, present: true, reasons: [], drives: [drive("data1"), drive("data2"), drive("parity1")], splitFolders: [], pausedFolders: [], description: null,
    };
    await writeFile(join(arrayDirectory, "status.json"), JSON.stringify(silentForDays));
    const { handleRequest } = await import("../src/routes.js");
    server = createServer((request, response) => void handleRequest(request, response));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  for (const [action, body] of actions) {
    it(`${action} on an array that is not connected is 409 and names it`, async () => {
      const answer = await fetch(`${base}/api/arrays/5784/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      assert.equal(answer.status, 409);
      assert.deepEqual(await answer.json(), { error: "private-array is not connected" });
    });
  }

  it("leaves no request for the mounter behind", () => {
    assert.equal(existsSync(join(directory, "arrays", "5784", "accept-smart.request")), false);
  });
});
