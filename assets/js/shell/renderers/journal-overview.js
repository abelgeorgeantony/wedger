/* renderers/journal-overview.js — the two statement previews at the top of a rendered journal.
 *
 *   Balance sheet     a SNAPSHOT as of a date          <- hledger `balancesheet`  (historical balances)
 *   Income statement  a PERIOD (default: this month)   <- hledger `incomestatement`
 *
 * Nothing here calculates money. The engine runs the reports; this file asks for them (with an explicit
 * date range built from the browser's local date), reads their documented structure through
 * report-model.js, formats the amounts hledger returned, and draws them. Amounts in different
 * commodities are always shown separately. If hledger returns nothing, the card says so instead of
 * showing zero; if the engine can't be trusted for a statement, it says that instead of showing numbers.
 *
 * Staleness: every load bumps `token`; invalidate() (called while the journal is being re-read) bumps it
 * too and wipes the cards, so an answer for an old journal text or an old period can never be drawn.
 */
import { h, icon } from "../core.js";
import { PERIOD_KINDS, resolvePeriod, periodQuery, snapshotQuery, withDepth, isoOf, dayLabel } from "../periods.js";
import { statementPreviewModel, accountTypesSummary, formatAmountLines, NO_STATEMENT_DATA } from "../report-model.js";
import { isNegativeText } from "../format.js";

const DETAILS = [
  { value: "1", label: "Top level" },
  { value: "2", label: "2 levels" },
  { value: "0", label: "All accounts" },
];
const ROW_LIMIT = 8;                       // rows shown per section before "Show all"

export function createOverview({ host, root }) {
  const slot = (n) => root.querySelector(`[data-slot="${n}"]`);
  const bar = slot("ov-bar"), cards = slot("ov-cards"), notes = slot("ov-notes");

  let periodKind = "current-month";
  let custom = { start: "", end: "" };
  let depth = 2;
  let ctx = null;                          // { file, text, forecast }
  let token = 0;
  let loadedOn = null;                     // local day the last load used (to notice midnight)
  let view = { phase: "idle" };            // idle | loading | invalid | ready
  const expanded = new Set();              // sections whose full row list is open ("bs:Assets")

  const grouping = () => host.settings.get("numberGrouping");

  /* ------------------------------------------------------------- toolbar */
  const periodSelect = h("select", { class: "input ov__select", name: "period", "aria-label": "Reporting period" },
    ...PERIOD_KINDS.map((k) => h("option", { value: k.id }, k.label)));
  const startInput = h("input", { class: "input", type: "date", name: "start", "aria-label": "Custom period start" });
  const endInput = h("input", { class: "input", type: "date", name: "end", "aria-label": "Custom period end (included)" });
  const applyBtn = h("button", { class: "btn btn--small", type: "button" }, "Apply");
  const customBox = h("span", { class: "ov__custom", hidden: true }, startInput, h("span", { class: "ov__to" }, "to"), endInput, applyBtn);
  const detailSelect = h("select", { class: "input ov__select", name: "detail", "aria-label": "Account detail" },
    ...DETAILS.map((d) => h("option", { value: d.value }, d.label)));
  detailSelect.value = String(depth);

  bar.replaceChildren(
    h("label", { class: "ov__ctl" }, h("span", { class: "ov__ctl-label" }, "Period"), periodSelect),
    customBox,
    h("label", { class: "ov__ctl ov__ctl--end" }, h("span", { class: "ov__ctl-label" }, "Detail"), detailSelect));

  periodSelect.addEventListener("change", () => {
    periodKind = periodSelect.value;
    customBox.hidden = periodKind !== "custom";
    if (periodKind === "custom") { startInput.focus(); return; }
    reload();
  });
  const applyCustom = () => { custom = { start: startInput.value, end: endInput.value }; reload(); };
  applyBtn.addEventListener("click", applyCustom);
  for (const input of [startInput, endInput]) input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); applyCustom(); } });
  detailSelect.addEventListener("change", () => { depth = Number(detailSelect.value); expanded.clear(); reload(); });

  /* --------------------------------------------------------------- loading */
  /** Wipes the cards right away (the journal is being re-read): no old figure is ever left on screen. */
  function invalidate() {
    token++;
    view = { phase: "loading" };
    paint();
  }

  function reload() { if (ctx) load(ctx); }

  async function load(next) {
    ctx = next;
    const mine = ++token;
    loadedOn = isoOf(new Date());
    const period = resolvePeriod(periodKind, { custom });
    if (!period.ok) { view = { phase: "invalid", error: period.error }; paint(); return; }
    view = { phase: "loading", period };
    paint();

    const { file, text, forecast } = next;
    const [bs, is, types] = await Promise.all([
      host.engine.report("balancesheet", text, { query: withDepth(snapshotQuery(period), depth), forecast }),
      host.engine.report("incomestatement", text, { query: withDepth(periodQuery(period), depth), forecast }),
      host.engine.report("accounttypes", text, { forecast }),
    ]);
    if (mine !== token) return;            // the journal, period or detail changed meanwhile: drop this answer
    view = { phase: "ready", period, forecast, file, text, bs, is, types: types?.ok ? accountTypesSummary(types) : null };
    paint();
  }

  /** A new local day started while the page stayed open: "current month" is no longer what's on screen. */
  function checkDayRollover() {
    if (ctx && loadedOn && isoOf(new Date()) !== loadedOn) reload();
  }
  const onVisible = () => { if (document.visibilityState === "visible") checkDayRollover(); };
  document.addEventListener("visibilitychange", onVisible);

  /* -------------------------------------------------------------- painting */
  function paint() {
    periodSelect.value = periodKind;
    customBox.hidden = periodKind !== "custom";
    if (periodKind === "custom") { startInput.value = custom.start; endInput.value = custom.end; }

    if (view.phase === "idle") { cards.replaceChildren(); notes.replaceChildren(); return; }
    if (view.phase === "invalid") {
      cards.replaceChildren(h("p", { class: "ov__msg", role: "alert" }, view.error));
      notes.replaceChildren();
      return;
    }
    const period = view.period;
    const loading = view.phase === "loading";
    const outdated = !loading && [view.bs, view.is].find((r) => r?.outdated);
    if (outdated) {
      // One notice instead of two identical ones: neither statement can be trusted, so neither is drawn.
      cards.replaceChildren(h("div", { class: "banner banner--warn ov__outdated", role: "status" },
        h("strong", {}, "Statements are unavailable: the accounting engine needs an update"), h("p", {}, outdated.error)));
      cards.setAttribute("aria-busy", "false");
      notes.replaceChildren();
      return;
    }
    cards.replaceChildren(
      card({ key: "bs", title: "Balance sheet", sub: period ? `As of ${dayLabel(period.asOf)}` : "", result: loading ? null : view.bs, netLabel: "Net assets", type: "balancesheet" }),
      card({ key: "is", title: "Income statement", sub: period?.label ?? "", result: loading ? null : view.is, netLabel: "Net", type: "incomestatement" }));
    cards.setAttribute("aria-busy", String(loading));
    notes.replaceChildren(...(loading ? [] : noteElements()));
  }

  function card({ key, title, sub, result, netLabel, type }) {
    const heading = `ov-${key}-title`;
    const open = h("button", { class: "btn btn--small btn--ghost ov__open", type: "button", disabled: !result?.ok, onclick: () => openFull(type) }, "Full report");
    const subs = [sub, view.forecast ? "Includes forecast transactions" : null].filter(Boolean);
    return h("article", { class: "stmt", "aria-labelledby": heading },
      h("header", { class: "stmt__head" },
        h("div", { class: "stmt__titles" },
          h("h2", { class: "stmt__title", id: heading }, title),
          h("p", { class: "stmt__sub" }, subs.join(" · "))),
        open),
      h("div", { class: "stmt__body" }, cardBody(key, result, netLabel)));
  }

  function cardBody(key, result, netLabel) {
    if (!result) return skeleton();
    if (!result.ok) {
      return h("div", { class: "banner banner--error", role: "alert" }, h("strong", {}, "hledger couldn't produce this statement."), h("pre", { class: "banner__pre" }, result.error ?? "Unknown error"),
        h("button", { class: "btn btn--small", type: "button", onclick: reload }, "Try again"));
    }
    const model = statementPreviewModel(result);
    if (model.status === "empty") return h("p", { class: "stmt__empty" }, NO_STATEMENT_DATA);
    const g = grouping();
    const out = model.sections.map((s) => section(`${key}:${s.title}`, s, g));
    // `net` is [] only when hledger reports a genuine zero for rows that exist; it is never filled in here.
    const netLines = model.net.length ? formatAmountLines(model.net, g) : ["0"];
    out.push(h("div", { class: "stmt__net" }, h("span", {}, netLabel), amountCell(netLines)));
    return h("div", {}, ...out);
  }

  function section(id, s, g) {
    const barable = s.title === "Expenses" && s.rows.length > 1 && s.rows.every((r) => r.amounts.length === 1 && r.amounts[0].value > 0)
      && new Set(s.rows.map((r) => r.amounts[0].commodity)).size === 1;
    const max = barable ? Math.max(...s.rows.map((r) => r.amounts[0].value)) : 0;
    const open = expanded.has(id);
    const shown = open ? s.rows : s.rows.slice(0, ROW_LIMIT);
    const rows = shown.map((r) => {
      const lines = r.amounts.length ? formatAmountLines(r.amounts, g) : ["0"];
      return h("li", { class: "stmt__row" },
        h("span", { class: "stmt__name", title: r.name }, r.name,
          barable && h("span", { class: "stmt__bar", "aria-hidden": "true" }, h("span", { style: `width:${Math.max(2, (r.amounts[0].value / max) * 100)}%` }))),
        amountCell(lines));
    });
    const more = s.rows.length > ROW_LIMIT && h("button", { class: "stmt__more", type: "button", "aria-expanded": String(open),
      onclick: () => { open ? expanded.delete(id) : expanded.add(id); paint(); } }, open ? "Show fewer" : `Show all ${s.rows.length} accounts`);
    const totalLines = s.total.length ? formatAmountLines(s.total, g) : ["0"];
    return h("section", { class: "stmt__sec" },
      h("h3", { class: "stmt__sec-title" }, s.title),
      h("ul", { class: "stmt__rows" }, ...rows),
      more,
      h("div", { class: "stmt__total" }, h("span", {}, `Total ${s.title.toLowerCase()}`), amountCell(totalLines)));
  }

  /** One line per commodity, right-aligned. Never joined, never summed. */
  function amountCell(lines) {
    return h("span", { class: "stmt__amt" }, ...lines.map((t) => h("span", { class: isNegativeText(t) ? "is-neg" : "" }, t)));
  }

  const skeleton = () => h("div", { class: "stmt__skeleton", role: "status", "aria-label": "Loading" },
    ...[62, 80, 48, 70].map((w) => h("span", { style: `width:${w}%` })));

  /* ----------------------------------------------------- diagnostics notes */
  function noteElements() {
    const t = view.types;
    if (!t || !t.untyped.length) return [];
    const n = t.untyped.length;
    const shown = t.untyped.slice(0, 12);
    return [h("details", { class: "ov__note" },
      h("summary", {}, icon("warning"), h("span", {}, `${n} ${n === 1 ? "account has" : "accounts have"} no account type, so hledger leaves ${n === 1 ? "it" : "them"} out of both statements`)),
      h("p", {}, shown.join(", "), n > shown.length ? ` and ${n - shown.length} more` : ""),
      h("p", { class: "ov__note-help" }, "Declare a type in the journal, for example ",
        h("code", {}, "account expenses:food  ; type: X"),
        " (A asset, L liability, E equity, R revenue, X expense, C cash). Put two spaces before the semicolon."))];
  }

  /* -------------------------------------------------------------- full report */
  function openFull(type) {
    if (view.phase !== "ready") return;
    const { period, file, text, forecast } = view;
    const query = type === "balancesheet" ? snapshotQuery(period) : periodQuery(period);   // full depth: the preview's grouping is not applied
    host.reports.run(type, { file, text, query, forecast });
  }

  return {
    load, invalidate, repaint: paint, reload,
    dispose() { token++; document.removeEventListener("visibilitychange", onVisible); },
  };
}
