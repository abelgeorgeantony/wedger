import test from "node:test";
import assert from "node:assert/strict";
import { TIMECLOCK, TIMEDOT } from "./time-fixtures.mjs";
import {
  parseTimeclock, clockIn, clockOut, addSession, editSession, deleteSession, deleteSessions,
} from "../assets/js/shell/timeclock.js";
import {
  parseTimedot, addPosting, editPosting, deletePosting, deletePostings, addDay, editDay, movePosting,
} from "../assets/js/shell/timedot.js";

const sessionOf = (text, account, date) => parseTimeclock(text).sessions.find((s) => s.account === account && s.start.date === date);

/* ============================================================ timeclock dialogs */
test("clock in writes one open session and nothing else changes", () => {
  const r = clockIn("", { date: "2026-11-26", time: "09:15:00", account: "work:code", description: "Review" });
  assert.equal(r.ok, true);
  assert.equal(r.text, "i 2026-11-26 09:15:00 work:code  Review\n");
  const s = parseTimeclock(r.text).sessions[0];
  assert.equal(s.status, "open");
  assert.equal(s.description, "Review");
});

test("clock in refuses a missing account and a bad time, leaving the text untouched", () => {
  assert.equal(clockIn(TIMECLOCK, { date: "2026-11-26", time: "09:00:00", account: "" }).ok, false);
  assert.equal(clockIn(TIMECLOCK, { date: "2026-11-26", time: "25:99:00", account: "a" }).ok, false);
  assert.equal(clockIn(TIMECLOCK, { date: "2026-13-40", time: "09:00:00", account: "a" }).ok, false);
});

test("add a completed historical session: a linked clock-in and clock-out", () => {
  const r = addSession(TIMECLOCK, { account: "work:docs", description: "Write", start: { date: "2026-11-20", time: "10:00:00" }, end: { date: "2026-11-20", time: "11:30:00" } });
  assert.equal(r.ok, true);
  const s = sessionOf(r.text, "work:docs", "2026-11-20");
  assert.equal(s.status, "closed");
  assert.equal(s.durationSeconds, 5400);
  assert.ok(s.outEvent, "the clock-out is linked to the clock-in");
});

test("a session may cross midnight, and a negative duration is refused, never silently produced", () => {
  const ok = addSession("", { account: "night", start: { date: "2026-11-20", time: "23:00:00" }, end: { date: "2026-11-21", time: "01:30:00" } });
  assert.equal(ok.ok, true);
  assert.equal(parseTimeclock(ok.text).sessions[0].durationSeconds, 9000);
  const bad = addSession(TIMECLOCK, { account: "x", start: { date: "2026-11-20", time: "12:00:00" }, end: { date: "2026-11-20", time: "11:00:00" } });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /before|after|end/i);
});

test("edit a completed session: account, description, start and end change; nothing else on the lines does", () => {
  const s = sessionOf(TIMECLOCK, "work:code", "2026-11-23");
  const r = editSession(TIMECLOCK, s.id, { account: "work:review", description: "Reviewed", start: { date: "2026-11-23", time: "09:30:00" }, end: { date: "2026-11-23", time: "12:00:00" } });
  assert.equal(r.ok, true);
  const e = sessionOf(r.text, "work:review", "2026-11-23");
  assert.equal(e.description, "Reviewed");
  assert.equal(e.durationSeconds, 9000);
  assert.equal(e.status, "closed");
  // the other sessions' lines are byte-for-byte unchanged
  assert.ok(r.text.includes("i 2026-11-24 14:00:00 work:mail"));
  assert.ok(r.text.includes("; late"), "an unrelated comment survives");
});

test("editing an OPEN session keeps it open, even when a patch carries an end", () => {
  const open = sessionOf(TIMECLOCK, "work:code", "2026-11-25");
  assert.equal(open.status, "open");
  const r = editSession(TIMECLOCK, open.id, { account: "work:renamed", description: "now with words" });
  assert.equal(r.ok, true);
  const after = sessionOf(r.text, "work:renamed", "2026-11-25");
  assert.equal(after.status, "open", "editing the account/description must not complete it");
  assert.equal(after.outEvent ?? null, null);
  assert.equal(after.description, "now with words");
  const outs = (t) => t.split("\n").filter((l) => l.startsWith("o ")).length;
  assert.equal(outs(r.text), outs(TIMECLOCK), "no clock-out was invented");
});

test("renaming a session whose clock-out has an account keeps the pair linked", () => {
  const text = "i 2026-11-23 09:00:00 a:b\no 2026-11-23 10:00:00 a:b\n";
  const s = parseTimeclock(text).sessions[0];
  const r = editSession(text, s.id, { account: "a:c" });
  assert.equal(r.ok, true);
  const e = parseTimeclock(r.text).sessions[0];
  assert.equal(e.account, "a:c");
  assert.equal(e.status, "closed");
  assert.equal(r.text, "i 2026-11-23 09:00:00 a:c\no 2026-11-23 10:00:00 a:c\n");
});

test("clock out stops exactly the intended session, not 'the most recent one'", () => {
  const text = "i 2026-11-25 08:00:00 first\ni 2026-11-25 09:00:00 second\n";
  const m = parseTimeclock(text);
  const first = m.sessions.find((s) => s.account === "first");
  const r = clockOut(text, first.id, { date: "2026-11-25", time: "10:00:00" });
  assert.equal(r.ok, true);
  const after = parseTimeclock(r.text).sessions;
  assert.equal(after.find((s) => s.account === "first").status, "closed");
  assert.equal(after.find((s) => s.account === "first").durationSeconds, 7200);
  assert.equal(after.find((s) => s.account === "second").status, "open");
});

test("clock out before the clock-in is refused", () => {
  const open = sessionOf(TIMECLOCK, "work:code", "2026-11-25");
  const r = clockOut(TIMECLOCK, open.id, { date: "2026-11-25", time: "07:00:00" });
  assert.equal(r.ok, false);
});

/* ======================================================= timeclock selection and delete */
test("deleting a session removes its clock-in AND clock-out (and its comment lines) together", () => {
  const s = sessionOf(TIMECLOCK, "home:chores", "2026-11-23");
  const r = deleteSession(TIMECLOCK, s.id);
  assert.equal(r.ok, true);
  assert.equal(r.text.includes("home:chores"), false);
  assert.equal(r.text.includes("2026-11-24 01:00:00"), false, "no orphaned clock-out");
  assert.equal(parseTimeclock(r.text).counts.error, 0);
});

test("bulk delete: several sessions in one edit, no orphan events, unrelated lines untouched", () => {
  const m = parseTimeclock(TIMECLOCK);
  const ids = [m.sessions[0].id, m.sessions[2].id];
  const r = deleteSessions(TIMECLOCK, ids);
  assert.equal(r.ok, true);
  assert.equal(r.deleted, 2);
  const after = parseTimeclock(r.text);
  assert.equal(after.counts.error, 0);
  assert.equal(after.sessions.length, m.sessions.length - 2);
  assert.ok(r.text.includes("i 2026-11-23 22:00:00 home:chores"), "the unselected session is intact");
});

test("bulk delete is atomic: one stale id refuses the whole batch and changes nothing", () => {
  const m = parseTimeclock(TIMECLOCK);
  const r = deleteSessions(TIMECLOCK, [m.sessions[0].id, "s999"]);
  assert.equal(r.ok, false);
  assert.match(r.error, /no longer exists|nothing was deleted/i);
  assert.equal(deleteSessions(TIMECLOCK, []).ok, false);
});

test("deleting a paired session leaves an interleaved open session paired as it was", () => {
  // The account-less clock-out at 10:00 closes B (the most recent open session); A pairs with the one at 11:00.
  const text = "i 2026-11-25 08:00:00 A\ni 2026-11-25 09:00:00 B\no 2026-11-25 10:00:00\no 2026-11-25 11:00:00\n";
  const b = parseTimeclock(text).sessions.find((s) => s.account === "B");
  const r = deleteSessions(text, [b.id]);
  assert.equal(r.ok, true);
  const after = parseTimeclock(r.text);
  assert.equal(after.sessions.length, 1);
  assert.equal(after.sessions[0].account, "A");
  assert.equal(after.sessions[0].durationSeconds, 10800);
});

test("a deletion that would change how OTHER clock-ins pair up is refused, and the text is left alone", () => {
  // The second clock-in for X is rejected (X is already running). Deleting the FIRST X session would silently turn
  // that rejected line into a live, running session: not what the person asked for.
  const text = "i 2026-11-25 08:00:00 X\ni 2026-11-25 08:30:00 X\no 2026-11-25 10:00:00 X\n";
  const m = parseTimeclock(text);
  const first = m.sessions.find((s) => s.status === "closed");
  assert.ok(first, "the first X session is the completed one");
  assert.ok(m.sessions.some((s) => s.status === "invalid"), "the duplicate clock-in is flagged");
  const r = deleteSessions(text, [first.id]);
  assert.equal(r.ok, false);
  assert.match(r.error, /pair up|Raw view/i);
});

/* ============================================================== timedot dialogs */
test("add an entry under an existing day, and under a new day in date order", () => {
  const a = addPosting(TIMEDOT, { date: "2026-11-24", account: "home:cook", quantityText: "45m", comment: "dinner" });
  assert.equal(a.ok, true);
  assert.ok(/2026-11-24\nwork:code {2}2h\nhome:cook {2}45m {2}; dinner\n/.test(a.text) || a.text.includes("home:cook  45m  ; dinner"));
  const b = addPosting(TIMEDOT, { date: "2026-11-22", account: "x", quantityText: "1h" });
  assert.equal(b.ok, true);
  assert.ok(b.text.indexOf("2026-11-22") < b.text.indexOf("2026-11-23"), "the new day is inserted before the later ones");
  assert.equal(parseTimedot(b.text).counts.error, 0);
});

test("every quantity form is accepted and never rounded silently", () => {
  for (const q of ["1.5", "90m", "1.5h", "30s", "1d", "2w", "1mo", "1y", "....", "ccec"]) {
    const r = addPosting("", { date: "2026-11-23", account: "a", quantityText: q });
    assert.equal(r.ok, true, `${q}: ${r.error}`);
  }
  const bad = addPosting("", { date: "2026-11-23", account: "a", quantityText: "1.5 dots" });
  assert.equal(bad.ok, false);
});

test("edit an entry: only the changed parts are rewritten; the letter notation is preserved when the amount is not touched", () => {
  const m = parseTimedot(TIMEDOT);
  const letters = m.postings.find((p) => p.raw === "ccec");
  const r = editPosting(TIMEDOT, letters.id, { comment: "late evening" });
  assert.equal(r.ok, true);
  assert.ok(r.text.includes("home:read  ccec  ; late evening"));
  const after = parseTimedot(r.text).postings.find((p) => p.raw === "ccec");
  assert.deepEqual(after.types.map((t) => t.type).sort(), ["c", "e"]);
  // an edit with no changes is a no-op
  assert.equal(editPosting(TIMEDOT, letters.id, {}).text, TIMEDOT);
});

test("editing the date moves the entry (with its comment lines) under that day", () => {
  const src = "2026-11-23\nhome:read  ccec  ; evening\n  ; second line\n2026-11-25\nwork  1h\n";
  const p = parseTimedot(src).postings[0];
  const r = movePosting(src, p.id, { date: "2026-11-25", account: "home:study" });
  assert.equal(r.ok, true);
  const m = parseTimedot(r.text);
  const moved = m.postings.find((x) => x.account === "home:study");
  assert.equal(m.days.find((d) => d.id === moved.dayId).date, "2026-11-25");
  assert.equal(moved.raw, "ccec");
  assert.ok(r.text.includes("  ; second line"));
  assert.equal(m.totalSeconds.toString(), parseTimedot(src).totalSeconds.toString(), "no time gained or lost");
  // a move to a date that has no day creates it, in order
  const r2 = movePosting(src, p.id, { date: "2026-11-24" });
  assert.equal(r2.ok, true);
  assert.ok(r2.text.indexOf("2026-11-24") > r2.text.indexOf("2026-11-23") && r2.text.indexOf("2026-11-24") < r2.text.indexOf("2026-11-25"));
});

test("add a day: empty heading, in order, refused when the date already exists", () => {
  const r = addDay(TIMEDOT, { date: "2026-11-25", description: "Conference" });
  assert.equal(r.ok, true);
  assert.ok(r.text.trimEnd().endsWith("2026-11-25 Conference"));
  const dup = addDay(TIMEDOT, { date: "2026-11-23" });
  assert.equal(dup.ok, false);
  assert.match(dup.error, /already/);
  assert.equal(addDay(TIMEDOT, { date: "2026-11-25", description: "a;b" }).ok, false);
  // entries can be added to the new day afterwards
  const again = addPosting(r.text, { date: "2026-11-25", account: "talk", quantityText: "1h" });
  assert.equal(again.ok, true);
  assert.equal(parseTimedot(again.text).days.find((d) => d.date === "2026-11-25").postings.length, 1);
});

test("add a day before later days keeps the file in date order", () => {
  const r = addDay(TIMEDOT, { date: "2026-11-22" });
  assert.equal(r.ok, true);
  assert.ok(r.text.indexOf("2026-11-22") < r.text.indexOf("2026-11-23"));
});

test("edit a day: the date and description change on the heading line only", () => {
  const d = parseTimedot(TIMEDOT).days[0];
  const r = editDay(TIMEDOT, d.id, { date: "2026-11-22", description: "Sunday" });
  assert.equal(r.ok, true);
  assert.ok(r.text.startsWith("2026-11-22 Sunday\n"));
  assert.equal(parseTimedot(r.text).totalSeconds.toString(), parseTimedot(TIMEDOT).totalSeconds.toString());
});

/* ================================================== timedot selection and delete */
test("delete one entry: its line and comment lines go, the day heading and neighbours stay", () => {
  const src = "2026-11-23 Mon\na  1h\n  ; about a\nb  2h\n";
  const a = parseTimedot(src).postings[0];
  const r = deletePosting(src, a.id);
  assert.equal(r.ok, true);
  assert.equal(r.text, "2026-11-23 Mon\nb  2h\n");
});

test("delete several entries in one edit; headings, comments and other entries are untouched", () => {
  const m = parseTimedot(TIMEDOT);
  const doomed = [m.postings[0], m.postings[2]];
  const r = deletePostings(TIMEDOT, doomed.map((p) => p.id));
  assert.equal(r.ok, true);
  assert.equal(r.deleted, 2);
  const after = parseTimedot(r.text);
  assert.equal(after.days.length, 2, "both day headings stay");
  assert.deepEqual(after.postings.map((p) => p.account), ["home:read", "work:code"]);
  assert.ok(r.text.includes("home:read  ccec  ; evening"), "the letters entry keeps its notation and comment");
});

test("bulk entry deletion is atomic: a missing id refuses the batch and nothing changes", () => {
  const m = parseTimedot(TIMEDOT);
  const r = deletePostings(TIMEDOT, [m.postings[0].id, "p999"]);
  assert.equal(r.ok, false);
  assert.equal(deletePostings(TIMEDOT, []).ok, false);
});

test("bulk deletion only removes what was selected, even from a different day", () => {
  const m = parseTimedot(TIMEDOT);
  const last = m.postings.at(-1);
  const r = deletePostings(TIMEDOT, [last.id]);
  assert.equal(r.ok, true);
  assert.equal(parseTimedot(r.text).postings.length, m.postings.length - 1);
  assert.ok(r.text.includes("2026-11-24"), "the now-empty day heading is not removed");
});
