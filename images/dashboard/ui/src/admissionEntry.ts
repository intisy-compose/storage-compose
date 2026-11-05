import { type NodeAdmission, answerAdmission } from "./api.js";
import { button, element } from "./dom.js";
import { requestRender } from "./renderRequest.js";
import { type Notice, appState } from "./state.js";

/** What accepting a node commits, in words, before the click. */
export function admissionText(admission: NodeAdmission): string {
  const where = admission.listed ? "the layout lists it, not admitted yet" : "the layout does not list it yet";
  return `${admission.name} (${admission.nodeId}) on ${admission.host}, threshold ${admission.threshold}: ${where}. Accepting commits admitted = true, so other nodes may share with it; it only reports until apply is turned on for it.`;
}

const busy = new Set<string>();
let lastNotice: Notice | null = null;

async function answer(admission: NodeAdmission, choice: "accept" | "refuse"): Promise<void> {
  const base = appState.layout?.version;
  if (!base) {
    lastNotice = { text: "The layout is not read yet.", tone: "bad" };
    return requestRender();
  }
  busy.add(admission.nodeId);
  requestRender();
  const result = await answerAdmission(admission.nodeId, { base, answer: choice });
  busy.delete(admission.nodeId);
  lastNotice = result.ok ? { text: `${admission.name}: ${choice === "accept" ? "admitted" : "refused"}, ${result.value.saved.message}.`, tone: result.value.saved.pushed ? "ok" : "warn" } : { text: `Not answered: ${result.message}`, tone: "bad" };
  requestRender();
}

export function admissionNotice(): HTMLElement | null {
  return lastNotice ? element("p", { className: `notice tone-text-${lastNotice.tone}`, attributes: { role: "status" } }, lastNotice.text) : null;
}

/** One node waiting for admission, answered on its own host, where its node file is. */
export function admissionEntry(admission: NodeAdmission): HTMLElement {
  const isBusy = busy.has(admission.nodeId);
  const isHere = appState.data?.host.name === admission.host;
  const accept = button("Admit", () => void answer(admission, "accept"), "button primary");
  const refuse = button("Refuse", () => void answer(admission, "refuse"), "button ghost");
  accept.disabled = refuse.disabled = isBusy || !appState.layout;
  return element(
    "li",
    { className: "request-entry" },
    element("span", { className: "request-text" }, element("strong", {}, admission.name), ` waits for admission`, element("small", { className: "request-detail" }, admissionText(admission))),
    isHere ? element("div", { className: "button-row" }, accept, refuse) : element("small", { className: "muted" }, `Answered on ${admission.host}'s dashboard.`),
  );
}
