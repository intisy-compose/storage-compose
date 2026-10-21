import type { NodesResponse, Warning, WarningLevel } from "./api.js";
import { element } from "./dom.js";
import { formatAge } from "./format.js";
import { locationFor } from "./state.js";

const levelGroups: { level: WarningLevel; heading: string }[] = [
  { level: "error", heading: "Errors" },
  { level: "warning", heading: "Warnings" },
  { level: "info", heading: "For your information" },
];

/** Where an entry leads: an offer to Requests, a folder's problem to the folder, anything else to its node. */
export function warningHref(warning: Warning): string | null {
  if (warning.kind === "pending-device" || warning.kind === "pending-folder") return locationFor("requests");
  if (warning.folderId) return locationFor("folders", warning.folderId);
  return warning.nodeId ? locationFor("nodes", warning.nodeId) : null;
}

function timeOf(warning: Warning): number {
  const time = Date.parse(warning.at);
  return Number.isFinite(time) ? time : 0;
}

function newestFirst(left: Warning, right: Warning): number {
  return timeOf(right) - timeOf(left);
}

function nodeNameOf(response: NodesResponse, warning: Warning): string | null {
  return response.nodes.find((node) => node.id === warning.nodeId)?.name ?? null;
}

function entry(response: NodesResponse, warning: Warning): HTMLElement {
  const href = warningHref(warning);
  const meta = [nodeNameOf(response, warning), formatAge(warning.at)].filter(Boolean).join(" · ");
  const item = element(
    href ? "a" : "div",
    { className: `warning level-${warning.level} attention-entry` },
    element("span", { className: "warning-text" }, warning.text),
    element("small", { className: "attention-meta" }, meta),
  );
  if (href) item.setAttribute("href", href);
  return item;
}

function levelGroup(response: NodesResponse, level: WarningLevel, heading: string): HTMLElement | null {
  const entries = response.warnings.filter((warning) => warning.level === level).sort(newestFirst);
  if (!entries.length) return null;
  return element(
    "section",
    { className: "attention-group" },
    element("h2", { className: "group-heading" }, heading, element("span", { className: "group-count" }, String(entries.length))),
    element("div", { className: "warnings attention-list" }, ...entries.map((warning) => entry(response, warning))),
  );
}

function allClear(): HTMLElement {
  return element("div", { className: "coming" }, element("strong", {}, "Nothing needs attention"), element("p", {}, "Every node, folder and request is in order."));
}

export function renderAttentionPage(response: NodesResponse): HTMLElement {
  const groups = levelGroups.map(({ level, heading }) => levelGroup(response, level, heading)).filter((group): group is HTMLElement => group !== null);
  return element(
    "div",
    { className: "page" },
    element(
      "header",
      { className: "page-header" },
      element("h1", {}, "Attention"),
      element("p", { className: "page-summary" }, "Everything that needs a person, by level and newest first. Each entry opens its node, folder or request."),
    ),
    ...(groups.length ? groups : [allClear()]),
  );
}
