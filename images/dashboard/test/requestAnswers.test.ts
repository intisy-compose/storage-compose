import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PendingDevice, PendingFolderOffer } from "../src/api/types.js";
import { type DeviceAnswer, type FolderAnswer, answerKey, folderAnswerKey, freshAnswer, freshFolderAnswer, ignoreClick, isAcceptConfirmed, pruneAnswers } from "../ui/src/requestAnswers.js";

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

    pruneAnswers(answers, [answerKey(laptop)], []);

    assert.deepEqual([...answers.keys()], [answerKey(laptop)]);
    assert.equal(answers.get(answerKey(laptop))?.name, "work-laptop");
  });

  it("an answer is kept while its node is only briefly unreadable or not connected", () => {
    const laptop = asking("d7e5", "LAPTOPA", "laptop");
    const onStick = asking("a1b2", "PHONEAA", "phone");
    const answers = new Map<string, DeviceAnswer>([
      [answerKey(laptop), { ...freshAnswer(laptop), name: "work-laptop" }],
      [answerKey(onStick), { ...freshAnswer(onStick), name: "my-phone" }],
    ]);

    pruneAnswers(answers, [], [
      { name: "d7e5", reason: "its Syncthing is not answering" },
      { name: "a1b2", reason: "not connected", notConnected: true },
    ]);
    assert.deepEqual([...answers.keys()], [answerKey(laptop), answerKey(onStick)]);

    pruneAnswers(answers, [], []);
    assert.deepEqual([...answers.keys()], [], "once the node answers without the request, its answer goes");
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

function offer(nodeId: string, folderId: string, offeredBy: string): PendingFolderOffer {
  return { nodeId, nodeName: nodeId, folderId, label: folderId, offeredBy, offeredByName: offeredBy, time: "2026-10-27T09:00:00Z", receiveEncrypted: false };
}

describe("answering a folder offer on the Requests page", () => {
  it("each device's offer of a folder to a node is answered on its own", () => {
    const keys = new Set([folderAnswerKey(offer("d7e5", "docs", "TW1")), folderAnswerKey(offer("d7e5", "docs", "TW2")), folderAnswerKey(offer("fb98", "docs", "TW1")), folderAnswerKey(offer("d7e5", "music", "TW1"))]);
    assert.equal(keys.size, 4);
  });

  it("an open accept form is kept while its node is briefly unreadable", () => {
    const docs = offer("d7e5", "docs", "TW1");
    const answers = new Map<string, FolderAnswer>([[folderAnswerKey(docs), { ...freshFolderAnswer(docs), open: true, confirm: "do" }]]);
    pruneAnswers(answers, [], [{ name: "d7e5", reason: "its Syncthing is not answering" }]);
    assert.equal(answers.get(folderAnswerKey(docs))?.confirm, "do");
    pruneAnswers(answers, [folderAnswerKey(docs)], []);
    assert.equal(answers.size, 1);
    pruneAnswers(answers, [], []);
    assert.equal(answers.size, 0);
  });

  it("an accept that needs the folder ID typed is confirmed only by the exact ID", () => {
    const answer = freshFolderAnswer(offer("a3f9", "documents", "PC"));
    assert.equal(isAcceptConfirmed(answer, "documents", false), true, "a node that needs no typed ID");
    assert.equal(isAcceptConfirmed(answer, "documents", true), false);
    answer.confirm = "Documents";
    assert.equal(isAcceptConfirmed(answer, "documents", true), false);
    answer.confirm = "documents";
    assert.equal(isAcceptConfirmed(answer, "documents", true), true);
  });
});
