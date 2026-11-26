/* time-format.js — shared, pure helpers for the .timeclock and .timedot formats.
 *
 * No DOM, no storage, no engine. Both native parsers (timeclock.js, timedot.js), the importer,
 * the editor highlighting and the rendered views build on this file.
 *
 *   exact arithmetic   Rat (BigInt rational) — timedot quantities are decimals × units, never floats
 *   dates / times      simple dates, HH:MM[:SS], wall-clock seconds, week and month keys, "now" in LOCAL time
 *   text               line splitting that remembers offsets and line endings, atomic non-overlapping edits
 *   diagnostics        { severity, code, message, line, range }
 *   formatting         "1h 30m", "1.50", "Mon, 23 Nov 2026" — nothing to do with money or the currency setting
 */

/* ------------------------------------------------------------------ file kinds */
const KIND_RE = /\.(timeclock|timedot)$/i;

/** "timeclock" | "timedot" | null, from a file name. */
export function timeKindOf(name) {
  const m = KIND_RE.exec(String(name ?? ""));
  return m ? m[1].toLowerCase() : null;
}
/** The standalone time formats are handled natively by Wedger and must never reach the hledger engine. */
export const isNativeTimeFile = (name) => timeKindOf(name) !== null;

/* ------------------------------------------------------------ exact arithmetic */
const abs = (a) => (a < 0n ? -a : a);
function gcd(a, b) {
  a = abs(a); b = abs(b);
  while (b) [a, b] = [b, a % b];
  return a;
}

/** An exact rational number over BigInt. Immutable. Used for timedot quantities, expressed in seconds. */
export class Rat {
  constructor(n, d = 1n) {
    if (d === 0n) throw new RangeError("Rat: zero denominator");
    if (d < 0n) { n = -n; d = -d; }
    const g = gcd(n, d) || 1n;
    this.n = n / g;
    this.d = d / g;
  }
  static of(x) {
    if (x instanceof Rat) return x;
    if (typeof x === "bigint") return new Rat(x, 1n);
    if (Number.isInteger(x)) return new Rat(BigInt(x), 1n);
    throw new TypeError(`Rat.of: expected an integer, got ${x}`);
  }
  /** "12", "1.5", ".5" -> Rat. Anything else (signs, exponents, separators) -> null. */
  static parseDecimal(str) {
    const m = /^(\d*)(?:\.(\d+))?$/.exec(str);
    if (!m || (!m[1] && !m[2])) return null;
    const frac = m[2] ?? "";
    return new Rat(BigInt((m[1] || "0") + frac), 10n ** BigInt(frac.length));
  }
  add(o) { o = Rat.of(o); return new Rat(this.n * o.d + o.n * this.d, this.d * o.d); }
  sub(o) { o = Rat.of(o); return new Rat(this.n * o.d - o.n * this.d, this.d * o.d); }
  mul(o) { o = Rat.of(o); return new Rat(this.n * o.n, this.d * o.d); }
  div(o) { o = Rat.of(o); return new Rat(this.n * o.d, this.d * o.n); }
  cmp(o) { o = Rat.of(o); const a = this.n * o.d, b = o.n * this.d; return a < b ? -1 : a > b ? 1 : 0; }
  equals(o) { return this.cmp(o) === 0; }
  isZero() { return this.n === 0n; }
  get isInteger() { return this.d === 1n; }
  /** Nearest integer, halves away from zero. */
  round() {
    const twice = this.n * 2n + (this.n < 0n ? -this.d : this.d);
    return twice / (this.d * 2n);
  }
  toNumber() { return Number(this.n) / Number(this.d); }
  /** Exact decimal string with `places` digits, rounded half away from zero. */
  toFixed(places = 2) {
    const scale = 10n ** BigInt(places);
    const q = new Rat(this.n * scale, this.d).round();
    const neg = q < 0n;
    let s = abs(q).toString().padStart(places + 1, "0");
    if (places > 0) s = `${s.slice(0, -places)}.${s.slice(-places)}`;
    return (neg ? "-" : "") + s;
  }
  toString() { return this.d === 1n ? String(this.n) : `${this.n}/${this.d}`; }
}
export const ZERO = new Rat(0n);
export const sumRats = (list) => list.reduce((acc, r) => acc.add(r), ZERO);

/* --------------------------------------------------------------------- dates */
export const pad2 = (n) => String(n).padStart(2, "0");
const DAY_MS = 86400000;
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
export const daysInMonth = (y, m) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
export const isValidYmd = (y, m, d) => Number.isInteger(y) && y >= 1 && y <= 9999 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
export const isoFromParts = (y, m, d) => `${String(y).padStart(4, "0")}-${pad2(m)}-${pad2(d)}`;

/**
 * hledger "simple date": YYYY-MM-DD, YYYY/MM/DD or YYYY.MM.DD (the same separator twice; month and day may have one
 * digit). A year is required: neither timedot nor timeclock files can supply a default year.
 * Returns null when the text is not shaped like a date, else { iso, y, m, d, sep, valid } (valid = a real calendar day).
 */
export function parseSimpleDate(text) {
  const m = /^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})$/.exec(text);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[3]), Number(m[4])];
  const valid = isValidYmd(y, mo, d);
  return { iso: valid ? isoFromParts(y, mo, d) : null, y, m: mo, d, sep: m[2], valid };
}

/** Integer day number of an ISO date (days since 1970-01-01). Calendar arithmetic only: no time zone is involved. */
export function daysFromIso(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}
export function isoFromDays(n) {
  const dt = new Date(n * DAY_MS);
  return isoFromParts(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}
export const addDaysIso = (iso, n) => isoFromDays(daysFromIso(iso) + n);
/** 0 = Sunday … 6 = Saturday. */
export const weekdayOf = (iso) => new Date(daysFromIso(iso) * DAY_MS).getUTCDay();
/** The first day of the week containing `iso`. weekStart: "monday" | "sunday". */
export function weekStartIso(iso, weekStart = "monday") {
  const wd = weekdayOf(iso);
  const back = weekStart === "sunday" ? wd : (wd + 6) % 7;
  return addDaysIso(iso, -back);
}
export const monthKey = (iso) => iso.slice(0, 7);

/* --------------------------------------------------------------------- times */
/**
 * hledger timeclock time: HH:MM[:SS] with two-digit parts, optionally followed by a +-ZZZZ offset (accepted, ignored).
 * Returns null when not shaped like a time, else { hh, mm, ss, hasSeconds, tz, valid, text, seconds }.
 */
export function parseClockTime(text) {
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?([+-]\d{4})?$/.exec(text);
  if (!m) return null;
  const [hh, mm, ss] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  const valid = hh <= 23 && mm <= 59 && ss <= 59;
  return { hh, mm, ss, hasSeconds: m[3] != null, tz: m[4] ?? null, valid, seconds: hh * 3600 + mm * 60 + ss, text: `${m[1]}:${m[2]}${m[3] != null ? `:${m[3]}` : ""}` };
}
export const clockText = (secs, { seconds = true } = {}) => {
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
  return `${pad2(h)}:${pad2(m)}${seconds ? `:${pad2(s)}` : ""}`;
};
/** Wall-clock seconds since 1970-01-01 00:00:00 of a date + time of day. Never touches time zones or DST (as hledger). */
export const wallSeconds = (iso, secondsOfDay) => daysFromIso(iso) * 86400 + secondsOfDay;

/**
 * The current LOCAL date and time as plain strings. Deliberately not toISOString(): that is UTC, and a clock-in
 * written in UTC would be hours off for most people.
 */
export function localNow(d = new Date()) {
  const date = isoFromParts(d.getFullYear(), d.getMonth() + 1, d.getDate());
  const secondsOfDay = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
  return { date, time: clockText(secondsOfDay), secondsOfDay, wall: wallSeconds(date, secondsOfDay) };
}
export const todayLocal = (d = new Date()) => localNow(d).date;

/* ---------------------------------------------------------------- formatting */
/** Whole seconds of a number or Rat (halves away from zero). */
export function roundedSeconds(x) {
  if (x instanceof Rat) return Number(x.round());
  return Math.round(Number(x));
}

/** "15m", "1h", "1h 30m", "8h 15m", "1h 30m 15s", "45s", "0m". Whole hours past 24 stay hours (e.g. "26h"). */
export function formatDuration(x) {
  const total = roundedSeconds(x);
  const neg = total < 0;
  const t = Math.abs(total);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const parts = [h && `${h}h`, m && `${m}m`, s && `${s}s`].filter(Boolean);
  return (neg ? "-" : "") + (parts.join(" ") || "0m");
}

/** Decimal hours for comparing totals ("1.50"). Exact for Rat input; display rounding only. */
export function formatHours(x, places = 2) {
  const r = x instanceof Rat ? x : Rat.of(Math.round(x));
  return r.div(3600n).toFixed(places);
}

const dateFmt = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const dateFmtLong = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const monthFmt = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const utcDate = (iso) => new Date(daysFromIso(iso) * DAY_MS);
export const plural = (n, word) => (n === 1 ? word : `${word}s`);

/** "Mon, 23 Nov 2026" — computed in UTC from calendar parts, so it never shifts a day. */
export const formatDateLabel = (iso) => (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? dateFmt.format(utcDate(iso)) : String(iso ?? ""));
export const formatDateLong = (iso) => (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? dateFmtLong.format(utcDate(iso)) : String(iso ?? ""));
export const formatMonthLabel = (key) => (/^\d{4}-\d{2}$/.test(key) ? monthFmt.format(utcDate(`${key}-01`)) : key);
/** "HH:MM" (or HH:MM:SS when the seconds are not zero) from seconds of the day. */
export const shortClock = (secs) => clockText(secs, { seconds: secs % 60 !== 0 });

/* --------------------------------------------------------------------- text */
/** Lines with their offsets and exact line endings: [{ n (1-based), start, end (excl. EOL), eol, text }]. */
export function splitLines(text) {
  const lines = [];
  const re = /\r\n|\n|\r/g;
  let start = 0, m, n = 1;
  while ((m = re.exec(text))) {
    lines.push({ n: n++, start, end: m.index, eol: m[0], text: text.slice(start, m.index) });
    start = m.index + m[0].length;
  }
  if (start < text.length || lines.length === 0) lines.push({ n, start, end: text.length, eol: "", text: text.slice(start) });
  return lines;
}
/** The file's own line ending ("\r\n" when the first break is CRLF), for lines Wedger adds. */
export function detectEol(text) {
  const m = /\r\n|\n|\r/.exec(text);
  return m ? m[0] : "\n";
}

/**
 * Applies non-overlapping edits [{ start, end, text }] (offsets into `text`) in ONE pass.
 * Throws when ranges overlap or fall outside the text, so a bad mutation can never half-apply.
 */
export function applyEdits(text, edits) {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  let out = "", cursor = 0;
  for (const e of sorted) {
    if (!(e.start >= cursor && e.end >= e.start && e.end <= text.length)) throw new RangeError("Overlapping or out-of-range edit.");
    out += text.slice(cursor, e.start) + e.text;
    cursor = e.end;
  }
  return out + text.slice(cursor);
}

/** `text` plus one more line. The text keeps its own line ending and gains a final break first if it lacked one. */
export function appendLine(text, line) {
  const eol = detectEol(text);
  return (text && !/[\r\n]$/.test(text) ? text + eol : text) + line + eol;
}

/**
 * The text after adding `fragment` to the end of `existing`, for the importer. The fragment is kept character for
 * character; only a missing final line break (and, for timedot, a blank line between day groups) is supplied.
 */
export function appendFragment(kind, existing, fragment) {
  if (!existing) return fragment;
  const eol = detectEol(existing);
  let head = existing;
  if (!/[\r\n]$/.test(head)) head += eol;
  if (kind === "timedot") {
    const body = head.replace(/(\r\n|\n|\r)$/, "");              // the text without its final line break
    const endsBlank = /(^|\r\n|\n|\r)[ \t]*$/.test(body);          // …ends in a blank line?
    const startsBlank = /^[ \t]*(\r\n|\n|\r)/.test(fragment);
    if (!endsBlank && !startsBlank) head += eol;
  }
  return head + fragment;
}

/* --------------------------------------------------------------- diagnostics */
export const SEVERITY_RANK = { error: 2, warning: 1, info: 0 };
/** range: { start, end } offsets into the text; line: 1-based. */
export function diag(severity, code, message, line, range = null) {
  return { severity, code, message, line, range };
}
export function countDiagnostics(diagnostics) {
  const c = { error: 0, warning: 0, info: 0 };
  for (const d of diagnostics) c[d.severity]++;
  return c;
}
export const sortDiagnostics = (list) => [...list].sort((a, b) => a.line - b.line || SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);

/* --------------------------------------------------------------- accounts */
/** First component of "a:b:c" — the "project" in Wedger's summaries. */
export const projectOf = (account) => String(account ?? "").split(":")[0].trim() || "(none)";

/** Case-insensitive match of every whitespace-separated word of `needle` against the joined fields. */
export function matchesText(fields, needle) {
  const words = String(needle ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = fields.filter((f) => f != null).join("\n").toLowerCase();
  return words.every((w) => hay.includes(w));
}

/**
 * A mutation is only accepted if it leaves the file no worse than before: it must not introduce errors
 * that were not there. `before`/`after` are parsed models ({ diagnostics }).
 */
export function newErrors(before, after) {
  const count = (m) => {
    const c = new Map();
    for (const d of m.diagnostics) if (d.severity === "error") c.set(d.code, (c.get(d.code) ?? 0) + 1);
    return c;
  };
  const was = count(before), now = count(after);
  return after.diagnostics.filter((d) => d.severity === "error" && (now.get(d.code) ?? 0) > (was.get(d.code) ?? 0));
}
