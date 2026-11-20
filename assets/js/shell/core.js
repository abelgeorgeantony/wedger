/* core.js — tiny shared basics: paths, emitter, DOM helper, small utilities. */

/** Absolute URL of the /assets/ folder (works under any baseurl). */
export const ASSETS = new URL("../../", import.meta.url);

export class Emitter {
  #listeners = new Map();
  on(event, fn) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
    this.#listeners.get(event).add(fn);
    return () => this.#listeners.get(event)?.delete(fn);
  }
  emit(event, data) {
    for (const fn of [...(this.#listeners.get(event) ?? [])]) {
      try { fn(data); } catch (err) { console.error(`Listener for "${event}" failed`, err); }
    }
  }
}

/** "file:finance.journal" -> { scheme: "file", path: "finance.journal" } */
export function parseUri(uri) {
  const i = uri.indexOf(":");
  return i < 0 ? { scheme: "", path: uri } : { scheme: uri.slice(0, i), path: uri.slice(i + 1) };
}
export const fileUri = (name) => `file:${name}`;

export function extOf(name) {
  const m = /(\.[A-Za-z0-9]+)$/.exec(name);
  return m ? m[1].toLowerCase() : "";
}

/** A copy of `list` with the item at `from` moved so that it ends up at index `to` (both clamped). Pure. */
export function moveItem(list, from, to) {
  const copy = list.slice();
  if (!Number.isInteger(from) || from < 0 || from >= copy.length) return copy;
  const dest = Math.min(copy.length - 1, Math.max(0, Number.isInteger(to) ? to : from));
  const [item] = copy.splice(from, 1);
  copy.splice(dest, 0, item);
  return copy;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function debounce(fn, ms) {
  let t;
  const wrapped = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  wrapped.cancel = () => clearTimeout(t);
  wrapped.flush = (...args) => { clearTimeout(t); fn(...args); };
  return wrapped;
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function relativeTime(ts, now = Date.now()) {
  if (!ts) return "never";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr} ${hr === 1 ? "hour" : "hours"} ago`;
  const d = Math.round(hr / 24);
  if (d < 30) return `${d} ${d === 1 ? "day" : "days"} ago`;
  return new Date(ts).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** h("div", {class:"x", dataset:{a:1}, onclick:fn}, child, "text") — always text-safe. */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

export const icon = (name) => h("span", { class: `icon icon--${name}`, "aria-hidden": "true" });

