import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PendingDevice } from "../src/api/types.js";
import { type DeviceAnswer, answerKey, freshAnswer, ignoreClick, pruneAnswers } from "../ui/src/requestAnswers.js";

function asking(nodeId: string, deviceId: string, name: string): PendingDevice {
  return { nodeId, nodeName: nodeId, deviceId, name, address: "", time: "2026-10-26T09:00:00Z" };
}

describe("answering a device on the Requests page", () => {
  it("an answer is kept only while its device is still asking", () => {
    const laptop = asking("d7e5", "LAPTOPA", "laptop");
    const phone = asking("d7e5", "PHONEAA", "phone");
    const answers = new Map<string, DeviceAnswer>([
      [answerKey(laptop), { ...freshAnswer(laptop), name: "work-laptop" }],
      [answerKey(phone), freshAnswer(phone)],
    ]);

    pruneAnswers(answers, [laptop]);

    assert.deepEqual([...answers.keys()], [answerKey(laptop)]);
    assert.equal(answers.get(answerKey(laptop))?.name, "work-laptop");
  });

  it("the same device asking two nodes keeps two answers", () => {
    assert.notEqual(answerKey(asking("d7e5", "LAPTOPA", "laptop")), answerKey(asking("fb98", "LAPTOPA", "laptop")));
  });

  it("ignore asks first and ignores only on the second click", () => {
    const answer = freshAnswer(asking("d7e5", "LAPTOPA", "laptop"));
    assert.equal(ignoreClick(answer), "ask");
    assert.equal(answer.confirmingIgnore, true);
    assert.equal(ignoreClick(answer), "ignore");
  });
});
