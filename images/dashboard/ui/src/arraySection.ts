import type { ArrayMember, NodeArray, Parity, StorageNode } from "./api.js";
import { arrayActionArea } from "./arrayActions.js";
import { element, keyValueList, progressBar, section } from "./dom.js";
import { formatBytes, formatDate, formatDuration, normaliseCompletion } from "./format.js";
import { arrayStateMeaning, memberSpaceTone, smartVerdict } from "./nodeStatus.js";
import { inventoryLink } from "./preferences.js";
import { requestRender } from "./renderRequest.js";
import { appState, effectiveInventoryItemUrl } from "./state.js";

const stateTone: Record<string, string> = { healthy: "ok", degraded: "warn", frozen: "bad" };

function assetElement(member: ArrayMember): HTMLElement | null {
  if (!member.asset) return null;
  const url = member.assetUrl ?? inventoryLink(effectiveInventoryItemUrl(), member.asset);
  if (!url) return element("span", { className: "chip" }, member.asset);
  return element("a", { className: "chip chip-link", attributes: { href: url, target: "_blank", rel: "noopener" } }, member.asset);
}

function memberSpace(member: ArrayMember): HTMLElement {
  const hasUsage = member.size !== null && member.used !== undefined && member.used !== null;
  const fraction = hasUsage ? (member.used as number) / (member.size as number) : null;
  const label = hasUsage ? `${formatBytes(member.used)} of ${formatBytes(member.size)}` : formatBytes(member.size);
  return element("span", { className: "member-space", title: label }, progressBar(fraction, memberSpaceTone(member), label), element("small", {}, label));
}

function memberRow(member: ArrayMember): HTMLElement {
  const verdict = smartVerdict(member);
  const temperature = member.present && member.temperature !== null ? `${member.temperature}°C` : "";
  return element(
    "div",
    { className: `member-row${member.present ? "" : " missing"}`, title: [member.label, member.serial].filter(Boolean).join(" · ") },
    element("strong", { className: "member-role" }, member.role),
    element("span", { className: "member-asset" }, assetElement(member)),
    memberSpace(member),
    element("span", { className: "member-temperature" }, temperature),
    element("span", { className: `member-smart tone-text-${verdict.tone}` }, verdict.label),
  );
}

function candidatesToggle(array: NodeArray): HTMLElement | null {
  const count = array.candidates.length;
  if (count === 0) return null;
  const toggle = element(
    "button",
    { className: "disclosure", attributes: { type: "button", "aria-expanded": String(appState.showCandidates) } },
    `${count} ${count === 1 ? "drive" : "drives"} that could be added`,
  );
  toggle.addEventListener("click", () => {
    appState.showCandidates = !appState.showCandidates;
    requestRender();
  });
  const list = appState.showCandidates
    ? element(
        "ul",
        { className: "candidate-list" },
        ...array.candidates.map((candidate) =>
          element("li", {}, [candidate.model, candidate.serial, formatBytes(candidate.size), candidate.path].filter(Boolean).join(" · ")),
        ),
      )
    : null;
  return element("div", { className: "candidates" }, toggle, list);
}

function remainingTime(job: NonNullable<Parity["job"]>): string | null {
  const progress = normaliseCompletion(job.progress);
  const elapsed = Date.now() - new Date(job.startedAt).getTime();
  if (!(progress > 0.01) || !Number.isFinite(elapsed) || elapsed <= 0) return null;
  return `${formatDuration((elapsed / progress) * (1 - progress))} left`;
}

function runningJob(job: NonNullable<Parity["job"]>): HTMLElement {
  const progress = normaliseCompletion(job.progress);
  const remaining = remainingTime(job);
  return element(
    "div",
    { className: "job" },
    element(
      "div",
      { className: "job-line" },
      element("strong", {}, `${job.kind.charAt(0).toUpperCase()}${job.kind.slice(1)} running`),
      element("span", { className: "job-percent" }, `${(progress * 100).toFixed(progress < 0.1 ? 1 : 0)}%`),
    ),
    progressBar(progress, "accent", `${job.kind} progress`),
    element("small", { className: "muted" }, [`started ${formatDate(job.startedAt)}`, remaining].filter(Boolean).join(", ")),
  );
}

function paritySection(node: StorageNode, array: NodeArray): HTMLElement {
  const parity = array.parity;
  return section(
    "Parity",
    parity.job ? runningJob(parity.job) : null,
    keyValueList([
      ["Last sync", formatDate(parity.lastSync)],
      ["Last scrub", formatDate(parity.lastScrub)],
      ...(parity.refused ? ([["Sync refused", element("span", { className: "tone-text-bad" }, parity.refused)]] as [string, HTMLElement][]) : []),
    ]),
    node.local ? arrayActionArea(node, array) : null,
  );
}

function stateBanner(array: NodeArray): HTMLElement {
  const missing = array.members.filter((member) => !member.present).map((member) => member.role);
  const missingText = missing.length ? ` Missing: ${missing.join(", ")}.` : "";
  return element(
    "div",
    { className: `state-banner tone-border-${stateTone[array.state] ?? "muted"}` },
    element("strong", { className: `tone-text-${stateTone[array.state] ?? "muted"}` }, `Array ${array.state}.`),
    ` ${arrayStateMeaning[array.state] ?? ""}${missingText}`,
  );
}

export function arraySections(node: StorageNode, array: NodeArray): HTMLElement[] {
  return [
    section(
      "Drives",
      array.state === "healthy" ? null : stateBanner(array),
      element("div", { className: "member-list" }, ...array.members.map(memberRow)),
      node.local ? candidatesToggle(array) : null,
    ),
    paritySection(node, array),
  ];
}
