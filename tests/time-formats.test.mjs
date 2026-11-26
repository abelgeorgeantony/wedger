import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  Rat, timeKindOf, isNativeTimeFile, splitLines, applyEdits, appendLine, appendFragment, parseSimpleDate, parseClockTime,
  addDaysIso, weekStartIso, weekdayOf, daysFromIso, formatDateLabel, formatMonthLabel, matchesText,
} from "../assets/js/shell/time-format.js";
import { planTimeImport } from "../assets/js/shell/time-import.js";
import { templatesFor, resolveTemplate, previewOf } from "../assets/js/shell/templates.js";
import { parseTimeclock } from "../assets/js/shell/timeclock.js";
import { parseTimedot } from "../assets/js/shell/timedot.js";
import { analyzeTimeclockLine } from "../assets/js/shell/timeclock.js";
import { analyzeTimedotLine } from "../assets/js/shell/timedot.js";

const json = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const templates = json("../assets/special/templates.json");
const manifest = json("../assets/special/manifest.json");

/* ----------------------------------------------------------------- helpers */
test("Rat is exact", () => {
  assert.equal(Rat.parseDecimal("0.1").add(Rat.parseDecimal("0.2")).equals(Rat.parseDecimal("0.3")), true);
  assert.equal(Rat.parseDecimal("2.675").toFixed(2), "2.68");
  assert.equal(new Rat(-5n, 2n).toFixed(0), "-3");
  assert.equal(Rat.parseDecimal("1e3"), null);
  assert.equal(Rat.parseDecimal("-1"), null);
  assert.equal(Rat.parseDecimal("."), null);
  assert.equal(new Rat(6n, 4n).toString(), "3/2");
});

test("file kinds", () => {
  assert.equal(timeKindOf("work.timeclock"), "timeclock");
  assert.equal(timeKindOf("WORK.TIMEDOT"), "timedot");
  assert.equal(timeKindOf("a.journal"), null);
  assert.equal(timeKindOf("a.timeclock.rules"), null);
  assert.equal(isNativeTimeFile("x.csv"), false);
});

test("splitLines keeps offsets and exact line endings; applyEdits is atomic", () => {
  const t = "a\r\nbb\nccc";
  const ls = splitLines(t);
  assert.deepEqual(ls.map((l) => [l.text, l.start, l.end, l.eol]), [["a", 0, 1, "\r\n"], ["bb", 3, 5, "\n"], ["ccc", 6, 9, ""]]);
  assert.equal(applyEdits(t, [{ start: 6, end: 9, text: "Z" }, { start: 0, end: 1, text: "A" }]), "A\r\nbb\nZ");
  assert.throws(() => applyEdits(t, [{ start: 0, end: 4, text: "" }, { start: 3, end: 5, text: "" }]));
  assert.equal(appendLine("a", "b"), "a\nb\n");
  assert.equal(appendLine("a\r\n", "b"), "a\r\nb\r\n");
});

test("dates: simple dates, calendar arithmetic and weeks", () => {
  assert.equal(parseSimpleDate("2026/4/1").iso, "2026-04-01");
  assert.equal(parseSimpleDate("2026-02-29").valid, false);
  assert.equal(parseSimpleDate("2024-02-29").valid, true);
  assert.equal(parseSimpleDate("2026-11/23"), null);
  assert.equal(parseSimpleDate("11-23"), null);
  assert.equal(addDaysIso("2026-12-31", 1), "2027-01-01");
  assert.equal(weekdayOf("2026-11-23"), 1);
  assert.equal(weekStartIso("2026-11-23", "monday"), "2026-11-23");
  assert.equal(weekStartIso("2026-11-22", "monday"), "2026-11-16");
  assert.equal(weekStartIso("2026-11-22", "sunday"), "2026-11-22");
  assert.equal(daysFromIso("1970-01-02"), 1);
  assert.equal(formatDateLabel("2026-11-23"), "Mon, 23 Nov 2026");
  assert.equal(formatMonthLabel("2026-11"), "November 2026");
});

test("times", () => {
  assert.equal(parseClockTime("09:05").seconds, 32700);
  assert.equal(parseClockTime("09:05:10+0530").tz, "+0530");
  assert.equal(parseClockTime("9:05"), null);
  assert.equal(parseClockTime("24:00").valid, false);
  assert.equal(parseClockTime("23:59:60").valid, false);
});

test("appendFragment keeps the fragment exactly and supplies only line breaks", () => {
  assert.equal(appendFragment("timeclock", "i a\n", "o b\n"), "i a\no b\n");
  assert.equal(appendFragment("timeclock", "i a", "o b"), "i a\no b");
  assert.equal(appendFragment("timedot", "2026-11-23\na  .\n", "2026-11-24\nb  .\n"), "2026-11-23\na  .\n\n2026-11-24\nb  .\n");
  assert.equal(appendFragment("timedot", "2026-11-23\na  .\n\n", "2026-11-24\nb  .\n"), "2026-11-23\na  .\n\n2026-11-24\nb  .\n");
  assert.equal(appendFragment("timedot", "", "x"), "x");
  assert.equal(appendFragment("timedot", "a\r\n", "b\r\n"), "a\r\n\r\nb\r\n");
});

test("matchesText is a case-insensitive all-words match", () => {
  assert.equal(matchesText(["Work:Admin", "weekly report"], "admin report"), true);
  assert.equal(matchesText(["Work:Admin"], "zzz"), false);
  assert.equal(matchesText([], ""), true);
});

test("line analysis is the single description of each format (used by parser and highlighting)", () => {
  const a = analyzeTimeclockLine("i 2026-11-23 09:00:00+0100 work:a  desc ; c");
  assert.equal(a.kind, "entry");
  assert.deepEqual([a.date.text, a.time.text, a.tz.text, a.account.text, a.description.text, a.comment.text], ["2026-11-23", "09:00:00+0100", "+0100", "work:a", "desc", "c"]);
  assert.equal(analyzeTimeclockLine("   ; x").kind, "comment");
  assert.equal(analyzeTimeclockLine("invoice").kind, "unknown");
  const d = analyzeTimedotLine("* 2026-11-23 Mon", { seenDate: false });
  assert.equal(d.kind, "date"); assert.ok(d.orgPrefix);
  assert.equal(analyzeTimedotLine("* heading", { seenDate: false }).kind, "heading");
  assert.equal(analyzeTimedotLine("* heading", { seenDate: true }).kind, "posting");
  assert.equal(analyzeTimedotLine("w  ccc ; k", { seenDate: true }).parsed.kind, "letters");
});

/* --------------------------------------------------------------- templates */
test("templates: each extension is only offered its own templates", () => {
  const ids = (ext) => templatesFor(templates, ext).map((t) => t.id);
  assert.ok(ids(".timeclock").includes("timeclock-starter"));
  assert.ok(ids(".timeclock").includes("blank"));
  assert.ok(!ids(".timeclock").some((id) => ["personal", "budget", "timedot-starter"].includes(id)));
  assert.ok(ids(".timedot").includes("timedot-starter") && ids(".timedot").includes("timedot-projects"));
  assert.ok(!ids(".timedot").some((id) => ["personal", "timeclock-starter"].includes(id)));
  assert.ok(!ids(".journal").some((id) => id.startsWith("time")));
  assert.deepEqual(ids(".csv"), ["blank"]);
  assert.ok(ids(".timeclock").length >= 3 && ids(".timedot").length >= 4);
});

test("every time template makes a valid file with no fabricated records", () => {
  for (const t of templates.filter((x) => x.types.some((y) => y === ".timeclock" || y === ".timedot"))) {
    const text = resolveTemplate(t, 2026);
    assert.ok(!text.includes("{{year}}"), t.id);
    assert.ok(t.name && t.description && previewOf(t, 2026).length > 0, t.id);
    if (t.types.includes(".timeclock")) {
      const m = parseTimeclock(text);
      assert.equal(m.counts.error + m.counts.warning, 0, t.id);
      assert.equal(m.events.length, 0, `${t.id} must not contain records`);
    } else {
      const m = parseTimedot(text);
      assert.equal(m.counts.error + m.counts.warning, 0, t.id);
      assert.equal(m.postings.length, 0, `${t.id} must not contain records`);
    }
  }
});

/* ----------------------------------------------------------------- routing */
test("the manifest routes .timeclock and .timedot to their own viewers, above the journal fallback", async () => {
  const { registry } = await import("../assets/js/shell/registry.js");
  registry.contributions = manifest.contributions;
  const pick = (uri) => registry.resolve(uri);
  assert.equal(pick("file:work.timeclock").viewType, "wedger.timeclockViewer");
  assert.equal(pick("file:WORK.TIMECLOCK").viewType, "wedger.timeclockViewer");
  assert.equal(pick("file:week.timedot").viewType, "wedger.timedotViewer");
  assert.equal(pick("file:a.journal").viewType, "wedger.journalViewer");
  assert.equal(pick("file:a.csv").viewType, "wedger.journalViewer");
  assert.equal(pick("wedger:settings").viewType, "wedger.settings");
  for (const vt of ["wedger.timeclockViewer", "wedger.timedotViewer"]) {
    const c = registry.byViewType(vt);
    assert.equal(c.renderer, "special");
    assert.ok(c.priority > 0 && c.controller && c.template && c.menuTemplate);
    for (const rel of [c.template, c.controller, c.menuTemplate]) assert.ok(readFileSync(new URL(`../assets/${rel}`, import.meta.url)), rel);
  }
  // renamed across kinds resolves to the new viewer
  assert.equal(pick("file:work.journal").viewType, "wedger.journalViewer");
});

/* -------------------------------------------------------- engine isolation */
test("the engine never receives .timeclock or .timedot files", async () => {
  globalThis.location = { protocol: "http:", hostname: "localhost" };
  const { engine } = await import("../assets/js/shell/engine.js");
  engine.replaceAllFiles(new Map([["a.journal", "x"], ["b.csv", "y"], ["c.rules", "z"], ["d.timeclock", "i"], ["e.timedot", "d"]]));
  assert.deepEqual(engine.mirroredNames.sort(), ["a.journal", "b.csv", "c.rules"]);
  engine.setFile("f.timeclock", "i"); engine.setFile("g.TIMEDOT", "d"); engine.setFile("h.journal", "q");
  assert.deepEqual(engine.mirroredNames.sort(), ["a.journal", "b.csv", "c.rules", "h.journal"]);
  engine.removeFile("h.journal"); engine.removeFile("never-there.timeclock");
  assert.deepEqual(engine.mirroredNames.sort(), ["a.journal", "b.csv", "c.rules"]);
});

/* ------------------------------------------------------------ import plans */
test("timeclock import: sessions, running sessions and totals come from the native parser", () => {
  const p = planTimeImport({ kind: "timeclock", fragment: "i 2026-11-23 09:00 a\no 2026-11-23 10:00 a\ni 2026-11-23 11:00 b\n" });
  assert.equal(p.status, "ok");
  assert.deepEqual([p.stats.completed, p.stats.running, p.stats.completedSeconds], [1, 1, 3600]);
  assert.equal(p.finalText.includes("b\n"), true);
});

test("timeclock import: errors are reported with lines; warnings alone don't block", () => {
  let p = planTimeImport({ kind: "timeclock", fragment: "o 2026-11-23 10:00 a\n" });
  assert.equal(p.status, "error"); assert.equal(p.issues[0].code, "unmatched-clock-out"); assert.equal(p.issues[0].line, 1);
  p = planTimeImport({ kind: "timeclock", fragment: "i 2026-11-23 10:00 a\ni 2026-11-23 09:00 b\no 2026-11-23 11:00 b\no 2026-11-23 12:00 a\n" });
  assert.equal(p.status, "warning");
});

test("timeclock append is validated in the context of the existing file", () => {
  const existing = "i 2026-11-23 09:00 a\n";
  const fits = planTimeImport({ kind: "timeclock", mode: "append", existing, fragment: "o 2026-11-23 10:00 a\n" });
  assert.equal(fits.status, "ok");
  assert.match(fits.notes[0], /closes “a”/);
  assert.equal(fits.finalText, existing + "o 2026-11-23 10:00 a\n");
  const alone = planTimeImport({ kind: "timeclock", fragment: "o 2026-11-23 10:00 a\n" });
  assert.equal(alone.status, "error");                                              // the same text is invalid on its own
  const clash = planTimeImport({ kind: "timeclock", mode: "append", existing, fragment: "i 2026-11-23 09:30 a\n" });
  assert.equal(clash.status, "error"); assert.equal(clash.issues[0].code, "overlapping-session");
  assert.equal(planTimeImport({ kind: "timeclock", mode: "append", existing: "o 2026-11-23 10:00 z\n", fragment: "i 2026-11-23 11:00 a\n" }).status, "ok");   // pre-existing errors aren't blamed on the import
});

test("timedot import: days, postings, hours and types; syntax errors; unsupported directives", () => {
  const p = planTimeImport({ kind: "timedot", fragment: "2026-11-23\nwork  ccec\nhome  1h\n2026-11-24\nx  ..\n" });
  assert.equal(p.status, "ok");
  assert.deepEqual([p.stats.days, p.stats.postings, p.stats.totalSeconds.toString()], [2, 3, String(3600 + 3600 + 1800)]);
  assert.deepEqual(p.stats.types.map((t) => t.type), ["c", "e"]);
  const bad = planTimeImport({ kind: "timedot", fragment: "2026-11-23\nx  1,5\ninclude foo\n" });
  assert.equal(bad.status, "error");
  assert.deepEqual(bad.issues.map((i) => i.code), ["invalid-amount", "unsupported-directive"]);
});

test("timedot append: entries without a date join the file's last day, and the merged text is what's checked", () => {
  const existing = "2026-11-23\na  .\n";
  const p = planTimeImport({ kind: "timedot", mode: "append", existing, fragment: "b  ..\n" });
  assert.equal(p.status, "ok");
  assert.match(p.notes[0], /2026-11-23/);
  assert.equal(p.finalText, "2026-11-23\na  .\n\nb  ..\n");
  assert.equal(planTimeImport({ kind: "timedot", fragment: "b  ..\n" }).status, "error");   // on its own it has no date
});

test("import never rewrites the imported text, whatever its problems", () => {
  const frag = "i 2026-11-23 09:00 a   \r\n garbage\r\n";
  const p = planTimeImport({ kind: "timeclock", fragment: frag });
  assert.equal(p.finalText, frag);
  assert.equal(p.status, "error");
});
