import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TIMECLOCK, TIMEDOT, NOW } from "./time-fixtures.mjs";
import { TIME_REPORTS, runTimeReport, reportCsv, presetRange, rangeLabel, validateRange, plainTable } from "../assets/js/shell/time-report.js";
import { buildModel, rawText, modelToCsv } from "../assets/js/shell/report-model.js";

const clock = (type, o = {}) => runTimeReport("timeclock", TIMECLOCK, { type, now: NOW, ...o });
const dot = (type, o = {}) => runTimeReport("timedot", TIMEDOT, { type, ...o });
const col = (r, name) => r.native.columns.indexOf(name);
const rowFor = (r, first) => r.native.rows.find((x) => x[0] === first);

/* ---------------------------------------------------------- report selection */
test("every report in the catalogue runs, for both formats, and produces a table", () => {
  for (const [kind, text] of [["timeclock", TIMECLOCK], ["timedot", TIMEDOT]]) {
    for (const info of TIME_REPORTS[kind]) {
      const r = runTimeReport(kind, text, { type: info.id, now: NOW });
      assert.equal(r.ok, true, `${kind}/${info.id}: ${r.error}`);
      assert.ok(r.native.columns.length >= 3 && r.native.text.length > 20, `${kind}/${info.id} has real content`);
    }
  }
});

test("the Reports menus and the catalogue agree: no dead buttons, no unreachable reports", () => {
  for (const kind of ["timeclock", "timedot"]) {
    const html = readFileSync(new URL(`../assets/special/${kind}-menu.html`, import.meta.url), "utf8");
    const inMenu = [...html.matchAll(/data-report="([^"]+)"/g)].map((m) => m[1]).sort();
    const inCatalogue = TIME_REPORTS[kind].map((r) => r.id).sort();
    assert.deepEqual(inMenu, inCatalogue, `${kind} menu`);
  }
});

test("an unknown report, a bad date and a contradictory range are refused with a reason", () => {
  assert.equal(runTimeReport("timeclock", TIMECLOCK, { type: "nope" }).ok, false);
  assert.match(clock("daily", { from: "2026-13-01" }).error, /From/);
  assert.match(clock("daily", { from: "2026-11-25", to: "2026-11-01" }).error, /after/);
  assert.equal(validateRange({ from: "2026-11-01", to: "2026-11-30" }), null);
});

/* --------------------------------------------------------------- timeclock */
test("timeclock session register: chronological, with start, end, duration and status", () => {
  const r = clock("register");
  assert.deepEqual(r.native.columns, ["Date", "Account", "Description", "Start", "End", "Duration", "Hours", "Status"]);
  assert.deepEqual(r.native.rows.map((x) => x[0]), ["2026-11-23", "2026-11-23", "2026-11-24", "2026-11-25"]);
  const code = r.native.rows[0];
  assert.deepEqual([code[3], code[4], code[5], code[6], code[7]], ["09:00", "11:30", "2h 30m", "2.50", "Completed"]);
  const night = r.native.rows[1];
  assert.equal(night[4], "2026-11-24 01:00", "a session ending on another day shows that day");
  assert.equal(night[5], "3h");
  const running = r.native.rows.at(-1);
  assert.deepEqual([running[5], running[6], running[7]], ["—", "—", "Running"], "a running session has no recorded duration");
  assert.equal(r.native.footer[5], "6h 15m", "total of COMPLETED time only: 2h30m + 3h + 45m (the running session adds nothing)");
});

test("timeclock register: order option reverses it, and the order never changes the totals", () => {
  const asc = clock("register").native, desc = clock("register", { order: "desc" }).native;
  assert.deepEqual(desc.rows.map((x) => x[0]), [...asc.rows.map((x) => x[0])].reverse());
  assert.deepEqual(desc.footer, asc.footer);
});

test("timeclock date ranges: a session crossing the range edge is listed whole but counted only inside it", () => {
  const r = clock("register", { from: "2026-11-24", to: "2026-11-24" });
  assert.deepEqual(r.native.rows.map((x) => x[1]), ["home:chores", "work:mail"]);
  assert.equal(r.native.footer[5], "1h 45m", "1h of the night session after midnight + 45m of mail");
  assert.ok(r.native.notes.some((n) => /crosses the edge/.test(n)));
  assert.equal(rangeLabel({ from: "2026-11-24", to: "2026-11-24" }), "2026-11-24");
});

test("time by account and by project aggregate completed time only", () => {
  const acct = clock("by-account");
  assert.deepEqual(acct.native.rows.map((x) => [x[0], x[1], x[2]]), [["home:chores", "1", "3h"], ["work:code", "1", "2h 30m"], ["work:mail", "1", "45m"]],
    "largest first; the running work:code session is NOT in it");
  assert.deepEqual(acct.native.footer, ["Total completed", "3", "6h 15m", "6.25"]);
  const proj = clock("by-project");
  assert.deepEqual(proj.native.rows.map((x) => [x[0], x[1], x[2]]), [["work", "2", "3h 15m"], ["home", "1", "3h"]]);
});

test("timeclock daily report splits a midnight-crossing session per day, but counts it once in the total", () => {
  const r = clock("daily");
  assert.deepEqual(r.native.rows.map((x) => [x[0], x[1], x[2], x[3]]),
    [["2026-11-23", "Mon", "2", "4h 30m"],   // 2h30m of code + the first 2h of the night session
     ["2026-11-24", "Tue", "2", "1h 45m"]]); // the last 1h of the night session + 45m of mail
  assert.equal(r.native.footer[2], "3", "unique sessions (the rows add up to 4 because one session spans two days)");
  assert.equal(r.native.footer[3], "6h 15m");
});

test("timeclock weekly and monthly reports", () => {
  const w = clock("weekly");
  assert.deepEqual(w.native.rows[0].slice(0, 2), ["2026-11-23", "2026-11-29"]);
  assert.equal(w.native.rows[0][3], "6h 15m");
  const sunday = clock("weekly", { weekStart: "sunday" });
  assert.equal(sunday.native.rows[0][0], "2026-11-22");
  const m = clock("monthly");
  assert.deepEqual(m.native.rows[0], ["2026-11", "3", "6h 15m", "6.25"]);
});

test("running sessions are reported separately, as an estimate, never as a recorded duration", () => {
  const r = clock("running");
  assert.equal(r.native.rows.length, 1);
  assert.equal(r.native.rows[0][3], "2h", "08:00 to the injected 10:00");
  assert.match(r.native.subtitle, /Estimated as of 2026-11-25 10:00/);
  assert.ok(r.native.notes.some((n) => /not a completed duration/.test(n)));
  assert.equal(r.native.columns[3], "Elapsed so far (estimate)");
  assert.equal(r.native.footer, null, "no total: nothing here is recorded time");
  // the totals reports mention the running session but do not include it
  const acct = clock("by-account");
  assert.ok(acct.native.notes.some((n) => /running session/.test(n)));
  assert.equal(rowFor(acct, "work:code")[2], "2h 30m");
});

test("empty results explain themselves", () => {
  const r = clock("register", { from: "2030-01-01", to: "2030-12-31" });
  assert.equal(r.ok, true);
  assert.equal(r.native.rows.length, 0);
  assert.match(r.native.emptyMessage, /No sessions/);
  assert.equal(buildModel("x", r).kind, "empty");
  const none = runTimeReport("timeclock", "", { type: "running", now: NOW });
  assert.equal(none.native.emptyMessage, "Nothing is running.");
});

/* ----------------------------------------------------------------- timedot */
test("timedot entry register: date, account, original notation, duration, types and comment", () => {
  const r = dot("register");
  assert.deepEqual(r.native.columns, ["Date", "Account", "Written as", "Duration", "Hours", "Types", "Comment"]);
  assert.equal(r.native.rows.length, 4);
  const letters = r.native.rows.find((x) => x[2] === "ccec");
  assert.deepEqual([letters[0], letters[1], letters[3], letters[5], letters[6]], ["2026-11-23", "home:read", "1h", "c 45m, e 15m", "evening"]);
  assert.equal(r.native.rows.find((x) => x[2] === "....")[3], "1h");
  assert.equal(r.native.footer[3], "5h 30m");
});

test("timedot time by account / project / day / week / month", () => {
  const acct = dot("by-account");
  assert.deepEqual(acct.native.rows.map((x) => [x[0], x[1], x[2]]), [["work:code", "2", "3h"], ["work:mail", "1", "1h 30m"], ["home:read", "1", "1h"]]);
  assert.deepEqual(dot("by-project").native.rows.map((x) => [x[0], x[1], x[2]]), [["work", "3", "4h 30m"], ["home", "1", "1h"]]);
  assert.deepEqual(dot("daily").native.rows.map((x) => [x[0], x[1], x[2], x[3]]), [["2026-11-23", "Mon", "3", "3h 30m"], ["2026-11-24", "Tue", "1", "2h"]]);
  assert.deepEqual(dot("weekly").native.rows[0], ["2026-11-23", "2026-11-29", "4", "5h 30m", "5.50"]);
  assert.deepEqual(dot("monthly").native.rows[0], ["2026-11", "4", "5h 30m", "5.50"]);
});

test("timedot date range limits every report", () => {
  const r = dot("by-account", { from: "2026-11-24", to: "2026-11-24" });
  assert.deepEqual(r.native.rows.map((x) => [x[0], x[2]]), [["work:code", "2h"]]);
  assert.equal(r.native.subtitle, "2026-11-24");
});

test("timedot type report breaks letter entries down by t: type and says what it cannot type", () => {
  const r = dot("by-type");
  assert.deepEqual(r.native.rows.map((x) => [x[0], x[2]]).sort(), [["t:c", "45m"], ["t:e", "15m"]].sort());
  assert.equal(r.native.footer[2], "1h");
  assert.ok(r.native.notes.some((n) => /no type/.test(n)), "dots and numbers are mentioned as untyped");
  const empty = runTimeReport("timedot", "2026-11-23\nx  1h\n", { type: "by-type" });
  assert.equal(empty.native.rows.length, 0);
  assert.match(empty.native.emptyMessage, /letters/);
});

test("unreadable timedot entries are counted in a note, not silently included", () => {
  const r = runTimeReport("timedot", "2026-11-23\na  1h\nb  1.2.3\n", { type: "register" });
  assert.equal(r.native.rows.length, 1);
  assert.ok(r.native.notes.some((n) => /couldn't be read/.test(n)));
});

/* ----------------------------------------------------------- CSV and output */
test("CSV is machine-friendly: ISO dates, exact seconds, decimal hours, no totals row", () => {
  const csv = reportCsv(clock("register").native).split("\n");
  assert.equal(csv[0], "Date,Account,Description,Start,End,Seconds,Hours,Status");
  assert.equal(csv[1], "2026-11-23,work:code,Fix bug,2026-11-23 09:00,2026-11-23 11:30,9000,2.5000,Completed");
  assert.equal(csv.length, 5, "header + 4 sessions, no Total row");
  assert.equal(csv.at(-1), "2026-11-25,work:code,,2026-11-25 08:00,,,,Running", "a running session has no seconds");
});

test("CSV quotes commas, quotes and newlines", () => {
  const r = runTimeReport("timeclock", 'i 2026-11-23 09:00:00 a  say "hi", then go\no 2026-11-23 10:00:00\n', { type: "register" });
  assert.ok(reportCsv(r.native).includes('"say ""hi"", then go"'));
});

test("the Reports output pipeline accepts native reports: model, raw text and CSV download", () => {
  const r = clock("by-account");
  const model = buildModel("timeclock:by-account", r);
  assert.equal(model.kind, "table");
  assert.deepEqual(model.footer.slice(0, 1), ["Total completed"]);
  assert.ok(model.notes.length >= 1);
  assert.equal(rawText(r), r.native.text);
  assert.match(rawText(r), /Time by account/);
  assert.equal(modelToCsv(model).split("\n")[0], "Account,Sessions,Seconds,Hours", "CSV uses the machine sheet, not the display cells");
  assert.equal(modelToCsv(model), reportCsv(r.native));
});

test("plain-text tables align numbers to the right", () => {
  const t = plainTable(["A", "N"], ["left", "right"], [["x", "1"], ["yy", "100"]], ["T", "101"]).split("\n");
  assert.equal(t[2], "x     1");
  assert.equal(t[3], "yy  100");
});

/* ------------------------------------------------------------------ presets */
test("period presets", () => {
  assert.deepEqual(presetRange("month", "2026-11-25"), { from: "2026-11-01", to: "2026-11-30" });
  assert.deepEqual(presetRange("last-month", "2026-01-10"), { from: "2025-12-01", to: "2025-12-31" });
  assert.deepEqual(presetRange("week", "2026-11-25"), { from: "2026-11-23", to: "2026-11-29" });
  assert.deepEqual(presetRange("week", "2026-11-25", "sunday"), { from: "2026-11-22", to: "2026-11-28" });
  assert.deepEqual(presetRange("last-week", "2026-11-25"), { from: "2026-11-16", to: "2026-11-22" });
  assert.deepEqual(presetRange("year", "2026-11-25"), { from: "2026-01-01", to: "2026-12-31" });
  assert.deepEqual(presetRange("today", "2026-11-25"), { from: "2026-11-25", to: "2026-11-25" });
  assert.deepEqual(presetRange("all", "2026-11-25"), { from: "", to: "" });
  assert.equal(presetRange("month", "2024-02-10").to, "2024-02-29");
});
