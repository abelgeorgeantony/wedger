/* editor-service.js — tabs + view lifecycle.
 *
 * open(uri) is the ONE code path for everything: welcome page, settings,
 * create-file wizard, journals... It resolves a renderer through the
 * registry, mounts it into a panel and shows a tab for it.
 *
 * A renderer is { mount(view, ctx) -> { dispose?, save?, onShow?, onHide? } }.
 * `view` gives it: uri, params, container, menubar, setTitle(), setDirty(), close().
 */
import { Emitter, h, icon, parseUri, moveItem } from "./core.js";
import { registry, assets } from "./registry.js";
import * as overlays from "./overlays.js";
import special from "./renderers/special.js";
import journal from "./renderers/journal.js";

const RENDERERS = { special, journal };
const TAB_DRAG_TYPE = "application/x-wedger-tab";
let seq = 0;

class EditorService extends Emitter {
  tabs = [];
  activeId = null;
  #dom = null;
  #host = null;
  #drag = null;                 // { id } while a tab is being dragged; the strip is not rebuilt until it ends
  #syncPending = false;

  /** dom: { tabs, menuBar, area, empty } */
  init(dom, host) {
    this.#dom = dom;
    this.#host = host;

    dom.tabs.addEventListener("keydown", (e) => {
      // Alt+Shift+Left / Right moves the focused tab; plain arrows, Home and End still just switch tabs.
      if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        const el = e.target.closest?.(".tab");
        const tab = el && this.tabs.find((t) => `tab-${t.id}` === el.id);
        if (tab) { e.preventDefault(); this.moveBy(tab.id, e.key === "ArrowRight" ? 1 : -1, { keepFocus: true }); }
        return;
      }
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const i = this.tabs.findIndex((t) => t.id === this.activeId);
      let next = null;
      if (e.key === "ArrowRight") next = this.tabs[(i + 1) % this.tabs.length];
      if (e.key === "ArrowLeft") next = this.tabs[(i - 1 + this.tabs.length) % this.tabs.length];
      if (e.key === "Home") next = this.tabs[0];
      if (e.key === "End") next = this.tabs[this.tabs.length - 1];
      if (next) { e.preventDefault(); this.activate(next.id); dom.tabs.querySelector('[aria-selected="true"]')?.focus(); }
    });
    this.#initDrag(dom.tabs);
    // Many tabs overflow the strip: a plain mouse wheel (or trackpad swipe) over it scrolls sideways, no Shift needed.
    dom.tabs.addEventListener("wheel", (e) => {
      if (dom.tabs.scrollWidth <= dom.tabs.clientWidth) return;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? dom.tabs.clientWidth : 1;
      const delta = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * unit;
      if (!delta) return;
      e.preventDefault();
      dom.tabs.scrollLeft += delta;
    }, { passive: false });

    // Global key bindings (Save included) live in keyboard-shortcuts.js; nothing in here listens on the document.
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
    this.#revealActive();
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
      setDirty(dirty) { if (tab.dirty === !!dirty) return; tab.dirty = !!dirty; self.#sync(); },
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
    this.#revealActive();
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
    for (const t of this.tabs.filter((t) => predicate(t))) await this.close(t.id);
  }

  /** A file was renamed: keep its tab, point it at the new URI. */
  retarget(oldUri, newUri, newTitle) {
    const tab = this.tabs.find((t) => t.uri === oldUri);
    if (!tab) return;
    tab.uri = newUri; tab.title = newTitle;
    this.#sync();
    this.emit("activechange", this.active);
  }

  /** Moves a tab so it ends up at `to` (0-based). Reorders the real list; panels, menus and renderers are untouched. */
  move(id, to, { keepFocus = false } = {}) {
    const from = this.tabs.findIndex((t) => t.id === id);
    if (from < 0) return false;
    const dest = Math.min(this.tabs.length - 1, Math.max(0, to));
    if (dest === from) return false;
    const hadFocus = keepFocus || this.#dom.tabs.contains(document.activeElement);
    this.tabs.splice(0, this.tabs.length, ...moveItem(this.tabs, from, dest));
    this.#sync();
    const el = this.#dom.tabs.querySelector(`#tab-${id}`);
    if (hadFocus) el?.focus();
    el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    this.emit("reordered", { tab: this.tabs[dest], from, to: dest });
    return true;
  }
  moveBy(id, delta, opts) { return this.move(id, this.tabs.findIndex((t) => t.id === id) + delta, opts); }

  /** Next / previous tab, wrapping around. */
  activateRelative(delta) {
    if (this.tabs.length < 2) return;
    const i = this.tabs.findIndex((t) => t.id === this.activeId);
    this.activate(this.tabs[(i + delta + this.tabs.length) % this.tabs.length].id);
  }

  async saveActive() {
    const tab = this.active;
    if (tab?.instance?.save) await tab.instance.save();
  }

  /** Scrolls the active tab into view. Only on open/activate, never on incidental re-renders. */
  #revealActive() {
    this.#dom?.tabs.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }

  #tabMenu(tab, anchor) {
    const idx = this.tabs.indexOf(tab);
    this.#host.dialogs.menu(anchor, [
      { label: "Close", onSelect: () => this.close(tab.id) },
      { label: "Close others", disabled: this.tabs.length < 2, onSelect: () => this.closeWhere((t) => t.id !== tab.id) },
      { label: "Close to the right", disabled: idx >= this.tabs.length - 1, onSelect: () => this.closeWhere((t) => this.tabs.indexOf(t) > idx) },
      { separator: true },
      { label: "Move left", disabled: idx <= 0, onSelect: () => this.moveBy(tab.id, -1, { keepFocus: true }) },
      { label: "Move right", disabled: idx >= this.tabs.length - 1, onSelect: () => this.moveBy(tab.id, 1, { keepFocus: true }) },
    ]);
  }

  /** Re-renders the strip and chrome (menu bar, empty state, window title). The strip waits while a tab is mid-drag. */
  #sync() {
    const { menuBar, empty } = this.#dom;
    if (this.#drag) this.#syncPending = true; else this.#renderStrip();
    const active = this.active;
    menuBar.hidden = !active || active.menu.childElementCount === 0;
    empty.hidden = this.tabs.length > 0;
    document.title = active ? `${active.title} — Wedger` : "Wedger";
  }

  #renderStrip() {
    this.#syncPending = false;
    this.#dom.tabs.replaceChildren(...this.tabs.map((t) => this.#tabEl(t)));
  }

  /* ---------- drag and drop ----------
   * Native drag events on the tab elements. The strip is rebuilt by #sync(), so a drag never holds a reference
   * to an element: it carries the tab id, and the drop slot is worked out from the tabs' current positions. */
  #initDrag(strip) {
    const clear = () => strip.querySelectorAll(".tab--drop-before, .tab--drop-after, .tab--dragging").forEach((el) => el.classList.remove("tab--drop-before", "tab--drop-after", "tab--dragging"));
    const isOurs = (e) => !!this.#drag && e.dataTransfer?.types?.includes?.(TAB_DRAG_TYPE);
    /** Gap index 0..n the pointer is over, plus the tab element and side for the indicator. */
    const slotAt = (x) => {
      const els = [...strip.querySelectorAll(".tab")];
      for (let i = 0; i < els.length; i++) {
        const r = els[i].getBoundingClientRect();
        if (x < r.left + r.width / 2) return { slot: i, el: els[i], side: "before" };
      }
      return { slot: els.length, el: els[els.length - 1] ?? null, side: "after" };
    };
    const end = () => { clear(); this.#drag = null; if (this.#syncPending) this.#renderStrip(); };

    strip.addEventListener("pointerdown", (e) => {                     // the close button must never start a drag
      const el = e.target.closest?.(".tab");
      if (el) el.draggable = !e.target.closest(".tab__close");
    });
    strip.addEventListener("dragstart", (e) => {
      const el = e.target.closest?.(".tab");
      const tab = el && this.tabs.find((t) => `tab-${t.id}` === el.id);
      if (!tab || e.target.closest(".tab__close")) { e.preventDefault(); return; }
      this.#drag = { id: tab.id };
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData(TAB_DRAG_TYPE, tab.id);
      el.classList.add("tab--dragging");
    });
    strip.addEventListener("dragover", (e) => {
      if (!isOurs(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const { slot, el, side } = slotAt(e.clientX);
      const from = this.tabs.findIndex((t) => t.id === this.#drag.id);
      clear();
      strip.querySelector(`#tab-${this.#drag.id}`)?.classList.add("tab--dragging");
      if (slot !== from && slot !== from + 1) el?.classList.add(side === "before" ? "tab--drop-before" : "tab--drop-after");   // dropping in place is a no-op: no indicator
      const r = strip.getBoundingClientRect(), edge = 40;                // auto-scroll near either end
      if (e.clientX < r.left + edge) strip.scrollLeft -= 14; else if (e.clientX > r.right - edge) strip.scrollLeft += 14;
    });
    strip.addEventListener("dragleave", (e) => { if (!strip.contains(e.relatedTarget)) clear(); });
    strip.addEventListener("drop", (e) => {
      if (!isOurs(e)) return;
      e.preventDefault();
      const id = this.#drag.id;
      const { slot } = slotAt(e.clientX);
      const from = this.tabs.findIndex((t) => t.id === id);
      end();                                                           // lets a deferred rebuild happen before the move rebuilds again
      if (from >= 0) this.move(id, slot > from ? slot - 1 : slot);
    });
    strip.addEventListener("dragend", end);
  }

  #tabEl(tab) {
    const selected = tab.id === this.activeId;
    return h("div", {
      class: "tab", role: "tab", id: `tab-${tab.id}`, tabindex: selected ? "0" : "-1", draggable: "true",
      "aria-selected": String(selected), "aria-controls": `panel-${tab.id}`, title: tab.uri,
      onclick: (e) => { if (!e.target.closest(".tab__close")) this.activate(tab.id); },
      onauxclick: (e) => { if (e.button === 1) { e.preventDefault(); this.close(tab.id); } },
      oncontextmenu: (e) => { e.preventDefault(); this.#tabMenu(tab, { x: e.clientX, y: e.clientY }); },
    },
      h("span", { class: "tab__title" }, tab.title),
      tab.dirty && h("span", { class: "tab__dirty", role: "img", "aria-label": "Unsaved changes" }, "●"),
      h("button", { class: "tab__close", type: "button", "aria-label": `Close ${tab.title}`, onclick: () => this.close(tab.id) }, icon("close")));
  }
}

export const editors = new EditorService();


