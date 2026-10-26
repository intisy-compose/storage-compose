import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import type { HostAgentHeartbeat } from "../src/hostAgent.js";

const now = Date.parse("2026-10-20T18:00:00Z");

function heartbeat(overrides: Partial<HostAgentHeartbeat> = {}): HostAgentHeartbeat {
  return {
    heartbeat: "2026-10-20T17:59:55Z",
    heartbeatEpoch: now / 1000 - 5,
    host: "pc",
    os: "windows",
    state: "running",
    problems: [],
    nodes: [
      {
        id: "5c1c",
        name: "ventoy-files",
        kind: "folder",
        threshold: 80,
        assigned: [],
        root: "D:\\files",
        syncthing: { state: "running", deviceId: "AAAAAAA", guiPort: 8391, listenPort: 22001, apiKey: "key", problem: null },
      },
      {
        id: "d15c",
        name: "data",
        kind: "drive",
        threshold: 0,
        assigned: [],
        root: "F:\\",
        syncthing: { state: "starting", deviceId: null, guiPort: null, listenPort: null, apiKey: null, problem: null },
      },
    ],
    ...overrides,
  };
}

describe("host agent", () => {
  let agent: typeof import("../src/hostAgent.js");

  before(async () => {
    process.env.HOST_AGENT_EXPECTED = "yes";
    agent = await import("../src/hostAgent.js");
  });

  it("is fine while its heartbeat is fresh and it runs", () => {
    assert.equal(agent.agentProblem(heartbeat(), now), null);
  });

  it("is reported when the heartbeat is missing, stale or the agent stopped", () => {
    assert.match(agent.agentProblem(null, now) ?? "", /host agent not running/);
    assert.match(agent.agentProblem(heartbeat({ heartbeatEpoch: now / 1000 - 31 }), now) ?? "", /31 s old/);
    assert.match(agent.agentProblem(heartbeat({ state: "stopped" }), now) ?? "", /it is stopped/);
  });

  it("turns its nodes into registry entries reached through the host", () => {
    const [folder, drive] = agent.agentEntries(heartbeat(), now);
    assert.equal(folder.present, true);
    assert.deepEqual(folder.syncthing, { url: "http://host.docker.internal:8391", apiKey: "key" });
    assert.equal(drive.syncthing, null);
  });

  it("agentEntries maps the agent's space", () => {
    const withSpace = heartbeat();
    withSpace.nodes[1].space = { size: 1000, free: 400 };
    const [folder, drive] = agent.agentEntries(withSpace, now);
    assert.deepEqual(drive.space, { size: 1000, used: 600 });
    assert.deepEqual(folder.space, { size: null, used: null });
  });

  it("shows its nodes absent while it is not alive", () => {
    assert.deepEqual(agent.agentEntries(heartbeat({ heartbeatEpoch: now / 1000 - 120 }), now).map((entry) => [entry.present, entry.syncthing]), [
      [false, null],
      [false, null],
    ]);
  });
});
