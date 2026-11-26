/* A minimal browser for the viewer integration tests: jsdom + the same fake host surface the viewers use.
 * Optional: if jsdom isn't installed, load() resolves to null and the tests that need it are skipped. */
import { readFileSync } from "node:fs";
import { Emitter } from "../assets/js/shell/core.js";

let cached;
export async function load() {
  if (cached !== undefined) return cached;
  cached = await create();
  return cached;
}
async function create() {
  let JSDOM;
  try { ({ JSDOM } = await import("jsdom")); } catch { return null; }
  const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
  const w = dom.window;
  for (const k of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "CustomEvent", "KeyboardEvent", "MouseEvent", "MutationObserver", "getComputedStyle", "DOMRect", "Range", "Selection", "HTMLInputElement", "HTMLTextAreaElement", "requestAnimationFrame", "cancelAnimationFrame"]) {
    try { Object.defineProperty(globalThis, k, { value: w[k], configurable: true, writable: true }); } catch { /* read-only on this node version */ }
  }
  globalThis.CSS = w.CSS = { escape: (v) => String(v).replace(/[^\w-]/g, "\\$&"), supports: () => false };   // jsdom has no CSS namespace
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.matchMedia = globalThis.matchMedia;
  // CodeMirror measures layout, which jsdom doesn't do: give it empty answers.
  w.Range.prototype.getClientRects = () => [];
  w.Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
  w.Element.prototype.scrollIntoView = () => {};
  if (!w.document.elementFromPoint) w.document.elementFromPoint = () => null;
  return { dom, window: w, document: w.document };
}

export function fakeHost(initial, { autoSave = true, defaultView = "rendered", weekStart = "monday" } = {}) {
  const store = new Map(Object.entries(initial));
  const files = Object.assign(new Emitter(), {
    writes: [],
    get: (n) => (store.has(n) ? { name: n, content: store.get(n) } : null),
    exists: (n) => store.has(n),
    list: () => [...store.keys()].map((name) => ({ name })),
    normalize: (n, ext) => (n.toLowerCase().endsWith(ext) ? n : `${n}${ext}`),
    validateName: (n) => (store.has(n) ? `"${n}" already exists.` : null),
    creates: [],
    create(n, c) { if (store.has(n)) throw new Error(`"${n}" already exists.`); store.set(n, c); this.creates.push([n, c]); this.emit("changed", { kind: "create", name: n }); },
    write(n, c) { if (!store.has(n)) throw new Error(`"${n}" was not found.`); if (store.get(n) === c) return; store.set(n, c); this.writes.push([n, c]); this.emit("changed", { kind: "write", name: n }); },
  });
  const values = { autoSave, defaultView, weekStart, lineNumbers: false };
  const settings = Object.assign(new Emitter(), { get: (k) => values[k], set(k, v) { values[k] = v; this.emit(k, v); } });
  const toasts = [], dialogs = [], opened = [];
  const host = {
    files, settings, store, toasts, dialogs, opened,
    open: async (uri) => { opened.push(uri); },
    sync: Object.assign(new Emitter(), { statusOf: () => "local", errorOf: () => null }),
    auth: new Emitter(),
    notify: (m, t) => toasts.push([t ?? "info", m]),
    dialogs: {
      showDialog(content) {
        let resolve; const done = new Promise((r) => { resolve = r; });
        const dialog = document.createElement("div");
        dialog.className = "test-dialog"; dialog.append(content); document.body.append(dialog);
        const d = { dialog, done, close: (r) => { dialog.remove(); resolve(r); } };
        dialogs.push(d);
        return d;
      },
      confirmAnswer: true,
      async confirm(o) { toasts.push(["confirm", o.title]); return host.dialogs.confirmAnswer; },
      menu() {},
    },
  };
  // The time viewers must never use the hledger engine or its reports: any touch of them fails the test loudly.
  const guarded = new Proxy(host, { get(t, k) { if (k === "engine" || k === "reports") throw new Error(`a time viewer touched host.${String(k)}`); return t[k]; } });
  return { host: guarded, raw: host, values };
}

const mounted = [];
/** Stops every viewer's timers (a failed test must not keep the process alive). */
export const disposeAll = () => { while (mounted.length) { try { mounted.pop().dispose(); } catch { /* already disposed */ } } };

export const read = (p) => readFileSync(new URL(`../assets/${p}`, import.meta.url), "utf8");

/** Mounts a viewer exactly as the special renderer would: template into root, menu template into the menubar. */
export async function mountViewer(kind, initialText, opts = {}) {
  const env = await load();
  if (!env) return null;
  const name = `w.${kind}`;
  const { host, raw, values } = fakeHost({ [name]: initialText }, opts);
  document.body.replaceChildren();
  const root = document.createElement("div");
  root.className = `sf sf-${kind}`;
  root.innerHTML = read(`special/${kind}.html`);
  const menubar = document.createElement("div");
  menubar.innerHTML = read(`special/${kind}-menu.html`);
  document.body.append(menubar, root);
  let dirty = false;
  const view = { uri: `file:${name}`, setDirty: (d) => { dirty = d; }, params: {} };
  const mod = await import(`../assets/special/${kind}.js`);
  const api = mod.mount({ root, view, host, assets: {}, params: {}, contrib: {}, menubar });
  api.onShow();
  mounted.push(api);
  return { ...env, host, raw, values, root, menubar, api, name, view, isDirty: () => dirty };
}

/** Mounts a wizard page (create-file, import-file) the way the special renderer does. */
export async function mountSpecial(name, { files = {}, assetsJson = {} } = {}) {
  const env = await load();
  if (!env) return null;
  const { host, raw, values } = fakeHost(files);
  document.body.replaceChildren();
  const root = document.createElement("div");
  root.innerHTML = read(`special/${name}.html`);
  document.body.append(root);
  const closed = [];
  const view = { uri: `wedger:${name}`, params: {}, close: () => closed.push(true), setDirty() {} };
  const mod = await import(`../assets/special/${name}.js`);
  const api = await mod.mount({ root, view, host, assets: { json: async (p) => assetsJson[p] }, params: {}, contrib: {} });
  mounted.push(api ?? { dispose() {} });
  return { ...env, host, raw, values, root, api, closed, form: root.querySelector("[data-slot=form]") };
}
