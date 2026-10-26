import { element } from "./dom.js";
import { locationFor } from "./state.js";

/** The detail of a device or drive the page cannot show: still being read, not readable, or not known. */
export function renderItemNotFound(what: string, key: string, isRead: boolean, readError: string | null): HTMLElement {
  const text = readError ? `The ${what}s could not be read: ${readError}` : isRead ? `No ${what} ${key} is known.` : `Reading ${what}s…`;
  return element(
    "div",
    { className: "detail-inner detail-empty" },
    element("p", {}, text),
    element("a", { attributes: { href: locationFor("nodes") } }, "Back to all devices"),
  );
}
