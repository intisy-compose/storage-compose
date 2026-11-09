import { type NodeAdmission, answerAdmission } from "./api.js";
import { button, element } from "./dom.js";
import { registerForm } from "./forms.js";
import { typedPriority } from "./priorityEditor.js";
import { requestRender } from "./renderRequest.js";
import { type Notice, appState } from "./state.js";

/** What accepting a node commits, in words, before the click. */
export function admissionText(admission: NodeAdmission): string {
  const where = admission.listed ? "the layout lists it, not admitted yet" : "the layout does not list it yet";
  const claim = admission.claimedBy ? `, reported by the device ${admission.claimedBy.deviceName}` : "";
  return `${admission.name} (${admission.nodeId}) on ${admission.host}${claim}: ${where}; its node file suggests threshold ${admission.threshold}. Admitting commits admitted = true at the threshold confirmed here, so other nodes may share with it, and apply = false: it only reports until apply is turned on for it.`;
}

const busy = new Set<string>();
/** The threshold typed per node, the node file's suggestion until it is changed. */
const thresholds = new Map<string, string>();
let lastNotice: Notice | null = null;

/** One row per claim, so two devices claiming one node id are answered apart. */
function admissionKey(admission: NodeAdmission): string {
  return `${admission.nodeId}-${admission.claimedBy?.deviceId ?? ""}`;
}

async function answer(admission: NodeAdmission, choice: "accept" | "refuse"): Promise<void> {
  const base = appState.layout?.version;
  if (!base) {
    lastNotice = { text: "The layout is not read yet.", tone: "bad" };
    return requestRender();
  }
  const threshold = typedPriority(thresholds.get(admissionKey(admission)) ?? String(admission.threshold));
  if (choice === "accept" && threshold === null) {
    lastNotice = { text: "The threshold is a whole number from 0 to 100.", tone: "bad" };
    return requestRender();
  }
  busy.add(admissionKey(admission));
  requestRender();
  const claimed = admission.claimedBy ? { deviceId: admission.claimedBy.deviceId } : {};
  const result = await answerAdmission(admission.nodeId, choice === "accept" ? { base, answer: choice, threshold: threshold as number, ...claimed } : { base, answer: choice, ...claimed });
  busy.delete(admissionKey(admission));
  lastNotice = result.ok ? { text: `${admission.name}: ${choice === "accept" ? "admitted" : "refused"}, ${result.value.saved.message}.`, tone: result.value.saved.pushed ? "ok" : "warn" } : { text: `Not answered: ${result.message}`, tone: "bad" };
  requestRender();
}

export function admissionNotice(): HTMLElement | null {
  return lastNotice ? element("p", { className: `notice tone-text-${lastNotice.tone}`, attributes: { role: "status" } }, lastNotice.text) : null;
}

/** One node waiting for admission, answered on its own host, where its node file is. */
export function admissionEntry(admission: NodeAdmission): HTMLElement {
  const key = admissionKey(admission);
  const isBusy = busy.has(key);
  const isHere = appState.data?.host.name === admission.host;
  const accept = button("Admit", () => void answer(admission, "accept"), "button primary");
  const refuse = button("Refuse", () => void answer(admission, "refuse"), "button ghost");
  accept.disabled = refuse.disabled = isBusy || !appState.layout;
  const formId = `admission-${key}`;
  registerForm(formId);
  const input = element("input", { attributes: { id: `${formId}-threshold`, type: "number", min: "0", max: "100", step: "1", "aria-label": `Threshold to admit ${admission.name} at` } });
  input.defaultValue = String(admission.threshold);
  input.value = thresholds.get(key) ?? String(admission.threshold);
  input.disabled = isBusy;
  input.addEventListener("input", () => thresholds.set(key, input.value));
  return element(
    "li",
    { className: "request-entry" },
    element("span", { className: "request-text" }, element("strong", {}, admission.name), ` waits for admission`, element("small", { className: "request-detail" }, admissionText(admission))),
    isHere ? element("div", { className: "button-row", attributes: { id: formId } }, element("label", { attributes: { for: `${formId}-threshold` } }, "Threshold "), input, accept, refuse) : element("small", { className: "muted" }, `Answered on ${admission.host}'s dashboard.`),
  );
}
