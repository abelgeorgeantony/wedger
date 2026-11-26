import test from "node:test";
import assert from "node:assert/strict";
import { TIMECLOCK, TIMEDOT, NOW } from "./time-fixtures.mjs";
import { parseTimeclock, deleteSessions } from "../assets/js/shell/timeclock.js";
import { parseTimedot, deletePostings } from "../assets/js/shell/timedot.js";
import { clockView, dotView, groupClockRows, activeFilterCount, effectiveFilters, sessionInRange } from "../assets/js/shell/time-register.js";
import { compileQuery } from "../assets/js/shell/find.js";
import { createSelection } from "../assets/js/shell/time-select.js";

const clock = parseTimeclock(TIMECLOCK);
const dot = parseTimedot(TIMEDOT);
const view = (o = {}) => clockView(clock, { filters: {}, compiled: compileQuery(""), query: "", sort: "date-desc", now: NOW, ...o });
const q = (text, opts) => ({ query: text, compiled: compileQuery(text, opts) });

/* ------------------------------------------------------------------ timeclock */
test("timeclock: no filters shows every session, newest first, grouped by start date", () => {
  const v = view();
  assert.equal(v.rows.length, 4);
  assert.deepEqual(v.rows.map((s) => s.start.date), ["2026-11-25", "2026-11-24", "2026-11-23", "2026-11-23"]);
  assert.equal(v.grouped, true);
  assert.deepEqual(groupClockRows(v.rows).map((g) => g.items.length), [1, 1, 2]);
});

test("timeclock: a session that crosses midnight is in range when ANY of its days is", () => {
  const night = clock.sessions.find((s) => s.account === "home:chores");
  assert.equal(sessionInRange(night, "2026-11-24", "2026-11-24"), true);
  assert.equal(sessionInRange(night, "2026-11-25", ""), false);
  assert.equal(view({ filters: { from: "2026-11-24", to: "2026-11-24" } }).rows.length, 2);
});

test("timeclock: account, project and status filters", () => {
  assert.equal(view({ filters: { account: "work" } }).rows.length, 3);
  assert.equal(view({ filters: { account: "work:code" } }).rows.length, 2);
  assert.equal(view({ filters: { project: "home" } }).rows.length, 1);
  assert.equal(view({ filters: { status: "running" } }).rows.length, 1);
  assert.equal(view({ filters: { status: "completed" } }).rows.length, 3);
  assert.equal(view({ filters: { status: "problems" } }).rows.length, 0);
});

test("timeclock: a contradictory range is ignored and explained instead of emptying the list", () => {
  const v = view({ filters: { from: "2026-11-25", to: "2026-11-01" } });
  assert.equal(v.rows.length, 4);
  assert.equal(v.issues.length, 1);
  assert.equal(effectiveFilters({ from: "2026-11-25", to: "2026-11-01" }).f.from, "");
});

test("timeclock: search covers account, description, comments, dates, times and status", () => {
  const ids = (t, o) => view(q(t, o)).rows.map((s) => s.account).sort();
  assert.deepEqual(ids("mail"), ["work:mail"]);
  assert.deepEqual(ids("Fix bug"), ["work:code"]);
  assert.deepEqual(ids("late"), ["home:chores"]);                 // the ; comment
  assert.deepEqual(ids("2026-11-24"), ["home:chores", "work:mail"]);
  assert.deepEqual(ids("22:00"), ["home:chores"]);
  assert.deepEqual(ids("running"), ["work:code"]);
  assert.deepEqual(ids("CODE", { caseSensitive: true }), []);
  assert.deepEqual(ids("^home", { regexp: true }), ["home:chores"]);
});

test("timeclock: an invalid regex matches nothing and is flagged, never throws", () => {
  const v = view(q("(", { regexp: true }));
  assert.equal(v.rows.length, 0);
  assert.equal(v.invalidSearch, true);
});

test("timeclock: sorting orders the rows and never changes the model", () => {
  const before = JSON.stringify(clock.sessions.map((s) => s.id));
  assert.deepEqual(view({ sort: "date-asc" }).rows.map((s) => s.start.date), ["2026-11-23", "2026-11-23", "2026-11-24", "2026-11-25"]);
  const byDur = view({ sort: "duration-desc" });
  assert.equal(byDur.grouped, false);
  assert.equal(byDur.rows[0].account, "home:chores");              // 3h recorded; the running session counts as its 2h so far, after 2h30m
  assert.equal(byDur.rows.at(-1).account, "work:mail");           // 45m
  assert.deepEqual(view({ sort: "account-asc" }).rows.map((s) => s.account), ["home:chores", "work:code", "work:code", "work:mail"]);
  assert.equal(JSON.stringify(clock.sessions.map((s) => s.id)), before);
});

test("timeclock: filters count only their own fields (search and sort are not filters)", () => {
  assert.equal(activeFilterCount({ from: "", to: "", account: "", project: "", status: "all" }, { status: true }), 0);
  assert.equal(activeFilterCount({ from: "2026-01-01", to: "", account: "a", project: "", status: "running" }, { status: true }), 3);
});

/* -------------------------------------------------------- selection with filters */
test("selection + filters: only selected sessions the list SHOWS are deleted; hidden ones survive", () => {
  const sel = createSelection();
  sel.bind(TIMECLOCK);
  sel.setMode(true);
  const all = view().rows;
  sel.selectAll(all);                                              // everything selected
  const shown = view({ filters: { project: "home" } }).rows;       // then a filter hides the rest
  const targets = sel.visible(shown);
  assert.equal(targets.length, 1);
  assert.equal(sel.hiddenCount(shown), 3);
  const r = deleteSessions(TIMECLOCK, targets.map((s) => s.id));
  assert.equal(r.ok, true);
  const left = parseTimeclock(r.text).sessions.map((s) => s.account).sort();
  assert.deepEqual(left, ["work:code", "work:code", "work:mail"], "the hidden selected sessions were not deleted");
});

/* ------------------------------------------------------------------- timedot */
const dview = (o = {}) => dotView(dot, { filters: {}, compiled: compileQuery(""), query: "", sort: "date-desc", ...o });

test("timedot: grouped by date, newest day first; entries stay in file order within a day", () => {
  const v = dview();
  assert.deepEqual(v.days.map((d) => d.date), ["2026-11-24", "2026-11-23"]);
  assert.deepEqual(v.days[1].postings.map((p) => p.account), ["work:code", "home:read", "work:mail"]);
  assert.equal(v.rows.length, 4);
  assert.equal(v.grouped, true);
});

test("timedot: filters by date, account and project", () => {
  assert.equal(dview({ filters: { from: "2026-11-24" } }).rows.length, 1);
  assert.equal(dview({ filters: { account: "work" } }).rows.length, 3);
  assert.equal(dview({ filters: { project: "home" } }).rows.length, 1);
  assert.deepEqual(dview({ filters: { to: "2026-11-23" } }).days.map((d) => d.date), ["2026-11-23"]);
});

test("timedot: search covers account, comment, original notation, day description, date and letter types", () => {
  const accts = (t, o) => dview(q(t, o)).rows.map((p) => p.account).sort();
  assert.deepEqual(accts("evening"), ["home:read"]);              // comment
  assert.deepEqual(accts("ccec"), ["home:read"]);                 // notation
  assert.deepEqual(accts("t:e"), ["home:read"]);                  // letter type
  assert.deepEqual(accts("Mon"), ["home:read", "work:code", "work:mail"]);   // the day's description
  assert.deepEqual(accts("2026-11-24"), ["work:code"]);
  assert.deepEqual(accts("1.5"), ["work:mail"]);
});

test("timedot: non-date sorts flatten the list across days", () => {
  const v = dview({ sort: "duration-desc" });
  assert.equal(v.days, null);
  assert.equal(v.grouped, false);
  assert.deepEqual(v.rows.map((p) => p.raw)[0], "2h");
  assert.equal(dview({ sort: "account-desc" }).rows[0].account, "work:mail");
});

test("timedot: an empty day shows only while nothing but dates narrows the list", () => {
  const withEmpty = parseTimedot(TIMEDOT + "2026-11-26 Empty day\n");
  const v = (o) => dotView(withEmpty, { filters: {}, compiled: compileQuery(""), query: "", sort: "date-desc", ...o });
  assert.equal(v().days[0].date, "2026-11-26");
  assert.equal(v({ filters: { account: "work" } }).days.some((d) => d.date === "2026-11-26"), false);
});

test("timedot: unreadable entries are listed (flagged), never silently dropped", () => {
  const bad = parseTimedot("2026-11-23\na  1h\nb  1.2.3\n");
  const v = dotView(bad, { filters: {}, compiled: compileQuery(""), query: "", sort: "date-desc" });
  assert.equal(v.rows.length, 2);
  assert.equal(v.rows.some((p) => !p.valid), true);
});

test("timedot selection + filters: hidden selected entries are not deleted, and the deletion is one edit", () => {
  const sel = createSelection();
  sel.bind(TIMEDOT);
  sel.selectAll(dview().rows);
  const shown = dview({ filters: { project: "work" } }).rows;      // hides home:read
  const targets = sel.visible(shown);
  assert.equal(targets.length, 3);
  assert.equal(sel.hiddenCount(shown), 1);
  const r = deletePostings(TIMEDOT, targets.map((p) => p.id));
  assert.equal(r.ok, true);
  assert.deepEqual(parseTimedot(r.text).postings.map((p) => p.account), ["home:read"]);
  assert.ok(r.text.includes("2026-11-23 Mon") && r.text.includes("2026-11-24"), "day headings survive");
});
