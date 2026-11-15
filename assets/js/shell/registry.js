/* registry.js — asset loader + renderer registry.
 *
 * Everything the viewer can open is described in assets/special/manifest.json.
 * resolve(uri) picks the best-matching contribution; the journal/text viewer
 * is the lowest-priority fallback for any "file:" URI, so nothing is ever
 * un-openable.
 */
import { ASSETS, parseUri } from "./core.js";

const cache = new Map();

async function fetchText(rel) {
  const res = await fetch(new URL(rel, ASSETS), { cache: "no-cache" });
  if (!res.ok) throw new Error(`Could not load "${rel}" (HTTP ${res.status}).`);
  return res.text();
}

/** Fetches files that live under /assets/. Paths are relative to /assets/. */
export const assets = {
  url: (rel) => new URL(rel, ASSETS),
  text(rel) {
    if (!cache.has(rel)) {
      const p = fetchText(rel);
      cache.set(rel, p);
      p.catch(() => cache.delete(rel)); // let Retry actually retry
    }
    return cache.get(rel);
  },
  async json(rel) { return JSON.parse(await this.text(rel)); },
  module(rel) { return import(new URL(rel, ASSETS).href); },
};

function matches(sel, { uri, scheme, path }) {
  if (sel.uri && sel.uri !== uri) return false;
  if (sel.scheme && sel.scheme !== scheme) return false;
  if (sel.extensions && !sel.extensions.some((e) => path.toLowerCase().endsWith(e))) return false;
  return true;
}

class Registry {
  contributions = [];

  async load() {
    const manifest = await assets.json("special/manifest.json");
    this.contributions = manifest.contributions ?? [];
  }

  byViewType(viewType) {
    return this.contributions.find((c) => c.viewType === viewType) ?? null;
  }

  resolve(uri) {
    const ctx = { uri, ...parseUri(uri) };
    return this.contributions
      .filter((c) => matches(c.selector ?? {}, ctx))
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))[0] ?? null;
  }
}

export const registry = new Registry();
