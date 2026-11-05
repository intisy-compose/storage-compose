import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { LayoutSaveAnswer } from "../src/api/types.js";
import { defaultPriorityBands } from "../src/api/types.js";
import { layoutVersion } from "../src/layoutEdit.js";
import { priorityRoutes } from "../src/routes/priorities.js";
import { parseLayout } from "../src/setupRepo.js";
import { bandOf } from "../ui/src/folderCondition.js";
import { bandRows, typedBands } from "../ui/src/bandsForm.js";
import { askRoutes, git, layoutRepos } from "./layoutRepos.js";

describe("priority bands from the layout", () => {
  it("a priority falls in the highest band that starts at or below it", () => {
    assert.deepEqual(bandOf(80), { name: "essential", rank: 0 });
    assert.deepEqual(bandOf(79), { name: "working", rank: 1 });
    assert.deepEqual(bandOf(30), { name: "archive", rank: 2 });
    assert.deepEqual(bandOf(1), { name: "archive", rank: 2 });
    assert.deepEqual(bandOf(0), { name: "local", rank: 3 });
  });

  it("follows the layout's own bands, whatever their order there", () => {
    const bands = [{ name: "low", from: 0 }, { name: "high", from: 70 }];
    assert.deepEqual(bandOf(75, bands), { name: "high", rank: 0 });
    assert.deepEqual(bandOf(30, bands), { name: "low", rank: 1 });
  });

  it("the design's bands stand in while no layout is read", () => {
    assert.deepEqual(bandOf(50, undefined), bandOf(50, defaultPriorityBands));
  });

  it("the Settings form reads rows of name and start, and names a row that is not one", () => {
    assert.deepEqual(bandRows(defaultPriorityBands), [["essential", "80"], ["working", "50"], ["archive", "1"], ["local", "0"]]);
    assert.deepEqual(typedBands([["high", "70"], ["low", "0"]]), { bands: [{ name: "high", from: 70 }, { name: "low", from: 0 }] });
    assert.deepEqual(typedBands([["high", "seventy"]]), { problem: "high: the start is a whole number from 0 to 100" });
    assert.deepEqual(typedBands([["", "5"]]), { problem: "every band needs a name" });
  });
});

describe("editing the bands through the setup repo", () => {
  let repos: ReturnType<typeof layoutRepos>;
  const routes = () => priorityRoutes({ repository: repos.ours, configured: async () => () => new Set() });
  const version = () => layoutVersion(readFileSync(join(repos.ours, "drive-sync.toml"), "utf8"));

  before(() => (repos = layoutRepos("bands-")));
  after(() => rmSync(repos.root, { recursive: true, force: true }));

  it("commits the layout's own [bands], which the layout then reads", async () => {
    const answer = await askRoutes(routes(), "PUT", "/api/layout/bands", { base: version(), bands: [{ name: "low", from: 0 }, { name: "high", from: 70 }] });
    assert.equal(answer.status, 200);
    const saved = answer.body as LayoutSaveAnswer;
    assert.deepEqual(saved.layout.bands, [{ name: "high", from: 70 }, { name: "low", from: 0 }]);
    assert.equal(saved.layout.bandsFromLayout, true);
    assert.deepEqual(parseLayout(git(repos.remote, "show", "main:drive-sync.toml")).bands, [{ name: "high", from: 70 }, { name: "low", from: 0 }]);
    assert.equal(git(repos.remote, "log", "-1", "--format=%s", "main"), "feat(layout): set the priority bands to high from 70, low from 0");
  });

  it("refuses bands without one from 0, and a save from an older layout", async () => {
    assert.equal((await askRoutes(routes(), "PUT", "/api/layout/bands", { base: version(), bands: [{ name: "high", from: 70 }] })).status, 400);
    assert.equal((await askRoutes(routes(), "PUT", "/api/layout/bands", { base: "stale", bands: [{ name: "all", from: 0 }] })).status, 409);
  });
});
