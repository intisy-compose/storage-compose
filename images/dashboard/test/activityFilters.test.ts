import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { activityFiltersOf, activityFiltersQuery, activityRequestQuery, defaultActivityFilters, matchesActivityFilters } from "../src/api/activityFilters.js";
import type { ActivityEntry } from "../src/api/types.js";
import { ActivityLog, type NewActivityEntry } from "../src/eventFeed.js";
import { activityQuery } from "../src/routes/activity.js";

function newEntry(type: string): NewActivityEntry {
  return { at: "2026-10-27T12:00:00Z", source: "syncthing", nodeId: "fb98", folderId: "documents", type, level: "info", text: type };
}

function entry(type: string): ActivityEntry {
  return { id: type, ...newEntry(type) };
}

describe("activity filters in the address", () => {
  it("filters persist in the hash and read back the same", () => {
    const filters = { ...defaultActivityFilters, node: "fb98", folder: "documents" };
    assert.equal(activityFiltersQuery(filters), "node=fb98&folder=documents");
    assert.deepEqual(activityFiltersOf(new URLSearchParams("node=fb98&folder=documents")), filters);
    const every = { node: "fb98", folder: "a b", source: "syncthing", kind: "changes" as const, routine: true };
    assert.deepEqual(activityFiltersOf(new URLSearchParams(activityFiltersQuery(every))), every);
  });

  it("the defaults leave the address bare, and an unknown kind or source reads as none", () => {
    assert.equal(activityFiltersQuery(defaultActivityFilters), "");
    assert.deepEqual(activityFiltersOf(new URLSearchParams("type=everything&source=elsewhere")), defaultActivityFilters);
  });

  it("asking for file changes sends type=changes and keeps them although routine entries are hidden", () => {
    const changes = activityRequestQuery({ ...defaultActivityFilters, folder: "documents", kind: "changes" }, 20);
    assert.equal(changes.toString(), "limit=20&folder=documents&type=changes");
    assert.equal(activityRequestQuery(defaultActivityFilters, 300).toString(), "limit=300&routine=false");
    const changesOnly = { ...defaultActivityFilters, kind: "changes" as const };
    assert.ok(matchesActivityFilters(entry("remote-change"), changesOnly));
    assert.ok(!matchesActivityFilters(entry("item-failed"), changesOnly));
    assert.ok(!matchesActivityFilters(entry("local-change"), defaultActivityFilters));
  });
});

describe("GET /api/activity?type=changes", () => {
  it("type=changes stands for both change types, and routine=false leaves out only routine types not asked for", () => {
    const query = activityQuery(new URL("http://dashboard/api/activity?type=changes&routine=false"));
    assert.deepEqual(query.types, ["local-change", "remote-change"]);
    const log = new ActivityLog(10);
    for (const type of ["local-change", "remote-change", "state-changed", "item-failed"]) log.append(type, newEntry(type));
    assert.deepEqual(log.query(query).entries.map((found) => found.type).sort(), ["local-change", "remote-change"]);
    assert.deepEqual(log.query(activityQuery(new URL("http://dashboard/api/activity?routine=false"))).entries.map((found) => found.type), ["item-failed"]);
  });
});
