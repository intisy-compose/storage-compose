import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Peer } from "./peers.js";

const run = promisify(execFile);
const executorScript = fileURLToPath(new URL("../../../../images/nodes/handoff.sh", import.meta.url));
const probeScript = fileURLToPath(new URL("../../../../images/nodes/handoff-probe.sh", import.meta.url));
const executorImage = "storage-nodes-tests:local";
const executorDockerfile = `FROM debian:trixie-slim
RUN apt-get update \\
    && apt-get install -y --no-install-recommends jq=1.7.1-6+deb13u4 curl=8.14.1-2+deb13u7 \\
    && rm -rf /var/lib/apt/lists/*
`;

export interface ExecutorResult {
  refused: string | null;
  results: { folderId: string; path: string; outcome: string; reason: string; trash?: string }[];
  purged: number;
}

/** The image the executor runs in, with the tools the nodes image gives it. */
export function buildExecutorImage(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["build", "--quiet", "-t", executorImage, "-"], { stdio: ["pipe", "ignore", "pipe"] });
    let errorText = "";
    child.stderr.on("data", (chunk: Buffer) => { errorText += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`docker build: exit ${code} ${errorText}`))));
    child.stdin.end(executorDockerfile);
  });
}

export async function inPeer(peer: Peer, script: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("docker", ["exec", "-u", "1000:1000", peer.container, "sh", "-c", script, "sh", ...args]);
  return stdout;
}

/** The node's own `.storage/node.toml`, which the executor checks for `apply = true` beside the contract. */
export async function writeNodeFile(peer: Peer, root: string, nodeId: string, apply: boolean): Promise<void> {
  await inPeer(peer, 'mkdir -p "$1/.storage" && printf "%s\\n" "[node]" "id = \\"$3\\"" "name = \\"$4\\"" "kind = \\"drive\\"" "threshold = 50" "apply = $2" > "$1/.storage/node.toml"', root, String(apply), nodeId, peer.name);
}

/**
 * The executor in a container that shares the node's volume and network, as the nodes service shares its node's, with the open-file probe
 * beside it in the same container, which sees no other container's processes.
 */
export async function runExecutor(peer: Peer, scratch: string, nodeId: string, root: string, environment: Record<string, string> = {}): Promise<ExecutorResult> {
  const variables = Object.entries({ HANDOFF_IGNORE_WAIT_SECONDS: "30", HANDOFF_OPEN_SNAPSHOT: "/tmp/probe/open.txt", HANDOFF_PROBE_INTERVAL_SECONDS: "1", ...environment }).flatMap(([name, value]) => ["-e", `${name}=${value}`]);
  await run("docker", [
    "run", "--rm", "--network", `container:${peer.container}`, "--volumes-from", peer.container,
    "-u", "1000:1000", "-v", `${scratch}:/handoff`, "-v", `${executorScript}:/handoff.sh:ro`, "-v", `${probeScript}:/handoff-probe.sh:ro`, ...variables, executorImage,
    "bash", "-c", 'mkdir -p /tmp/probe && { bash /handoff-probe.sh /tmp/probe & } && bash /handoff.sh "$@"', "executor",
    nodeId, root, "http://127.0.0.1:8384", peer.apiKey, `/handoff/${nodeId}.json`, `/handoff/${nodeId}.result.json`,
  ], { env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
  return JSON.parse(readFileSync(join(scratch, `${nodeId}.result.json`), "utf8")) as ExecutorResult;
}
