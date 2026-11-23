/* renderers/journal.js — the journal viewer.
 *
 * Two views of the same text:
 *   Rendered  the transaction register (a day-pinned list). Add / edit / delete go through the engine so
 *             hledger validates and balances them; nothing here calculates money. Statements live in Reports.
 *   Raw       the file text in a CodeMirror editor (line numbers follow the setting), with an editor status line.
 * Search, filters, sort, selection and "Add transaction" live ONLY in the menu bar (Filters, Sort and
 * Transactions are three independent menus). Filters and sort apply the moment they change.
 */
import { h, icon, parseUri, extOf, debounce } from "../core.js";
import { initMenubar } from "../menubar.js";
import { fmtDate, fmtDateLong, fmtDayParts, txnMaxAbs, txnHeadlineSigned, isNegativeText } from "../format.js";
import { compileQuery, stepRange } from "../find.js";
import { bindShortcutHints } from "../keyboard-shortcuts.js";
import { createBoundEditor } from "../../codemirror/bundle.js";

const SORTS = {
  "date-desc": (a, b) => b.date.localeCompare(a.date) || b.index - a.index,
  "date-asc": (a, b) => a.date.localeCompare(b.date) || a.index - b.index,
  "desc-asc": (a, b) => a.description.localeCompare(b.description),
  "desc-desc": (a, b) => b.description.localeCompare(a.description),
  // "Largest posting": the biggest absolute posting amount of each transaction, compared as plain numbers.
  // It is a sort key, never shown as a transaction total (a transaction has no single meaningful amount).
  "amount-desc": (a, b) => b.maxAbs - a.maxAbs,
  "amount-asc": (a, b) => a.maxAbs - b.maxAbs,
};
const SORT_LABELS = {
  "date-asc": "Oldest first", "desc-asc": "Description A–Z", "desc-desc": "Description Z–A",
  "amount-desc": "Largest posting, high to low", "amount-asc": "Largest posting, low to high",
};
const FILTER_LABELS = { account: "Account", desc: "Description", from: "From", to: "To", min: "Posting ≥", max: "Posting ≤" };
const DEFAULT_SORT = "date-desc";
const RECENT_KEY = "wedger_recent_searches";
const PREVIEW_NAMES = 4;                 // transactions named in the bulk-delete confirmation
/** "Friday, 2 January 2026", or the text as written when it isn't a real date. */
const longDate = (iso) => { const s = fmtDateLong(iso); return /invalid/i.test(s) ? String(iso) : s; };

export default {
  async mount(view, { host, assets, contrib }) {
    const [html, menuHtml] = await Promise.all([assets.text("views/journal.html"), assets.text("views/journal-menu.html")]);
    const root = h("div", { class: "jv" });
    root.innerHTML = html;
    view.container.append(root);
    view.menubar.innerHTML = menuHtml;
    const bar = view.menubar;
    const menu = initMenubar(bar, { onOpen: (id) => { if (id === "search") renderRecent(); } });

    const $ = (sel, scope = root) => scope.querySelector(sel);
    const slot = (n, scope = root) => scope.querySelector(`[data-slot="${n}"]`);

    /* ------------------------------------------------------------ state */
    const name = () => parseUri(view.uri).path;
    const isJournal = () => extOf(name()) === ".journal";
    let savedText = host.files.get(name())?.content ?? "";
    let text = savedText;
    let mode = isJournal() ? host.settings.get("defaultView") : "raw";
    let forecast = false;
    let filters = {};
    let sort = DEFAULT_SORT;
    let query = "";
    const findOpts = { caseSensitive: false, wholeWord: false, regexp: false };   // not persisted
    let compiled = compileQuery("");
    let txns = [];                        // decorated, in file order
    let txnsText = null;                  // the text `txns` was parsed from (ids below belong to THIS text)
    let byId = new Map();
    let shownRows = [];                   // what the list currently displays (after search / filters / sort)
    let selectMode = false;
    const selected = new Set();           // transaction ids; only meaningful for `txnsText`
    let anchorId = null;                  // last toggled row, for shift-click ranges
    let busy = false;                     // a delete is in flight
    let token = 0;                        // discards out-of-date engine answers
    let loadState = "idle";               // idle | loading | ok | engine-error | parse-error
    let loadError = "";
    let rawMatches = 0;
    const isDirty = () => text !== savedText;
    // With auto-save on, "unsaved" lasts under a second, so the tab doesn't flash a dot (or nag on close).
    const markDirty = () => view.setDirty(isDirty() && !host.settings.get("autoSave"));

    /* ------------------------------------------------------------- raw pane */
    // The textarea stays as the value bridge; CodeMirror is the editor. Programmatic `ta.value = x` replaces the document
    // (and its undo history, as a file switch should) without firing `input`; typing fires it, so the handler below runs.
    const ta = slot("text");
    const editor = createBoundEditor(ta, {
      dispatchInput: true, resetHistoryOnSet: true, lineWrapping: false,
      lineNumbers: !!host.settings.get("lineNumbers"),
      onSelection: () => updatePos(),
    });
    const lineCount = () => editor.view.state.doc.lines;
    function applyLineNumbers() { editor.setLineNumbers(!!host.settings.get("lineNumbers")); }
    function updatePos() {
      const el = slot("status-pos");
      if (mode !== "raw") { el.textContent = ""; return; }
      const { line, col } = editor.getCursor();
      el.textContent = `Ln ${line}, Col ${col}`;
    }
    const showEditor = () => requestAnimationFrame(() => editor.refresh());      // CodeMirror measures 0 inside a hidden pane
    ta.value = text;
    ta.addEventListener("input", () => {
      text = ta.value;
      markDirty();
      updatePos(); renderStatus();
      if (host.settings.get("autoSave")) autosave();
    });
    editor.wrapper.addEventListener("focusout", () => { if (host.settings.get("autoSave")) autosave.flush(); });

    /* ------------------------------------------------------------ saving */
    function save() {
      if (!isDirty()) return true;
      try { host.files.write(name(), text); }
      catch (err) { host.notify(err.message, "error"); return false; }
      savedText = text;
      markDirty();
      renderStatus();
      return true;
    }
    const autosave = debounce(() => { save(); }, 700);

    /* ---------------------------------------------------------- status bar */
    // An editor status line: raw view only. In rendered view the list speaks for itself and the footer is hidden.
    const SYNC_TEXT = { local: "Saved on this device", pending: "Syncing to Drive…", synced: "Synced to Drive", error: "Drive sync failed" };
    function renderStatus() {
      const footer = slot("status");
      footer.hidden = mode !== "raw";
      if (mode !== "raw") return;
      const n = lineCount();
      slot("status-lines").textContent = `${n} ${n === 1 ? "line" : "lines"}`;
      const st = host.sync.statusOf(name());
      const syncEl = slot("status-sync");
      syncEl.textContent = SYNC_TEXT[st];
      syncEl.classList.toggle("statusbar__warn", st === "error");
      syncEl.title = st === "error" ? (host.sync.errorOf(name()) ?? "") : "";
      slot("status-saved").textContent = isDirty() ? "Unsaved changes" : "Saved";
    }

    /* ---------------------------------------------------------------- data */
    const decorate = (data) => data.map((t, index) => ({
      id: t.id ?? index, index, date: String(t.date ?? ""), description: String(t.description ?? ""),
      postings: (t.postings ?? []).map((p) => ({ account: String(p.account ?? ""), amount: p.amount == null ? "" : String(p.amount) })),
      rawText: t.rawText ?? "", maxAbs: 0,
      editable: t.editable !== false, blockedReason: t.blockedReason ?? null, source: t.source ?? null,
    })).map((t) => ({ ...t, maxAbs: txnMaxAbs(t) }));

    async function refreshData() {
      if (!isJournal()) return;
      const mine = ++token;
      // The journal is being re-read: every id, every report and the selection belong to the OLD text.
      selected.clear(); anchorId = null; busy = false; shownRows = [];
      loadState = "loading"; drawState(); updateSelectionUI();
      try { await host.engine.whenReady(); }
      catch (err) { if (mine === token) { loadState = "engine-error"; loadError = err.message; drawState(); } return; }
      const snapshot = text;
      const res = await host.engine.transactions(name(), snapshot, { forecast });
      if (mine !== token) return;
      if (!res.ok) { loadState = "parse-error"; loadError = res.error; txns = []; txnsText = null; byId = new Map(); drawState(); renderStatus(); return; }
      txns = decorate(res.data); txnsText = snapshot;
      byId = new Map(txns.map((t) => [String(t.id), t]));
      loadState = "ok";
      drawState(); drawHeading(); drawList(); renderStatus();
    }
    const refreshSoon = debounce(refreshData, 60);

    /* ---------------------------------------------------------- state card */
    function drawState() {
      queueMicrotask(updateSelectionUI);                    // menu entries follow the load state (enabled only when the list is ready)
      const el = slot("state"), content = slot("content");
      el.replaceChildren();
      content.hidden = loadState !== "ok";
      if (loadState === "ok" || loadState === "idle") { el.hidden = true; return; }
      el.hidden = false;
      if (loadState === "loading") {
        el.append(h("div", { class: "spinner", "aria-hidden": "true" }),
          h("p", {}, host.engine.ready ? "Reading your journal…" : "Loading the accounting engine…"),
          h("p", { class: "text-faint", dataset: { slot: "progress" } }, host.engine.progress));
      } else if (loadState === "engine-error") {
        el.append(h("div", { class: "banner banner--error", role: "alert" }, h("strong", {}, "The accounting engine isn't available."), h("p", {}, loadError)),
          h("div", { class: "jv__state-actions" },
            h("button", { class: "btn btn--primary", type: "button", onclick: () => { host.engine.retry().catch(() => { }); refreshData(); } }, "Retry"),
            h("button", { class: "btn", type: "button", onclick: () => setMode("raw") }, "Edit raw text")));
      } else {
        el.append(h("div", { class: "banner banner--error", role: "alert" }, h("strong", {}, "hledger couldn't read this journal."), h("pre", {}, loadError)),
          h("div", { class: "jv__state-actions" }, h("button", { class: "btn btn--primary", type: "button", onclick: () => setMode("raw") }, "Fix it in raw text")));
      }
    }

    /* ------------------------------------------------------------ heading */
    // The file name is read by screen readers only (the h1 is visually hidden); the register starts right at the top.
    const drawHeading = () => { slot("heading").textContent = name(); };

    /* ----------------------------------------------------------- the list */
    const hasValue = (v) => v !== "" && v != null;
    /**
     * The filters that actually apply, plus a plain-language list of what was ignored and why. A contradictory range
     * (From after To, Min above Max) is ignored as a pair instead of silently producing an empty list.
     */
    function effectiveFilters() {
      const f = { account: "", desc: "", from: "", to: "", min: "", max: "", ...filters };
      const issues = [];
      for (const k of ["min", "max"]) {
        if (!hasValue(f[k])) continue;
        const n = Number(f[k]);
        if (!Number.isFinite(n) || n < 0) { issues.push(`${k === "min" ? "Min" : "Max"} posting amount must be a number, 0 or more, so it isn't applied.`); f[k] = ""; }
      }
      if (f.from && f.to && f.from > f.to) { issues.push("The From date is after the To date, so neither date is applied."); f.from = f.to = ""; }
      if (hasValue(f.min) && hasValue(f.max) && Number(f.min) > Number(f.max)) { issues.push("The minimum amount is larger than the maximum, so neither amount is applied."); f.min = f.max = ""; }
      return { f, issues };
    }
    const filterActive = () => Object.values(effectiveFilters().f).some(hasValue);
    function visible() {
      if (query.trim() && !compiled.ok) return [];                 // an invalid pattern matches nothing (the menu says why)
      const q = query.trim();
      const { f } = effectiveFilters();
      const acc = f.account.toLowerCase(), desc = f.desc.toLowerCase();
      const min = hasValue(f.min) ? Number(f.min) : null;
      const max = hasValue(f.max) ? Number(f.max) : null;
      return txns.filter((t) => {
        if (q && !compiled.test(`${t.date} ${t.description} ${t.postings.map((p) => `${p.account} ${p.amount}`).join(" ")}`)) return false;
        if (acc && !t.postings.some((p) => p.account.toLowerCase().includes(acc))) return false;
        if (desc && !t.description.toLowerCase().includes(desc)) return false;
        if (f.from && t.date < f.from) return false;
        if (f.to && t.date > f.to) return false;
        if (min != null && t.maxAbs < min) return false;
        if (max != null && t.maxAbs > max) return false;
        return true;
      }).sort(SORTS[sort]);
    }

    const lockLabel = (t) => (t.source && t.source !== "input" ? `From ${t.source}` : /forecast/i.test(t.blockedReason ?? "") ? "Forecast" : null);

    function actionBtn(label, iconName, t, onclick, extra = "") {
      const locked = !t.editable;
      return h("button", {
        class: `icon-btn${extra}${locked ? " is-disabled" : ""}`, type: "button", title: locked ? (t.blockedReason ?? "Can't be changed here") : label,
        "aria-label": `${label} ${t.description || "transaction"}`, "aria-disabled": locked ? "true" : null,
        onclick: () => (locked ? host.notify(t.blockedReason ?? "This transaction can't be changed here.", "info") : onclick(t)),
      }, icon(iconName));
    }

    function txnRow(t) {
      const isSel = selected.has(t.id);
      const note = !t.editable ? lockLabel(t) : null;
      const blocked = !t.editable ? (t.blockedReason ?? "Can't be changed here") : "";
      const long = longDate(t.date), parts = fmtDayParts(t.date);
      const headline = txnHeadlineSigned(t);               // the biggest posting as the engine printed it: a scan aid, not a total
      return h("article", { class: `txn${isSel ? " is-selected" : ""}${t.editable ? "" : " is-locked"}`, dataset: { id: t.id } },
        selectMode && h("label", { class: "txn__select" },
          h("input", {
            type: "checkbox", checked: isSel, disabled: !t.editable,
            title: t.editable ? null : t.blockedReason,
            "aria-label": `Select ${t.description || "transaction"} on ${fmtDate(t.date)}`
          })),
        h("time", { class: "txn__date", datetime: t.date, title: long },
          h("span", { class: "txn__day", "aria-hidden": "true" }, parts.day),
          h("span", { class: "txn__wd", "aria-hidden": "true" }, parts.weekday),
          h("span", { class: "sr-only" }, long)),
        h("div", { class: "txn__main" },
          h("div", { class: "txn__head" },
            h("div", { class: `txn__desc${t.description ? "" : " is-empty"}` }, t.description || "(no description)",
              note && h("span", { class: "txn__note", title: blocked }, note),
              note && h("span", { class: "sr-only" }, `. ${blocked}`)),
            headline && h("div", { class: `txn__headline${isNegativeText(headline) ? " is-neg" : ""}` }, headline)),
          h("ul", { class: "txn__postings" }, ...t.postings.map((p) =>
            h("li", { class: "txn__posting" },
              h("span", { class: "txn__account" }, p.account),
              h("span", { class: `txn__amount${isNegativeText(p.amount) ? " is-neg" : ""}` }, p.amount))))),
        h("div", { class: "txn__actions" },
          actionBtn("Edit", "edit", t, editTxn),
          actionBtn("Delete", "trash", t, deleteTxn, " icon-btn--danger")));
    }

    function drawChips() {
      const chips = slot("chips");
      const items = [];
      for (const [k, label] of Object.entries(FILTER_LABELS)) if (filters[k]) items.push([label, k === "from" || k === "to" ? fmtDate(filters[k]) : filters[k], `Remove the ${label} filter`, () => { filters[k] = ""; syncFilterForm(); drawFilterIssues(); drawList(); }]);
      if (query.trim()) items.push(["Search", query.trim(), "Clear the search", () => { clearSearch(); }]);
      if (sort !== DEFAULT_SORT) items.push(["Sort", SORT_LABELS[sort], "Reset the sort order", () => { setSort(DEFAULT_SORT); }]);
      chips.hidden = !items.length;
      chips.replaceChildren(...items.map(([label, value, aria, remove]) => h("span", { class: "jv-chip" }, `${label}: ${value}`,
        h("button", { type: "button", "aria-label": aria, onclick: remove }, icon("close")))),
        ...(items.length > 1 ? [h("button", { class: "jv__chips-clear", type: "button", title: "Clear all filters, the search and the sort order", onclick: resetAll }, "Reset all")] : []));
      // The Filters badge counts the filter fields in force. Search and sort have their own chips and are never counted here.
      const badge = $("[data-slot=filter-count]", bar);
      const n = Object.values(effectiveFilters().f).filter(hasValue).length;
      badge.hidden = !n; badge.textContent = n;
      badge.title = n ? `${n} ${n === 1 ? "filter" : "filters"} on` : "";
    }

    /** Explains, in the menu and above the list, any filter that was left out because it contradicted another. */
    function drawFilterIssues() {
      const { issues } = effectiveFilters();
      const el = $("[data-slot=filter-error]", bar);
      el.hidden = !issues.length;
      el.textContent = issues.join("\n");
    }

    /** Quiet notices above the list: ignored filters, and transactions that can't be edited here. */
    function drawNotice() {
      const el = slot("list-notice");
      const { issues } = effectiveFilters();
      const locked = txns.filter((t) => !t.editable);
      el.replaceChildren(...issues.map((m) => h("div", { class: "banner banner--warn", role: "status" }, m)));
      if (locked.length) {
        const everyone = locked.length === txns.length && locked.every((t) => !t.source);
        el.append(h("div", { class: "banner banner--info", role: "status" },
          everyone ? h("span", {}, locked[0].blockedReason)
            : h("span", {}, `${locked.length} ${locked.length === 1 ? "transaction comes" : "transactions come"} from included files or forecast rules and can't be edited or deleted here.`)));
      }
      el.hidden = !el.childElementCount;
    }

    function drawList() {
      if (loadState !== "ok") return;
      const rows = visible();
      shownRows = rows;
      const list = slot("list"), empty = slot("empty");
      list.replaceChildren(); empty.hidden = true;
      const narrowed = filterActive() || query.trim();
      slot("list-meta").textContent = txns.length && narrowed ? `Showing ${rows.length} of ${txns.length}` : "";   // only where it explains a narrowed list
      drawChips(); drawNotice();
      const grouped = sort === "date-desc" || sort === "date-asc";
      list.classList.toggle("ledger--grouped", grouped);
      list.classList.toggle("is-selecting", selectMode);
      list.hidden = !rows.length;
      if (!rows.length) {
        empty.hidden = false;
        empty.replaceChildren(h("p", {}, txns.length ? "No transactions match the current filters or search." : "This journal has no transactions yet."),
          ...(txns.length
            ? [filterActive() && h("button", { class: "btn", type: "button", onclick: clearFilters }, "Clear filters"),
            query.trim() && h("button", { class: "btn", type: "button", onclick: clearSearch }, "Clear search")]
            : [h("button", { class: "btn btn--primary", type: "button", onclick: () => addTxn() }, "Add the first transaction")]));
        updateSelectionUI();
        return;
      }
      const frag = document.createDocumentFragment();
      if (grouped) {
        // One pill per day, sticky while that day's rows are under it. Each row also carries its own date rail.
        const counts = new Map();
        for (const t of rows) counts.set(t.date, (counts.get(t.date) ?? 0) + 1);
        let day = null, lastDate = null;
        for (const t of rows) {
          if (t.date !== lastDate) {
            const n = counts.get(t.date);
            day = h("section", { class: "day" },
              h("h3", { class: "day__pill" }, longDate(t.date),
                h("span", { class: "day__count", "aria-hidden": "true" }, String(n)),
                h("span", { class: "sr-only" }, `, ${n} ${n === 1 ? "transaction" : "transactions"}`)));
            frag.append(day); lastDate = t.date;
          }
          day.append(txnRow(t));
        }
      } else {
        for (const t of rows) frag.append(txnRow(t));
      }
      list.append(frag);
      updateSelectionUI();
    }

    /* ---------------------------------------------------------- selection */
    // Scope rules: "Select all visible" and "Delete selected" only ever touch what the list shows right now.
    // Selected transactions hidden by a filter stay selected (and are counted separately) but are never deleted.
    const selectable = (t) => t.editable;
    const visibleSelected = () => shownRows.filter((t) => selected.has(t.id));

    function syncRow(t) {
      const row = slot("list").querySelector(`.txn[data-id="${CSS.escape(String(t.id))}"]`);
      if (!row) return;
      const on = selected.has(t.id);
      row.classList.toggle("is-selected", on);
      const box = row.querySelector(".txn__select input");
      if (box) box.checked = on;
    }

    function setSelected(t, on, { range = false } = {}) {
      if (!selectable(t)) return;
      const targets = [t];
      if (range && anchorId != null) {
        const a = shownRows.findIndex((r) => r.id === anchorId), b = shownRows.findIndex((r) => r.id === t.id);
        if (a >= 0 && b >= 0) targets.splice(0, 1, ...shownRows.slice(Math.min(a, b), Math.max(a, b) + 1).filter(selectable));
      }
      for (const r of targets) { on ? selected.add(r.id) : selected.delete(r.id); syncRow(r); }
      anchorId = t.id;
      updateSelectionUI();
    }

    function setSelectMode(on) {
      if (selectMode === on) return;
      selectMode = on;
      if (!on) { selected.clear(); anchorId = null; }
      drawList();
      updateSelectionUI();
    }

    function selectAllVisible() {
      if (!selectMode) setSelectMode(true);
      for (const t of shownRows) if (selectable(t)) selected.add(t.id);
      for (const t of shownRows) syncRow(t);
      updateSelectionUI();
    }

    function clearSelection() {
      const had = [...selected];
      selected.clear(); anchorId = null;
      for (const id of had) { const t = byId.get(String(id)); if (t) syncRow(t); }
      updateSelectionUI();
    }

    /** Can the Add transaction dialog open right now? (Rendered journal, read from the current text, nothing in flight.) */
    const canAdd = () => isJournal() && mode === "rendered" && loadState === "ok" && txnsText === text && !busy;

    /** Every label, count and disabled state below is derived from the real selection; nothing is static. */
    function updateSelectionUI() {
      const total = selected.size;
      const sel = visibleSelected().length;                 // selected AND shown by the current filters / search
      const hiddenSel = total - sel;                        // selected but filtered out: kept, never deleted
      const canSelect = shownRows.filter(selectable).length;
      const ready = loadState === "ok";

      const trigger = $("[data-menu=transactions] .menubar__btn", bar);
      trigger.dataset.active = String(selectMode);
      const badge = slot("sel-badge", bar);
      badge.hidden = !selectMode || total === 0;
      badge.replaceChildren(String(total), h("span", { class: "sr-only" }, " selected"));
      badge.title = total ? `${total} selected` : "";

      slot("selbar").hidden = !selectMode || !ready;
      slot("sel-count").textContent = busy ? "Deleting…" : `${total} selected`;
      slot("sel-note").textContent = !busy && hiddenSel ? `${hiddenSel} hidden by filters, not deleted.` : "";
      $("[data-act=exit-select]").disabled = busy;
      $("[data-act=bar-select-all]").disabled = busy || !ready || canSelect === 0;
      $("[data-act=bar-clear]").disabled = busy || total === 0;
      $("[data-act=bar-delete]").disabled = busy || sel === 0;
      syncPinnedTop();

      $("[data-act=add-txn]", bar).disabled = !canAdd();
      const toggle = $("[data-act=toggle-select]", bar);
      toggle.setAttribute("aria-pressed", String(selectMode));
      toggle.textContent = selectMode ? "Exit selection mode" : "Select transactions";
      toggle.disabled = busy || !ready;
      const all = $("[data-act=select-visible]", bar);
      all.disabled = busy || !ready || canSelect === 0;
      all.textContent = canSelect ? `Select all visible (${canSelect})` : "Select all visible";
      all.title = "Selects only the transactions the list shows right now";
      const clear = $("[data-act=clear-selection]", bar);
      clear.disabled = busy || total === 0;
      clear.textContent = total ? `Clear selection (${total})` : "Clear selection";
      const del = $("[data-act=delete-selected]", bar);
      del.disabled = busy || sel === 0;
      del.textContent = sel ? `Delete selected (${sel})…` : "Delete selected…";
    }

    /** Day pills stick below the selection bar while it is showing (it is sticky at the top of the same scroll area). */
    const rendered = $("[data-pane=rendered]");
    function syncPinnedTop() {
      const el = slot("selbar");
      rendered.style.setProperty("--pinned-top", el.hidden ? "0px" : `${el.offsetHeight + 6}px`);
    }
    const resizeWatch = typeof ResizeObserver === "function" ? new ResizeObserver(syncPinnedTop) : null;
    resizeWatch?.observe(slot("selbar"));

    // One delegated listener: the checkbox, or (in selection mode) anywhere on a row.
    slot("list").addEventListener("click", (e) => {
      if (!selectMode) return;
      const row = e.target.closest(".txn");
      if (!row || e.target.closest(".txn__actions")) return;
      const t = byId.get(row.dataset.id);
      if (!t || !selectable(t)) return;
      const box = e.target.closest(".txn__select input");
      if (box) { setSelected(t, box.checked, { range: e.shiftKey }); return; }
      if (e.target.closest(".txn__select")) return;                    // label padding: the input's own click follows
      setSelected(t, !selected.has(t.id), { range: e.shiftKey });
    });
    // The selection bar and the Transactions menu call the same functions; there is one selection implementation.
    slot("selbar").addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (!act || e.target.closest("button")?.disabled) return;
      if (act === "exit-select") setSelectMode(false);
      else if (act === "bar-select-all") selectAllVisible();
      else if (act === "bar-clear") clearSelection();
      else if (act === "bar-delete") deleteSelected();
    });

    /* --------------------------------------------------------- mutations */
    async function commit(newText) {
      text = newText;
      ta.value = text;
      if (!save()) return false;       // saves immediately: these are deliberate actions, not typing
      await refreshData();             // re-reads once; clears the selection
      return true;
    }

    async function guardFresh() {
      if (loadState === "ok" && txnsText === text) return true;
      host.notify("Still reading the journal. Try again in a moment.", "info");
      return false;
    }

    async function addTxn() {
      if (!(await guardFresh())) return;
      await host.dialogs.openTemplate("dialogs/add-transaction.html", {
        controller: "dialogs/add-transaction.js", wide: true, label: "Add transaction",
        params: {
          accounts: host.engine.accounts(text, { forecast }), defaultCommodity: host.settings.get("defaultCommodity"),
          submit: async (txnText) => {
            const res = await host.engine.addTransaction(text, txnText, { forecast });
            if (!res.ok) return res.error;
            await commit(res.text);
            host.notify("Transaction added", "ok");
            return null;
          },
        },
      });
    }

    async function editTxn(t) {
      if (!(await guardFresh())) return;
      await host.dialogs.openTemplate("dialogs/add-transaction.html", {
        controller: "dialogs/add-transaction.js", wide: true, label: "Edit transaction",
        params: {
          txn: t, accounts: host.engine.accounts(text, { forecast }), defaultCommodity: host.settings.get("defaultCommodity"),
          submit: async (txnText) => {
            const res = await host.engine.updateTransaction(text, t.id, txnText, { forecast });
            if (!res.ok) return res.error;
            await commit(res.text);
            host.notify("Transaction updated", "ok");
            return null;
          },
        },
      });
    }

    async function deleteTxn(t) {
      if (!(await guardFresh())) return;
      const ok = await host.dialogs.confirm({
        title: "Delete this transaction?", message: `“${t.description || "(no description)"}” on ${fmtDate(t.date)} will be removed from the file.`,
        confirmLabel: "Delete", danger: true,
      });
      if (!ok) return;
      const res = await host.engine.deleteTransaction(text, t.id, { forecast });
      if (!res.ok) { host.notify(`Couldn't delete it: ${res.error}`, "error"); return; }
      await commit(res.text);
      host.notify("Transaction deleted", "ok");
    }

    /** One confirmation, ONE engine operation, one save, one refresh, one notification. */
    async function deleteSelected() {
      if (busy || !(await guardFresh())) return;
      const targets = visibleSelected();                                  // only what the list shows
      if (!targets.length) { host.notify("Nothing is selected in the current list.", "info"); return; }
      if (targets.some((t) => !t.editable)) { host.notify("Some selected transactions can't be deleted here.", "error"); return; }
      const n = targets.length;
      const named = targets.slice(0, PREVIEW_NAMES).map((t) => `“${t.description || "(no description)"}” (${fmtDate(t.date)})`).join(", ");
      const hiddenSel = selected.size - n;
      const ok = await host.dialogs.confirm({
        title: `Delete ${n} selected ${n === 1 ? "transaction" : "transactions"}?`,
        message: `${named}${n > PREVIEW_NAMES ? ` and ${n - PREVIEW_NAMES} more` : ""} will be removed from the file. Only the ${n === 1 ? "transaction" : "transactions"} shown in the list ${n === 1 ? "is" : "are"} deleted.${hiddenSel ? ` ${hiddenSel} more ${hiddenSel === 1 ? "is" : "are"} selected but hidden by the current filters or search, and ${hiddenSel === 1 ? "stays" : "stay"} in the file.` : ""}`,
        confirmLabel: `Delete ${n}`, danger: true,
      });
      if (!ok) return;                                                    // cancelled: nothing changed
      if (txnsText !== text) { host.notify("The journal changed while you were deciding. Select again.", "error"); return; }
      busy = true; updateSelectionUI();
      const res = await host.engine.deleteTransactions(text, targets.map((t) => t.id), { forecast });
      busy = false;
      if (!res.ok) { host.notify(`Couldn't delete the selected transactions: ${res.error}`, "error"); updateSelectionUI(); return; }   // saved journal untouched
      if (!(await commit(res.text))) return;                              // save failed: commit already said so
      selectMode = false;
      drawList();
      host.notify(`${res.deleted ?? n} ${(res.deleted ?? n) === 1 ? "transaction" : "transactions"} deleted`, "ok");
    }

    /* ------------------------------------------------------ search / filters */
    const readRecent = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]"); } catch { return []; } };
    function rememberSearch(q) {
      if (!q) return;
      const list = [q, ...readRecent().filter((x) => x !== q)].slice(0, 6);
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch { /* ignore */ }
    }
    function renderRecent() {
      const list = readRecent(), box = $("[data-slot=recent]", bar);
      $("[data-slot=recent-group]", bar).hidden = !list.length;
      box.replaceChildren(...list.map((q) => h("button", { class: "chip", type: "button", onclick: () => { const i = $("[name=search]", bar); i.value = q; i.dispatchEvent(new Event("input")); } }, q)));
    }

    const searchInput = $("[name=search]", bar);
    const recompile = () => { compiled = compileQuery(query.trim(), findOpts); };
    /** The line under the field: a match count, or why the pattern is not usable (it then matches nothing). */
    function paintSearchCount() {
      const el = $("[data-slot=search-count]", bar);
      if (!query.trim()) { el.textContent = ""; return; }
      if (!compiled.ok) { el.textContent = `Invalid pattern: ${compiled.error}`; return; }
      if (mode === "rendered") el.textContent = loadState === "ok" ? `${shownRows.length} matching transactions` : "";
      else el.textContent = `${rawMatches} ${rawMatches === 1 ? "match" : "matches"}`;
    }
    function applySearch() {
      query = searchInput.value;
      recompile();
      if (mode === "rendered") drawList(); else countRaw();
      paintSearchCount();
    }
    const runSearch = debounce(applySearch, 120);
    searchInput.addEventListener("input", runSearch);
    searchInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      rememberSearch(searchInput.value.trim());
      if (mode === "raw") { applySearch(); findNext(e.shiftKey ? -1 : 1); }
      else menu.close({ restoreFocus: true });
    });
    // Match case / whole word / regex: one compiled query serves both the list and the raw editor.
    const findButtons = { caseSensitive: $("[name=findCase]", bar), wholeWord: $("[name=findWord]", bar), regexp: $("[name=findRegexp]", bar) };
    for (const [key, btn] of Object.entries(findButtons)) {
      btn.addEventListener("click", () => {
        findOpts[key] = !findOpts[key];
        btn.setAttribute("aria-pressed", String(findOpts[key]));
        runSearch.cancel(); applySearch();
      });
    }

    function countRaw() {
      rawMatches = query.trim() && compiled.ok ? compiled.ranges(editor.value).length : 0;
    }
    function findNext(dir = 1) {
      if (!query.trim() || !compiled.ok) return;              // an invalid pattern never moves the selection
      const hit = stepRange(compiled.ranges(editor.value), editor.getSelection(), dir);
      if (!hit) return;
      editor.setSelection(hit.from, hit.to);                  // selects and scrolls it into view; focus stays in the search field
      updatePos();
    }

    /* ------------------------------------------------- filters and sort: two independent controls */
    const filterForm = $("[data-form=filters]", bar);
    const sortRadios = [...bar.querySelectorAll("[data-form=sort] [name=sort]")];
    const clearFiltersBtn = $("[data-act=clear-filters]", bar);

    const readFilters = () => {
      const data = new FormData(filterForm);
      filters = Object.fromEntries(Object.keys(FILTER_LABELS).map((k) => [k, String(data.get(k) ?? "").trim()]));
    };
    function syncFilterForm() {
      for (const k of Object.keys(FILTER_LABELS)) filterForm.elements[k].value = filters[k] ?? "";
      clearFiltersBtn.disabled = !Object.values(filters).some(hasValue);
    }
    function syncSortForm() { for (const r of sortRadios) r.checked = r.value === sort; }

    /** The View and Sort menus show what the state says — never what the DOM remembers. */
    function syncMenuUI() {
      for (const r of bar.querySelectorAll("[name=view]")) r.checked = r.value === mode;
      syncSortForm();
    }

    /** Filtering feels immediate: text is debounced, everything else applies on change. */
    const applyFilterInput = () => { readFilters(); clearFiltersBtn.disabled = !Object.values(filters).some(hasValue); drawFilterIssues(); drawList(); };
    const applyFilterSoon = debounce(applyFilterInput, 150);
    filterForm.addEventListener("input", applyFilterSoon);
    filterForm.addEventListener("change", applyFilterSoon.flush);
    filterForm.addEventListener("submit", (e) => e.preventDefault());          // Enter in a field must not reload the page

    function clearFilters() {                                                   // filters only: search and sort are left alone
      applyFilterSoon.cancel();
      filters = {};
      syncFilterForm(); drawFilterIssues(); drawList();
    }
    function setSort(next) {                                                    // sort only: filters and search are left alone
      sort = SORTS[next] ? next : DEFAULT_SORT;
      syncSortForm(); drawList();
    }
    function clearSearch() {
      query = ""; searchInput.value = "";
      recompile();
      $("[data-slot=search-count]", bar).textContent = "";
      if (mode === "rendered") drawList(); else countRaw();
    }
    function resetAll() {                                                       // the one action that clears everything, and says so
      applyFilterSoon.cancel();
      filters = {}; sort = DEFAULT_SORT;
      syncFilterForm(); syncSortForm(); drawFilterIssues();
      clearSearch();
    }
    for (const r of sortRadios) r.addEventListener("change", () => { if (r.checked) setSort(r.value); });

    /* ------------------------------------------------------------- reports */
    function runReport(type) {
      const q = $("[name=query]", bar).value.trim();
      menu.close();
      host.reports.run(type, { file: name(), text, query: q, forecast });
    }
    bar.addEventListener("click", (e) => {
      const rep = e.target.closest("[data-report]");
      if (rep) { runReport(rep.dataset.report); return; }
      if (e.target.closest("[data-file-action=download]")) { menu.close(); host.actions.export(name()); return; }
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (!act || e.target.closest("button")?.disabled) return;
      if (act === "add-txn") { menu.close(); addTxn(); return; }
      if (act === "clear-filters") { clearFilters(); return; }
      if (act === "toggle-select") { menu.close(); setSelectMode(!selectMode); }
      else if (act === "select-visible") { menu.close(); selectAllVisible(); }
      else if (act === "clear-selection") { clearSelection(); }
      else if (act === "delete-selected") { menu.close(); deleteSelected(); }
    });
    $("[name=forecast]", bar).addEventListener("change", (e) => { forecast = e.target.checked; if (mode === "rendered") refreshData(); });

    /* ------------------------------------------------------------ view mode */
    function setMode(next) {
      if (next === "rendered" && !isJournal()) next = "raw";
      mode = next;
      $("[data-pane=rendered]").hidden = mode !== "rendered";
      $("[data-pane=raw]").hidden = mode !== "raw";
      for (const r of bar.querySelectorAll("[name=view]")) r.checked = r.value === mode;
      for (const el of bar.querySelectorAll("[data-needs=rendered]")) el.disabled = mode !== "rendered" || !isJournal();
      $("[data-slot=search-help]", bar).textContent = mode === "raw" ? "Enter for the next match, Shift+Enter for the previous." : "Filters the transactions below as you type.";
      if (mode === "raw") setSelectMode(false);                 // the list is hidden: selection mode would be invisible
      searchInput.dispatchEvent(new Event("input"));
      menu.close();
      if (mode === "rendered") { if (txnsText !== text || loadState !== "ok") refreshData(); drawList(); }
      else { ta.value = text; showEditor(); updatePos(); }
      renderStatus();
      updateSelectionUI();
    }
    for (const r of bar.querySelectorAll("[name=view]")) r.addEventListener("change", () => { if (r.checked) setMode(r.value); });
    const rendereredRadio = $("[name=view][value=rendered]", bar);
    if (!isJournal()) { rendereredRadio.disabled = true; for (const el of bar.querySelectorAll("[data-needs=journal]")) el.disabled = true; }

    /* --------------------------------------------------------------- wiring */
    const offs = [
      host.files.on("changed", (ev) => {
        if (ev.kind === "meta" || ev.name === name() || ev.kind === "reload") {
          const f = host.files.get(name());
          if (f && f.content !== savedText && !isDirty()) {      // changed elsewhere (sync, another tab): adopt it
            savedText = text = f.content; ta.value = text;
            selected.clear(); anchorId = null; updateSelectionUI();   // ids from the old text must never be acted on
            if (mode === "rendered") refreshSoon();
          }
        }
        renderStatus();
      }),
      host.sync.on("changed", renderStatus),
      host.auth.on("changed", renderStatus),
      host.settings.on("lineNumbers", applyLineNumbers),
      bindShortcutHints(bar),                                  // Add transaction / Search hints follow the live bindings
      host.engine.on("progress", (msg) => { const p = $("[data-slot=progress]"); if (p) p.textContent = msg; }),
      host.engine.on("status", (s) => { if (s === "ready" && mode === "rendered" && loadState !== "ok") refreshData(); }),
    ];

    const flushNow = () => { if (host.settings.get("autoSave") && host.files.exists(name())) autosave.flush(); };
    const onHidden = () => { if (document.visibilityState === "hidden") flushNow(); };
    window.addEventListener("pagehide", flushNow);
    document.addEventListener("visibilitychange", onHidden);
    offs.push(() => { window.removeEventListener("pagehide", flushNow); document.removeEventListener("visibilitychange", onHidden); },
      host.settings.on("autoSave", () => { markDirty(); if (host.settings.get("autoSave")) autosave(); }));

    applyLineNumbers();
    syncFilterForm(); syncSortForm(); drawFilterIssues();
    setMode(mode);
    renderStatus();
    updateSelectionUI();
    if (mode === "rendered") refreshData();

    /** Small, explicit surface for the keyboard-shortcut service (see keyboard-shortcuts.js). */
    return {
      canAddTransaction: canAdd,
      addTransaction() { if (!canAdd()) return; menu.close(); return addTxn(); },
      canFocusSearch: () => true,
      focusSearch() { menu.open("search", { focusFirst: true }); searchInput.focus({ preventScroll: true }); searchInput.select(); },
      onShow() { syncMenuUI(); showEditor(); if (mode === "raw") { editor.focus(); updatePos(); } },
      save,
      dispose() {
        if (host.settings.get("autoSave") && host.files.exists(name())) autosave.flush(); else autosave.cancel();
        offs.forEach((off) => off()); menu.dispose(); resizeWatch?.disconnect(); editor.destroy(); refreshSoon.cancel(); runSearch.cancel(); token++;
      },
    };
  },
};

