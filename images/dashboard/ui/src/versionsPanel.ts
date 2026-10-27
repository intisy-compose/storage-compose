import { type FileVersion, type FolderCopy, type VersionsPage, defaultItemsPerPage, fetchVersions, maxItemsPerPage, restoreConsequences, restoreVersions, versioningWords } from "./api.js";
import { arrayConfirmField, isArrayConfirmed } from "./arrayConfirm.js";
import { button, element } from "./dom.js";
import { formatBytes, formatCount, plural } from "./format.js";
import { controlId, registerForm } from "./forms.js";
import { pageCount } from "./itemPages.js";
import { requestRender } from "./renderRequest.js";
import { type Notice, type VersionsState, appState, editFolderLocation } from "./state.js";

const pageSizes = [...new Set([25, defaultItemsPerPage, maxItemsPerPage])].sort((left, right) => left - right);

export function isVersionsOpen(copy: Pick<FolderCopy, "nodeId" | "id">): boolean {
  const open = appState.versions;
  return open !== null && open.nodeId === copy.nodeId && open.folderId === copy.id;
}

/** The instant a date field's day starts or ends, in the browser's own time zone; empty for no bound. */
function boundOf(day: string, end: boolean): string {
  if (!day) return "";
  const instant = new Date(`${day}T${end ? "23:59:59.999" : "00:00:00"}`);
  return Number.isNaN(instant.getTime()) ? "" : instant.toISOString();
}

/** @implNote An answer for a directory, page or filter the person has since left, or for a browser since closed, is dropped. */
async function load(state: VersionsState, reread = false): Promise<void> {
  const asked = { prefix: state.prefix, page: state.page, perPage: state.perPage, from: state.from, to: state.to };
  state.loading = true;
  requestRender();
  const answer = await fetchVersions(state.nodeId, state.folderId, { ...asked, from: boundOf(asked.from, false), to: boundOf(asked.to, true), reread });
  const isCurrent = appState.versions === state && Object.entries(asked).every(([key, value]) => state[key as keyof typeof asked] === value);
  if (!isCurrent) return;
  state.answer = answer;
  state.loading = false;
  requestRender();
}

export function toggleVersions(copy: FolderCopy): void {
  if (isVersionsOpen(copy)) {
    appState.versions = null;
    requestRender();
    return;
  }
  const state: VersionsState = { nodeId: copy.nodeId, folderId: copy.id, prefix: "", page: 1, perPage: appState.itemsPerPage, from: "", to: "", loading: false, answer: null, chosen: new Map(), confirmOpen: false, confirm: "", busy: false, result: null };
  appState.versions = state;
  void load(state);
}

function goTo(state: VersionsState, change: Partial<Pick<VersionsState, "prefix" | "page" | "perPage" | "from" | "to">>): void {
  Object.assign(state, { page: 1 }, change);
  void load(state);
}

/** A version's time to the second, with its year: versions of one file are often minutes apart. */
function versionTimeText(versionTime: string): string {
  const date = new Date(versionTime);
  if (Number.isNaN(date.getTime())) return versionTime;
  return date.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function versionText(version: FileVersion): string {
  return `${versionTimeText(version.versionTime)}, ${formatBytes(version.size)}`;
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function formIdOf(state: VersionsState): string {
  const id = `versions-${`${state.folderId}-${state.nodeId}`.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  registerForm(id);
  return id;
}

function dateField(state: VersionsState, formId: string, which: "from" | "to", label: string): HTMLElement {
  const id = controlId(formId, which);
  const input = element("input", { attributes: { id, type: "date" } });
  input.defaultValue = state[which];
  input.value = state[which];
  input.disabled = state.busy;
  input.addEventListener("change", () => goTo(state, { [which]: input.value }));
  return element("label", { className: "versions-date", attributes: { for: id } }, element("span", {}, label), input);
}

function filterRow(state: VersionsState, formId: string): HTMLElement {
  const clear = button("Any date", () => goTo(state, { from: "", to: "" }), "button ghost");
  clear.disabled = state.busy || (!state.from && !state.to);
  return element("div", { className: "versions-filter" }, dateField(state, formId, "from", "Replaced from"), dateField(state, formId, "to", "to"), clear);
}

function crumbs(state: VersionsState): HTMLElement {
  const parts = state.prefix ? state.prefix.split("/") : [];
  const links: (HTMLElement | string)[] = [button("folder root", () => goTo(state, { prefix: "" }), "link-button")];
  parts.forEach((part, index) => {
    links.push(" / ");
    const prefix = parts.slice(0, index + 1).join("/");
    links.push(index === parts.length - 1 ? element("strong", {}, part) : button(part, () => goTo(state, { prefix }), "link-button"));
  });
  return element("p", { className: "versions-crumbs" }, ...links);
}

function directoryRow(state: VersionsState, directory: { path: string; files: number }): HTMLElement {
  return element(
    "li",
    { className: "item-row versions-directory" },
    button(`${baseName(directory.path)}/`, () => goTo(state, { prefix: directory.path }), "link-button item-name"),
    element("small", { className: "item-meta" }, `${plural(directory.files, "file")} with versions`),
  );
}

/** @implNote The chosen option is also the default one, so a choice does not count as unsaved input that would stop the poll for good. */
function versionChoice(state: VersionsState, formId: string, path: string, versions: FileVersion[], canRestore: boolean): HTMLElement {
  const select = element("select", { attributes: { id: controlId(formId, `file-${encodeURIComponent(path)}`), "aria-label": `Version of ${path} to restore` } });
  const chosen = state.chosen.get(path)?.versionTime ?? "";
  const options = [{ value: "", text: canRestore ? "keep the current file" : `${plural(versions.length, "version")}` }, ...versions.map((version) => ({ value: version.versionTime, text: versionText(version) }))];
  for (const option of options) {
    const entry = element("option", { attributes: { value: option.value } }, option.text);
    entry.selected = entry.defaultSelected = option.value === chosen;
    select.append(entry);
  }
  select.disabled = state.busy;
  select.addEventListener("change", () => {
    const version = versions.find((candidate) => candidate.versionTime === select.value);
    if (version) state.chosen.set(path, version);
    else state.chosen.delete(path);
    state.confirmOpen = false;
    requestRender();
  });
  return select;
}

function fileRow(state: VersionsState, formId: string, path: string, versions: FileVersion[], canRestore: boolean): HTMLElement {
  const newest = versions[0];
  return element(
    "li",
    { className: "item-row versions-file" },
    element("span", { className: "item-name", title: path }, baseName(path)),
    versionChoice(state, formId, path, versions, canRestore),
    element("small", { className: "item-meta" }, `${plural(versions.length, "version")}, newest replaced ${versionTimeText(newest.versionTime)}`),
  );
}

function pager(state: VersionsState, page: VersionsPage): HTMLElement {
  const pages = pageCount(page.total, state.perPage) ?? 1;
  const previous = button("Previous", () => goTo(state, { page: state.page - 1 }), "button ghost");
  previous.disabled = state.loading || state.page <= 1;
  const next = button("Next", () => goTo(state, { page: state.page + 1 }), "button ghost");
  next.disabled = state.loading || state.page >= pages;
  const size = element("select", { attributes: { "aria-label": "Entries per page" } });
  for (const value of pageSizes) {
    const option = element("option", { attributes: { value: String(value) } }, `${value} a page`);
    option.selected = option.defaultSelected = value === state.perPage;
    size.append(option);
  }
  size.addEventListener("change", () => {
    appState.itemsPerPage = Number(size.value);
    goTo(state, { perPage: appState.itemsPerPage });
  });
  const again = button("Read again", () => void load(state, true), "button ghost");
  again.disabled = state.loading;
  const position = state.loading ? "Reading…" : `Page ${formatCount(state.page)} of ${formatCount(pages)}`;
  return element("div", { className: "item-pager" }, previous, element("span", { className: "muted" }, position), next, size, again);
}

function versioningOffText(copy: FolderCopy): HTMLElement {
  const where = copy.local ? element("a", { attributes: { href: editFolderLocation(copy.id, copy.nodeId) } }, "Turn it on in the folder's versioning settings") : `It is turned on on ${copy.host}'s dashboard`;
  return element("p", { className: "muted" }, `Versioning is off for ${copy.label || copy.id} on ${copy.nodeName}, so Syncthing keeps no versions to restore. `, where, ".");
}

function chosenLine(path: string, version: FileVersion): HTMLElement {
  return element("li", {}, element("code", {}, path), `: the current file is replaced by its version from ${versionText(version)}`);
}

function isArrayCopy(copy: FolderCopy): boolean {
  return appState.data?.nodes.find((node) => node.id === copy.nodeId)?.kind === "array";
}

function restoreDone(state: VersionsState, copy: FolderCopy, value: { restored: string[]; errors: Record<string, string> }): Notice {
  const failed = Object.entries(value.errors);
  for (const path of value.restored) state.chosen.delete(path);
  const restored = value.restored.length ? `Restored ${plural(value.restored.length, "file")} on ${copy.nodeName}.` : `Nothing was restored on ${copy.nodeName}.`;
  const errors = failed.map(([path, error]) => `${path}: ${error}`).join("; ");
  return { text: failed.length ? `${restored} Not restored: ${errors}.` : restored, tone: failed.length ? (value.restored.length ? "warn" : "bad") : "ok" };
}

async function runRestore(state: VersionsState, copy: FolderCopy): Promise<void> {
  const files = Object.fromEntries([...state.chosen].map(([path, version]) => [path, version.versionTime]));
  state.busy = true;
  state.result = null;
  requestRender();
  const result = await restoreVersions(copy.nodeId, copy.id, files, isArrayCopy(copy) ? state.confirm : "");
  state.busy = false;
  if (result.ok) {
    state.result = restoreDone(state, copy, result.value);
    state.confirmOpen = false;
    state.confirm = "";
    void load(state, true);
  } else state.result = result.maybeSaved ? { text: `${result.message}.`, tone: "warn" } : { text: `Not restored: ${result.message}`, tone: "bad" };
  requestRender();
}

/**
 * Names every current file a restore replaces and the version that replaces it, says how this folder's versioning keeps the replaced file and
 * where the change goes, and on an array asks for the folder ID typed.
 * @implNote A restore overwrites the current file, so it is a second step after the choice, never one click.
 */
function confirmForm(state: VersionsState, copy: FolderCopy, page: VersionsPage, formId: string): HTMLElement {
  const array = isArrayCopy(copy);
  const go = button(state.busy ? "Restoring…" : `Restore ${plural(state.chosen.size, "file")} on ${copy.nodeName}`, () => void runRestore(state, copy), "button danger");
  go.disabled = state.busy || (array && !isArrayConfirmed(state.confirm, copy.id));
  const [kept, spread] = restoreConsequences(copy.nodeName, copy.label || copy.id, page.versioning, page.folderType);
  return element(
    "div",
    { className: "action-form destructive" },
    element("p", {}, element("strong", {}, `Restoring replaces ${state.chosen.size === 1 ? "this current file" : "these current files"} in ${copy.label || copy.id} on ${copy.nodeName}:`)),
    element("ul", { className: "versions-chosen" }, ...[...state.chosen].map(([path, version]) => chosenLine(path, version))),
    element("p", {}, kept),
    element("p", {}, spread),
    array ? arrayConfirmField({ formId, nodeName: copy.nodeName, doing: "restore versions", folderId: () => copy.id, showsId: true, typed: state.confirm, disabled: state.busy, onInput: (typed) => (state.confirm = typed) }) : null,
    element("div", { className: "button-row" }, go),
  );
}

function restoreControls(state: VersionsState, copy: FolderCopy, page: VersionsPage, formId: string): HTMLElement[] {
  if (!copy.local) return [element("p", { className: "muted" }, `Versions of ${copy.nodeName} are restored on ${copy.host}'s dashboard.`)];
  const toggle = button(
    state.confirmOpen ? "Keep the current files" : `Restore ${plural(state.chosen.size, "chosen file")}…`,
    () => {
      state.confirmOpen = !state.confirmOpen;
      state.confirm = "";
      requestRender();
    },
    state.confirmOpen ? "button ghost" : "button danger",
  );
  toggle.disabled = state.busy || state.chosen.size === 0;
  const result = state.result ? element("p", { className: `notice tone-text-${state.result.tone}`, attributes: { role: "status" } }, state.result.text) : null;
  return [element("div", { className: "button-row" }, toggle), result, state.confirmOpen && state.chosen.size ? confirmForm(state, copy, page, formId) : null].filter((part): part is HTMLElement => part !== null);
}

function levelBody(state: VersionsState, copy: FolderCopy, page: VersionsPage, formId: string): HTMLElement[] {
  const files = Object.entries(page.files);
  const entries = [...page.directories.map((directory) => directoryRow(state, directory)), ...files.map(([path, versions]) => fileRow(state, formId, path, versions, copy.local))];
  const filtered = state.from || state.to ? " in these dates" : "";
  const empty = state.page > 1 ? "No entries on this page." : `No versions kept here${filtered}.`;
  return [
    element("p", { className: "muted" }, `Versioning ${versioningWords(page.versioning)}.`),
    filterRow(state, formId),
    crumbs(state),
    entries.length ? element("ol", { className: "item-list" }, ...entries) : element("p", { className: "muted" }, empty),
    pager(state, page),
    ...restoreControls(state, copy, page, formId),
  ];
}

function panelBody(state: VersionsState, copy: FolderCopy, formId: string): HTMLElement[] {
  const answer = state.answer;
  if (!answer) return [element("p", { className: "muted" }, "Reading the versions… Syncthing lists every kept version at once, which can take up to 30 s.")];
  if (!answer.ok) {
    const isRefusal = answer.status >= 400 && answer.status < 500;
    return [element("p", { className: isRefusal ? "muted" : "tone-text-bad", attributes: { role: "status" } }, isRefusal ? `${answer.message}.` : `Could not be read: ${answer.message}`)];
  }
  if (!answer.value.enabled) return [versioningOffText(copy)];
  return levelBody(state, copy, answer.value, formId);
}

/** The folder copy's kept versions as a tree, one directory at a time, with a date filter, and the restore of chosen versions on this host's nodes. */
export function versionsPanel(copy: FolderCopy): HTMLElement | null {
  const state = appState.versions;
  if (!state || !isVersionsOpen(copy)) return null;
  const formId = formIdOf(state);
  return element(
    "div",
    { className: "item-list-panel versions-panel", attributes: { id: formId } },
    element("div", { className: "item-list-head" }, element("strong", {}, `Versions on ${copy.nodeName}`), button("Close", () => toggleVersions(copy), "button ghost")),
    ...panelBody(state, copy, formId),
  );
}
