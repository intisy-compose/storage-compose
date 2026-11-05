import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { type Peers, completion, connectedDevices, shareFolder, startPeers, stopPeers, waitUntil } from "./peers.js";

let peers: Peers;

before(async () => {
  peers = await startPeers();
});

after(async () => {
  await stopPeers();
});

test("three peers see each other and complete an empty folder", async () => {
  const all = [peers.stick, peers.keeper, peers.other];
  for (const peer of all) {
    const others = all.filter((candidate) => candidate !== peer).map((candidate) => candidate.deviceId);
    assert.deepEqual((await connectedDevices(peer)).sort(), others.sort(), `${peer.name} is connected to both others`);
  }
  await shareFolder("empty", all.map((peer) => ({ peer, type: "sendreceive" })));
  for (const peer of all) {
    for (const remote of all.filter((candidate) => candidate !== peer)) {
      await waitUntil(async () => (await completion(peer, "empty", remote)).completion === 100, `${remote.name} complete on ${peer.name}`);
    }
  }
});
