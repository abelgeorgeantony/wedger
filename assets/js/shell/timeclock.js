/* timeclock.js — Wedger's own reader, calculator and editor for hledger .timeclock files.
 *
 * Pure: no DOM, no storage, no hledger engine. Everything here works on plain text and returns plain objects.
 *
 * Format (hledger 1.50+, per Hledger.Read.TimeclockReader):
 *   i DATE HH:MM[:SS][+-ZZZZ] ACCOUNT[  DESCRIPTION][ ; COMMENT]     clock in  (account required)
 *   o DATE HH:MM[:SS][+-ZZZZ][ ACCOUNT][ ; COMMENT]                  clock out (account optional)
 *   b / h / O lines are accepted and ignored.  Blank lines and lines starting with #, ; or * are ignored.
 *   An indented ";" line directly after an entry continues that entry's comment.
 *
 * Session matching (per Hledger.Data.Timeclock), entries are processed in FILE order, not sorted by time:
 *   - Several sessions may be open at once, but not two with the same account (hledger: "overlapping sessions").
 *   - A clock-out with an account closes the open session with that account; with no account it closes the most
 *     recently clocked-in open session; otherwise it is unmatched.
 *   - A clock-out earlier than its clock-in is an error.
 *   - Sessions crossing midnight are split per calendar day for daily reporting.
 *   - hledger closes sessions still open at the end of the file "now". Wedger does NOT: they stay open, are
 *     reported as running, and never count towards completed totals.
 *
 * Decisions where Wedger deliberately differs (all visible to the user, none silent):
 *   - Day segments split at exactly 00:00:00, so segments add up to the true elapsed time. hledger ends each
 *     non-final segment at 23:59:59 and therefore drops one second per midnight.
 *   - A +-ZZZZ suffix is kept in the text and otherwise ignored, exactly as hledger does ("times are always
 *     interpreted as a local time"). Durations are wall-clock differences (DST is not considered, as in hledger).
 *     A clock-in and clock-out with different offsets get a warning, because the zones are not applied.
 *   - Errors hledger would stop on (unmatched clock-out, overlapping same-account clock-in, clock-out before its
 *     clock-in, bad dates) are reported with their line, the rest of the file is still read, and the affected
 *     records are listed but excluded from totals.
 */
import {
  parseSimpleDate, parseClockTime, wallSeconds, isoFromDays, clockText, splitLines, detectEol, applyEdits, appendLine,
  diag, countDiagnostics, sortDiagnostics, newErrors, weekStartIso, monthKey, projectOf, matchesText,
} from "./time-format.js";

/* ============================================================== line analysis */
/**
 * Classifies ONE line and locates its parts (offsets relative to the line). The parser, the editor highlighting and
 * the mutations all use this, so the format is described in exactly one place.
 */
export function analyzeTimeclockLine(text) {
  if (!text.trim()) return { kind: "blank" };
  const indented = /^[ \t]/.test(text);
  const first = text.trimStart()[0];
  if (first === "#" || first === ";" || first === "*") return { kind: "comment", indented, semicolon: first === ";" };

  const code = text[0];
  if (!"iobhO".includes(code) || !(text.length === 1 || /\s/.test(text[1]))) return { kind: "unknown", indented };

  const problems = [];
  const re = /\S+/g;
  re.lastIndex = 1;
  const token = () => { const m = re.exec(text); return m ? { text: m[0], start: m.index, end: m.index + m[0].length } : null; };

  const dateTok = token();
  const timeTok = token();
  const out = { kind: "entry", code, date: null, time: null, tz: null, account: null, description: null, comment: null, extra: null, problems };

  if (!dateTok) { problems.push({ code: "missing-datetime", message: "A date and a time are needed after the entry letter, e.g. 2026-11-23 09:00:00.", start: 1, end: text.length }); return out; }
  const pd = parseSimpleDate(dateTok.text);
  out.date = { ...dateTok, parsed: pd };
  if (!pd) problems.push({ code: "invalid-date", message: `“${dateTok.text}” is not a date. Use YYYY-MM-DD (the year is required).`, start: dateTok.start, end: dateTok.end });
  else if (!pd.valid) problems.push({ code: "invalid-date", message: `${dateTok.text} is not a real calendar date.`, start: dateTok.start, end: dateTok.end });

  if (!timeTok) { problems.push({ code: "missing-datetime", message: "A time is needed after the date, e.g. 09:00 or 09:00:00.", start: dateTok.end, end: text.length }); return out; }
  const pt = parseClockTime(timeTok.text);
  out.time = { ...timeTok, parsed: pt };
  if (!pt) problems.push({ code: "invalid-time", message: `“${timeTok.text}” is not a time. Use HH:MM or HH:MM:SS with two digits for each part.`, start: timeTok.start, end: timeTok.end });
  else if (!pt.valid) problems.push({ code: "invalid-time", message: `${timeTok.text} is not a valid time of day.`, start: timeTok.start, end: timeTok.end });
  if (pt?.tz) out.tz = { text: pt.tz, start: timeTok.start + pt.text.length, end: timeTok.end };

  const restStart = timeTok.end;
  const rest = text.slice(restStart);
  const semi = rest.indexOf(";");
  if (semi >= 0) out.comment = { start: restStart + semi, end: text.length, text: text.slice(restStart + semi + 1).trim() };
  const body = semi < 0 ? rest : rest.slice(0, semi);
  const trimmed = body.trim();

  if (trimmed) {
    const bs = restStart + /^[ \t]*/.exec(body)[0].length;
    if (code === "i" || code === "o") {
      const sep = /[ \t]{2,}|\t/.exec(trimmed);
      const accEnd = sep ? sep.index : trimmed.length;
      out.account = { text: trimmed.slice(0, accEnd), start: bs, end: bs + accEnd };
      if (sep) {
        const desc = trimmed.slice(sep.index + sep[0].length);
        const piece = { text: desc, start: bs + trimmed.length - desc.length, end: bs + trimmed.length };
        if (code === "i") out.description = piece;
        else out.extra = piece;
      }
    } else {
      out.extra = { text: trimmed, start: bs, end: bs + trimmed.length };        // b / h / O: free text, ignored
    }
  }
  if (code === "i" && !out.account) problems.push({ code: "missing-account", message: "A clock-in needs an account (the project or task), e.g. work:programming.", start: timeTok.end, end: text.length });
  if (code === "o" && out.extra) problems.push({ code: "clock-out-description", message: "A clock-out can have an account and a ; comment, but no description. hledger rejects this line.", start: out.extra.start, end: out.extra.end });
  return out;
}

const tagsOf = (comment) => {
  const tags = [];
  for (const m of comment.matchAll(/(?:^|[\s,])([^\s:,;]+):([^,\n]*)/g)) tags.push({ name: m[1], value: m[2].trim() });
  return tags;
};

/* =================================================================== parsing */
/**
 * @returns {{
 *   kind: "timeclock", text: string, eol: string, lines: object[], events: object[], sessions: object[],
 *   diagnostics: object[], counts: {error:number, warning:number, info:number}, accounts: string[]
 * }}
 * `events` is the original entry stream in file order; `sessions` is derived from it.
 */
export function parseTimeclock(text) {
  const lines = splitLines(text);
  const events = [];
  const diagnostics = [];
  const lineKinds = [];
  let owner = null;                                   // the entry that indented ";" lines may continue

  // Everything the line analyzer reports is something hledger itself rejects, so it is an error here too.
  const addProblem = (line, p) =>
    diagnostics.push(diag("error", p.code, p.message, line.n, { start: line.start + (p.start ?? 0), end: line.start + (p.end ?? line.text.length) }));

  for (const line of lines) {
    const a = analyzeTimeclockLine(line.text);
    if (a.kind === "blank") { lineKinds.push("blank"); owner = null; continue; }
    if (a.kind === "comment") {
      if (a.indented && a.semicolon && owner) {                       // continuation of the entry's comment
        owner.commentLines.push(line.n);
        owner.comment = [owner.comment, line.text.trim().replace(/^;\s?/, "")].filter((s) => s !== "").join("\n");
        owner.range.end = line.end + line.eol.length;
        lineKinds.push("continuation");
        continue;
      }
      lineKinds.push("comment"); owner = null; continue;
    }
    owner = null;
    if (a.kind === "unknown") {
      lineKinds.push("unknown");
      diagnostics.push(diag("error", a.indented ? "unexpected-indent" : "unrecognized-line",
        a.indented ? "Entries must start in the first column; only ; comment lines may be indented." : "Not a timeclock line. Lines start with i (clock in), o (clock out), a comment mark (#, ; or *) or nothing at all.",
        line.n, { start: line.start, end: line.end }));
      continue;
    }

    // An entry.
    lineKinds.push("entry");
    const abs = (r) => (r ? { start: line.start + r.start, end: line.start + r.end } : null);
    const pd = a.date?.parsed, pt = a.time?.parsed;
    const ev = {
      id: `e${line.n}`, line: line.n, code: a.code,
      type: a.code === "i" ? "in" : a.code === "o" ? "out" : "ignored",
      date: pd?.valid ? pd.iso : null, dateText: a.date?.text ?? "",
      time: pt?.valid ? pt.text : null, secondsOfDay: pt?.valid ? pt.seconds : null, hasSeconds: !!pt?.hasSeconds,
      tz: a.tz?.text ?? null,
      account: a.account?.text ?? "", description: a.description?.text ?? "",
      comment: a.comment?.text ?? "", commentLines: [], tags: [],
      wall: pd?.valid && pt?.valid ? wallSeconds(pd.iso, pt.seconds) : null,
      ranges: { line: { start: line.start, end: line.end }, date: abs(a.date), time: pt ? { start: line.start + a.time.start, end: line.start + a.time.start + pt.text.length } : null, tz: abs(a.tz), account: abs(a.account), description: abs(a.description), comment: abs(a.comment), extra: abs(a.extra) },
      range: { start: line.start, end: line.end + line.eol.length },
      valid: false, problems: a.problems.map((p) => p.code), sessionId: null, rejected: null,
    };
    for (const p of a.problems) addProblem(line, p);
    ev.valid = ev.wall != null && !(ev.type === "in" && !ev.account);
    if (ev.type === "ignored") {
      ev.valid = false;
      diagnostics.push(diag("info", "ignored-line", `A “${a.code}” line is part of the old timeclock.el format. hledger ignores it, and so does Wedger.`, line.n, { start: line.start, end: line.end }));
    }
    events.push(ev);
    if (ev.type !== "ignored") owner = ev;
  }
  for (const ev of events) ev.tags = tagsOf(ev.comment);

  const sessions = pairEvents(events, diagnostics, lines);

  const withTz = events.filter((e) => e.tz).length;
  if (withTz) diagnostics.push(diag("info", "timezone-ignored", `${withTz} ${withTz === 1 ? "entry carries" : "entries carry"} a +-ZZZZ offset. Like hledger, Wedger keeps it in the file but reads every time as local wall-clock time.`, events.find((e) => e.tz).line, null));

  const sorted = sortDiagnostics(diagnostics);
  return {
    kind: "timeclock", text, eol: detectEol(text), lines: lines.map((l, i) => ({ ...l, kind: lineKinds[i] })),
    events, sessions, diagnostics: sorted, counts: countDiagnostics(sorted),
    accounts: [...new Set(sessions.map((s) => s.account).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
  };
}

/** Splits [start, end] (wall seconds) at midnight. Zero-length trailing pieces are dropped; a zero-length session keeps one. */
export function splitAtMidnight(start, end) {
  const segments = [];
  const first = Math.floor(start / 86400), last = Math.floor(end / 86400);
  for (let d = first; d <= last; d++) {
    const s = d === first ? start : d * 86400;
    const e = d === last ? end : (d + 1) * 86400;
    if (e === s && start !== end) continue;
    segments.push({ date: isoFromDays(d), startSec: s - d * 86400, endSec: e - d * 86400, seconds: e - s, continuesFromPrevious: d > first, continuesToNext: d < last });
  }
  return segments;
}

function pairEvents(events, diagnostics, lines) {
  const sessions = [];
  let actives = [];                                  // open sessions, most recently clocked-in first (as hledger)
  let previous = null;

  const make = (ev) => ({
    id: `s${ev.line}`, line: ev.line, inEvent: ev, outEvent: null, account: ev.account, description: ev.description,
    comment: ev.comment, tags: ev.tags, status: "open", problems: [],
    start: { date: ev.date, secondsOfDay: ev.secondsOfDay, wall: ev.wall }, end: null, durationSeconds: null, segments: [],
  });

  for (const ev of events) {
    if (ev.type === "ignored") continue;
    if (ev.wall != null && previous && ev.wall < previous.wall) {
      diagnostics.push(diag("warning", "out-of-order", `This entry is earlier than the one on line ${previous.line}. hledger reads entries in file order, so this is fine only if it is intended.`, ev.line, ev.ranges.line));
    }
    if (ev.wall != null) previous = ev;
    if (!ev.valid) continue;

    if (ev.type === "in") {
      const s = make(ev);
      const clash = actives.find((a) => a.account === ev.account);
      if (clash) {
        diagnostics.push(diag("error", "overlapping-session", `“${ev.account}” is already clocked in (since line ${clash.line}). hledger does not allow two open sessions with the same account name; clock out first or use another account.`, ev.line, ev.ranges.line));
        s.status = "invalid"; s.problems.push("overlapping-session"); ev.rejected = "overlapping-session";
        sessions.push(s); ev.sessionId = s.id;
        continue;
      }
      actives.unshift(s);
      sessions.push(s); ev.sessionId = s.id;
      continue;
    }

    // clock-out
    const idx = ev.account ? actives.findIndex((a) => a.account === ev.account) : (actives.length ? 0 : -1);
    if (idx < 0) {
      const open = actives.map((a) => `“${a.account}”`).join(", ");
      diagnostics.push(diag("error", "unmatched-clock-out", ev.account
        ? `No open clock-in for “${ev.account}” to match this clock-out.${open ? ` Open sessions: ${open}.` : ""}`
        : "There is no open clock-in for this clock-out to close.", ev.line, ev.ranges.line));
      ev.rejected = "unmatched-clock-out";
      continue;
    }
    const [s] = actives.splice(idx, 1);
    s.outEvent = ev; ev.sessionId = s.id;
    s.comment = [s.comment, ev.comment].filter(Boolean).join("\n");
    if (ev.wall < s.start.wall) {
      s.status = "invalid"; s.problems.push("clock-out-before-clock-in");
      diagnostics.push(diag("error", "clock-out-before-clock-in", `This clock-out is earlier than its clock-in on line ${s.line}, so the session has no valid duration.`, ev.line, ev.ranges.line));
      s.end = { date: ev.date, secondsOfDay: ev.secondsOfDay, wall: ev.wall };
      continue;
    }
    s.status = "closed";
    s.end = { date: ev.date, secondsOfDay: ev.secondsOfDay, wall: ev.wall };
    s.durationSeconds = ev.wall - s.start.wall;
    s.segments = splitAtMidnight(s.start.wall, ev.wall);
    if (s.inEvent.tz && ev.tz && s.inEvent.tz !== ev.tz) {
      s.problems.push("timezone-mismatch");
      diagnostics.push(diag("warning", "timezone-mismatch", `The clock-in says ${s.inEvent.tz} and this clock-out says ${ev.tz}. Offsets are not applied (as in hledger), so the duration is the plain difference of the two clock times.`, ev.line, ev.ranges.line));
    }
  }
  for (const s of actives) {
    diagnostics.push(diag("info", "open-session", `“${s.account}” is still clocked in (no clock-out yet). It is shown as running and is not counted in completed totals.`, s.line, s.inEvent.ranges.line));
  }
  return sessions.sort((a, b) => a.start.wall - b.start.wall || a.line - b.line);
}

/** Seconds a running session has been open, at `now` (a localNow() value). Never negative; this is an estimate, not a record. */
export function liveElapsed(session, now) {
  if (session.status !== "open" || session.start.wall == null) return null;
  return Math.max(0, now.wall - session.start.wall);
}

/* ============================================================ source editing */
export function validateAccount(name) {
  const s = String(name ?? "");
  if (!s.trim()) return "Give the session an account, e.g. work:programming.";
  if (/[\r\n]/.test(s)) return "The account must be on one line.";
  if (s.includes(";")) return "The account can't contain “;” (it starts a comment).";
  if (s !== s.trim()) return "The account can't start or end with a space.";
  if (/[ \t]{2,}|\t/.test(s)) return "The account can't contain a tab or two spaces in a row (that's where the description starts).";
  return null;
}
export function validateDescription(desc) {
  const s = String(desc ?? "");
  if (/[\r\n]/.test(s)) return "The description must be on one line.";
  if (s.includes(";")) return "The description can't contain “;” (it starts a comment).";
  return null;
}
function validateStamp(label, stamp) {
  const d = parseSimpleDate(stamp?.date ?? "");
  if (!d?.valid) return `${label}: enter a real date.`;
  const t = parseClockTime(stamp?.time ?? "");
  if (!t?.valid || t.tz) return `${label}: enter a time like 09:30 or 09:30:15.`;
  return null;
}
const stampOf = (stamp) => ({ date: parseSimpleDate(stamp.date).iso, secs: parseClockTime(stamp.time).seconds, wall: wallSeconds(parseSimpleDate(stamp.date).iso, parseClockTime(stamp.time).seconds) });
const entryLine = (code, stamp, account, description, comment) =>
  `${code} ${stamp.date} ${clockText(stamp.secs)}${account ? ` ${account}` : ""}${description ? `  ${description}` : ""}${comment ? `  ; ${comment}` : ""}`;

const refuse = (error) => ({ ok: false, error });
/** Accepts a mutation's new text only when it adds no errors the file did not already have. */
function accept(before, newText, extra = {}) {
  const after = parseTimeclock(newText);
  const added = newErrors(before, after);
  return added.length ? refuse(`That change would make the file invalid: ${added[0].message}`) : { ok: true, text: newText, model: after, ...extra };
}
const findSession = (model, id) => model.sessions.find((s) => s.id === id) ?? null;
const duplicatesOpen = (model, account) => model.sessions.filter((s) => s.account === account && (s.status === "open" || s.problems.includes("overlapping-session"))).length > 1;

/** Appends `i DATE TIME ACCOUNT[  DESCRIPTION]`. date/time are LOCAL values (use localNow()). */
export function clockIn(text, { date, time, account, description = "", comment = "" }) {
  const err = validateStamp("Start", { date, time }) ?? validateAccount(account) ?? validateDescription(description) ?? validateDescription(comment);
  if (err) return refuse(err);
  const model = parseTimeclock(text);
  const open = model.sessions.find((s) => s.status === "open" && s.account === account);
  if (open) return refuse(`“${account}” is already clocked in (since ${open.start.date} ${clockText(open.start.secondsOfDay, { seconds: false })}). Clock it out first, or use a different account.`);
  const line = entryLine("i", stampOf({ date, time }), account, description.trim(), comment.trim());
  return accept(model, appendLine(text, line));
}

/** Closes one particular open session with a NAMED clock-out, so it can never close a different open session. */
export function clockOut(text, sessionId, { date, time, comment = "" }) {
  const err = validateStamp("End", { date, time }) ?? validateDescription(comment);
  if (err) return refuse(err);
  const model = parseTimeclock(text);
  const s = findSession(model, sessionId);
  if (!s || s.status !== "open") return refuse("That session is no longer open.");
  if (duplicatesOpen(model, s.account)) return refuse(`Several clock-ins for “${s.account}” overlap in this file, so a clock-out can't tell them apart. Fix the duplicate in Raw view first.`);
  const end = stampOf({ date, time });
  if (end.wall < s.start.wall) return refuse(`The clock-out would be before the clock-in (${s.start.date} ${clockText(s.start.secondsOfDay, { seconds: false })}).`);
  return accept(model, appendLine(text, entryLine("o", end, s.account, "", comment.trim())));
}

/** Adds a finished session (an `i` and a named `o`) — for entering history after the fact. */
export function addSession(text, { account, description = "", comment = "", start, end }) {
  const err = validateAccount(account) ?? validateDescription(description) ?? validateDescription(comment) ?? validateStamp("Start", start) ?? validateStamp("End", end);
  if (err) return refuse(err);
  const a = stampOf(start), b = stampOf(end);
  if (b.wall < a.wall) return refuse("The end is before the start.");
  const model = parseTimeclock(text);
  if (model.sessions.some((s) => s.status === "open" && s.account === account)) return refuse(`“${account}” is clocked in right now, and a second session with the same account can't be added until it is clocked out.`);
  const next = appendLine(appendLine(text, entryLine("i", a, account, description.trim(), comment.trim())), entryLine("o", b, account));
  return accept(model, next);
}

/** What deleting a single event (instead of the whole session) would leave behind, in words, for a confirmation. */
export function describeEventDeletion(model, eventId) {
  const ev = model.events.find((e) => e.id === eventId);
  if (!ev) return null;
  const s = ev.sessionId ? model.sessions.find((x) => x.id === ev.sessionId) : null;
  if (ev.type === "out" && s) return `Deleting this clock-out reopens the session “${s.account}” from ${s.start.date} ${clockText(s.start.secondsOfDay, { seconds: false })}: it will be shown as still running and stops counting in totals.`;
  if (ev.type === "in" && s?.outEvent) return `Deleting this clock-in leaves the clock-out on line ${s.outEvent.line} without a session. hledger will report it as an error until you remove or fix it too.`;
  if (ev.type === "in") return "Deleting this clock-in removes the running session.";
  return "This line is not part of any session. Deleting it removes only this line.";
}

const lineRemoval = (ev) => ({ start: ev.range.start, end: ev.range.end, text: "" });

/**
 * What a session looks like to everything else in the file: who, when, and how it ended. Used to prove that removing
 * some sessions did not silently change how the REMAINING clock-ins and clock-outs pair up.
 */
const pairingKey = (s) => `${s.account}|${s.status}|${s.start.wall}|${s.end ? s.end.wall : ""}`;
const countKeys = (list) => { const m = new Map(); for (const s of list) { const k = pairingKey(s); m.set(k, (m.get(k) ?? 0) + 1); } return m; };

/**
 * Removes whole sessions in ONE edit: each session's clock-in and clock-out (and their indented comment lines) go
 * together, so no clock event is ever left behind. Nothing else is touched. All or nothing:
 *   - a session that no longer exists refuses the whole batch;
 *   - the batch is refused when removing it would change how any OTHER session pairs up (a clock-out without an
 *     account closes the most recent open session, so some deletions are ambiguous), or would add an error.
 * @returns {{ ok: true, text, model, deleted: number } | { ok: false, error }}
 */
export function deleteSessions(text, sessionIds) {
  const ids = [...new Set(sessionIds ?? [])];
  if (!ids.length) return refuse("No sessions were selected.");
  const model = parseTimeclock(text);
  const edits = [];
  const doomed = new Set();
  for (const id of ids) {
    const s = findSession(model, id);
    if (!s) return refuse(ids.length === 1 ? "That session no longer exists." : "One of the selected sessions no longer exists, so nothing was deleted. Select again.");
    doomed.add(s.id);
    edits.push(lineRemoval(s.inEvent));
    if (s.outEvent) edits.push(lineRemoval(s.outEvent));
  }
  const next = applyEdits(text, edits);
  const after = parseTimeclock(next);
  const keep = countKeys(model.sessions.filter((s) => !doomed.has(s.id)));
  const kept = countKeys(after.sessions);
  const same = keep.size === kept.size && [...keep].every(([k, n]) => kept.get(k) === n);
  if (!same) return refuse(ids.length === 1
    ? "Deleting this session would change how other clock-ins and clock-outs in the file pair up (a clock-out without an account closes the most recent open session), so it was not deleted. Edit the file in Raw view instead."
    : "Deleting these sessions would change how other clock-ins and clock-outs in the file pair up (a clock-out without an account closes the most recent open session), so nothing was deleted. Edit the file in Raw view instead.");
  const res = accept(model, next);
  return res.ok ? { ...res, deleted: ids.length } : res;
}

/** Removes a session's clock-in and clock-out (and their indented comment lines) together; nothing else is touched. */
export function deleteSession(text, sessionId) {
  return deleteSessions(text, [sessionId]);
}

/** Removes ONE entry (see describeEventDeletion for the consequences to show first). */
export function deleteEvent(text, eventId) {
  const model = parseTimeclock(text);
  const ev = model.events.find((e) => e.id === eventId);
  if (!ev) return refuse("That line no longer exists.");
  const next = applyEdits(text, [lineRemoval(ev)]);
  const after = parseTimeclock(next);
  return { ok: true, text: next, model: after };          // deliberately allowed to leave an orphan: the caller has warned
}

function eventEdits(ev, { date, time, account, description }) {
  const edits = [];
  const r = ev.ranges;
  if (date != null && date !== ev.date) edits.push({ ...r.date, text: date });
  if (time != null) {
    const secs = parseClockTime(time).seconds;
    if (secs !== ev.secondsOfDay) edits.push({ ...r.time, text: clockText(secs, { seconds: ev.hasSeconds || secs % 60 !== 0 }) });
  }
  if (account != null && account !== ev.account) {
    if (r.account) edits.push({ ...r.account, text: account });
    else { const at = (r.tz ?? r.time).end; edits.push({ start: at, end: at, text: ` ${account}` }); }
  }
  if (description != null && ev.type === "in" && description !== ev.description) {
    if (r.description && description) edits.push({ ...r.description, text: description });
    else if (r.description) edits.push({ start: r.account.end, end: r.description.end, text: "" });
    else if (description) edits.push({ start: r.account.end, end: r.account.end, text: `  ${description}` });
  }
  return edits;
}

/**
 * Edits a session in place. Only the changed fields' spans are rewritten. If the account changes and the clock-out
 * did not name its account, the new name is written into it too, so the pair can't be separated by the rename.
 * patch: { account?, description?, start?: {date,time}, end?: {date,time} }
 */
export function editSession(text, sessionId, patch) {
  const model = parseTimeclock(text);
  const s = findSession(model, sessionId);
  if (!s) return refuse("That session no longer exists.");
  if (s.problems.includes("overlapping-session") || (!s.outEvent && s.status === "invalid")) return refuse("This session overlaps another one with the same account. Fix it in Raw view first.");
  const err = (patch.account != null ? validateAccount(patch.account) : null) ?? (patch.description != null ? validateDescription(patch.description) : null)
    ?? (patch.start ? validateStamp("Start", patch.start) : null) ?? (patch.end && s.outEvent ? validateStamp("End", patch.end) : null);
  if (err) return refuse(err);

  const start = patch.start ? stampOf(patch.start) : { date: s.start.date, secs: s.start.secondsOfDay, wall: s.start.wall };
  const end = s.outEvent ? (patch.end ? stampOf(patch.end) : { date: s.end.date, secs: s.end.secondsOfDay, wall: s.end.wall }) : null;
  if (end && end.wall < start.wall) return refuse("The end would be before the start.");

  const renamed = patch.account != null && patch.account !== s.account ? patch.account : null;
  const edits = eventEdits(s.inEvent, { date: patch.start ? start.date : null, time: patch.start?.time ?? null, account: renamed, description: patch.description?.trim() });
  if (s.outEvent) {
    edits.push(...eventEdits(s.outEvent, { date: patch.end ? end.date : null, time: patch.end?.time ?? null, account: renamed }));
  }
  if (!edits.length) return { ok: true, text, model, unchanged: true };
  return accept(model, applyEdits(text, edits));
}

/* ================================================================ summaries */
const accountMatches = (account, wanted) => !wanted || account === wanted || account.startsWith(`${wanted}:`);

/** Sessions that pass the non-date filters. filter: { account, project, text, status: all|running|completed|problems } */
export function filterSessions(model, f = {}) {
  return model.sessions.filter((s) => {
    if (!accountMatches(s.account, f.account)) return false;
    if (f.project && projectOf(s.account) !== f.project) return false;
    if (f.text && !matchesText([s.account, s.description, s.comment, s.start.date, s.end?.date, ...s.tags.map((t) => `${t.name}:${t.value}`)], f.text)) return false;
    const status = f.status ?? "all";
    if (status === "running" && s.status !== "open") return false;
    if (status === "completed" && s.status !== "closed") return false;
    if (status === "problems" && s.status !== "invalid" && !s.problems.length) return false;
    return true;
  });
}

const inRange = (date, f) => (!f.from || date >= f.from) && (!f.to || date <= f.to);

/**
 * Totals derived only from the parsed intervals. `from`/`to` are ISO dates (inclusive); a session that spans midnight
 * contributes each day's segment to that day only.
 * @returns {{ sessions: object[], completedSeconds: number, completedCount: number, runningCount: number,
 *   problemCount: number, byDay: object[], byWeek: object[], byMonth: object[], byAccount: object[], byProject: object[],
 *   firstDate: string|null, lastDate: string|null, incomplete: boolean }}
 */
export function summarizeTimeclock(model, filter = {}, { weekStart = "monday" } = {}) {
  const base = filterSessions(model, filter);
  const sessions = [];
  const buckets = { day: new Map(), week: new Map(), month: new Map(), account: new Map(), project: new Map() };
  let completedSeconds = 0, completedCount = 0, runningCount = 0, problemCount = 0, first = null, last = null;

  const add = (kind, key, seconds, id) => {
    const b = buckets[kind].get(key) ?? { key, seconds: 0, ids: new Set() };
    b.seconds += seconds; b.ids.add(id);
    buckets[kind].set(key, b);
  };
  for (const s of base) {
    let shown = false;
    if (s.status === "closed") {
      for (const seg of s.segments) {
        if (!inRange(seg.date, filter)) continue;
        shown = true;
        completedSeconds += seg.seconds;
        add("day", seg.date, seg.seconds, s.id);
        add("week", weekStartIso(seg.date, weekStart), seg.seconds, s.id);
        add("month", monthKey(seg.date), seg.seconds, s.id);
        add("account", s.account, seg.seconds, s.id);
        add("project", projectOf(s.account), seg.seconds, s.id);
        if (!first || seg.date < first) first = seg.date;
        if (!last || seg.date > last) last = seg.date;
      }
      if (shown) completedCount++;
    } else if (s.start.date && inRange(s.start.date, filter)) {
      shown = true;
      if (s.status === "open") runningCount++;
      if (s.status === "invalid") problemCount++;
    }
    if (shown) { sessions.push(s); if (s.problems.length && s.status !== "invalid") problemCount++; }
  }
  const rows = (kind, cmp) => [...buckets[kind].values()].map((b) => ({ key: b.key, seconds: b.seconds, sessions: b.ids.size })).sort(cmp);
  const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const bySeconds = (a, b) => b.seconds - a.seconds || byKey(a, b);
  return {
    sessions, completedSeconds, completedCount, runningCount, problemCount,
    byDay: rows("day", byKey), byWeek: rows("week", byKey), byMonth: rows("month", byKey),
    byAccount: rows("account", bySeconds), byProject: rows("project", bySeconds),
    firstDate: first, lastDate: last,
    incomplete: model.sessions.some((s) => s.status === "invalid") || model.diagnostics.some((d) => d.severity === "error" && d.code === "unmatched-clock-out"),
  };
}

export const projectsOf = (model) => [...new Set(model.sessions.map((s) => projectOf(s.account)))].sort((a, b) => a.localeCompare(b));
