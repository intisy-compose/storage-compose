import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type NodeWriteRoute, type Route, type WriteNote, dashboardRoutes, hostWritePattern, isNodePattern, settleWrite } from "../src/routes.js";

function recorder() {
  const recorded: WriteNote[] = [];
  let invalidations = 0;
  return {
    recorded,
    invalidations: () => invalidations,
    effects: { invalidate: () => void (invalidations += 1), record: (note: WriteNote) => void recorded.push(note) },
  };
}

const note: WriteNote = { nodeId: "fb98", nodeName: "pc", folderId: null, text: "pc: renamed device dashboard-test-peer to dashboard-test-renamed" };

describe("a write through the dashboard", () => {
  it("a successful write drops the shared local build and enters its note in Activity", () => {
    const effects = recorder();
    settleWrite("PATCH", 200, note, effects.effects);
    assert.equal(effects.invalidations(), 1);
    assert.deepEqual(effects.recorded, [note]);
  });

  it("a node write must answer with its note, so a forgotten one does not compile", () => {
    const forgetful: NodeWriteRoute = {
      method: "PATCH",
      pattern: /^\/api\/nodes\/x$/,
      // @ts-expect-error a node write that names nothing for Activity is a compile error
      write: async () => {},
    };
    assert.equal(forgetful.method, "PATCH");
  });

  it("a write to several nodes enters each node's note and drops the shared build once", () => {
    const effects = recorder();
    const other: WriteNote = { nodeId: "d7e5", nodeName: "dashboard-test-peer", folderId: null, text: "dashboard-test-peer: changed connection options; relays on" };
    settleWrite("PATCH", 200, [note, other], effects.effects);
    assert.deepEqual(effects.recorded, [note, other]);
    assert.equal(effects.invalidations(), 1);
  });

  it("a write to several nodes cannot answer with no note at all", () => {
    const empty: NodeWriteRoute = {
      method: "PATCH",
      pattern: /^\/api\/nodes\/x$/,
      // @ts-expect-error an empty list of notes would drop the shared build and name nothing
      write: async () => [],
    };
    assert.equal(empty.method, "PATCH");
  });

  it("a node write that wrote nothing enters nothing in Activity and keeps the shared build", () => {
    const effects = recorder();
    settleWrite("POST", 200, { nothingWritten: true }, effects.effects);
    assert.deepEqual(effects.recorded, []);
    assert.equal(effects.invalidations(), 0);
  });

  it("a node write whose note is empty is still entered, naming the node", () => {
    const effects = recorder();
    settleWrite("PATCH", 200, { ...note, text: " " }, effects.effects);
    assert.deepEqual(effects.recorded.map((entry) => entry.text), ["pc: changed through the dashboard"]);
    assert.equal(effects.invalidations(), 1);
  });

  it("a write that is not a node's, such as an array action, only drops the shared build", () => {
    const effects = recorder();
    settleWrite("POST", 202, null, effects.effects);
    assert.equal(effects.invalidations(), 1);
    assert.deepEqual(effects.recorded, []);
  });

  it("a read or a refused write changes nothing", () => {
    const effects = recorder();
    settleWrite("GET", 200, note, effects.effects);
    settleWrite("PATCH", 409, note, effects.effects);
    assert.equal(effects.invalidations(), 0);
    assert.deepEqual(effects.recorded, []);
  });

  it("a write under /api/nodes/ declared as a plain route does not compile", () => {
    // @ts-expect-error only a node write may carry a write method under /api/nodes/: a plain route's write pattern must come from hostWritePattern
    const misdeclared: Route = {
      method: "POST",
      pattern: /^\/api\/nodes\/([^/]+)\/devices$/,
      handle: async () => {},
    };
    assert.equal(misdeclared.method, "POST");
    assert.throws(() => hostWritePattern(/^\/api\/nodes\/([^/]+)\/devices$/), /is a node's path/);
    assert.throws(() => hostWritePattern(/^\/api\/nodes\/x$/), /is a node's path/);
    assert.throws(() => hostWritePattern(/^\/api\/nodes\/.*/), /is a node's path/);
    assert.throws(() => hostWritePattern(/^\/api\/nodes\/(fb98|d7e5)\/devices$/), /is a node's path/);
    assert.ok(hostWritePattern(/^\/api\/arrays\/x\/sync$/).test("/api/arrays/x/sync"));
    assert.ok(hostWritePattern(/^\/api\/join$/));
    assert.throws(() => hostWritePattern(/^\/api\/(arrays|nodes)\/([^/]+)$/), /is a node's path/, "an alternation that can name nodes");
    assert.throws(() => hostWritePattern(/^\/api\/(arrays|nodes)\/([^/]+)\/([^/]+)$/), /is a node's path/);
    assert.equal(isNodePattern(/^\/api\/nodes$/), false, "the nodes list itself is no node's path");
  });

  it("every write route under /api/nodes/ in the dashboard is a node write", () => {
    const nodeWrites = dashboardRoutes.filter((route) => route.method !== "GET" && isNodePattern(route.pattern));
    assert.ok(nodeWrites.length >= 2, "the device edit and the device add");
    for (const route of nodeWrites) assert.ok("write" in route, `${route.method} ${route.pattern} is not a NodeWriteRoute`);
  });
});
