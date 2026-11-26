/* time-report.js — on-demand reports for .timeclock and .timedot files. Pure: no DOM, no hledger, no host.
 *
 * Everything comes from Wedger's own parsers and summary functions (timeclock.js, timedot.js), so a time report can
 * never go through the accounting engine and is never mistaken for a financial one. A report is requested by the
 * person (Reports menu) and is NOT part of the rendered register.
 *
 *   runTimeReport(kind, text, options) -> { ok: true, native: { title, subtitle, columns, align, rows, footer, notes, csv, text } }
 *                                        | { ok: false, error }
 *
 * The result has the shape Reports output already knows how to draw (see report-model.js: nativeModel). `csv` is
 * machine-friendly (ISO dates, exact seconds, decimal hours, no totals row); `rows`/`footer` are for reading.
 *
 * Honesty rules, visible in every report:
 *   - Completed time and running time are never mixed. A running session has no recorded duration; the Running
 *     sessions report shows time so far, labelled as an estimate as of a stated moment.
 *   - Anything the file has but a report cannot use (unmatched clock-outs, unreadable amounts, problems) is counted in a note.
 */
import {
  Rat, sumRats, formatDuration, formatHours, shortClock, weekdayOf, addDaysIso, weekStartIso, daysInMonth, parseSimpleDate, isoFromParts,
} from "./time-format.js";
import { parseTimeclock, summarizeTimeclock, liveElapsed } from "./timeclock.js";
import { parseTimedot, summarizeTimedot, countable } from "./timedot.js";
import { STATUS_LABEL } from "./time-register.js";

/* ------------------------------------------------------------------ catalogue */
/** The reports of each format, in menu order. The Reports menus (timeclock-menu.html / timedot-menu.html) use these ids. */
export const TIME_REPORTS = {
  timeclock: [
    { id: "register", label: "Session register", group: "Listings", ranged: true },
    { id: "running", label: "Running sessions", group: "Listings", ranged: false },
    { id: "by-account", label: "Time by account", group: "Totals", ranged: true },
    { id: "by-project", label: "Time by project", group: "Totals", ranged: true },
    { id: "daily", label: "Daily report", group: "By period", ranged: true },
    { id: "weekly", label: "Weekly report", group: "By period", ranged: true },
    { id: "monthly", label: "Monthly report", group: "By period", ranged: true },
  ],
  timedot: [
    { id: "register", label: "Entry register", group: "Listings", ranged: true },
    { id: "by-account", label: "Time by account", group: "Totals", ranged: true },
    { id: "by-project", label: "Time by project", group: "Totals", ranged: true },
    { id: "by-type", label: "Type report", group: "Totals", ranged: true },
    { id: "daily", label: "Daily report", group: "By period", ranged: true },
    { id: "weekly", label: "Weekly report", group: "By period", ranged: true },
    { id: "monthly", label: "Monthly report", group: "By period", ranged: true },
  ],
};

export const reportInfo = (kind, id) => TIME_REPORTS[kind]?.find((r) => r.id === id) ?? null;

/* ---------------------------------------------------------------- date ranges */
export const RANGE_PRESETS = [
  ["all", "All time"], ["today", "Today"], ["week", "This week"], ["last-week", "Last week"],
  ["month", "This month"], ["last-month", "Last month"], ["year", "This year"],
];

/** { from, to } (ISO dates, inclusive; "" = open) for a preset, relative to `today`. */
export function presetRange(preset, today, weekStart = "monday") {
  const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
  const monthSpan = (yy, mm) => ({ from: isoFromParts(yy, mm, 1), to: isoFromParts(yy, mm, daysInMonth(yy, mm)) });
  switch (preset) {
    case "today": return { from: today, to: today };
    case "week": { const s = weekStartIso(today, weekStart); return { from: s, to: addDaysIso(s, 6) }; }
    case "last-week": { const s = addDaysIso(weekStartIso(today, weekStart), -7); return { from: s, to: addDaysIso(s, 6) }; }
    case "month": return monthSpan(y, m);
    case "last-month": return m === 1 ? monthSpan(y - 1, 12) : monthSpan(y, m - 1);
    case "year": return { from: isoFromParts(y, 1, 1), to: isoFromParts(y, 12, 31) };
    default: return { from: "", to: "" };
  }
}

/** "2026-11-01 to 2026-11-30", "from 2026-11-01", "up to 2026-11-30", "All dates". */
export function rangeLabel({ from = "", to = "" } = {}) {
  if (from && to) return from === to ? from : `${from} to ${to}`;
  if (from) return `from ${from}`;
  if (to) return `up to ${to}`;
  return "All dates";
}

/** An error message when the range can't be used, else null. */
export function validateRange({ from = "", to = "" } = {}) {
  for (const [label, v] of [["From", from], ["To", to]]) if (v && !parseSimpleDate(v)?.valid) return `${label}: enter a real date.`;
  if (from && to && from > to) return "The From date is after the To date.";
  return null;
}

/* -------------------------------------------------------------------- helpers */
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const weekdayShort = (iso) => WD[weekdayOf(iso)];
const esc = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const secondsText = (x) => (x instanceof Rat ? (x.isInteger ? String(x.n) : x.toFixed(3)) : String(x));
const hoursText = (x) => formatHours(x, 4);

/** A plain-text table: right-aligned numbers, a rule under the header and above the footer. */
export function plainTable(columns, align, rows, footer = null) {
  const all = [columns, ...rows, ...(footer ? [footer] : [])];
  const width = columns.map((_, i) => Math.max(...all.map((r) => Array.from(String(r[i] ?? "")).length)));
  const line = (r) => r.map((c, i) => {
    const s = String(c ?? ""), pad = " ".repeat(width[i] - Array.from(s).length);
    return align[i] === "right" ? pad + s : s + pad;
  }).join("  ").replace(/\s+$/, "");
  const rule = width.map((w) => "-".repeat(w)).join("  ");
  return [line(columns), rule, ...rows.map(line), ...(footer ? [rule, line(footer)] : [])].join("\n");
}

function result({ title, subtitle, columns, align, rows, footer = null, notes = [], csv, emptyMessage }) {
  const head = [title, subtitle].filter(Boolean).join("\n");
  const body = rows.length ? plainTable(columns, align, rows, footer) : (emptyMessage ?? "Nothing to report for this selection.");
  const text = [head, "", body, ...(notes.length ? ["", ...notes.map((n) => `Note: ${n}`)] : [])].join("\n");
  return { ok: true, native: { title, subtitle, columns, align, rows, footer, notes, csv, text, emptyMessage: emptyMessage ?? "Nothing to report for this selection." } };
}

const fileNotes = (model, what) => {
  const errors = model.counts.error;
  return errors ? [`This file has ${esc(errors, "error", "errors")}, so some ${what} may be missing from this report. Fix them in Raw view.`] : [];
};

/* ============================================================== timeclock */
const stampText = (st) => `${st.date} ${shortClock(st.secondsOfDay)}`;

function clockReport(model, id, o) {
  const range = { from: o.from, to: o.to };
  const subtitle = `${rangeLabel(range)}${o.account ? ` · account ${o.account}` : ""}`;
  const sum = summarizeTimeclock(model, { ...range, account: o.account }, { weekStart: o.weekStart });
  const desc = o.order === "desc";
  const chrono = (rows) => (desc ? [...rows].reverse() : rows);
  const notes = [];
  if (sum.runningCount) notes.push(`${esc(sum.runningCount, "running session isn't", "running sessions aren't")} counted: ${sum.runningCount === 1 ? "its" : "their"} time is only recorded once you clock out. See Running sessions.`);
  if (sum.problemCount) notes.push(`${esc(sum.problemCount, "session has a problem and isn't", "sessions have a problem and aren't")} counted.`);
  notes.push(...fileNotes(model, "sessions"));
  const total = sum.completedSeconds;

  if (id === "register") {
    const crossing = sum.sessions.filter((s) => s.status === "closed" && s.segments.some((g) => (range.from && g.date < range.from) || (range.to && g.date > range.to))).length;
    if (crossing) notes.push(`${esc(crossing, "session crosses", "sessions cross")} the edge of the date range. It is listed whole, but the total counts only the part inside the range.`);
    const rows = chrono([...sum.sessions].sort((a, b) => a.start.wall - b.start.wall || a.line - b.line));
    const closed = (s) => s.status === "closed";
    const endText = (s) => (s.end ? (s.end.date !== s.start.date ? `${s.end.date} ` : "") + shortClock(s.end.secondsOfDay) : "—");
    return result({
      title: "Session register", subtitle,
      columns: ["Date", "Account", "Description", "Start", "End", "Duration", "Hours", "Status"],
      align: ["left", "left", "left", "left", "left", "right", "right", "left"],
      rows: rows.map((s) => [s.start.date, s.account, s.description, shortClock(s.start.secondsOfDay), endText(s),
        closed(s) ? formatDuration(s.durationSeconds) : "—", closed(s) ? formatHours(s.durationSeconds) : "—",
        s.status === "closed" && s.problems.length ? "Completed (check)" : STATUS_LABEL[s.status]]),
      footer: ["Total", "", "", "", "", formatDuration(total), formatHours(total), `${sum.completedCount} completed`],
      notes,
      csv: {
        columns: ["Date", "Account", "Description", "Start", "End", "Seconds", "Hours", "Status"],
        rows: rows.map((s) => [s.start.date, s.account, s.description, stampText(s.start), s.end ? stampText(s.end) : "",
          closed(s) ? String(s.durationSeconds) : "", closed(s) ? hoursText(s.durationSeconds) : "", STATUS_LABEL[s.status]]),
      },
      emptyMessage: "No sessions in this range.",
    });
  }

  if (id === "running") {
    const now = o.now;
    const open = model.sessions.filter((s) => s.status === "open");
    const rows = chrono([...open].sort((a, b) => a.start.wall - b.start.wall || a.line - b.line));
    const asOf = `${now.date} ${shortClock(now.secondsOfDay)}`;
    return result({
      title: "Running sessions", subtitle: `Estimated as of ${asOf} · not a recorded duration`,
      columns: ["Account", "Description", "Since", "Elapsed so far (estimate)", "Status"],
      align: ["left", "left", "left", "right", "left"],
      rows: rows.map((s) => [s.account, s.description, stampText(s.start), formatDuration(liveElapsed(s, now)), "Running"]),
      notes: [`Time so far is calculated from the clock at ${asOf}. It is not a completed duration and isn't included in any total.`, ...fileNotes(model, "sessions")],
      csv: {
        columns: ["Account", "Description", "Since", "Elapsed seconds (estimate)", "Estimated at"],
        rows: rows.map((s) => [s.account, s.description, stampText(s.start), String(liveElapsed(s, now)), asOf]),
      },
      emptyMessage: "Nothing is running.",
    });
  }

  const grouped = (title, label, rowsIn) => result({
    title, subtitle, notes,
    columns: [label, "Sessions", "Duration", "Hours"], align: ["left", "right", "right", "right"],
    rows: rowsIn.map((r) => [r.key, String(r.sessions), formatDuration(r.seconds), formatHours(r.seconds)]),
    footer: ["Total completed", String(sum.completedCount), formatDuration(total), formatHours(total)],
    csv: { columns: [label, "Sessions", "Seconds", "Hours"], rows: rowsIn.map((r) => [r.key, String(r.sessions), String(r.seconds), hoursText(r.seconds)]) },
    emptyMessage: "No completed sessions in this range.",
  });

  if (id === "by-account") return grouped("Time by account", "Account", sum.byAccount);
  if (id === "by-project") return grouped("Time by project", "Project", sum.byProject);

  const period = {
    daily: { title: "Daily report", label: "Date", rows: chrono(sum.byDay), lead: (k) => [weekdayShort(k)], leadCols: ["Day"], leadAlign: ["left"], text: (k) => k },
    weekly: { title: "Weekly report", label: "Week starting", rows: chrono(sum.byWeek), lead: (k) => [addDaysIso(k, 6)], leadCols: ["Week ending"], leadAlign: ["left"], text: (k) => k },
    monthly: { title: "Monthly report", label: "Month", rows: chrono(sum.byMonth), lead: () => [], leadCols: [], leadAlign: [], text: (k) => k },
  }[id];
  const extra = id === "daily" ? ["A session that crosses midnight is split: each day gets its own part, so “Sessions” counts the sessions with time on that day."]
    : id === "weekly" ? [`Weeks start on ${o.weekStart === "sunday" ? "Sunday" : "Monday"} (a Settings choice). A session is counted in the week of each day it covers.`] : [];
  const cols = [period.label, ...period.leadCols, "Sessions", "Duration", "Hours"];
  return result({
    title: period.title, subtitle, notes: [...extra, ...notes],
    columns: cols, align: ["left", ...period.leadAlign, "right", "right", "right"],
    rows: period.rows.map((r) => [period.text(r.key), ...period.lead(r.key), String(r.sessions), formatDuration(r.seconds), formatHours(r.seconds)]),
    footer: ["Total completed", ...period.leadCols.map(() => ""), String(sum.completedCount), formatDuration(total), formatHours(total)],
    csv: { columns: [period.label, ...period.leadCols, "Sessions", "Seconds", "Hours"], rows: period.rows.map((r) => [period.text(r.key), ...period.lead(r.key), String(r.sessions), String(r.seconds), hoursText(r.seconds)]) },
    emptyMessage: "No completed sessions in this range.",
  });
}

/* =============================================================== timedot */
function dotReport(model, id, o) {
  const range = { from: o.from, to: o.to };
  const subtitle = `${rangeLabel(range)}${o.account ? ` · account ${o.account}` : ""}`;
  const sum = summarizeTimedot(model, { ...range, account: o.account }, { weekStart: o.weekStart });
  const desc = o.order === "desc";
  const chrono = (rows) => (desc ? [...rows].reverse() : rows);
  const total = sum.totalSeconds;
  const notes = [];
  if (sum.excluded) notes.push(`${esc(sum.excluded, "entry couldn't", "entries couldn't")} be read (an unreadable amount or an invalid date) and ${sum.excluded === 1 ? "is" : "are"} left out. Fix ${sum.excluded === 1 ? "it" : "them"} in Raw view.`);
  notes.push(...fileNotes(model, "entries"));

  if (id === "register") {
    const dayOf = new Map(model.days.map((d) => [d.id, d]));
    const inRange = (d) => (!range.from || d.date >= range.from) && (!range.to || d.date <= range.to);
    const list = countable(model).filter((p) => inRange(dayOf.get(p.dayId)) && (!o.account || p.account === o.account || p.account.startsWith(`${o.account}:`)));
    const rows = chrono([...list].sort((a, b) => dayOf.get(a.dayId).date.localeCompare(dayOf.get(b.dayId).date) || a.line - b.line));
    const typesText = (p) => p.types.map((t) => `${t.type} ${formatDuration(t.seconds)}`).join(", ");
    return result({
      title: "Entry register", subtitle, notes,
      columns: ["Date", "Account", "Written as", "Duration", "Hours", "Types", "Comment"],
      align: ["left", "left", "left", "right", "right", "left", "left"],
      rows: rows.map((p) => [dayOf.get(p.dayId).date, p.account, p.raw || "(no amount)", formatDuration(p.seconds), formatHours(p.seconds), typesText(p), p.comment.split("\n")[0]]),
      footer: ["Total", esc(rows.length, "entry", "entries"), "", formatDuration(sumRats(rows.map((p) => p.seconds))), formatHours(sumRats(rows.map((p) => p.seconds))), "", ""],
      csv: {
        columns: ["Date", "Account", "Written as", "Seconds", "Hours", "Types", "Comment"],
        rows: rows.map((p) => [dayOf.get(p.dayId).date, p.account, p.raw, secondsText(p.seconds), hoursText(p.seconds), p.types.map((t) => `${t.type}:${secondsText(t.seconds)}`).join(" "), p.comment.split("\n")[0]]),
      },
      emptyMessage: "No entries in this range.",
    });
  }

  const table = ({ title, label, rowsIn, text, lead = () => [], leadCols = [], leadAlign = [], extra = [] }) => result({
    title, subtitle, notes: [...extra, ...notes],
    columns: [label, ...leadCols, "Entries", "Duration", "Hours"], align: ["left", ...leadAlign, "right", "right", "right"],
    rows: rowsIn.map((r) => [text(r.key), ...lead(r.key), String(r.count), formatDuration(r.seconds), formatHours(r.seconds)]),
    footer: ["Total", ...leadCols.map(() => ""), String(sum.postingCount), formatDuration(total), formatHours(total)],
    csv: { columns: [label, ...leadCols, "Entries", "Seconds", "Hours"], rows: rowsIn.map((r) => [text(r.key), ...lead(r.key), String(r.count), secondsText(r.seconds), hoursText(r.seconds)]) },
    emptyMessage: "No entries in this range.",
  });

  if (id === "by-account") return table({ title: "Time by account", label: "Account", rowsIn: sum.byAccount, text: (k) => k });
  if (id === "by-project") return table({ title: "Time by project", label: "Project", rowsIn: sum.byProject, text: (k) => k });
  if (id === "daily") return table({ title: "Daily report", label: "Date", rowsIn: chrono(sum.byDay), text: (k) => k, lead: (k) => [weekdayShort(k)], leadCols: ["Day"], leadAlign: ["left"] });
  if (id === "weekly") return table({
    title: "Weekly report", label: "Week starting", rowsIn: chrono(sum.byWeek), text: (k) => k, lead: (k) => [addDaysIso(k, 6)], leadCols: ["Week ending"], leadAlign: ["left"],
    extra: [`Weeks start on ${o.weekStart === "sunday" ? "Sunday" : "Monday"} (a Settings choice).`],
  });
  if (id === "monthly") return table({ title: "Monthly report", label: "Month", rowsIn: chrono(sum.byMonth), text: (k) => k });

  // Type report: letter entries only. Each letter is 15 minutes and its own type (the `t:` tag in hledger).
  const dayOf = new Map(model.days.map((d) => [d.id, d]));
  const untyped = countable(model).filter((p) => p.kind !== "letters"
    && (!range.from || dayOf.get(p.dayId).date >= range.from) && (!range.to || dayOf.get(p.dayId).date <= range.to)
    && (!o.account || p.account === o.account || p.account.startsWith(`${o.account}:`)));
  const untypedSeconds = sumRats(untyped.map((p) => p.seconds));
  const typedTotal = sumRats(sum.byType.map((t) => t.seconds));
  const typeNotes = ["Only entries written as letters have a type. Each letter is 15 minutes and sets the t: tag, so ccec is c 45m and e 15m."];
  if (untyped.length) typeNotes.push(`${esc(untyped.length, "entry has", "entries have")} no type (written as dots or a number) and ${untyped.length === 1 ? "isn't" : "aren't"} listed: ${formatDuration(untypedSeconds)} in all.`);
  return result({
    title: "Type report", subtitle, notes: [...typeNotes, ...notes],
    columns: ["Type (t: tag)", "Entries", "Duration", "Hours"], align: ["left", "right", "right", "right"],
    rows: sum.byType.map((t) => [`t:${t.key}`, String(t.count), formatDuration(t.seconds), formatHours(t.seconds)]),
    footer: ["Total typed", "", formatDuration(typedTotal), formatHours(typedTotal)],
    csv: { columns: ["Type", "Entries", "Seconds", "Hours"], rows: sum.byType.map((t) => [t.key, String(t.count), secondsText(t.seconds), hoursText(t.seconds)]) },
    emptyMessage: "No letter entries in this range. Write time as letters (like ccec) to total it by type.",
  });
}

/* ============================================================ entry point */
/**
 * @param kind     "timeclock" | "timedot"
 * @param text     the file's text (the report parses it itself)
 * @param options  { type, from, to, account, weekStart, order: "asc"|"desc", now: localNow() }
 */
export function runTimeReport(kind, text, options = {}) {
  const info = reportInfo(kind, options.type);
  if (!info) return { ok: false, error: `“${options.type}” isn't a ${kind} report.` };
  const o = { from: "", to: "", account: "", weekStart: "monday", order: "asc", ...options };
  if (info.ranged) { const bad = validateRange(o); if (bad) return { ok: false, error: bad }; } else { o.from = ""; o.to = ""; }
  if (/[\r\n]/.test(String(o.account))) return { ok: false, error: "The account must be on one line." };
  o.account = String(o.account ?? "").trim();
  try {
    if (kind === "timeclock") return clockReport(parseTimeclock(text), options.type, o);
    return dotReport(parseTimedot(text), options.type, o);
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/** Machine-readable CSV text of a native report result (no totals row). */
export function reportCsv(native) {
  const q = (v) => (/[",\n\r]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v));
  const csv = native.csv ?? { columns: native.columns, rows: native.rows };
  return [csv.columns, ...csv.rows].map((r) => r.map(q).join(",")).join("\n");
}
