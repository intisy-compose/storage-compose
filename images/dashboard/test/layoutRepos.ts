import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostAllowlist } from "../src/http.js";
import type { AnyRoute } from "../src/routeTypes.js";
import { requestHandler } from "../src/routes.js";

export function git(directory: string, ...args: string[]): string {
  return execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function cloneOf(remote: string, directory: string): string {
  execFileSync("git", ["clone", "-q", "-c", "core.autocrlf=false", remote, directory], { stdio: "ignore" });
  git(directory, "config", "user.email", "test@example.invalid");
  git(directory, "config", "user.name", "test");
  return directory;
}

export const testLayout = `[devices.pc]
id     = "PC-ID"
root   = "/data"
joined = true

[folders.Documents]
priority = 80

[folders.Videos]
priority = 30

[nodes.a1b2]
name      = "pc"
device    = "pc"
threshold = 50
admitted  = true
`;

/** A bare remote holding `testLayout` as drive-sync.toml, and two clones of it, ours and another host's. */
export function layoutRepos(prefix: string): { root: string; remote: string; ours: string; theirs: string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const remote = join(root, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  const seed = cloneOf(remote, join(root, "seed"));
  writeFileSync(join(seed, "drive-sync.toml"), testLayout);
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "seed");
  git(seed, "push", "-q", "origin", "HEAD:main");
  return { root, remote, ours: cloneOf(remote, join(root, "ours")), theirs: cloneOf(remote, join(root, "theirs")) };
}

/** Answers `routes` on a loopback port for one request. */
export async function askRoutes(routes: AnyRoute[], method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const handler = requestHandler(routes, { invalidate: () => {}, record: () => {} }, hostAllowlist(["127.0.0.1"]));
  const server: Server = createServer((request, response) => void handler(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
