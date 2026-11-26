import test from "node:test";
import assert from "node:assert/strict";
import {
  parseTimedot, parseQuantity, buildQuantity, dotsFor, addPosting, editPosting, deletePosting, editDay, deleteDay,
  summarizeTimedot, modeOf,
} from "../assets/js/shell/timedot.js";
import { Rat, formatDuration, formatHours } from "../assets/js/shell/time-format.js";

const secs = (r) => r.toString();
const codes = (m, sev) => m.diagnostics.filter((d) => !sev || d.severity === sev).map((d) => d.code);

test("a day with several accounts and dot quantities", () => {
  const m = parseTimedot("2026-11-23\nwork:programming  .... ....\nwork:research     ..\npersonal:reading  .\n");
  assert.equal(m.days.length, 1);
  assert.deepEqual(m.postings.map((p) => [p.account, secs(p.seconds), p.dots]), [["work:programming", "7200", 8], ["work:research", "1800", 2], ["personal:reading", "900", 1]]);
  assert.equal(secs(m.days[0].seconds), "9900");
  assert.equal(codes(m).length, 0);
});

test("repeated dates, day description and comments (day, entry, continuation)", () => {
  const t = "2026-11-23 Monday focus ; day note\n  ; more day note\nwork  .  ; entry note\n  ; more entry\n\n2026-11-23\nhome  ..\n";
  const m = parseTimedot(t);
  assert.equal(m.days.length, 2);
  assert.equal(m.days[0].description, "Monday focus");
  assert.equal(m.days[0].comment, "day note\nmore day note");
  assert.equal(m.postings[0].comment, "entry note\nmore entry");
  const sum = summarizeTimedot(m);
  assert.equal(sum.dayCount, 1);                                                     // both groups are the same date
  assert.equal(secs(sum.totalSeconds), "2700");
});

test("dots: grouping spaces are ignored, trailing spaces too", () => {
  assert.equal(secs(parseQuantity(".... ..   ").seconds), "5400");
  assert.equal(parseQuantity(". . . .").dots, 4);
  assert.equal(secs(parseQuantity("....").seconds), "3600");
});

test("numbers and every unit convert exactly", () => {
  const h = (s) => secs(parseQuantity(s).seconds);
  assert.equal(h("8"), "28800");
  assert.equal(h("1.5"), "5400");
  assert.equal(h("1.5h"), "5400");
  assert.equal(h(".5"), "1800");
  assert.equal(h("90s"), "90");
  assert.equal(h("5m"), "300");                                                        // hledger rounds this to 0.08 h; Wedger is exact
  assert.equal(h("2h"), "7200");
  assert.equal(h("2d"), "172800");
  assert.equal(h("1w"), "604800");
  assert.equal(h("1mo"), String(30 * 86400));
  assert.equal(h("1y"), String(365 * 86400));
  assert.equal(h("0.001h"), "18/5");                                                   // 3.6 s, no float noise
  assert.equal(parseQuantity("0.1h").seconds.add(parseQuantity("0.2h").seconds).equals(parseQuantity("0.3h").seconds), true);
});

test("exact accumulation: no floating-point drift", () => {
  const m = parseTimedot("2026-11-23\n" + Array.from({ length: 10 }, (_, i) => `a${i}  0.1h`).join("\n") + "\n");
  assert.equal(secs(m.totalSeconds), "3600");
  assert.equal(formatHours(m.totalSeconds), "1.00");
});

test("zero amounts and account-only entries", () => {
  const m = parseTimedot("2026-11-23\nidle\nalso  \nzero  0\nreal  .\n");
  assert.deepEqual(m.postings.map((p) => [p.account, p.kind, secs(p.seconds)]), [["idle", "empty", "0"], ["also", "empty", "0"], ["zero", "number", "0"], ["real", "dots", "900"]]);
  assert.equal(codes(m, "error").length, 0);
});

test("letter notation: counted, typed, aggregated, original text kept", () => {
  const t = "2026-11-23\nwork:administration  ccecces\nwork:administration  c e\n";
  const m = parseTimedot(t);
  const p = m.postings[0];
  assert.equal(p.kind, "letters");
  assert.deepEqual(p.types.map((x) => [x.type, x.count, secs(x.seconds)]), [["c", 4, "3600"], ["e", 2, "1800"], ["s", 1, "900"]]);
  assert.equal(secs(p.seconds), "6300");
  assert.equal(p.raw, "ccecces");
  const sum = summarizeTimedot(m);
  assert.deepEqual(sum.byType.map((r) => [r.key, secs(r.seconds)]), [["c", "4500"], ["e", "2700"], ["s", "900"]]);
  assert.equal(secs(sum.totalSeconds), "8100");
  assert.equal(parseQuantity("Aa").types.length, 2);                                  // letters are case-sensitive types
});

test("Org-mode: headings before the first date are ignored; after it a leading * is ignored on dates and entries", () => {
  const t = "* Project notes\n** whatever 12 words\n* 2026-11-23 Monday\n* work:a  ..\n** work:b  .\n* just a heading\n";
  const m = parseTimedot(t);
  assert.equal(m.days.length, 1);
  assert.equal(m.days[0].description, "Monday");
  assert.deepEqual(m.postings.map((p) => [p.account, secs(p.seconds)]), [["work:a", "1800"], ["work:b", "900"], ["just a heading", "0"]]);
  assert.equal(m.lines[0].kind, "heading");
  assert.deepEqual(codes(m), ["org-heading-entry"]);                                  // surfaced, not hidden
});

test("# and ; comment lines are ignored; text before the first date is not silently accepted", () => {
  const m = parseTimedot("# a\n; b\n\nwork  ..\n2026-11-23\n# c\nx  .\n");
  assert.deepEqual(m.diagnostics.map((d) => [d.line, d.code]), [[4, "unsupported-line"]]);
  assert.equal(m.postings.length, 1);
});

test("journal directives are reported and preserved, never read as accounts", () => {
  const t = "account assets:bank\n2026-11-23\ncommodity 1.00h\ninclude other.journal\nP 2026-11-23 X 1\nreal  .\n";
  const m = parseTimedot(t);
  assert.deepEqual(codes(m, "error"), ["unsupported-directive", "unsupported-directive", "unsupported-directive", "unsupported-directive"]);
  assert.deepEqual(m.postings.map((p) => p.account), ["real"]);
  assert.equal(m.text, t);
});

test("invalid quantities and dates carry line numbers and are excluded from totals", () => {
  const t = "2026-11-23\na  1,5\nb  1.5 h\nc  5x\nd  ..  x\ne  -1\nf  .\n2026-02-30\ng  .\n11-23\nh  .\n";
  const m = parseTimedot(t);
  assert.deepEqual(m.diagnostics.filter((d) => d.severity === "error").map((d) => [d.line, d.code]),
    [[2, "invalid-amount"], [3, "invalid-amount"], [4, "invalid-amount"], [5, "invalid-amount"], [6, "invalid-amount"], [8, "invalid-date"], [10, "invalid-date"]]);
  assert.equal(secs(m.totalSeconds), "900");                                          // only f counts
  const d = m.diagnostics.find((x) => x.line === 2);
  assert.equal(t.slice(d.range.start, d.range.end), "1,5");
  const sum = summarizeTimedot(m);
  assert.equal(sum.incomplete, true);
  assert.equal(sum.excluded, 7);
});

test("one space between account and dots is warned about", () => {
  const m = parseTimedot("2026-11-23\nwork ....\nroom 101\n");
  assert.deepEqual(m.diagnostics.map((d) => [d.line, d.code, d.severity]), [[2, "missing-double-space", "warning"]]);
  assert.equal(m.postings[0].account, "work ....");
});

test("a tab separates account and amount; indentation is allowed", () => {
  const m = parseTimedot("2026-11-23\n\twork\t..\n    home  .\n");
  assert.deepEqual(m.postings.map((p) => [p.account, secs(p.seconds)]), [["work", "1800"], ["home", "900"]]);
});

test("dotsFor and buildQuantity never round", () => {
  assert.equal(dotsFor(5400), ".... ..");
  assert.equal(dotsFor(1200), null);
  assert.equal(buildQuantity("dots", "1.25").text, ".... .");
  assert.match(buildQuantity("dots", "0.3").error, /15-minute/);
  assert.match(buildQuantity("dots", "0").error, /15-minute/);
  assert.equal(buildQuantity("dots", "....   ..").text, ".... ..");
  assert.equal(buildQuantity("h", "1.5").text, "1.5h");
  assert.equal(buildQuantity("mo", "1").text, "1mo");
  assert.ok(buildQuantity("h", "1,5").error);
  assert.equal(buildQuantity("letters", "cce").text, "cce");
  assert.ok(buildQuantity("letters", "c1").error);
  assert.deepEqual(modeOf(parseTimedot("2026-11-23\na  90m\nb  ccc\n").postings[0]), { mode: "m", value: "90" });
});

test("round trip: parsing never changes the text, ranges point at the right spans", () => {
  const t = "# top\r\n\r\n2026-11-23 x ; c\r\n  work  ..  ; n\r\nidle\r\n";
  const m = parseTimedot(t);
  assert.equal(m.text, t);
  const p = m.postings[0];
  assert.equal(t.slice(p.ranges.account.start, p.ranges.account.end), "work");
  assert.equal(t.slice(p.ranges.amount.start, p.ranges.amount.end), "..");
  assert.equal(t.slice(p.ranges.comment.start, p.ranges.comment.end), "; n");
  assert.equal(m.eol, "\r\n");
});

test("addPosting: to an existing date, keeping its indentation and amount column", () => {
  const t = "2026-11-23\n  work:a    ..\n  work:b    .\n\n2026-11-24\nx  .\n";
  const r = addPosting(t, { date: "2026-11-23", account: "work:c", quantityText: "1h", comment: "new" });
  assert.equal(r.text, "2026-11-23\n  work:a    ..\n  work:b    .\n  work:c    1h  ; new\n\n2026-11-24\nx  .\n");
  assert.equal(secs(r.model.totalSeconds), String(1800 + 900 + 3600 + 900));
});

test("addPosting: a new date group — in order when the file is in order, else at the end", () => {
  const t = "# log\n2026-11-20\na  .\n\n# week 2\n2026-11-25\nb  .\n";
  let r = addPosting(t, { date: "2026-11-22", account: "n", quantityText: ".." });
  assert.equal(r.text, "# log\n2026-11-20\na  .\n\n2026-11-22\nn  ..\n\n# week 2\n2026-11-25\nb  .\n");
  r = addPosting(t, { date: "2026-11-30", account: "n", quantityText: "2h" });
  assert.equal(r.text, t + "\n2026-11-30\nn  2h\n");
  r = addPosting("2026-11-25\nb  .\n\n2026-11-20\na  .\n", { date: "2026-11-22", account: "n", quantityText: "." });   // not in order: append
  assert.ok(r.text.endsWith("2026-11-20\na  .\n\n2026-11-22\nn  .\n"));
  assert.equal(addPosting("", { date: "2026-11-23", account: "a", quantityText: "." }).text, "2026-11-23\na  .\n");
  assert.equal(addPosting("2026-11-23\na  .", { date: "2026-11-24", account: "b", quantityText: "." }).text, "2026-11-23\na  .\n\n2026-11-24\nb  .\n");
});

test("addPosting uses the LAST group of a repeated date and keeps CRLF files CRLF", () => {
  const t = "2026-11-23\r\na  .\r\n2026-11-23\r\nb  .\r\n";
  const r = addPosting(t, { date: "2026-11-23", account: "c", quantityText: "." });
  assert.equal(r.text, "2026-11-23\r\na  .\r\n2026-11-23\r\nb  .\r\nc  .\r\n");
});

test("addPosting validates: account, date, quantity; refuses to create an invalid file", () => {
  const t = "2026-11-23\na  .\n";
  assert.ok(addPosting(t, { date: "2026-11-23", account: "", quantityText: "." }).error);
  assert.ok(addPosting(t, { date: "2026-11-23", account: "a;b", quantityText: "." }).error);
  assert.ok(addPosting(t, { date: "2026-13-23", account: "a", quantityText: "." }).error);
  assert.ok(addPosting(t, { date: "2026-11-23", account: "a", quantityText: "1,5" }).error);
  assert.ok(addPosting(t, { date: "2026-11-23", account: "account foo", quantityText: "." }).error);
  assert.ok(addPosting(t, { date: "2026-11-23", account: "2026-11-24", quantityText: "." }).error);
});

test("editPosting rewrites only the amount (or account, or comment) span", () => {
  const t = "# x\n2026-11-23\nwork:a   ....  ; keep\nwork:b   ccec\n";
  const m = parseTimedot(t);
  let r = editPosting(t, m.postings[0].id, { quantityText: "90m" });
  assert.equal(r.text, "# x\n2026-11-23\nwork:a   90m  ; keep\nwork:b   ccec\n");
  r = editPosting(t, m.postings[0].id, { account: "work:z" });
  assert.equal(r.text, t.replace("work:a ", "work:z "));
  r = editPosting(t, m.postings[0].id, { comment: "" });
  assert.equal(r.text, "# x\n2026-11-23\nwork:a   ....\nwork:b   ccec\n");
  r = editPosting(t, m.postings[1].id, { comment: "typed" });
  assert.equal(r.text, t.replace("ccec\n", "ccec  ; typed\n"));
  r = editPosting(t, m.postings[1].id, { quantityText: "" });
  assert.equal(r.text, "# x\n2026-11-23\nwork:a   ....  ; keep\nwork:b\n");
  assert.equal(editPosting(t, m.postings[1].id, { quantityText: "ccec" }).unchanged, true);   // letters untouched unless the user edits them
  assert.ok(editPosting(t, m.postings[0].id, { quantityText: "1,5" }).error);
  // an amount added to an account-only entry
  const e = parseTimedot("2026-11-23\nidle\n");
  assert.equal(editPosting("2026-11-23\nidle\n", e.postings[0].id, { quantityText: ".." }).text, "2026-11-23\nidle  ..\n");
});

test("editing an entry with letters keeps type information when the letters are kept", () => {
  const t = "2026-11-23\nw  ccecces\n";
  const r = editPosting(t, "p2", { account: "w2" });
  assert.deepEqual(r.model.postings[0].types.map((x) => x.type), ["c", "e", "s"]);
  assert.equal(r.model.postings[0].raw, "ccecces");
});

test("deletePosting removes the entry and its comment lines only", () => {
  const t = "2026-11-23\na  .  ; x\n  ; more\nb  ..\n# between\nc  ...\n";
  const m = parseTimedot(t);
  const r = deletePosting(t, m.postings[0].id);
  assert.equal(r.text, "2026-11-23\nb  ..\n# between\nc  ...\n");
  assert.equal(secs(r.model.totalSeconds), String(1800 + 2700));
});

test("editDay / deleteDay", () => {
  const t = "2026-11-23 old ; c\na  .\n\n2026-11-24\nb  .\n";
  const m = parseTimedot(t);
  assert.equal(editDay(t, m.days[0].id, { description: "new" }).text, t.replace("old", "new"));
  assert.equal(editDay(t, m.days[0].id, { date: "2026-11-22" }).text, t.replace("2026-11-23", "2026-11-22"));
  assert.equal(editDay(t, m.days[1].id, { description: "hi" }).text, t.replace("2026-11-24\n", "2026-11-24 hi\n"));
  assert.equal(deleteDay(t, m.days[0].id).text, "\n2026-11-24\nb  .\n");
  assert.ok(editDay(t, m.days[0].id, { date: "nope" }).error);
});

test("summaries: day, week, month, account, project, type, filters, average", () => {
  const t = "2026-11-22\nwork:a  2h\n2026-11-23\nwork:a  1h\nhome:b  ccec\n2026-12-01\nwork:c  30m\n";
  const m = parseTimedot(t);
  const s = summarizeTimedot(m, {}, { weekStart: "monday" });
  assert.equal(secs(s.totalSeconds), String(7200 + 3600 + 3600 + 1800));
  assert.equal(s.dayCount, 3);
  assert.equal(secs(s.averageSeconds), "5400");
  assert.deepEqual(s.byMonth.map((r) => [r.key, secs(r.seconds)]), [["2026-11", "14400"], ["2026-12", "1800"]]);
  assert.deepEqual(s.byWeek.map((r) => r.key), ["2026-11-16", "2026-11-23", "2026-11-30"]);
  assert.deepEqual(s.byProject.map((r) => [r.key, secs(r.seconds)]), [["work", "12600"], ["home", "3600"]]);
  assert.deepEqual(s.byType.map((r) => r.key), ["c", "e"]);
  assert.equal(secs(summarizeTimedot(m, { from: "2026-11-23", to: "2026-11-23" }).totalSeconds), "7200");
  assert.equal(secs(summarizeTimedot(m, { account: "work" }).totalSeconds), "12600");
  assert.equal(secs(summarizeTimedot(m, { account: "work:a" }).totalSeconds), "10800");
  assert.equal(secs(summarizeTimedot(m, { text: "home" }).totalSeconds), "3600");
  assert.equal(summarizeTimedot(parseTimedot("")).averageSeconds, null);
});

test("duration formatting", () => {
  assert.deepEqual([900, 3600, 5400, 29700, 3661, 45, 0].map(formatDuration), ["15m", "1h", "1h 30m", "8h 15m", "1h 1m 1s", "45s", "0m"]);
  assert.equal(formatDuration(new Rat(18n, 5n)), "4s");
  assert.equal(formatHours(5400), "1.50");
  assert.equal(formatHours(new Rat(300n)), "0.08");
});
