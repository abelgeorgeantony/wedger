/* renderers/journal.js — the journal viewer.
 *
 * Two views of the same text:
 *   Rendered  an overview (latest month, top spending) + the transaction list,
 *             all computed from the hledger engine; add / edit / delete go
 *             through the engine so hledger validates and balances them.
 *   Raw       the file text with line numbers.
 * Search, filters and sorts live ONLY in the menu bar.
 */
import { h, icon, parseUri, extOf, debounce } from "../core.js";
import { initMenubar } from "../menubar.js";
import {
  fmtDate, fmtDateLong, monthLabel, parseAmountText, formatMoney, txnMaxAbs, txnHeadline, isNegativeText,
} from "../format.js";

const SORTS = {
  "date-desc": (a, b) => b.date.localeCompare(a.date) || b.index - a.index,
  "date-asc": (a, b) => a.date.localeCompare(b.date) || a.index - b.index,
  "desc-asc": (a, b) => a.description.localeCompare(b.description),
  "desc-desc": (a, b) => b.description.localeCompare(a.description),
  "amount-desc": (a, b) => b.maxAbs - a.maxAbs,
  "amount-asc": (a, b) => a.maxAbs - b.maxAbs,
};
const SORT_LABELS = {
  "date-asc": "Oldest first", "desc-asc": "Description A–Z", "desc-desc": "Description Z–A",
  "amount-desc": "Amount high to low", "amount-asc": "Amount low to high",
};
const FILTER_LABELS = { account: "Account", desc: "Description", from: "From", to: "To", min: "Min", max: "Max" };
const RECENT_KEY = "wedger_recent_searches";

const accountKind = (account) => {
  const top = account.split(":")[0].toLowerCase();
  if (/^assets?$/.test(top)) return "asset";
  if (/^liabilit/.test(top)) return "liability";
  if (/^expenses?$/.test(top)) return "expense";
  if (/^(income|revenues?)$/.test(top)) return "income";
  return "other";
};

const prevMonth = (ym) => { const [y, m] = ym.split("-").map(Number); const d = new Date(y, m - 2, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };

/** Everything the overview needs, in the file's most-used commodity. Pure. */
export function summarize(txns) {
  const counts = new Map(), styles = new Map(), accounts = new Set();
  let first = null, last = null;
  for (const t of txns) {
    if (!first || t.date < first) first = t.date;
    if (!last || t.date > last) last = t.date;
    for (const p of t.postings) {
      accounts.add(p.account);
      const a = parseAmountText(p.amount);
      if (!a) continue;
      counts.set(a.commodity, (counts.get(a.commodity) ?? 0) + 1);
      if (!styles.has(a.commodity)) styles.set(a.commodity, a);
    }
  }
  const primary = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  const style = styles.get(primary) ?? { commodity: primary, side: "L", spaced: false, places: 2 };
  const month = last?.slice(0, 7) ?? null, before = month ? prevMonth(month) : null;
  const s = { count: txns.length, accounts: accounts.size, first, last, month, before, style, otherCommodities: Math.max(0, counts.size - 1),
    netWorth: 0, income: 0, expenses: 0, prevIncome: 0, prevExpenses: 0, hasMonthData: false, categories: [] };
  const cats = new Map();
  for (const t of txns) {
    const ym = t.date.slice(0, 7);
    for (const p of t.postings) {
      const a = parseAmountText(p.amount);
      if (!a || a.commodity !== primary) continue;
      const kind = accountKind(p.account);
      if (kind === "asset" || kind === "liability") s.netWorth += a.value;
      if (ym === month) {
        if (kind === "income") { s.income -= a.value; s.hasMonthData = true; }
        if (kind === "expense") {
          s.expenses += a.value; s.hasMonthData = true;
          const key = p.account.split(":").slice(0, 2).join(":");
          cats.set(key, (cats.get(key) ?? 0) + a.value);
        }
      } else if (ym === before) {
        if (kind === "income") s.prevIncome -= a.value;
        if (kind === "expense") s.prevExpenses += a.value;
      }
    }
  }
  s.categories = [...cats.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, value]) => ({ name, value }));
  return s;
}

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
    const grouping = () => host.settings.get("numberGrouping");
    const money = (value, style) => formatMoney(value, style, grouping());

    /* ------------------------------------------------------------ state */
    const name = () => parseUri(view.uri).path;
    const isJournal = () => extOf(name()) === ".journal";
    let savedText = host.files.get(name())?.content ?? "";
    let text = savedText;
    let mode = isJournal() ? host.settings.get("defaultView") : "raw";
    let forecast = false;
    let filters = {};
    let sort = "date-desc";
    let query = "";
    let txns = [];                        // decorated, in file order
    let txnsText = null;                  // the text `txns` was parsed from
    let summary = null;
    let token = 0;                        // discards out-of-date engine answers
    let loadState = "idle";               // idle | loading | ok | engine-error | parse-error
    let loadError = "";
    let rawMatches = 0;
    const isDirty = () => text !== savedText;
    // With auto-save on, "unsaved" lasts under a second, so the tab doesn't flash a dot (or nag on close).
    const markDirty = () => view.setDirty(isDirty() && !host.settings.get("autoSave"));

    /* ------------------------------------------------------------- raw pane */
    const ta = slot("text"), gutter = slot("gutter");
    let lineCount = 0;
    function drawGutter() {
      const n = ta.value.split("\n").length;
      if (n !== lineCount) { lineCount = n; gutter.textContent = Array.from({ length: n }, (_, i) => i + 1).join("\n"); }
      gutter.scrollTop = ta.scrollTop;
    }
    function applyLineNumbers() { gutter.hidden = !host.settings.get("lineNumbers"); }
    function updatePos() {
      const upto = ta.value.slice(0, ta.selectionStart).split("\n");
      slot("status-pos").textContent = mode === "raw" ? `Ln ${upto.length}, Col ${upto[upto.length - 1].length + 1}` : "";
    }
    ta.value = text;
    ta.addEventListener("scroll", () => { gutter.scrollTop = ta.scrollTop; });
    ta.addEventListener("keyup", updatePos);
    ta.addEventListener("click", updatePos);
    ta.addEventListener("input", () => {
      text = ta.value;
      markDirty();
      drawGutter(); updatePos(); renderStatus();
      if (host.settings.get("autoSave")) autosave();
    });
    ta.addEventListener("blur", () => { if (host.settings.get("autoSave")) autosave.flush(); });

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
    const SYNC_TEXT = { local: "Saved on this device", pending: "Syncing to Drive…", synced: "Synced to Drive", error: "Drive sync failed" };
    function renderStatus() {
      slot("status-view").textContent = mode === "raw" ? `Raw · ${lineCount || text.split("\n").length} lines` : `Rendered · ${loadState === "ok" ? `${txns.length} transactions` : "…"}`;
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
    })).map((t) => ({ ...t, maxAbs: txnMaxAbs(t) }));

    async function refreshData() {
      if (!isJournal()) return;
      const mine = ++token;
      loadState = "loading"; drawState();
      try { await host.engine.whenReady(); }
      catch (err) { if (mine === token) { loadState = "engine-error"; loadError = err.message; drawState(); } return; }
      const snapshot = text;
      const res = await host.engine.transactions(name(), snapshot, { forecast });
      if (mine !== token) return;
      if (!res.ok) { loadState = "parse-error"; loadError = res.error; txns = []; txnsText = null; drawState(); renderStatus(); return; }
      txns = decorate(res.data); txnsText = snapshot;
      summary = summarize(txns);
      loadState = "ok";
      drawState(); drawOverview(); drawList(); renderStatus();
    }
    const refreshSoon = debounce(refreshData, 60);

    /* ---------------------------------------------------------- state card */
    function drawState() {
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
            h("button", { class: "btn btn--primary", type: "button", onclick: () => { host.engine.retry().catch(() => {}); refreshData(); } }, "Retry"),
            h("button", { class: "btn", type: "button", onclick: () => setMode("raw") }, "Edit raw text")));
      } else {
        el.append(h("div", { class: "banner banner--error", role: "alert" }, h("strong", {}, "hledger couldn't read this journal."), h("pre", {}, loadError)),
          h("div", { class: "jv__state-actions" }, h("button", { class: "btn btn--primary", type: "button", onclick: () => setMode("raw") }, "Fix it in raw text")));
      }
    }

    /* ------------------------------------------------------------ overview */
    function delta(cur, prev) {
      if (!prev) return null;
      const pct = Math.round(((cur - prev) / Math.abs(prev)) * 100);
      return pct === 0 ? "Same as" : `${pct > 0 ? "▲" : "▼"} ${Math.abs(pct)}% vs`;
    }

    function drawOverview() {
      const s = summary;
      const empty = s.count === 0;
      slot("heading").textContent = empty ? "Nothing here yet" : monthLabel(s.last);
      const bits = empty ? ["Add a transaction to get started"]
        : [`${s.count} ${s.count === 1 ? "transaction" : "transactions"}`, `${s.accounts} accounts`, s.first === s.last ? fmtDate(s.first) : `${fmtDate(s.first)} – ${fmtDate(s.last)}`];
      if (s.otherCommodities) bits.push(`summary in ${s.style.commodity || "plain numbers"} only`);
      slot("subheading").textContent = bits.join(" · ");

      const stats = slot("stats"), top = slot("top");
      stats.replaceChildren(); top.replaceChildren(); top.hidden = true;
      stats.hidden = empty;
      if (empty) return;

      const prevLabel = monthLabel(s.before, { short: true }).split(" ")[0];
      const net = s.income - s.expenses;
      const rate = s.income > 0 ? Math.round((net / s.income) * 100) : null;
      const card = (label, value, note, neg = false) => h("div", { class: "jv-stat" },
        h("div", { class: "jv-stat__label" }, label),
        h("div", { class: `jv-stat__value${neg ? " is-neg" : ""}` }, value),
        h("div", { class: "jv-stat__note" }, note));
      const dNote = (cur, prev) => { const d = delta(cur, prev); return d ? `${d} ${prevLabel}` : "No earlier month to compare"; };
      stats.append(
        card("Net worth", money(s.netWorth, s.style), "Assets plus liabilities, all time", s.netWorth < 0),
        card(`Income · ${monthLabel(s.last, { short: true })}`, s.hasMonthData ? money(s.income, s.style) : "—", dNote(s.income, s.prevIncome)),
        card(`Spending · ${monthLabel(s.last, { short: true })}`, s.hasMonthData ? money(s.expenses, s.style) : "—", dNote(s.expenses, s.prevExpenses)),
        card("Saved this month", s.hasMonthData ? money(net, s.style) : "—", rate == null ? "No income recorded" : `${rate}% of income`, net < 0),
      );

      if (s.categories.length) {
        const max = s.categories[0].value, total = s.expenses || max;
        top.hidden = false;
        top.append(h("div", { class: "jv-top__title" }, `Where it went · ${monthLabel(s.last)}`),
          ...s.categories.map((c) => h("div", { class: "jv-top__row" },
            h("span", { class: "jv-top__name", title: c.name }, c.name.split(":").slice(1).join(":") || c.name),
            h("span", { class: "jv-top__bar", "aria-hidden": "true" }, h("span", { style: `width:${Math.max(2, (c.value / max) * 100)}%` })),
            h("span", { class: "jv-top__amount" }, `${money(c.value, s.style)} · ${Math.round((c.value / total) * 100)}%`))));
      }
    }

    /* ----------------------------------------------------------- the list */
    const filterActive = () => Object.values(filters).some((v) => v !== "" && v != null);
    function visible() {
      const q = query.trim().toLowerCase();
      const acc = (filters.account ?? "").toLowerCase(), desc = (filters.desc ?? "").toLowerCase();
      const min = filters.min !== "" && filters.min != null ? Number(filters.min) : null;
      const max = filters.max !== "" && filters.max != null ? Number(filters.max) : null;
      return txns.filter((t) => {
        if (q && !`${t.date} ${t.description} ${t.postings.map((p) => `${p.account} ${p.amount}`).join(" ")}`.toLowerCase().includes(q)) return false;
        if (acc && !t.postings.some((p) => p.account.toLowerCase().includes(acc))) return false;
        if (desc && !t.description.toLowerCase().includes(desc)) return false;
        if (filters.from && t.date < filters.from) return false;
        if (filters.to && t.date > filters.to) return false;
        if (min != null && t.maxAbs < min) return false;
        if (max != null && t.maxAbs > max) return false;
        return true;
      }).sort(SORTS[sort]);
    }

    function txnCard(t) {
      const total = txnHeadline(t);
      return h("article", { class: "jv-txn", dataset: { id: t.id } },
        h("div", { class: "jv-txn__top" },
          h("span", { class: "jv-txn__desc" }, t.description || "(no description)"),
          total && h("span", { class: "jv-txn__total" }, total)),
        h("div", { class: "jv-txn__postings" }, ...t.postings.flatMap((p) => [
          h("span", { class: "jv-txn__account" }, p.account),
          h("span", { class: `jv-txn__amount${isNegativeText(p.amount) ? " is-neg" : ""}` }, p.amount),
        ])),
        h("div", { class: "jv-txn__actions" },
          h("button", { class: "icon-btn", type: "button", "aria-label": `Edit ${t.description}`, title: "Edit", onclick: () => editTxn(t) }, icon("edit")),
          h("button", { class: "icon-btn icon-btn--danger", type: "button", "aria-label": `Delete ${t.description}`, title: "Delete", onclick: () => deleteTxn(t) }, icon("trash"))));
    }

    function drawChips() {
      const chips = slot("chips");
      const items = [];
      for (const [k, label] of Object.entries(FILTER_LABELS)) if (filters[k]) items.push([label, k === "from" || k === "to" ? fmtDate(filters[k]) : filters[k], () => { filters[k] = ""; syncForm(); drawList(); }]);
      if (query.trim()) items.push(["Search", query.trim(), () => { query = ""; $("[name=search]", bar).value = ""; drawList(); }]);
      if (sort !== "date-desc") items.push(["Sort", SORT_LABELS[sort], () => { sort = "date-desc"; syncForm(); drawList(); }]);
      chips.hidden = !items.length;
      chips.replaceChildren(...items.map(([label, value, remove]) => h("span", { class: "jv-chip" }, `${label}: ${value}`,
        h("button", { type: "button", "aria-label": `Remove ${label} filter`, onclick: remove }, icon("close")))),
        ...(items.length > 1 ? [h("button", { class: "jv__chips-clear", type: "button", onclick: clearAll }, "Clear all")] : []));
      const badge = $("[data-slot=filter-count]", bar);
      const n = Object.values(filters).filter(Boolean).length + (sort !== "date-desc" ? 1 : 0);
      badge.hidden = !n; badge.textContent = n;
    }

    function drawList() {
      if (loadState !== "ok") return;
      const rows = visible();
      const list = slot("list"), empty = slot("empty");
      list.replaceChildren(); empty.hidden = true;
      const filtered = filterActive() || query.trim();
      slot("list-meta").textContent = txns.length ? (filtered ? `Showing ${rows.length} of ${txns.length}` : `${txns.length} total`) : "";
      drawChips();
      if (!rows.length) {
        empty.hidden = false;
        empty.replaceChildren(h("p", {}, txns.length ? "No transactions match these filters." : "This journal has no transactions yet."),
          txns.length ? h("button", { class: "btn", type: "button", onclick: clearAll }, "Clear filters")
            : h("button", { class: "btn btn--primary", type: "button", onclick: () => addTxn() }, "Add the first transaction"));
        return;
      }
      const byDate = sort === "date-desc" || sort === "date-asc";
      let lastDate = null;
      for (const t of rows) {
        if (byDate && t.date !== lastDate) { list.append(h("h3", { class: "jv__date" }, fmtDateLong(t.date))); lastDate = t.date; }
        list.append(txnCard(t));
      }
    }

    /* --------------------------------------------------------- mutations */
    async function commit(newText) {
      text = newText;
      ta.value = text; drawGutter();
      if (!save()) return false;       // saves immediately: these are deliberate actions, not typing
      await refreshData();
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

    slot("content").addEventListener("click", (e) => { if (e.target.closest("[data-act=add-txn]")) addTxn(); });

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
    const runSearch = debounce(() => {
      query = searchInput.value;
      if (mode === "rendered") { drawList(); $("[data-slot=search-count]", bar).textContent = query.trim() ? `${visible().length} matching transactions` : ""; }
      else { countRaw(); $("[data-slot=search-count]", bar).textContent = query.trim() ? `${rawMatches} ${rawMatches === 1 ? "match" : "matches"}` : ""; }
    }, 120);
    searchInput.addEventListener("input", runSearch);
    searchInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      rememberSearch(searchInput.value.trim());
      if (mode === "raw") findNext(e.shiftKey ? -1 : 1);
      else menu.close({ restoreFocus: true });
    });

    function countRaw() {
      const q = query.trim().toLowerCase();
      rawMatches = q ? text.toLowerCase().split(q).length - 1 : 0;
    }
    function findNext(dir = 1) {
      const q = query.trim().toLowerCase();
      if (!q) return;
      const hay = text.toLowerCase();
      let i = dir > 0 ? hay.indexOf(q, ta.selectionEnd) : hay.lastIndexOf(q, Math.max(0, ta.selectionStart - 1));
      if (i < 0) i = dir > 0 ? hay.indexOf(q) : hay.lastIndexOf(q);
      if (i < 0) return;
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(i, i + q.length);
      const line = text.slice(0, i).split("\n").length - 1;
      ta.scrollTop = Math.max(0, line * parseFloat(getComputedStyle(ta).lineHeight) - ta.clientHeight / 2);
      drawGutter(); updatePos();
      searchInput.focus({ preventScroll: true });
    }

    const form = bar.querySelector("form.menubar__panel");
    const readForm = () => {
      const data = new FormData(form);
      filters = Object.fromEntries(Object.keys(FILTER_LABELS).map((k) => [k, String(data.get(k) ?? "").trim()]));
      sort = data.get("sort") ?? "date-desc";
    };
    function syncForm() {
      for (const k of Object.keys(FILTER_LABELS)) form.elements[k].value = filters[k] ?? "";
      form.elements.sort.value = sort;
    }
    function clearAll() {
      filters = {}; sort = "date-desc"; query = ""; searchInput.value = "";
      syncForm(); drawList();
      $("[data-slot=search-count]", bar).textContent = "";
    }
    form.addEventListener("submit", (e) => { e.preventDefault(); readForm(); drawList(); menu.close({ restoreFocus: true }); });
    form.addEventListener("change", () => { readForm(); drawList(); });
    form.querySelector("[data-act=clear-filters]").addEventListener("click", clearAll);

    /* ------------------------------------------------------------- reports */
    function runReport(type) {
      const q = $("[name=query]", bar).value.trim();
      menu.close();
      host.reports.run(type, { file: name(), text, query: q, forecast });
    }
    bar.addEventListener("click", (e) => {
      const rep = e.target.closest("[data-report]");
      if (rep) { runReport(rep.dataset.report); return; }
      if (e.target.closest("[data-file-action=download]")) { menu.close(); host.actions.export(name()); }
    });
    $("[name=forecast]", bar).addEventListener("change", (e) => { forecast = e.target.checked; if (mode === "rendered") refreshData(); });

    /* ------------------------------------------------------------ view mode */
    function setMode(next) {
      if (next === "rendered" && !isJournal()) next = "raw";
      mode = next;
      $("[data-pane=rendered]").hidden = mode !== "rendered";
      $("[data-pane=raw]").hidden = mode !== "raw";
      for (const r of bar.querySelectorAll("[name=view]")) r.checked = r.value === mode;
      $("[data-needs=rendered]", bar).disabled = mode !== "rendered" || !isJournal();
      $("[data-slot=search-help]", bar).textContent = mode === "raw" ? "Press Enter for the next match, Shift+Enter for the previous." : "Filters the transactions below as you type.";
      searchInput.dispatchEvent(new Event("input"));
      menu.close();
      if (mode === "rendered") { if (txnsText !== text || loadState !== "ok") refreshData(); drawList(); }
      else { ta.value = text; lineCount = 0; drawGutter(); updatePos(); }
      renderStatus();
    }
    for (const r of bar.querySelectorAll("[name=view]")) r.addEventListener("change", () => { if (r.checked) setMode(r.value); });
    const rendereredRadio = $("[name=view][value=rendered]", bar);
    if (!isJournal()) { rendereredRadio.disabled = true; $("[data-needs=journal]", bar).disabled = true; }

    /* --------------------------------------------------------------- wiring */
    const offs = [
      host.files.on("changed", (ev) => {
        if (ev.kind === "meta" || ev.name === name() || ev.kind === "reload") {
          const f = host.files.get(name());
          if (f && f.content !== savedText && !isDirty()) {      // changed elsewhere (sync, another tab): adopt it
            savedText = text = f.content; ta.value = text; lineCount = 0; drawGutter();
            if (mode === "rendered") refreshSoon();
          }
        }
        renderStatus();
      }),
      host.sync.on("changed", renderStatus),
      host.auth.on("changed", renderStatus),
      host.settings.on("lineNumbers", applyLineNumbers),
      host.settings.on("numberGrouping", () => { if (loadState === "ok") { drawOverview(); drawList(); } }),
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
    syncForm();
    setMode(mode);
    drawGutter();
    renderStatus();
    if (mode === "rendered") refreshData();

    return {
      onShow() { if (mode === "raw") { ta.focus({ preventScroll: true }); updatePos(); } },
      save,
      dispose() {
        if (host.settings.get("autoSave") && host.files.exists(name())) autosave.flush(); else autosave.cancel();
        offs.forEach((off) => off()); menu.dispose(); refreshSoon.cancel(); runSearch.cancel(); token++; },
    };
  },
};
