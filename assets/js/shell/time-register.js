/* time-register.js — what the rendered .timeclock and .timedot registers show, as plain data. Pure: no DOM.
 *
 * Filters, search and sort are three separate things, exactly as in the journal viewer:
 *   filters   narrow the list by date range, account, project (and session status for timeclock)
 *   search    narrows it by text, through one compiled query (find.js), so Aa / whole word / regex work here too
 *   sort      only orders what is left; it never changes the file or what is shown
 * None of them touches the text or the parsed model. The rows returned are the model's own session / posting objects, so
 * their ids stay valid for the mutations in timeclock.js / timedot.js.
 */
import { ZERO, sumRats, formatDateLong, formatDuration, projectOf, shortClock } from "./time-format.js";
import { liveElapsed } from "./timeclock.js";

const hasValue = (v) => v !== "" && v != null;
const accountMatches = (account, wanted) => !wanted || account === wanted || account.startsWith(`${wanted}:`);

/* ----------------------------------------------------------------- filters */
export const CLOCK_FILTER_FIELDS = ["from", "to", "account", "project", "status"];
export const DOT_FILTER_FIELDS = ["from", "to", "account", "project"];

/**
 * The filters that actually apply, plus a plain-language list of what was left out and why. A contradictory range
 * (From after To) is ignored as a pair instead of silently producing an empty list. Pure.
 */
export function effectiveFilters(raw = {}, { status = false } = {}) {
  const f = { from: "", to: "", account: "", project: "", ...(status ? { status: "all" } : {}), ...raw };
  const issues = [];
  if (f.from && f.to && f.from > f.to) { issues.push("The From date is after the To date, so neither date is applied."); f.from = f.to = ""; }
  return { f, issues };
}

/** How many filter fields are in force (the Filters badge). Search and sort are never counted here. */
export function activeFilterCount(raw = {}, opts = {}) {
  const { f } = effectiveFilters(raw, opts);
  return ["from", "to", "account", "project"].filter((k) => hasValue(f[k])).length + (opts.status && f.status && f.status !== "all" ? 1 : 0);
}

/* ---------------------------------------------------------------- timeclock */
export const CLOCK_SORTS = {
  "date-desc": { label: "Date, newest first", grouped: true },
  "date-asc": { label: "Date, oldest first", grouped: true },
  "duration-desc": { label: "Longest first", grouped: false },
  "duration-asc": { label: "Shortest first", grouped: false },
  "account-asc": { label: "Account A–Z", grouped: false },
  "account-desc": { label: "Account Z–A", grouped: false },
};
export const DEFAULT_CLOCK_SORT = "date-desc";

/** A session is in a date range when any of its daily parts is (completed), or its start is (running, problem). */
export function sessionInRange(s, from, to) {
  const inR = (d) => (!from || d >= from) && (!to || d <= to);
  if (s.status === "closed") return s.segments.some((seg) => inR(seg.date));
  return !!s.start.date && inR(s.start.date);
}

/** What a session's time is for sorting: recorded for completed ones, time so far for running ones, 0 for problems. */
const durationKey = (s, now) => (s.status === "closed" ? s.durationSeconds : s.status === "open" ? (liveElapsed(s, now) ?? 0) : 0);

export const STATUS_LABEL = { open: "Running", closed: "Completed", invalid: "Problem" };

/** Everything search looks at for one session. */
export function sessionHaystack(s) {
  return [
    s.account, s.description, s.comment, ...s.tags.map((t) => `${t.name}:${t.value}`),
    s.start.date, s.end?.date, s.start.date ? formatDateLong(s.start.date) : null,
    s.start.secondsOfDay != null ? shortClock(s.start.secondsOfDay) : null, s.end ? shortClock(s.end.secondsOfDay) : null,
    STATUS_LABEL[s.status],
  ].filter((x) => x != null).join("\n");
}

/**
 * @param model       parseTimeclock() result
 * @param filters     { from, to, account, project, status }
 * @param compiled    compileQuery() result (an empty query matches nothing and means "no search")
 * @param query       the raw search text (empty = no search)
 * @param sort        a CLOCK_SORTS key
 * @param now         localNow() — only used to order running sessions by time so far
 * @returns {{ rows: object[], grouped: boolean, issues: string[], invalidSearch: boolean }}
 */
export function clockView(model, { filters = {}, compiled = null, query = "", sort = DEFAULT_CLOCK_SORT, now }) {
  const { f, issues } = effectiveFilters(filters, { status: true });
  const q = String(query ?? "").trim();
  if (q && compiled && !compiled.ok) return { rows: [], grouped: !!CLOCK_SORTS[sort]?.grouped, issues, invalidSearch: true };
  const rows = model.sessions.filter((s) => {
    if (!accountMatches(s.account, f.account)) return false;
    if (f.project && projectOf(s.account) !== f.project) return false;
    if ((f.from || f.to) && !sessionInRange(s, f.from, f.to)) return false;
    if (f.status === "running" && s.status !== "open") return false;
    if (f.status === "completed" && s.status !== "closed") return false;
    if (f.status === "problems" && s.status !== "invalid" && !s.problems.length) return false;
    if (q && compiled && !compiled.test(sessionHaystack(s))) return false;
    return true;
  });
  const byLine = (a, b) => a.line - b.line;
  const cmp = {
    "date-desc": (a, b) => b.start.wall - a.start.wall || b.line - a.line,
    "date-asc": (a, b) => a.start.wall - b.start.wall || byLine(a, b),
    "duration-desc": (a, b) => durationKey(b, now) - durationKey(a, now) || b.start.wall - a.start.wall || byLine(a, b),
    "duration-asc": (a, b) => durationKey(a, now) - durationKey(b, now) || a.start.wall - b.start.wall || byLine(a, b),
    "account-asc": (a, b) => a.account.localeCompare(b.account) || b.start.wall - a.start.wall || byLine(a, b),
    "account-desc": (a, b) => b.account.localeCompare(a.account) || b.start.wall - a.start.wall || byLine(a, b),
  }[CLOCK_SORTS[sort] ? sort : DEFAULT_CLOCK_SORT];
  return { rows: [...rows].sort(cmp), grouped: !!CLOCK_SORTS[sort]?.grouped, issues, invalidSearch: false };
}

/** Consecutive rows that share a start date: [{ date, items }] (what the day pills are drawn from). */
export function groupClockRows(rows) {
  const out = [];
  for (const s of rows) {
    const g = out.at(-1);
    if (g && g.date === s.start.date) g.items.push(s); else out.push({ date: s.start.date, items: [s] });
  }
  return out;
}

/* ------------------------------------------------------------------ timedot */
export const DOT_SORTS = {
  "date-desc": { label: "Date, newest first", grouped: true },
  "date-asc": { label: "Date, oldest first", grouped: true },
  "duration-desc": { label: "Longest first", grouped: false },
  "duration-asc": { label: "Shortest first", grouped: false },
  "account-asc": { label: "Account A–Z", grouped: false },
  "account-desc": { label: "Account Z–A", grouped: false },
};
export const DEFAULT_DOT_SORT = "date-desc";

/** Everything search looks at for one entry: account, comments, notation, its day's text and date, and its letter types. */
export function postingHaystack(p, day) {
  return [
    p.account, p.comment, p.raw, day?.description, day?.comment, day?.date, day?.dateText,
    day?.date ? formatDateLong(day.date) : null,
    ...p.types.flatMap((t) => [t.type, `t:${t.type}`]),
  ].filter((x) => x != null && x !== "").join("\n");
}

/**
 * @returns {{ days: object[]|null, rows: object[], grouped: boolean, issues: string[], invalidSearch: boolean }}
 *   `rows` is every shown entry in DISPLAY order (what selection ranges and "select all visible" run over).
 *   `days` is set when the sort is by date: [{ key, date, dateText, valid, groups, postings, seconds }].
 *   Entries of an unreadable amount or an invalid date are listed too (flagged), never hidden; they just carry no time.
 */
export function dotView(model, { filters = {}, compiled = null, query = "", sort = DEFAULT_DOT_SORT }) {
  const { f, issues } = effectiveFilters(filters);
  const q = String(query ?? "").trim();
  const grouped = !!DOT_SORTS[sort]?.grouped;
  if (q && compiled && !compiled.ok) return { days: grouped ? [] : null, rows: [], grouped, issues, invalidSearch: true };

  const narrowing = !!(f.account || f.project || q);          // an empty day only shows while nothing but dates narrows the list
  const dayOf = new Map(model.days.map((d) => [d.id, d]));
  const dayPasses = (d) => {
    if (!(f.from || f.to)) return true;
    if (!d.date) return false;                                // an invalid date can't be compared with a range
    return (!f.from || d.date >= f.from) && (!f.to || d.date <= f.to);
  };
  const postingPasses = (p) => {
    const d = dayOf.get(p.dayId);
    if (!dayPasses(d)) return false;
    if (!accountMatches(p.account, f.account)) return false;
    if (f.project && projectOf(p.account) !== f.project) return false;
    if (q && compiled && !compiled.test(postingHaystack(p, d))) return false;
    return true;
  };
  const shown = model.postings.filter(postingPasses);

  const secondsOf = (list) => sumRats(list.filter((p) => p.valid && dayOf.get(p.dayId)?.valid).map((p) => p.seconds));
  const durKey = (p) => (p.valid && dayOf.get(p.dayId)?.valid && p.seconds ? p.seconds : ZERO);

  if (!grouped) {
    const dateOf = (p) => dayOf.get(p.dayId)?.date ?? "";
    const cmp = {
      "duration-desc": (a, b) => durKey(b).cmp(durKey(a)) || dateOf(b).localeCompare(dateOf(a)) || a.line - b.line,
      "duration-asc": (a, b) => durKey(a).cmp(durKey(b)) || dateOf(b).localeCompare(dateOf(a)) || a.line - b.line,
      "account-asc": (a, b) => a.account.localeCompare(b.account) || dateOf(b).localeCompare(dateOf(a)) || a.line - b.line,
      "account-desc": (a, b) => b.account.localeCompare(a.account) || dateOf(b).localeCompare(dateOf(a)) || a.line - b.line,
    }[sort];
    return { days: null, rows: [...shown].sort(cmp), grouped, issues, invalidSearch: false };
  }

  // Grouped by date: groups that share a date merge into one day; invalid-date groups stay on their own.
  const byKey = new Map();
  for (const d of model.days) {
    const key = d.date ? d.date : `invalid:${d.id}`;
    if (!byKey.has(key)) byKey.set(key, { key, date: d.date, dateText: d.dateText, valid: d.valid, groups: [], postings: [] });
    byKey.get(key).groups.push(d);
  }
  const shownSet = new Set(shown);
  for (const day of byKey.values()) day.postings = model.postings.filter((p) => shownSet.has(p) && day.groups.some((g) => g.id === p.dayId));
  let days = [...byKey.values()].filter((day) => {
    if (day.postings.length) return true;
    if (day.groups.some((g) => model.postings.some((p) => p.dayId === g.id))) return false;     // it has entries, but none passed
    if (narrowing && !(q && !f.account && !f.project && compiled?.test(day.groups.map((g) => `${g.description}\n${g.comment}\n${g.dateText}`).join("\n")))) return false;
    return day.groups.some(dayPasses);                                                           // a day with no entries yet (just added)
  });
  for (const day of days) day.seconds = secondsOf(day.postings);
  const dated = days.filter((d) => d.date), undated = days.filter((d) => !d.date);
  dated.sort((a, b) => (sort === "date-desc" ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date)));
  days = [...dated, ...undated];
  return { days, rows: days.flatMap((d) => d.postings), grouped, issues, invalidSearch: false };
}

/** "3h 15m" for a day's readable entries (empty string when there are none). */
export const dayTotalText = (day) => (day.postings.length ? formatDuration(day.seconds) : "");
