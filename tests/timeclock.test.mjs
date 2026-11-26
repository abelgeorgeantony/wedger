import test from "node:test";
import assert from "node:assert/strict";
import {
  parseTimeclock, splitAtMidnight, liveElapsed, clockIn, clockOut, addSession, deleteSession, deleteEvent,
  editSession, describeEventDeletion, summarizeTimeclock, filterSessions,
} from "../assets/js/shell/timeclock.js";
import { localNow } from "../assets/js/shell/time-format.js";

const codes = (m, sev) => m.diagnostics.filter((d) => !sev || d.severity === sev).map((d) => d.code);
const S = (m) => m.sessions.map((s) => [s.account, s.status, s.durationSeconds]);

test("basic clock-in / clock-out, seconds optional, unnamed and named clock-out", () => {
  const m = parseTimeclock("i 2026-11-23 09:00:00 work:programming\no 2026-11-23 10:30:00\n");
  assert.deepEqual(S(m), [["work:programming", "closed", 5400]]);
  const n = parseTimeclock("i 2026-11-23 09:00 work:programming  Working on Wedger\no 2026-11-23 10:30 work:programming\n");
  assert.deepEqual(S(n), [["work:programming", "closed", 5400]]);
  assert.equal(n.sessions[0].description, "Working on Wedger");
  assert.equal(codes(n, "error").length, 0);
});

test("accounts may contain single spaces; two spaces start the description; ; starts a comment", () => {
  const m = parseTimeclock("i 2015/03/30 09:00:00 some account  optional description after 2 spaces ; optional comment, tags:\no 2015/03/30 09:20:00\n");
  const s = m.sessions[0];
  assert.equal(s.account, "some account");
  assert.equal(s.description, "optional description after 2 spaces");
  assert.match(s.comment, /optional comment/);
  assert.equal(s.durationSeconds, 1200);
});

test("hledger manual example", () => {
  const m = parseTimeclock(`i 2015/03/30 09:00:00 some account  optional description after 2 spaces ; optional comment, tags:
o 2015/03/30 09:20:00
i 2015/03/31 22:21:45 another:account
o 2015/04/01 02:00:34
i 2015/04/02 12:00:00 another:account ; this demonstrates multiple sessions being clocked in
i 2015/04/02 13:00:00 some account
o 2015/04/02 14:00:00
o 2015/04/02 15:00:00 another:account
`);
  assert.equal(codes(m, "error").length, 0);
  assert.deepEqual(m.sessions.map((s) => s.durationSeconds), [1200, 13129, 10800, 3600]);
  // session 2 crosses midnight: 22:21:45 -> 00:00:34 next day... segments sum to the real elapsed time
  const cross = m.sessions.find((s) => s.start.date === "2015-03-31");
  assert.deepEqual(cross.segments.map((x) => [x.date, x.seconds]), [["2015-03-31", 5895], ["2015-04-01", 7234]]);
});

test("indented ; lines continue the comment; # ; * and blank lines and b/h/O are ignored", () => {
  const t = "# c\n; c\n* c\n\nb 2026-11-23 08:00:00 3600\ni 2026-11-23 09:00:00 a  d ; one\n  ; two\no 2026-11-23 10:00:00\nO 2026-11-23 18:00:00\nh 2026-11-23 00:00:00 8\n";
  const m = parseTimeclock(t);
  assert.equal(m.events.filter((e) => e.type === "ignored").length, 3);
  assert.equal(m.sessions[0].comment, "one\ntwo");
  assert.equal(m.events[1].commentLines.length, 1);
  assert.equal(codes(m, "error").length, 0);
});

test("multiple simultaneous sessions, named and unnamed clock-outs", () => {
  const m = parseTimeclock("i 2026-11-23 00:00:00 a\ni 2026-11-23 01:00:00 b\ni 2026-11-23 02:00:00 c\no 2026-11-23 03:00:00 b\no 2026-11-23 04:00:00 a\no 2026-11-23 05:00:00\n");
  assert.deepEqual(m.sessions.map((s) => [s.account, s.durationSeconds]), [["a", 14400], ["b", 7200], ["c", 10800]]);
  // unnamed closes the MOST RECENTLY clocked-in open session
  const u = parseTimeclock("i 2026-11-23 09:00 a\ni 2026-11-23 09:30 b\no 2026-11-23 10:00\n");
  assert.deepEqual(S(u), [["a", "open", null], ["b", "closed", 1800]]);
});

test("sessions cross midnight and several days, split at 00:00:00", () => {
  const m = parseTimeclock("i 2026-11-23 23:00:00 night\no 2026-11-26 01:00:00\n");
  const s = m.sessions[0];
  assert.deepEqual(s.segments.map((x) => [x.date, x.seconds]), [["2026-11-23", 3600], ["2026-11-24", 86400], ["2026-11-25", 86400], ["2026-11-26", 3600]]);
  assert.equal(s.durationSeconds, s.segments.reduce((a, x) => a + x.seconds, 0));
  assert.deepEqual(splitAtMidnight(0, 0).map((x) => x.seconds), [0]);
  assert.deepEqual(splitAtMidnight(0, 86400).map((x) => x.seconds), [86400]);       // ends exactly at midnight: no empty trailing day
});

test("unclosed sessions stay open and are never given a duration", () => {
  const m = parseTimeclock("i 2026-11-23 09:00 a\n");
  assert.equal(m.sessions[0].status, "open");
  assert.equal(m.sessions[0].durationSeconds, null);
  assert.deepEqual(codes(m), ["open-session"]);
  const now = { wall: m.sessions[0].start.wall + 90 };
  assert.equal(liveElapsed(m.sessions[0], now), 90);
  assert.equal(liveElapsed(m.sessions[0], { wall: 0 }), 0);                          // clock-in in the future: never negative
  const sum = summarizeTimeclock(m);
  assert.equal(sum.completedSeconds, 0); assert.equal(sum.runningCount, 1);
});

test("unmatched clock-outs, overlapping same-account clock-ins, out-before-in", () => {
  let m = parseTimeclock("o 2026-11-23 10:00 a\n");
  assert.deepEqual(codes(m, "error"), ["unmatched-clock-out"]);
  m = parseTimeclock("i 2026-11-23 09:00 a\no 2026-11-23 10:00 b\n");
  assert.deepEqual(codes(m, "error"), ["unmatched-clock-out"]);
  m = parseTimeclock("o 2026-11-23 10:00\n");
  assert.deepEqual(codes(m, "error"), ["unmatched-clock-out"]);
  m = parseTimeclock("i 2026-11-23 09:00 a\ni 2026-11-23 09:30 a\no 2026-11-23 10:00 a\n");
  assert.deepEqual(codes(m, "error"), ["overlapping-session"]);
  assert.equal(m.sessions.filter((s) => s.status === "invalid").length, 1);
  assert.equal(m.sessions.find((s) => s.status === "closed").durationSeconds, 3600);
  m = parseTimeclock("i 2026-11-23 10:00 a\no 2026-11-23 09:00 a\n");
  assert.deepEqual(codes(m, "error"), ["clock-out-before-clock-in"]);
  assert.equal(m.sessions[0].durationSeconds, null);
  assert.equal(summarizeTimeclock(m).incomplete, true);
});

test("invalid dates and times, with source line numbers and ranges", () => {
  const t = "i 2026-02-30 09:00 a\ni 2026-11-23 25:00 a\ni 26-11-23 09:00 a\ni 2026-11-23 9:00 a\ni 2026-11-23 09:00\nhello\n  i 2026-11-23 09:00 a\n";
  const m = parseTimeclock(t);
  const errs = m.diagnostics.filter((d) => d.severity === "error");
  assert.deepEqual(errs.map((d) => [d.line, d.code]), [[1, "invalid-date"], [2, "invalid-time"], [3, "invalid-date"], [4, "invalid-time"], [5, "missing-account"], [6, "unrecognized-line"], [7, "unexpected-indent"]]);
  const d = errs[0];
  assert.equal(t.slice(d.range.start, d.range.end), "2026-02-30");
  assert.equal(m.sessions.length, 0);
});

test("out-of-order entries warn but are processed in file order; timezone is ignored, mismatch warns", () => {
  const m = parseTimeclock("i 2026-11-23 10:00 a\ni 2026-11-23 09:00 b\no 2026-11-23 11:00 b\no 2026-11-23 12:00 a\n");
  assert.ok(codes(m, "warning").includes("out-of-order"));
  assert.deepEqual(S(m), [["b", "closed", 7200], ["a", "closed", 7200]]);
  const z = parseTimeclock("i 2026-11-23 09:00:00+0530 a\no 2026-11-23 10:00:00+0000 a\n");
  assert.equal(z.sessions[0].durationSeconds, 3600);                                // offsets are not applied
  assert.ok(codes(z).includes("timezone-mismatch") && codes(z).includes("timezone-ignored"));
});

test("a clock-out with a description is an error hledger rejects, but the session is still shown", () => {
  const m = parseTimeclock("i 2026-11-23 09:00 a\no 2026-11-23 10:00 a  nope\n");
  assert.deepEqual(codes(m, "error"), ["clock-out-description"]);
  assert.equal(m.sessions[0].status, "closed");
});

test("the file text is never altered by parsing; CRLF and a missing final newline are handled", () => {
  const t = "i 2026-11-23 09:00 a\r\no 2026-11-23 10:00 a";
  const m = parseTimeclock(t);
  assert.equal(m.text, t);
  assert.equal(m.eol, "\r\n");
  assert.equal(m.sessions[0].durationSeconds, 3600);
  assert.equal(t.slice(m.events[0].ranges.account.start, m.events[0].ranges.account.end), "a");
});

test("clockIn / clockOut append canonical named lines and keep everything else", () => {
  const base = "# my log\ni 2026-11-22 09:00:00 old\no 2026-11-22 10:00:00\n";
  let r = clockIn(base, { date: "2026-11-23", time: "09:00:00", account: "work:programming", description: "Wedger" });
  assert.ok(r.ok); assert.equal(r.text, base + "i 2026-11-23 09:00:00 work:programming  Wedger\n");
  const open = r.model.sessions.find((s) => s.status === "open");
  r = clockOut(r.text, open.id, { date: "2026-11-23", time: "10:30:00" });
  assert.ok(r.ok);
  assert.ok(r.text.endsWith("o 2026-11-23 10:30:00 work:programming\n"));
  assert.equal(r.model.sessions.at(-1).durationSeconds, 5400);
  // no trailing newline in the source: one is supplied, the CRLF style is kept
  assert.equal(clockIn("i 2026-11-23 09:00 a\r\no 2026-11-23 10:00", { date: "2026-11-23", time: "11:00", account: "b" }).text, "i 2026-11-23 09:00 a\r\no 2026-11-23 10:00\r\ni 2026-11-23 11:00:00 b\r\n");
});

test("clockIn refuses a second open session with the same account; clockOut refuses a time before the start", () => {
  const t = "i 2026-11-23 09:00 a\n";
  assert.match(clockIn(t, { date: "2026-11-23", time: "10:00", account: "a" }).error, /already clocked in/);
  assert.match(clockOut(t, "s1", { date: "2026-11-23", time: "08:00" }).error, /before the clock-in/);
  assert.match(clockIn(t, { date: "2026-11-23", time: "10:00", account: "bad;name" }).error, /;/);
  assert.match(clockIn(t, { date: "2026-11-31", time: "10:00", account: "x" }).error, /date/);
  assert.match(clockOut(t, "s99", { date: "2026-11-23", time: "10:00" }).error, /no longer open/);
});

test("clockOut with several open sessions closes exactly the chosen one", () => {
  let t = "i 2026-11-23 09:00 a\ni 2026-11-23 09:10 b\n";
  const m = parseTimeclock(t);
  const r = clockOut(t, m.sessions.find((s) => s.account === "a").id, { date: "2026-11-23", time: "10:00" });
  assert.ok(r.ok);
  assert.deepEqual(r.model.sessions.map((s) => [s.account, s.status]), [["a", "closed"], ["b", "open"]]);
});

test("addSession appends an in and a named out; rejects end < start and a clash with a running account", () => {
  const r = addSession("", { account: "meet", start: { date: "2026-11-20", time: "09:00" }, end: { date: "2026-11-20", time: "09:45" } });
  assert.equal(r.text, "i 2026-11-20 09:00:00 meet\no 2026-11-20 09:45:00 meet\n");
  assert.match(addSession("", { account: "m", start: { date: "2026-11-20", time: "10:00" }, end: { date: "2026-11-20", time: "09:00" } }).error, /before/);
  assert.match(addSession("i 2026-11-23 09:00 m\n", { account: "m", start: { date: "2026-11-20", time: "09:00" }, end: { date: "2026-11-20", time: "10:00" } }).error, /clocked in/);
});

test("deleteSession removes both events and their comment lines, nothing else", () => {
  const t = "# keep\ni 2026-11-23 09:00 a ; x\n  ; more\ni 2026-11-23 09:10 b\no 2026-11-23 10:00 a\n\n# keep too\no 2026-11-23 10:10 b\n";
  const m = parseTimeclock(t);
  const r = deleteSession(t, m.sessions.find((s) => s.account === "a").id);
  assert.ok(r.ok);
  assert.equal(r.text, "# keep\ni 2026-11-23 09:10 b\n\n# keep too\no 2026-11-23 10:10 b\n");
  assert.deepEqual(r.model.sessions.map((s) => s.status), ["closed"]);
});

test("deleting a single event is described honestly and leaves an orphan when asked", () => {
  const t = "i 2026-11-23 09:00 a\no 2026-11-23 10:00 a\n";
  const m = parseTimeclock(t);
  assert.match(describeEventDeletion(m, "e2"), /reopens/);
  assert.match(describeEventDeletion(m, "e1"), /without a session/);
  const r = deleteEvent(t, "e1");
  assert.deepEqual(codes(r.model, "error"), ["unmatched-clock-out"]);
});

test("editSession rewrites only the changed spans; renaming names an unnamed clock-out", () => {
  const t = "# top\ni 2026-11-23 09:00:00 old:acct  desc ; keep\no 2026-11-23 10:00:00\n";
  const m = parseTimeclock(t);
  const id = m.sessions[0].id;
  let r = editSession(t, id, { end: { date: "2026-11-23", time: "10:15:00" } });
  assert.equal(r.text, t.replace("10:00:00", "10:15:00"));
  r = editSession(t, id, { account: "new:acct", description: "other" });
  assert.equal(r.text, "# top\ni 2026-11-23 09:00:00 new:acct  other ; keep\no 2026-11-23 10:00:00 new:acct\n");
  assert.equal(r.model.sessions[0].durationSeconds, 3600);
  r = editSession(t, id, { description: "" });
  assert.equal(r.text, "# top\ni 2026-11-23 09:00:00 old:acct ; keep\no 2026-11-23 10:00:00\n");
  assert.match(editSession(t, id, { end: { date: "2026-11-23", time: "08:00" } }).error, /before the start/);
  assert.equal(editSession(t, id, {}).unchanged, true);
  // moving the start across midnight keeps the session intact
  r = editSession(t, id, { start: { date: "2026-11-22", time: "23:00" } });
  assert.deepEqual(r.model.sessions[0].segments.map((x) => x.date), ["2026-11-22", "2026-11-23"]);
});

test("editing is refused when it would introduce an error", () => {
  const t = "i 2026-11-23 09:00 a\ni 2026-11-23 09:30 b\no 2026-11-23 10:00 a\no 2026-11-23 10:30 b\n";
  const m = parseTimeclock(t);
  const r = editSession(t, m.sessions.find((s) => s.account === "a").id, { account: "b" });
  assert.equal(r.ok, false);
  assert.match(r.error, /invalid/);
});

test("summaries: per day, week, month, account and project come from the intervals", () => {
  const t = "i 2026-11-22 23:00 work:a\no 2026-11-23 01:00 work:a\ni 2026-11-23 09:00 work:b\no 2026-11-23 10:00 work:b\ni 2026-12-01 08:00 home:c\no 2026-12-01 08:30 home:c\n";
  const m = parseTimeclock(t);
  const sum = summarizeTimeclock(m, {}, { weekStart: "monday" });
  assert.equal(sum.completedSeconds, 3600 + 3600 + 3600 + 1800);
  assert.deepEqual(sum.byDay.map((r) => [r.key, r.seconds]), [["2026-11-22", 3600], ["2026-11-23", 7200], ["2026-12-01", 1800]]);
  assert.deepEqual(sum.byMonth.map((r) => [r.key, r.seconds]), [["2026-11", 10800], ["2026-12", 1800]]);
  assert.deepEqual(sum.byWeek.map((r) => r.key), ["2026-11-16", "2026-11-23", "2026-11-30"]);   // Monday weeks (22 Nov 2026 is a Sunday)
  assert.deepEqual(summarizeTimeclock(m, {}, { weekStart: "sunday" }).byWeek.map((r) => r.key), ["2026-11-22", "2026-11-29"]);
  assert.deepEqual(sum.byProject.map((r) => [r.key, r.seconds]), [["work", 10800], ["home", 1800]]);
  assert.equal(sum.completedCount, 3);
  const day = summarizeTimeclock(m, { from: "2026-11-23", to: "2026-11-23" });
  assert.equal(day.completedSeconds, 3600 + 3600);                                     // the midnight-crossing session contributes only its 23rd
  assert.equal(day.completedCount, 2);
  assert.equal(summarizeTimeclock(m, { account: "work" }).completedSeconds, 10800);
  assert.equal(filterSessions(m, { text: "home" }).length, 1);
  assert.equal(filterSessions(m, { status: "running" }).length, 0);
});

test("localNow uses local calendar fields, not UTC", () => {
  const d = new Date(2026, 10, 23, 0, 30, 5);                                          // local midnight-ish: toISOString() could be the 22nd
  const n = localNow(d);
  assert.equal(n.date, "2026-11-23"); assert.equal(n.time, "00:30:05");
});
