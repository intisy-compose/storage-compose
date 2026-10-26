import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { priorityBadgeText, statusPresentation } from "../src/api/explorerText.js";
import type { EntryStatus, NodeEntryState, PriorityInfo } from "../src/api/types.js";

function priority(overrides: Partial<PriorityInfo>): PriorityInfo {
  return { effective: 0, setHere: null, inherited: 0, inheritedFrom: null, source: "default", overridesParent: false, ...overrides };
}

function state(status: EntryStatus, detail: string | null = null): NodeEntryState {
  return { nodeId: "fb98", nodeName: "pc", host: "finn", status, detail };
}

const everyStatus: EntryStatus[] = ["failed", "syncing", "missing", "ignored", "local-only", "below-threshold", "paused", "unknown", "in-sync"];

describe("explorer text", () => {
  it("the override badge reads overrides parent: 80 (parent 0)", () => {
    const info = priority({ effective: 80, setHere: 80, inherited: 0, source: "setup-repo", overridesParent: true });
    assert.equal(priorityBadgeText(info), "overrides parent: 80 (parent 0)");
  });

  it("an equal entry reads set here: 80, same as parent", () => {
    const info = priority({ effective: 80, setHere: 80, inherited: 80, inheritedFrom: "Documents", source: "setup-repo" });
    assert.equal(priorityBadgeText(info), "set here: 80, same as parent");
  });

  it("an inherited priority names its source", () => {
    const info = priority({ effective: 80, inherited: 80, inheritedFrom: "Documents", source: "inherited" });
    assert.equal(priorityBadgeText(info), "80, inherited from Documents");
    assert.equal(priorityBadgeText(priority({ effective: 20, inherited: 20, inheritedFrom: ".", source: "inherited" })), "20, inherited from the top directory");
  });

  it("the top directory's default says so", () => {
    assert.equal(priorityBadgeText(priority({})), "0, default of the top directory");
    assert.equal(priorityBadgeText(priority({}), true), "0, default of the top directory");
  });

  it("a top directory set away from 0 is marked as overriding the default", () => {
    const top = priority({ effective: 20, setHere: 20, source: "setup-repo" });
    assert.equal(priorityBadgeText(top, true), "overrides the default: 20 (default 0)");
    assert.equal(priorityBadgeText(priority({ setHere: 0, source: "setup-repo" }), true), "set here: 0, same as the default");
  });

  it("missing is muted, syncing is warn, failed is bad", () => {
    assert.equal(statusPresentation(state("missing", "offered, not accepted")).tone, "muted");
    assert.equal(statusPresentation(state("syncing", "3 items outstanding below")).tone, "warn");
    assert.equal(statusPresentation(state("failed", "652 items failed below")).tone, "bad");
  });

  it("ignored is muted italic, only here and paused carry chips, below threshold is dimmed with its threshold", () => {
    assert.deepEqual(statusPresentation(state("ignored", "ignored by .stignore")), { tone: "muted", label: "ignored", chip: "ignored", italic: true, dimmed: false });
    assert.equal(statusPresentation(state("local-only")).chip, "only here");
    assert.equal(statusPresentation(state("local-only")).tone, "normal");
    assert.deepEqual(statusPresentation(state("below-threshold", "below threshold 50")), { tone: "normal", label: "below threshold", chip: "below threshold 50", italic: false, dimmed: true });
    assert.deepEqual(statusPresentation(state("paused")), { tone: "muted", label: "paused", chip: "paused", italic: false, dimmed: false });
    assert.equal(statusPresentation(state("unknown")).label, "?");
    assert.equal(statusPresentation(state("unknown")).tone, "muted");
  });

  it("every status has a presentation", () => {
    for (const status of everyStatus) {
      const shown = statusPresentation(state(status));
      assert.ok(shown.label.length > 0, status);
      assert.ok(["normal", "muted", "warn", "bad"].includes(shown.tone), status);
    }
  });
});
