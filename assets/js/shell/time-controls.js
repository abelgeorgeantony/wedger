/* time-controls.js — the menu-bar and list controls the .timeclock and .timedot viewers share.
 *
 * Both viewers have the same menus as the journal viewer (items, Reports, Filters, Sort, Search, View). The state is
 * held by the viewer; these helpers only read and paint the controls and report changes. Nothing here knows what a
 * session or an entry is, and nothing here touches the file.
 *
 *   bindSearch     the Search menu: one compiled query (Aa / whole word / regex), match count, recent searches
 *   bindFilters    the Filters form: applies as you type (text debounced, the rest on change), no Apply button
 *   bindSort       the Sort radios: applies the moment one is picked
 *   paintChips     removable chips for what is narrowing the list, plus "Reset all"
 *   paintSelection the selection bar, the items menu and its badge, all derived from the real selection
 *   bindRowSelection  one delegated click listener for checkboxes and (in selection mode) whole rows
 *   bindReports    the Reports menu: period, account, order, and one button per report (see time-report.js)
 */
import { h, icon, debounce } from "./core.js";
import { compileQuery } from "./find.js";
import { localNow, todayLocal, weekdayOf } from "./time-format.js";
import { RANGE_PRESETS, presetRange, rangeLabel, reportInfo, runTimeReport, validateRange } from "./time-report.js";

const RECENT_KEY = "wedger_recent_searches";            // the journal viewer's list: one set of recent searches for the app

/* -------------------------------------------------------------------- search */
export function bindSearch(bar, { menu, onChange }) {
  const input = bar.querySelector("[name=search]");
  const count = bar.querySelector("[data-slot=search-count]");
  const opts = { caseSensitive: false, wholeWord: false, regexp: false };
  let compiled = compileQuery("");
  const buttons = { caseSensitive: "findCase", wholeWord: "findWord", regexp: "findRegexp" };

  const readRecent = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]"); } catch { return []; } };
  const remember = (q) => {
    if (!q) return;
    try { localStorage.setItem(RECENT_KEY, JSON.stringify([q, ...readRecent().filter((x) => x !== q)].slice(0, 6))); } catch { /* storage blocked */ }
  };
  const apply = () => { compiled = compileQuery(input.value.trim(), opts); onChange(); };
  const soon = debounce(apply, 120);

  input.addEventListener("input", soon);
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    soon.cancel(); apply();
    remember(input.value.trim());
    menu.close({ restoreFocus: true });
  });
  for (const [key, name] of Object.entries(buttons)) {
    const btn = bar.querySelector(`[name=${name}]`);
    btn.addEventListener("click", () => {
      opts[key] = !opts[key];
      btn.setAttribute("aria-pressed", String(opts[key]));
      soon.cancel(); apply();
    });
  }

  return {
    input,
    get query() { return input.value.trim(); },
    get compiled() { return compiled; },
    /** The line under the field: a match count, or why the pattern can't be used (it then matches nothing). */
    paintCount(text) {
      count.textContent = !input.value.trim() ? "" : !compiled.ok ? `Invalid pattern: ${compiled.error}` : text;
    },
    renderRecent() {
      const list = readRecent(), box = bar.querySelector("[data-slot=recent]"), group = bar.querySelector("[data-slot=recent-group]");
      if (!box) return;
      group.hidden = !list.length;
      box.replaceChildren(...list.map((q) => h("button", { class: "chip", type: "button", onclick: () => { input.value = q; input.dispatchEvent(new Event("input")); } }, q)));
    },
    clear() { soon.cancel(); input.value = ""; compiled = compileQuery(""); count.textContent = ""; },
    setEnabled(on) { input.disabled = !on; },
    dispose() { soon.cancel(); },
  };
}

/* ------------------------------------------------------------------- filters */
/**
 * `fields` are the form control names. `values` is the live object the viewer reads; it is edited in place.
 * onChange() runs after every change (text fields debounced a little, so typing stays smooth).
 */
export function bindFilters(bar, { fields, defaults = {}, onChange }) {
  const form = bar.querySelector("[data-form=filters]");
  const values = Object.fromEntries(fields.map((k) => [k, defaults[k] ?? ""]));
  const clearBtn = bar.querySelector("[data-act=clear-filters]");
  const isSet = (k) => values[k] !== "" && values[k] !== (defaults[k] ?? "");
  const read = () => { for (const k of fields) values[k] = String(form.elements[k].value ?? "").trim(); };
  const sync = () => { for (const k of fields) form.elements[k].value = values[k]; clearBtn.disabled = !fields.some(isSet); };
  const apply = () => { read(); clearBtn.disabled = !fields.some(isSet); onChange(); };
  const soon = debounce(apply, 150);

  form.addEventListener("input", soon);
  form.addEventListener("change", soon.flush);
  form.addEventListener("submit", (e) => e.preventDefault());                 // Enter in a field must not reload the page
  sync();

  return {
    values, form, sync,
    clear() { soon.cancel(); for (const k of fields) values[k] = defaults[k] ?? ""; sync(); },
    dispose() { soon.cancel(); },
  };
}

/* ---------------------------------------------------------------------- sort */
export function bindSort(bar, { sorts, def, onChange }) {
  const radios = [...bar.querySelectorAll("[data-form=sort] [name=sort]")];
  let value = def;
  const paint = () => { for (const r of radios) r.checked = r.value === value; };
  const set = (next) => { value = sorts[next] ? next : def; paint(); };
  for (const r of radios) r.addEventListener("change", () => { if (r.checked) { set(r.value); onChange(); } });
  paint();
  return { get value() { return value; }, set, paint, reset() { set(def); } };
}

/* --------------------------------------------------------------------- chips */
/** items: [[label, value, ariaLabel, remove]]. `resetAll` is offered when more than one thing is narrowing the list. */
export function paintChips(box, items, resetAll) {
  box.hidden = !items.length;
  box.replaceChildren(
    ...items.map(([label, value, aria, remove]) => h("span", { class: "tv-fchip" }, `${label}: ${value}`,
      h("button", { type: "button", "aria-label": aria, onclick: remove }, icon("close")))),
    ...(items.length > 1 ? [h("button", { class: "tv-chips__clear", type: "button", title: "Clear all filters, the search and the sort order", onclick: resetAll }, "Reset all")] : []));
}

/* ----------------------------------------------------------------- selection */
/**
 * Paints every selection-dependent control from the real selection state; nothing is static.
 * @param bar       the menu bar (the items menu with its badge and entries)
 * @param root      the rendered pane (the selection bar)
 * @param noun      { one: "session", many: "sessions", Select: "Select sessions" }
 * @param shown     the rows the list shows right now (in display order)
 */
export function paintSelection({ bar, root, selection, shown, noun, ready = true, busy = false, selectable = () => true }) {
  const total = selection.size;
  const sel = selection.visible(shown).length;                         // selected AND shown: the only rows a bulk action may touch
  const hiddenSel = total - sel;                                       // selected but filtered out: kept, never deleted
  const canSelect = shown.filter(selectable).length;
  const q = (scope, s) => scope.querySelector(s);

  const badge = q(bar, "[data-slot=sel-badge]");
  const trigger = badge.closest(".menubar__btn");
  trigger.dataset.active = String(selection.mode);
  badge.hidden = !selection.mode || total === 0;
  badge.replaceChildren(String(total), h("span", { class: "sr-only" }, " selected"));
  badge.title = total ? `${total} selected` : "";

  const selbar = q(root, "[data-slot=selbar]");
  selbar.hidden = !selection.mode || !ready;
  pinBelow(root, selbar);
  q(root, "[data-slot=sel-count]").textContent = busy ? "Deleting…" : `${total} selected`;
  q(root, "[data-slot=sel-note]").textContent = !busy && hiddenSel ? `${hiddenSel} hidden by filters, not deleted.` : "";
  q(root, "[data-act=exit-select]").disabled = busy;
  q(root, "[data-act=bar-select-all]").disabled = busy || !ready || canSelect === 0;
  q(root, "[data-act=bar-clear]").disabled = busy || total === 0;
  q(root, "[data-act=bar-delete]").disabled = busy || sel === 0;

  const toggle = q(bar, "[data-act=toggle-select]");
  toggle.setAttribute("aria-pressed", String(selection.mode));
  toggle.textContent = selection.mode ? "Exit selection mode" : noun.Select;
  toggle.disabled = busy || !ready;
  const all = q(bar, "[data-act=select-visible]");
  all.disabled = busy || !ready || canSelect === 0;
  all.textContent = canSelect ? `Select all visible (${canSelect})` : "Select all visible";
  all.title = `Selects only the ${noun.many} the list shows right now`;
  const clear = q(bar, "[data-act=clear-selection]");
  clear.disabled = busy || total === 0;
  clear.textContent = total ? `Clear selection (${total})` : "Clear selection";
  const del = q(bar, "[data-act=delete-selected]");
  del.disabled = busy || sel === 0;
  del.textContent = sel ? `Delete selected (${sel})…` : "Delete selected…";
}

/** Day headings stick just under the selection bar when it is showing (the journal does the same with --pinned-top). */
function pinBelow(root, selbar) {
  const pane = root.querySelector("[data-pane=rendered]");
  pane?.style.setProperty("--pinned-top", selbar.hidden ? "0px" : `${selbar.offsetHeight + 6}px`);
}

/** Marks a row (and its checkbox) as selected or not. */
export function syncRow(list, id, on) {
  const row = list.querySelector(`.tv-row[data-id="${CSS.escape(String(id))}"]`);
  if (!row) return;
  row.classList.toggle("is-selected", on);
  const box = row.querySelector(".tv-row__select input");
  if (box) box.checked = on;
}

/**
 * One delegated listener: the checkbox, or — in selection mode — anywhere on a row except its action buttons.
 * @param find(id) -> the row object for a data-id; shown() -> the rows displayed now; paint() repaints the selection UI.
 */
export function bindRowSelection({ list, selection, find, shown, selectable = () => true, paint }) {
  list.addEventListener("click", (e) => {
    if (!selection.mode) return;
    const rowEl = e.target.closest(".tv-row");
    if (!rowEl || e.target.closest(".tv-row__actions")) return;
    const row = find(rowEl.dataset.id);
    if (!row || !selectable(row)) return;
    const box = e.target.closest(".tv-row__select input");
    if (e.target.closest(".tv-row__select") && !box) return;              // label padding: the input's own click follows
    const on = box ? box.checked : !selection.has(row.id);
    const touched = selection.set(row, on, { range: e.shiftKey, shown: shown(), selectable });
    for (const id of touched) syncRow(list, id, on);
    paint();
  });
}

/** The selection bar's buttons and the items menu's entries call the same functions: there is one implementation. */
export function bindSelectionActions({ root, bar, menu, actions }) {
  const selbar = root.querySelector("[data-slot=selbar]");
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => pinBelow(root, selbar)).observe(selbar);   // the bar wraps on narrow windows
  selbar.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn || btn.disabled) return;
    const map = { "exit-select": actions.exit, "bar-select-all": actions.selectAll, "bar-clear": actions.clear, "bar-delete": actions.deleteSelected };
    map[btn.dataset.act]?.();
  });
  bar.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;
    if (act === "toggle-select") { menu.close(); actions.toggle(); }
    else if (act === "select-visible") { menu.close(); actions.selectAll(); }
    else if (act === "clear-selection") actions.clear();
    else if (act === "delete-selected") { menu.close(); actions.deleteSelected(); }
  });
}

/* ------------------------------------------------------------------- reports */
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** "Mon 23 Nov" — a compact date for rows and headings. */
export const shortDate = (iso) => `${DAY[weekdayOf(iso)]} ${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1]}`;

/**
 * The Reports menu. Every report button runs a NATIVE report (time-report.js) on the viewer's current text, including
 * unsaved edits, and shows it in Reports output; nothing goes to the accounting engine. "Run again" there re-runs it
 * on the saved file with a fresh clock.
 */
export function bindReports(bar, { kind, menu, host, getText, getName, weekStart }) {
  const form = bar.querySelector("[data-form=reports]");
  const err = form.querySelector("[data-slot=report-error]");
  const setError = (msg) => { err.hidden = !msg; err.textContent = msg ?? ""; };

  form.querySelector("[data-slot=presets]").replaceChildren(...RANGE_PRESETS.map(([id, label]) =>
    h("button", {
      class: "chip", type: "button", title: label === "All time" ? "No date limit" : `Fill in the dates for “${label.toLowerCase()}”`,
      onclick: () => { const r = presetRange(id, todayLocal(), weekStart()); form.elements.from.value = r.from; form.elements.to.value = r.to; setError(null); },
    }, label)));
  form.addEventListener("submit", (e) => e.preventDefault());
  form.addEventListener("input", () => setError(null));

  form.addEventListener("click", async (e) => {
    if (e.target.closest("[data-file-action=download]")) { menu.close(); host.actions.export(getName()); return; }
    const btn = e.target.closest("[data-report]");
    if (!btn) return;
    const info = reportInfo(kind, btn.dataset.report);
    if (!info) return;
    const range = { from: form.elements.from.value, to: form.elements.to.value };
    const bad = info.ranged ? validateRange(range) : null;
    if (bad) { setError(bad); form.elements.from.focus(); return; }
    setError(null);
    menu.close();
    const opts = { type: info.id, ...(info.ranged ? range : {}), account: form.elements.account.value.trim(), order: form.elements.order.value, weekStart: weekStart() };
    await host.reports.runNative({
      type: `${kind}:${info.id}`, label: info.label, file: getName(), text: getText(),
      query: info.ranged ? `${rangeLabel(range)}${opts.account ? ` · ${opts.account}` : ""}` : "running now",
      compute: (text) => runTimeReport(kind, text, { ...opts, now: localNow() }),
    });
  });
  return { form, setError };
}
