/* core.js — tiny shared basics: paths, mock flags, emitter, DOM helper. */

/** Absolute URL of the /assets/ folder (works under any baseurl). */
export const ASSETS = new URL("../../", import.meta.url);

/**
 * UI-phase demo switches, set with ?mock=a,b,c in the address bar:
 *   empty       start with no journals
 *   signedin    pretend Google sign-in is active
 *   sync-error  one file fails to sync
 *   slow        slow down template loading so loading states are visible
 */
export const mock = (() => {
  const raw = new URLSearchParams(globalThis.location?.search ?? "").get("mock") ?? "";
  const flags = new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
  return { flags, has: (f) => flags.has(f) };
})();

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

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
