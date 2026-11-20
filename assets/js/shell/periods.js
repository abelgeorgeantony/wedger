/* periods.js — reporting periods for the journal overview. Pure: no DOM, no engine.
 *
 * Every period is built from the BROWSER'S LOCAL calendar date (never UTC, never
 * the date of the journal's latest transaction) and carries explicit bounds:
 *
 *   start         first day INCLUDED  ("YYYY-MM-DD"), or null for "from the beginning"
 *   lastDay       last day INCLUDED   (what people read: "to 17 Nov")
 *   endExclusive  the day AFTER lastDay (what hledger needs: `date:A..B` excludes B)
 *
 * hledger's `date:A..B` query includes A and excludes B, so lastDay + 1 is passed
 * as the end. The query string only ever carries dates; accumulation modes and sign
 * conventions of each statement are fixed inside the engine and cannot be overridden here.
 */

const pad = (n) => String(n).padStart(2, "0");
export const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SHORT = MONTHS.map((m) => m.slice(0, 3));

/** "2026-11-17" -> local Date at 00:00, or null when malformed / not a real calendar day. */
export function parseIso(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ""));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d ? date : null;
}

const addDays = (date, n) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);

export const PERIOD_KINDS = [
  { id: "current-month", label: "Current month" },
  { id: "previous-month", label: "Previous month" },
  { id: "last-30-days", label: "Last 30 days" },
  { id: "year-to-date", label: "Year to date" },
  { id: "all-time", label: "All time" },
  { id: "custom", label: "Custom period…" },
];

/** "1–17 November 2026" | "19 Oct – 17 Nov 2026" | "30 Dec 2025 – 17 Nov 2026" */
export function rangeLabel(startIso, lastIso) {
  const a = parseIso(startIso), b = parseIso(lastIso);
  if (!a || !b) return "";
  if (a.getTime() === b.getTime()) return `${b.getDate()} ${MONTHS[b.getMonth()]} ${b.getFullYear()}`;
  if (a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()) return `${a.getDate()}–${b.getDate()} ${MONTHS[b.getMonth()]} ${b.getFullYear()}`;
  if (a.getFullYear() === b.getFullYear()) return `${a.getDate()} ${SHORT[a.getMonth()]} – ${b.getDate()} ${SHORT[b.getMonth()]} ${b.getFullYear()}`;
  return `${a.getDate()} ${SHORT[a.getMonth()]} ${a.getFullYear()} – ${b.getDate()} ${SHORT[b.getMonth()]} ${b.getFullYear()}`;
}

export const dayLabel = (iso) => {
  const d = parseIso(iso);
  return d ? `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}` : String(iso);
};

/**
 * Resolves a period kind against `today` (a Date; defaults to now, local time).
 * Returns { kind, ok:true, start, lastDay, endExclusive, label, note, asOf } or { ok:false, error }.
 *   label  "1–17 November 2026 · Month to date"
 *   asOf   the date the Balance Sheet snapshot is taken: the period's last included day
 */
export function resolvePeriod(kind, { today = new Date(), custom = {} } = {}) {
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const y = t.getFullYear(), m = t.getMonth();
  let start, last, note;
  switch (kind) {
    case "current-month": start = new Date(y, m, 1); last = t; note = "Month to date"; break;
    case "previous-month": start = new Date(y, m - 1, 1); last = new Date(y, m, 0); note = "Previous month"; break;
    case "last-30-days": start = addDays(t, -29); last = t; note = "Last 30 days"; break;
    case "year-to-date": start = new Date(y, 0, 1); last = t; note = "Year to date"; break;
    case "all-time": start = null; last = t; note = "All time"; break;
    case "custom": {
      start = parseIso(custom.start); last = parseIso(custom.end); note = "Custom period";
      if (!start || !last) return { ok: false, kind, error: "Choose a start and an end date." };
      if (start > last) return { ok: false, kind, error: "The start date is after the end date." };
      break;
    }
    default: return { ok: false, kind, error: `Unknown period "${kind}".` };
  }
  const lastDay = isoOf(last), endExclusive = isoOf(addDays(last, 1)), startIso = start ? isoOf(start) : null;
  const range = start ? rangeLabel(startIso, lastDay) : `up to ${dayLabel(lastDay)}`;
  return { ok: true, kind, start: startIso, lastDay, endExclusive, label: `${range} · ${note}`, range, note, asOf: lastDay };
}

/** hledger date query for an income-statement style period: `date:A..B` or `date:..B`. */
export const periodQuery = (p) => `date:${p.start ?? ""}..${p.endExclusive}`;

/** hledger date query for a balance-sheet snapshot as of the period's last day: `date:..B`. */
export const snapshotQuery = (p) => `date:..${p.endExclusive}`;

/** Adds hledger's own depth limit (it rolls deeper accounts up and sums them): level 0 = all accounts. */
export const withDepth = (query, depth) => (depth > 0 ? `${query} depth:${depth}` : query);
