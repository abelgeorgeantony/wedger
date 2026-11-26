/* report-model.js — turns raw hledger report JSON into a small display model.
 *
 * Model kinds:
 *   { kind: "tree",  sections: [{ title, nodes, total }] , total }
 *   { kind: "table", columns: [string], align: ["left"|"right"], rows: [[string]] }
 *   { kind: "text",  text }
 *   { kind: "empty", message }
 *
 * Amounts are formatted from hledger's exact mantissa (not floating point).
 * Pure data in, pure data out: the DOM lives in report-view.js.
 */
import { amountFromHledger, formatMoney } from "./format.js";

const payloadOf = (result) => (result && typeof result === "object" && "data" in result ? result.data : result);

/* --------------------------------------------------------------- amounts */
/** hledger amount list -> [{value, commodity, side, spaced, places}] */
export const amountsOf = (list) => (Array.isArray(list) ? list.map(amountFromHledger).filter(Boolean) : []);

/**
 * Sums amounts per commodity (never across commodities), keeping the first style seen for each.
 * Exact: uses hledger's integer mantissas (BigInt), so there is no floating-point drift. This only
 * gives a PARENT account in a tree the total of its listed children; statement totals and the Net
 * line always come from hledger itself.
 */
function sumAmounts(lists) {
  const acc = new Map();
  for (const list of lists) {
    for (const a of list) {
      let cur = acc.get(a.commodity);
      if (!cur) { cur = { style: a, big: 0n, places: a.qplaces ?? 0, exact: true, approx: 0 }; acc.set(a.commodity, cur); }
      cur.approx += a.value;
      if (a.mantissa == null) { cur.exact = false; continue; }
      if (a.qplaces > cur.places) { cur.big *= 10n ** BigInt(a.qplaces - cur.places); cur.places = a.qplaces; }
      cur.big += BigInt(a.mantissa) * 10n ** BigInt(cur.places - a.qplaces);
    }
  }
  return [...acc.values()].map((c) => ({ ...c.style, value: c.exact ? Number(c.big) / 10 ** c.places : c.approx, places: Math.max(c.style.places, c.places), mantissa: null }));
}

export function formatAmounts(list, grouping = "auto") {
  if (!list.length) return "";
  return list.map((a) => formatMoney(a.value, a, grouping)).join(", ");
}

/** One formatted string per commodity (so a multi-commodity amount can be stacked, never merged). */
export const formatAmountLines = (list, grouping = "auto") => list.map((a) => formatMoney(a.value, a, grouping));

/* ----------------------------------------------------------------- trees */
/**
 * rows: [{ name: "assets:bank", amounts: [Amount] }] -> nested nodes.
 * A parent the engine didn't list gets the sum of its children.
 */
export function buildTree(rows) {
  const roots = [];
  const index = new Map();
  for (const row of rows) {
    const parts = String(row.name ?? "").split(":").filter(Boolean);
    if (!parts.length) continue;
    let level = roots, path = "";
    parts.forEach((part, i) => {
      path = path ? `${path}:${part}` : part;
      let node = index.get(path);
      if (!node) {
        node = { name: part, full: path, amounts: null, children: [] };
        index.set(path, node);
        level.push(node);
      }
      if (i === parts.length - 1) node.amounts = row.amounts;
      level = node.children;
    });
  }
  const fill = (node) => {
    node.children.forEach(fill);
    if (node.amounts == null) node.amounts = sumAmounts(node.children.map((c) => c.amounts));
  };
  roots.forEach(fill);
  return roots;
}

export function treeToRows(nodes, depth = 0, out = []) {
  for (const n of nodes) { out.push({ depth, name: n.name, full: n.full, amounts: n.amounts, leaf: !n.children.length }); treeToRows(n.children, depth + 1, out); }
  return out;
}

/* ---------------------------------------------------------- report shapes */
function balanceModel(result) {
  const payload = payloadOf(result);
  if (!Array.isArray(payload) || !Array.isArray(payload[0])) return { kind: "empty", message: "No balances to show." };
  const rows = payload[0].map((r) => ({ name: r[0], amounts: amountsOf(r[3]) }));
  if (!rows.length) return { kind: "empty", message: "No balances to show." };
  const totals = amountsOf(payload[1]);
  return { kind: "tree", sections: [{ title: "", nodes: buildTree(rows), total: totals.length ? totals : null }] };
}

export const NO_STATEMENT_DATA = "No data returned by hledger for this statement. Check the reporting period and account type declarations.";

function statementModel(result, { totalLabel = "Net" } = {}) {
  const payload = payloadOf(result);
  const subs = payload?.cbrSubreports;
  if (!Array.isArray(subs)) return { kind: "empty", message: NO_STATEMENT_DATA };
  const sections = [];
  for (const sub of subs) {
    const title = typeof sub?.[0] === "string" ? sub[0] : "";
    const rows = sub?.[1]?.prRows;
    if (!Array.isArray(rows) || !rows.length) continue;
    const total = amountsOf(sub[1].prTotals?.prrTotal);
    sections.push({ title, nodes: buildTree(rows.map((r) => ({ name: r.prrName, amounts: amountsOf(r.prrTotal) }))), total: total.length ? total : null });
  }
  if (!sections.length) return { kind: "empty", message: NO_STATEMENT_DATA };
  const net = amountsOf(payload.cbrTotals?.prrTotal);
  return { kind: "tree", sections, total: net.length ? net : null, totalLabel };
}

/**
 * Compact, flat model for the journal overview cards. Rows and totals are exactly what hledger returned
 * (no parent synthesis, no sums of our own). Statuses:
 *   "empty"  hledger returned no rows at all -> never presented as zero
 *   "ok"     at least one section has rows
 * A section's / the net's `amounts` is [] only when hledger reports a genuine zero for rows that exist.
 */
export function statementPreviewModel(result) {
  const payload = payloadOf(result);
  const subs = payload?.cbrSubreports;
  if (!Array.isArray(subs)) return { status: "empty", sections: [], net: null };
  const sections = [];
  for (const sub of subs) {
    const title = typeof sub?.[0] === "string" ? sub[0] : "";
    const rows = sub?.[1]?.prRows;
    if (!Array.isArray(rows) || !rows.length) continue;
    sections.push({
      title,
      rows: sortComparable(rows.map((r) => ({ name: String(r.prrName ?? ""), amounts: amountsOf(r.prrTotal) }))),
      total: amountsOf(sub[1].prTotals?.prrTotal),
    });
  }
  if (!sections.length) return { status: "empty", sections: [], net: null };
  return { status: "ok", sections, net: amountsOf(payload.cbrTotals?.prrTotal) };
}

/** Display order only: biggest first, but ONLY when every row is a single amount in one shared commodity. */
function sortComparable(rows) {
  const commodities = new Set();
  for (const r of rows) {
    if (r.amounts.length !== 1) return rows;
    commodities.add(r.amounts[0].commodity);
  }
  if (commodities.size !== 1) return rows;
  return [...rows].sort((a, b) => Math.abs(b.amounts[0].value) - Math.abs(a.amounts[0].value) || a.name.localeCompare(b.name));
}

/** Result of the engine's "accounttypes" diagnostic -> { total, untyped: [name] } (null when unavailable). */
export function accountTypesSummary(result) {
  const payload = payloadOf(result);
  if (!Array.isArray(payload)) return null;
  const untyped = payload.filter((r) => r && r.type == null).map((r) => String(r.account));
  return { total: payload.length, untyped };
}

function registerModel(result) {
  const payload = payloadOf(result);
  if (!Array.isArray(payload) || !payload.length) return { kind: "empty", message: "No postings to show." };
  let lastDate = "", lastDesc = "";
  const rows = payload.map((row) => {
    if (row[0] != null) lastDate = row[0];
    if (row[2] != null) lastDesc = row[2];
    const p = row[3] ?? {};
    return [lastDate, lastDesc, p.paccount ?? "", formatAmounts(amountsOf(p.pamount)), formatAmounts(amountsOf(row[4]))];
  });
  return { kind: "table", columns: ["Date", "Description", "Account", "Amount", "Balance"], align: ["left", "left", "left", "right", "right"], rows };
}

function periodicModel(result) {
  const payload = payloadOf(result);
  if (!payload?.prRows?.length) return { kind: "empty", message: "No data for this report." };
  const columns = ["Account"];
  for (const pair of payload.prDates ?? []) {
    const start = pair?.[0]?.contents ?? "", end = pair?.[1]?.contents ?? start;
    columns.push(start === end ? String(start) : `${start} to ${end}`);
  }
  columns.push("Total");
  const rows = payload.prRows.map((r) => [
    r.prrName ?? "",
    ...(Array.isArray(r.prrAmounts) ? r.prrAmounts.map((l) => formatAmounts(amountsOf(l))) : []),
    formatAmounts(amountsOf(r.prrTotal)),
  ]);
  return { kind: "table", columns, align: columns.map((_, i) => (i === 0 ? "left" : "right")), rows };
}

const isAmount = (v) => v && typeof v === "object" && "acommodity" in v && "aquantity" in v;

function cellText(v) {
  if (v == null) return "";
  if (isAmount(v)) return formatAmounts(amountsOf([v]));
  if (Array.isArray(v)) return v.every(isAmount) ? formatAmounts(amountsOf(v)) : v.map(cellText).join(", ");
  if (typeof v === "object") return v.contents != null ? cellText(v.contents) : JSON.stringify(v);
  return String(v);
}

function listModel(result, columnTitle) {
  const payload = payloadOf(result);
  if (typeof payload === "string") return { kind: "text", text: payload };
  if (!Array.isArray(payload) || !payload.length) return { kind: "empty", message: `No ${columnTitle.toLowerCase()} found.` };
  if (payload.every((x) => typeof x !== "object" || x === null)) {
    return { kind: "table", columns: [columnTitle], align: ["left"], rows: payload.map((x) => [String(x)]) };
  }
  const columns = [...new Set(payload.flatMap((o) => (o && typeof o === "object" && !Array.isArray(o) ? Object.keys(o) : [])))];
  if (!columns.length) return { kind: "text", text: JSON.stringify(payload, null, 2) };
  return { kind: "table", columns, align: columns.map(() => "left"), rows: payload.map((o) => columns.map((c) => cellText(o?.[c]))) };
}

function textModel(result) {
  const payload = payloadOf(result);
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return text?.trim() ? { kind: "text", text } : { kind: "empty", message: "Nothing to report. All good." };
}

const BUILDERS = {
  balance: balanceModel,
  register: registerModel,
  balancesheet: (r) => statementModel(r, { totalLabel: "Net assets" }),
  incomestatement: (r) => statementModel(r, { totalLabel: "Net" }),
  cashflow: (r) => statementModel(r, { totalLabel: "Net" }),
  budget: periodicModel,
  accounts: (r) => listModel(r, "Account"),
  payees: (r) => listModel(r, "Payee"),
  commodities: (r) => listModel(r, "Commodity"),
  tags: (r) => listModel(r, "Tag"),
  prices: (r) => listModel(r, "Price"),
  print: textModel,
  printtext: textModel,
  check: textModel,
  checkstrict: textModel,
};

/**
 * A report Wedger computed itself (time-report.js): already a table with an optional totals row and notes. `csv` is the
 * machine-friendly export (ISO dates, exact seconds); it replaces the table's own cells in CSV downloads.
 */
function nativeModel(native) {
  const base = { notes: native.notes ?? [], csv: native.csv ?? null };
  if (!native.rows.length) return { kind: "empty", message: native.emptyMessage ?? "Nothing to report.", ...base };
  return { kind: "table", columns: native.columns, align: native.align, rows: native.rows, footer: native.footer ?? null, ...base };
}

/** Never throws: a report we can't interpret still shows as text. */
export function buildModel(type, result) {
  try {
    if (result && typeof result === "object" && result.native) return nativeModel(result.native);
    return (BUILDERS[type] ?? textModel)(result);
  } catch (err) {
    console.error(`Couldn't render the "${type}" report`, err);
    return textModel(result);
  }
}

/** The report exactly as the engine returned it (the "Raw" view). */
export function rawText(result) {
  if (result && typeof result === "object" && result.native) return result.native.text;
  const payload = payloadOf(result);
  return typeof payload === "string" ? payload : JSON.stringify(result, null, 2);
}

/** Plain-text/CSV exports of a model (copy & download). */
export function modelToCsv(model, grouping = "auto") {
  const esc = (v) => (/[",\n]/.test(v) ? `"${String(v).replaceAll('"', '""')}"` : String(v));
  if (model.kind === "table") {
    const sheet = model.csv ?? { columns: model.columns, rows: model.rows };            // native reports bring a machine-friendly sheet
    return [sheet.columns, ...sheet.rows].map((r) => r.map(esc).join(",")).join("\n");
  }
  if (model.kind === "tree") {
    const rows = [["Account", "Amount"]];
    for (const s of model.sections) {
      if (s.title) rows.push([s.title, ""]);
      for (const r of treeToRows(s.nodes)) rows.push([r.full, formatAmounts(r.amounts, grouping)]);
      if (s.total) rows.push(["Total", formatAmounts(s.total, grouping)]);
    }
    return rows.map((r) => r.map(esc).join(",")).join("\n");
  }
  return null;
}

