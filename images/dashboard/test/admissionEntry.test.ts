import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { admissionText } from "../ui/src/admissionEntry.js";

describe("a node waiting for admission on Requests", () => {
  it("says what accepting commits, and that the node only reports after it", () => {
    const text = admissionText({ nodeId: "b001", name: "stick", source: "registry", host: "storage", threshold: 80, listed: false });
    assert.equal(text, "stick (b001) on storage, threshold 80: the layout does not list it yet. Accepting commits admitted = true, so other nodes may share with it; it only reports until apply is turned on for it.");
    assert.match(admissionText({ nodeId: "b001", name: "stick", source: "registry", host: "storage", threshold: 80, listed: true }), /the layout lists it, not admitted yet/);
  });
});
