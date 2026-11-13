/* editor-service.js — tabs + view lifecycle.
 *
 * open(uri) is the ONE code path for everything: welcome page, settings,
 * create-file wizard, journals... It resolves a renderer through the
 * registry, mounts it into a panel and shows a tab for it.
 *
 * A renderer is { mount(view, ctx) -> { dispose?, save?, onShow?, onHide? } }.
 * `view` gives it: uri, params, container, menubar, setTitle(), setDirty(), close().
 */
import { Emitter, h, icon, parseUri } from "./core.js";
import { registry, assets } from "./registry.js";
import * as overlays from "./overlays.js";
import special from "./renderers/special.js";
import journal from "./renderers/journal.js";

const RENDERERS = { special, journal };
let seq = 0;

class EditorService extends Emitter {
  tabs = [];
  activeId = null;
  #dom = null;
  #host = null;

  /** dom: { tabs, menuBar, area, empty } */
  init(dom, host) {
    this.#dom = dom;
    this.#host = host;

    dom.tabs.addEventListener("keydown", (e) => {
      const i = this.tabs.findIndex((t) => t.id === this.activeId);
      let next = null;
      if (e.key === "ArrowRight") next = this.tabs[(i + 1) % this.tabs.length];
      if (e.key === "ArrowLeft") next = this.tabs[(i - 1 + this.tabs.length) % this.tabs.length];
      if (e.key === "Home") next = this.tabs[0];
      if (e.key === "End") next = this.tabs[this.tabs.length - 1];
      if (next) { e.preventDefault(); this.activate(next.id); dom.tabs.querySelector('[aria-selected="true"]')?.focus(); }
    });
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); this.saveActive(); }
    });
  }

  get active() { return this.tabs.find((t) => t.id === this.activeId) ?? null; }

  async open(uri, { viewType, params = {}, focus = true } = {}) {
    const existing = this.tabs.find((t) => t.uri === uri && (!viewType || t.contrib?.viewType === viewType));
    if (existing) { if (focus) this.activate(existing.id); return existing; }

    const contrib = viewType ? registry.byViewType(viewType) : registry.resolve(uri);
    const id = `t${++seq}`;
    const tab = {
      id, uri, contrib, params, dirty: false, closed: false, instance: null,
      title: contrib?.title ?? parseUri(uri).path,
      panel: h("div", { class: "view", role: "tabpanel", id: `panel-${id}`, "aria-labelledby": `tab-${id}`, hidden: true }),
      menu: h("div", { class: "view-menu", hidden: true }),
    };
    this.tabs.push(tab);
    this.#dom.area.append(tab.panel);
    this.#dom.menuBar.append(tab.menu);
    if (focus || !this.active) this.activate(id); else this.#sync();
    await this.#mount(tab);
    return tab;
  }

  async #mount(tab) {
    tab.panel.querySelector(".view__error")?.remove();
    const loading = h("div", { class: "view__loading", role: "status" }, h("div", { class: "spinner" }), h("p", {}, "Loading…"));
    tab.panel.append(loading);
    try {
      if (!tab.contrib) throw new Error(`No renderer is registered for "${tab.uri}".`);
      const renderer = RENDERERS[tab.contrib.renderer];
      if (!renderer) throw new Error(`Unknown renderer "${tab.contrib.renderer}".`);
      const instance = await renderer.mount(this.#makeView(tab), { host: this.#host, assets, contrib: tab.contrib });
      if (tab.closed) { instance?.dispose?.(); return; }
      tab.instance = instance ?? {};
      if (this.activeId === tab.id) tab.instance.onShow?.();
    } catch (err) {
      console.error(`Failed to open ${tab.uri}`, err);
      if (!tab.closed) this.#showError(tab, err);
    } finally {
      loading.remove();
      this.#sync();
    }
  }

  #showError(tab, err) {
    tab.panel.append(h("div", { class: "view__error", role: "alert" },
      h("h2", {}, "Couldn't open this file"),
      h("p", {}, tab.uri),
      h("pre", {}, err?.message ?? String(err)),
      h("div", { class: "view__error-actions" },
        h("button", { class: "btn", type: "button", onclick: () => this.close(tab.id, { force: true }) }, "Close tab"),
        h("button", { class: "btn btn--primary", type: "button", onclick: () => this.#mount(tab) }, "Retry"))));
  }

  #makeView(tab) {
    const self = this;
    return {
      get uri() { return tab.uri; },
      params: tab.params,
      container: tab.panel,
      menubar: tab.menu,
      setTitle(title) { tab.title = title; self.#sync(); },
      setDirty(dirty) { tab.dirty = !!dirty; self.#sync(); },
      close() { return self.close(tab.id, { force: true }); },
    };
  }

  activate(id) {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    const prev = this.active;
    if (prev && prev.id !== id) {
      prev.panel.hidden = true; prev.menu.hidden = true;
      prev.instance?.onHide?.();
    }
    this.activeId = id;
    tab.panel.hidden = false; tab.menu.hidden = false;
    if (prev?.id !== id) tab.instance?.onShow?.();
    this.#sync();
    this.emit("activechange", tab);
  }

  async close(id, { force = false } = {}) {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return false;
    const tab = this.tabs[idx];
    if (tab.dirty && !force) {
      const ok = await overlays.confirm({
        title: `Close ${tab.title}?`, message: "It has unsaved changes that will be lost.",
        confirmLabel: "Discard changes", danger: true,
      });
      if (!ok) return false;
    }
    tab.closed = true;
    try { tab.instance?.dispose?.(); } catch (err) { console.error(err); }
    tab.panel.remove(); tab.menu.remove();
    this.tabs.splice(idx, 1);
    if (this.activeId === id) {
      this.activeId = null;
      const next = this.tabs[idx] ?? this.tabs[idx - 1] ?? null;
      if (next) this.activate(next.id);
      else { this.#sync(); this.emit("activechange", null); }
    } else this.#sync();
    this.emit("closed", { tab });
    return true;
  }

  async closeByUri(uri) {
    for (const t of this.tabs.filter((t) => t.uri === uri)) await this.close(t.id, { force: true });
  }
  async closeWhere(predicate) {
    for (const t of this.tabs.filter(predicate)) await this.close(t.id);
  }

  /** A file was renamed: keep its tab, point it at the new URI. */
  retarget(oldUri, newUri, newTitle) {
    const tab = this.tabs.find((t) => t.uri === oldUri);
    if (!tab) return;
    tab.uri = newUri; tab.title = newTitle;
    this.#sync();
    this.emit("activechange", this.active);
  }

  async saveActive() {
    const tab = this.active;
    if (tab?.instance?.save) await tab.instance.save();
  }

  /** Re-renders the strip and chrome (menu bar, empty state, window title). */
  #sync() {
    const { tabs: strip, menuBar, empty } = this.#dom;
    strip.replaceChildren(...this.tabs.map((t) => this.#tabEl(t)));
    strip.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    const active = this.active;
    menuBar.hidden = !active || active.menu.childElementCount === 0;
    empty.hidden = this.tabs.length > 0;
    document.title = active ? `${active.title} — Wedger` : "Wedger";
  }

  #tabEl(tab) {
    const selected = tab.id === this.activeId;
    return h("div", {
      class: "tab", role: "tab", id: `tab-${tab.id}`, tabindex: selected ? "0" : "-1",
      "aria-selected": String(selected), "aria-controls": `panel-${tab.id}`, title: tab.uri,
      onclick: (e) => { if (!e.target.closest(".tab__close")) this.activate(tab.id); },
      onauxclick: (e) => { if (e.button === 1) { e.preventDefault(); this.close(tab.id); } },
    },
      h("span", { class: "tab__title" }, tab.title),
      tab.dirty && h("span", { class: "tab__dirty", role: "img", "aria-label": "Unsaved changes" }, "●"),
      h("button", { class: "tab__close", type: "button", "aria-label": `Close ${tab.title}`, onclick: () => this.close(tab.id) }, icon("close")));
  }
}

export const editors = new EditorService();
