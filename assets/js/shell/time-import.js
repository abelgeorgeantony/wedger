/* time-import.js — import planning for .timeclock and .timedot text. Pure; the importer page only draws the result.
 *
 * The same native parsers that render the files validate the import. Nothing here touches the hledger engine.
 * When text is ADDED to an existing file the MERGED text is parsed, because a fragment can depend on what is already
 * there (a clock-out that closes a session started earlier, entries that join the last day of a timedot file).
 * The imported text is kept character for character; only a missing final line break (and, for timedot, one blank
 * line between day groups) is supplied when appending.
 */
import { appendFragment, countDiagnostics, newErrors, formatDuration } from "./time-format.js";
import { parseTimeclock } from "./timeclock.js";
import { parseTimedot, countable } from "./timedot.js";
import { ZERO, sumRats } from "./time-format.js";

export const parserFor = (kind) => (kind === "timeclock" ? parseTimeclock : kind === "timedot" ? parseTimedot : null);

/**
 * @param {{ kind: "timeclock"|"timedot", fragment: string, mode?: "new"|"replace"|"append", existing?: string }} input
 * @returns {{ kind, mode, finalText: string, model: object, issues: object[], counts: {error,warning,info},
 *   status: "ok"|"warning"|"error", stats: object, notes: string[], fragStart: number, lineOffset: number }}
 */
export function planTimeImport({ kind, fragment, mode = "new", existing = "" }) {
  const parse = parserFor(kind);
  if (!parse) throw new Error(`Not a time format: ${kind}`);
  const append = mode === "append";
  const finalText = append ? appendFragment(kind, existing, fragment) : fragment;
  const model = parse(finalText);
  const before = append ? parse(existing) : null;
  const fragStart = append ? finalText.length - fragment.length : 0;
  const startOf = (d) => model.lines[d.line - 1]?.start ?? 0;

  // What the person is importing: problems on the imported lines, plus any error the merge introduces elsewhere.
  const issues = model.diagnostics.filter((d) => d.severity !== "info" && (!append || startOf(d) >= fragStart));
  if (append) for (const d of newErrors(before, model)) if (!issues.includes(d)) issues.push(d);
  issues.sort((a, b) => a.line - b.line);
  const counts = countDiagnostics(issues);
  const status = counts.error ? "error" : counts.warning ? "warning" : "ok";

  const stats = kind === "timeclock" ? clockStats(model, fragStart) : dotStats(model, fragStart);
  const notes = [];
  if (append) notes.push(...appendNotes(kind, model, fragStart));
  // Lines in the merged file before the imported text, so a message can say "line 3 of what you're importing".
  const lineOffset = model.lines.filter((l) => l.start < fragStart).length;
  return { kind, mode, finalText, model, issues, counts, status, stats, notes, fragStart, lineOffset };
}

function clockStats(model, fragStart) {
  const mine = model.sessions.filter((s) => s.inEvent.range.start >= fragStart);
  const closed = mine.filter((s) => s.status === "closed");
  const dates = closed.flatMap((s) => s.segments.map((g) => g.date)).sort();
  return {
    sessions: mine.length, completed: closed.length, running: mine.filter((s) => s.status === "open").length,
    invalid: mine.filter((s) => s.status === "invalid").length,
    completedSeconds: closed.reduce((n, s) => n + s.durationSeconds, 0),
    accounts: [...new Set(mine.map((s) => s.account))].sort(),
    firstDate: dates[0] ?? null, lastDate: dates.at(-1) ?? null,
    entries: model.events.filter((e) => e.range.start >= fragStart && e.type !== "ignored").length,
  };
}

function dotStats(model, fragStart) {
  const days = model.days.filter((d) => d.range.start >= fragStart);
  const postings = model.postings.filter((p) => p.range.start >= fragStart);
  const ok = new Set(model.days.filter((d) => d.valid).map((d) => d.id));
  const good = countable(model).filter((p) => p.range.start >= fragStart);
  const types = new Map();
  for (const p of good) for (const t of p.types) types.set(t.type, (types.get(t.type) ?? ZERO).add(t.seconds));
  const dates = [...new Set(days.filter((d) => ok.has(d.id)).map((d) => d.date))].sort();
  return {
    groups: days.length, days: dates.length, postings: postings.length, skipped: postings.length - good.length,
    totalSeconds: sumRats(good.map((p) => p.seconds)),
    types: [...types].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([type, seconds]) => ({ type, seconds })),
    firstDate: dates[0] ?? null, lastDate: dates.at(-1) ?? null,
  };
}

function appendNotes(kind, model, fragStart) {
  const notes = [];
  if (kind === "timedot") {
    const joined = model.days.find((d) => d.range.start < fragStart && d.postings.some((p) => p.range.start >= fragStart));
    if (joined) notes.push(`The first entries in this text have no date of their own, so they will be added to the ${joined.dateText} day already in the file.`);
  } else {
    const closing = model.events.filter((e) => e.type === "out" && e.range.start >= fragStart && e.sessionId)
      .map((e) => model.sessions.find((s) => s.id === e.sessionId)).filter((s) => s && s.inEvent.range.start < fragStart);
    for (const s of closing) notes.push(`A clock-out here closes “${s.account}”, which is clocked in on line ${s.line} of the file${s.durationSeconds != null ? ` (${formatDuration(s.durationSeconds)})` : ""}.`);
  }
  return notes;
}
