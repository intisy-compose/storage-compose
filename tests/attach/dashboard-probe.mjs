// Run inside the dashboard image by vhdx.ps1: what the dashboard offers and which SMART report it shows.
import { listBlockDevices, replacementCandidates, wholeDeviceOf } from "/app/dist/blockDevices.js";
import { smartSummary } from "/app/dist/smart.js";

const [labelledPartition] = process.argv.slice(2);
const devices = await listBlockDevices();
const labelledDisk = wholeDeviceOf(devices, labelledPartition);
const smart = labelledDisk ? await smartSummary(labelledDisk) : null;
console.log(JSON.stringify({
  candidates: replacementCandidates(devices).map((candidate) => ({ path: candidate.path, size: candidate.size, transport: candidate.transport })),
  labelledDisk: labelledDisk?.path ?? null,
  labelledSerial: smart?.serial ?? null,
}));
