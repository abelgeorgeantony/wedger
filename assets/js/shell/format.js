/* format.js — dates, amounts and small text helpers. No DOM, no engine.
 *
 * The hledger engine already hands the UI formatted amount strings for
 * transactions ("-$45.00"). These helpers parse those strings back into
 * numbers (for summaries and filters), format hledger's structured amounts
 * for reports, and convert between a transaction's form fields and its text.
 */

const pad = (n) => String(n).padStart(2, "0");

/* ------------------------------------------------------------------ dates */
export const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export function fmtDate(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  if (!y || !m || !d) return String(iso);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

export function fmtDateLong(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

export function monthLabel(iso, { short = false } = {}) {
  const [y, m] = String(iso).split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: short ? "short" : "long", year: "numeric" });
}

/* ---------------------------------------------------------------- amounts */
const COMMODITY = String.raw`("[^"]+"|[^\d\s.,+\-()@;"]+)`;
const AMOUNT_RE = new RegExp(String.raw`^([-+])?\s*${COMMODITY}?\s*([-+])?\s*(\d[\d,]*(?:\.\d+)?|\.\d+)\s*${COMMODITY}?$`);

/**
 * "-$45.00" | "₹12,000.00" | "10 INFY" | "5 USD @ 83 INR"  ->
 * { value, commodity, side: "L"|"R", spaced, places }  (cost after "@" is ignored)
 */
export function parseAmountText(raw) {
  if (raw == null) return null;
  const s = String(raw).split(/\s@@?\s/)[0].trim().replace(/\s+/g, " ");
  if (!s) return null;
  const m = AMOUNT_RE.exec(s);
  if (!m) return null;
  const neg = m[1] === "-" || m[3] === "-";
  const numText = m[4];
  const value = parseFloat(numText.replace(/,/g, "")) * (neg ? -1 : 1);
  if (!Number.isFinite(value)) return null;
  const left = m[2], right = m[5];
  const commodity = (left || right || "").replace(/^"|"$/g, "");
  const dot = numText.indexOf(".");
  const places = dot < 0 ? 0 : numText.length - dot - 1;
  const spaced = left ? /^[-+]?\s*\S+\s+\S/.test(s) && /\s/.test(s.slice(s.indexOf(left) + left.length, s.indexOf(left) + left.length + 1)) : /\s/.test(s.slice(s.indexOf(numText) + numText.length, s.indexOf(numText) + numText.length + 1));
  return { value, commodity, side: left ? "L" : "R", spaced: !!spaced && !!commodity, places };
}

/** True for "-5", "-$5", "$-5", "₹ -5.00" ... (hledger puts the sign after the symbol: "$-250"). */
export const isNegativeText = (s) => /^[^\d.]*-/.test(String(s ?? ""));

/** Largest absolute amount in a transaction (engine strings), used for sorting and filtering. */
export function txnMaxAbs(txn) {
  let max = 0;
  for (const p of txn.postings ?? []) {
    const a = parseAmountText(p.amount);
    if (a) max = Math.max(max, Math.abs(a.value));
  }
  return max;
}

/** The posting amount string with the largest magnitude, as the engine printed it (sign dropped). */
export function txnHeadline(txn) {
  let best = null, bestAbs = -1;
  for (const p of txn.postings ?? []) {
    const a = parseAmountText(p.amount);
    if (a && Math.abs(a.value) > bestAbs) { best = p.amount; bestAbs = Math.abs(a.value); }
  }
  return best ? String(best).replace(/^-\s*/, "").replace(/^([^\d\s]*)-/, "$1") : "";
}

const INDIAN_COMMODITIES = new Set(["₹", "INR", "Rs", "Rs."]);

/** grouping: "auto" | "indian" | "international" | "none" */
function groupingLocale(commodity, grouping) {
  if (grouping === "none") return null;
  if (grouping === "indian") return "en-IN";
  if (grouping === "international") return "en-US";
  return INDIAN_COMMODITIES.has(commodity) ? "en-IN" : "en-US";
}

export function formatNumber(value, places, commodity = "", grouping = "auto") {
  const locale = groupingLocale(commodity, grouping);
  const opts = { minimumFractionDigits: places, maximumFractionDigits: places, useGrouping: !!locale };
  return Math.abs(value).toLocaleString(locale ?? "en-US", opts);
}

/** Formats a number in the style captured by parseAmountText / amountFromHledger. */
export function formatMoney(value, style = {}, grouping = "auto") {
  const { commodity = "", side = "L", spaced = false, places = 2 } = style;
  const num = formatNumber(value, places, commodity, grouping);
  const sign = value < 0 && Number(num.replace(/[^\d]/g, "")) !== 0 ? "-" : "";
  if (!commodity) return `${sign}${num}`;
  const gap = spaced ? " " : "";
  return side === "R" ? `${sign}${num}${gap}${commodity}` : `${sign}${commodity}${gap}${num}`;
}

/** hledger's JSON amount -> { value, commodity, side, spaced, places } (exact: built from the mantissa). */
export function amountFromHledger(a) {
  if (!a || typeof a !== "object") return null;
  const q = a.aquantity ?? {};
  const places = Number.isInteger(q.decimalPlaces) ? q.decimalPlaces : 0;
  let value;
  if (typeof q.decimalMantissa === "number") value = q.decimalMantissa / 10 ** places;
  else value = Number(q.floatingPoint ?? 0);
  const style = a.astyle ?? {};
  const asPrecision = typeof style.asprecision === "number" ? style.asprecision : (style.asprecision?.contents ?? null);
  return {
    value,
    // exact integer form (value = mantissa / 10^qplaces); lets sums stay exact instead of using floats
    mantissa: typeof q.decimalMantissa === "number" && Number.isSafeInteger(q.decimalMantissa) ? q.decimalMantissa : null,
    qplaces: places,
    commodity: a.acommodity ?? "",
    side: style.ascommodityside === "R" ? "R" : "L",
    spaced: !!style.ascommodityspaced,
    places: Math.max(places, Number.isInteger(asPrecision) ? asPrecision : 0),
  };
}

/* ----------------------------------------------- transaction <-> form text */
const TXN_HEAD = /^(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})(?:=\S+)?\s*(?:[*!]\s*)?(?:\(([^)]*)\)\s*)?(.*)$/;

/**
 * Reads ONE transaction's text into form fields. Used only by the
 * add/edit dialog to switch between its Form and Raw tabs; the engine is the
 * authority on what a valid transaction is.
 */
export function parseTxnText(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const first = lines.findIndex((l) => l.trim());
  if (first < 0) return null;
  const m = TXN_HEAD.exec(lines[first].trim());
  if (!m) return null;
  const date = m[1].replace(/[/.]/g, "-").split("-").map((p, i) => (i === 0 ? p : pad(p))).join("-");
  const postings = [];
  for (const line of lines.slice(first + 1)) {
    if (!/^\s+\S/.test(line) || /^\s*[;#]/.test(line)) continue;
    const body = line.replace(/\s;.*$/, "");
    const mm = /^\s+(\S.*?)(?:\s{2,}|\t+)(.+?)\s*$/.exec(body);
    postings.push(mm ? { account: mm[1].trim(), amountText: mm[2].trim() } : { account: body.trim(), amountText: "" });
  }
  return { date, description: m[3].split(/\s;/)[0].trim(), postings };
}

/** True when the text carries things the form can't show (comments, tags, status, code). */
export function needsRawEditing(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  if (lines.some((l) => /;/.test(l))) return true;
  return /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:=\S+)?\s+(?:[*!]|\()/.test(lines[0] ?? "");
}

/** A bare number gets `defaultCommodity` in front (if one is configured); anything else is kept as typed. */
export function normalizeAmountInput(raw, defaultCommodity = "") {
  const s = String(raw ?? "").trim();
  if (defaultCommodity && /^[-+]?[\d,]*\.?\d+$/.test(s)) {
    const neg = s.startsWith("-");
    return `${neg ? "-" : ""}${defaultCommodity}${s.replace(/^[-+]/, "")}`;
  }
  return s;
}

export function buildTransactionText({ date, description, postings }, defaultCommodity = "") {
  const rows = postings.map((p) => {
    const amt = normalizeAmountInput(p.amountText, defaultCommodity);
    return amt ? `    ${p.account.padEnd(32)}${amt}` : `    ${p.account}`;
  });
  return [`${date} ${description}`.trimEnd(), ...rows].join("\n");
}

