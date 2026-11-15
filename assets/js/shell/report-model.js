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
const amountsOf = (list) => (Array.isArray(list) ? list.map(amountFromHledger).filter(Boolean) : []);

/** Sums amounts per commodity, keeping the first style seen for each. */
function sumAmounts(lists) {
  const byCommodity = new Map();
  for (const list of lists) {
    for (const a of list) {
      const cur = byCommodity.get(a.commodity);
      if (cur) { cur.value += a.value; cur.places = Math.max(cur.places, a.places); }
      else byCommodity.set(a.commodity, { ...a });
    }
  }
  return [...byCommodity.values()];
}

export function formatAmounts(list, grouping = "auto") {
  if (!list.length) return "";
  return list.map((a) => formatMoney(a.value, a, grouping)).join(", ");
}

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

function statementModel(result) {
  const payload = payloadOf(result);
  const subs = payload?.cbrSubreports;
  if (!Array.isArray(subs)) return { kind: "empty", message: "No data for this statement." };
  const sections = [];
  for (const sub of subs) {
    const title = typeof sub?.[0] === "string" ? sub[0] : "";
    const rows = sub?.[1]?.prRows;
    if (!Array.isArray(rows) || !rows.length) continue;
    const total = amountsOf(sub[1].prTotals?.prrTotal);
    sections.push({ title, nodes: buildTree(rows.map((r) => ({ name: r.prrName, amounts: amountsOf(r.prrTotal) }))), total: total.length ? total : null });
  }
  if (!sections.length) return { kind: "empty", message: "No data for this statement." };
  const net = amountsOf(payload.cbrTotals?.prrTotal);
  return { kind: "tree", sections, total: net.length ? net : null, totalLabel: "Net" };
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
  balancesheet: statementModel,
  incomestatement: statementModel,
  cashflow: statementModel,
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

/** Never throws: a report we can't interpret still shows as text. */
export function buildModel(type, result) {
  try {
    return (BUILDERS[type] ?? textModel)(result);
  } catch (err) {
    console.error(`Couldn't render the "${type}" report`, err);
    return textModel(result);
  }
}

/** The report exactly as the engine returned it (the "Raw" view). */
export function rawText(result) {
  const payload = payloadOf(result);
  return typeof payload === "string" ? payload : JSON.stringify(result, null, 2);
}

/** Plain-text/CSV exports of a model (copy & download). */
export function modelToCsv(model, grouping = "auto") {
  const esc = (v) => (/[",\n]/.test(v) ? `"${String(v).replaceAll('"', '""')}"` : String(v));
  if (model.kind === "table") return [model.columns, ...model.rows].map((r) => r.map(esc).join(",")).join("\n");
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
