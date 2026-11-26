/* timedot.js — Wedger's own reader, calculator and editor for hledger .timedot files.
 *
 * Pure: no DOM, no storage, no hledger engine.
 *
 * Format (hledger 1.50+, per Hledger.Read.TimedotReader):
 *   DATE [DESCRIPTION] [; COMMENT]            starts a day. DATE is YYYY-MM-DD (or / or .); the year is required.
 *   ACCOUNT[  QUANTITY][  ; COMMENT]          one entry, under the day. Two or more spaces (or a tab) end the account.
 * QUANTITY is one of
 *   dots      . = 15 minutes; spaces between dots are only for grouping:  .... ..  = 1h 30m
 *   a number  with an optional unit s, m, h, d, w, mo, y glued to it (no space), hours when there is none: 1.5  90m  2d
 *   letters   each letter is 15 minutes and a type ("t" tag): ccecces = c 1h, e 30m, s 15m
 *   nothing   the entry is 0
 * Equivalences: 1m = 60s, 1h = 60m, 1d = 24h, 1w = 7d, 1mo = 30d, 1y = 365d.
 * Blank lines and lines starting with # or ; are comments. Before the first date, lines starting with * (Org-mode
 * headings) are ignored whatever they contain; after it, a leading "* " on a date or entry line is ignored.
 *
 * Decisions where Wedger deliberately differs from hledger's implementation (all visible, none silent):
 *   - Quantities are exact seconds (BigInt rationals). hledger rounds unit quantities to 0.01 h (5m -> 0.08h).
 *   - Documented equivalences are used for mo and y. The hledger 1.50 source table holds 5040 h for 1mo and 61320 h
 *     for 1y, which is 7x the documented 30 d and 365 d.
 *   - Journal directives (account, include, P, …) are not part of timedot. hledger reads such a line after the first
 *     date as an account name with 0 h; Wedger reports it as an unsupported directive and keeps the text untouched.
 *   - Only "." is a decimal mark; commas are rejected rather than guessed. Negative quantities are rejected.
 *   - Entries on a day with an invalid date are listed but excluded from totals.
 */
import {
  Rat, ZERO, sumRats, parseSimpleDate, splitLines, detectEol, applyEdits, appendLine, diag, countDiagnostics,
  sortDiagnostics, newErrors, weekStartIso, monthKey, projectOf, matchesText,
} from "./time-format.js";

/* ============================================================== quantities */
export const UNIT_SECONDS = { s: 1n, m: 60n, h: 3600n, d: 86400n, w: 604800n, mo: 2592000n, y: 31536000n };
export const UNIT_LABELS = { s: "seconds", m: "minutes", h: "hours", d: "days", w: "weeks", mo: "months", y: "years" };
const QUARTER_HOUR = 900n;
const LETTER_RE = /^\p{L}[\p{L} ]*$/u;
const NUMBER_RE = /^(\d+(?:\.\d+)?|\.\d+)(mo|[smhdwy])?$/;

/**
 * Parses the quantity part of an entry (already trimmed).
 * @returns {{ ok: true, kind: "empty"|"dots"|"number"|"letters", seconds: Rat, dots: number, unit: string|null,
 *   types: {type: string, count: number, seconds: Rat}[] } | { ok: false, error: string }}
 */
export function parseQuantity(raw) {
  const text = String(raw ?? "").trim();
  if (text === "") return { ok: true, kind: "empty", seconds: ZERO, dots: 0, unit: null, types: [] };

  if (/^\.[. ]*$/.test(text)) {
    const dots = (text.match(/\./g) ?? []).length;
    return { ok: true, kind: "dots", seconds: new Rat(QUARTER_HOUR * BigInt(dots)), dots, unit: null, types: [] };
  }
  const num = NUMBER_RE.exec(text);
  if (num) {
    const unit = num[2] ?? null;
    return { ok: true, kind: "number", seconds: Rat.parseDecimal(num[1]).mul(UNIT_SECONDS[unit ?? "h"]), dots: 0, unit, types: [] };
  }
  if (LETTER_RE.test(text)) {
    const counts = new Map();
    for (const ch of text.replace(/ /g, "")) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    const types = [...counts].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([type, count]) => ({ type, count, seconds: new Rat(QUARTER_HOUR * BigInt(count)) }));
    return { ok: true, kind: "letters", seconds: sumRats(types.map((t) => t.seconds)), dots: 0, unit: null, types };
  }
  if (text.startsWith("-")) return { ok: false, error: "Negative quantities are not supported." };
  if (text.includes(",")) return { ok: false, error: "Use a decimal point, not a comma (for example 1.5)." };
  if (/^(\d+(?:\.\d+)?|\.\d+)\s+(mo|[smhdwy])$/.test(text)) return { ok: false, error: "Write the unit right after the number with no space (for example 90m)." };
  const unknown = /^(?:\d+(?:\.\d+)?|\.\d+)([A-Za-z]+)$/.exec(text);
  if (unknown) return { ok: false, error: `“${unknown[1]}” is not a time unit. Use s, m, h, d, w, mo or y.` };
  return { ok: false, error: "Use dots (.... = 1 hour), a number with an optional unit (1.5, 90m, 2d) or letters (ccec), but not a mix." };
}

/** A multiple of 15 minutes written as grouped dots: 1.5 h -> ".... ..". */
export function dotsFor(seconds) {
  const quarters = Rat.of(seconds).div(QUARTER_HOUR);
  if (!quarters.isInteger || quarters.n <= 0n) return null;
  const n = Number(quarters.n);
  return Array.from({ length: Math.ceil(n / 4) }, (_, i) => ".".repeat(Math.min(4, n - i * 4))).join(" ");
}

/**
 * Turns what the quick-add form holds into entry text, never rounding. mode: "dots" | "letters" | a unit (s m h d w mo y).
 * Dots mode takes dots, or hours that are a whole number of quarters (1.25), which become dots.
 * @returns {{ ok: true, text: string, parsed: object } | { ok: false, error: string }}
 */
export function buildQuantity(mode, value) {
  const v = String(value ?? "").trim();
  if (!v) return { ok: false, error: "Enter an amount of time." };
  let text;
  if (mode === "dots") {
    if (/^\.[. ]*$/.test(v)) text = v.replace(/\s+/g, " ");
    else {
      const hours = /^(\d+(?:\.\d+)?|\.\d+)$/.test(v) ? Rat.parseDecimal(v) : null;
      if (!hours) return { ok: false, error: "Type dots (. = 15 minutes), or hours in steps of 0.25." };
      const dots = dotsFor(hours.mul(3600n));
      if (!dots) return { ok: false, error: `${v} hours isn't a whole number of 15-minute steps, so it can't be written as dots. Use minutes or hours instead.` };
      text = dots;
    }
  } else if (mode === "letters") {
    if (!LETTER_RE.test(v)) return { ok: false, error: "Letters only (each is 15 minutes), for example ccec." };
    text = v.replace(/\s+/g, " ");
  } else if (UNIT_SECONDS[mode] != null) {
    if (!/^(\d+(?:\.\d+)?|\.\d+)$/.test(v)) return { ok: false, error: "Enter a number such as 1.5 (a decimal point, no unit — pick the unit separately)." };
    text = `${v}${mode}`;
  } else return { ok: false, error: "Pick how the time is written." };
  const parsed = parseQuantity(text);
  return parsed.ok ? { ok: true, text, parsed } : { ok: false, error: parsed.error };
}

/** What a stored quantity looks like in the quick-add / edit form: { mode, value }. */
export function modeOf(posting) {
  if (posting.kind === "dots") return { mode: "dots", value: posting.raw };
  if (posting.kind === "letters") return { mode: "letters", value: posting.raw };
  if (posting.kind === "number") {
    const m = NUMBER_RE.exec(posting.raw);
    return { mode: m?.[2] ?? "h", value: m?.[1] ?? posting.raw };
  }
  return { mode: "h", value: "" };
}

/* ============================================================== line analysis */
const DATE_SHAPE = /^(\*+[ \t]+)?(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2})(?=$|[ \t;])/;
const DIRECTIVE_RE = /^(account|alias|apply|bucket|capture|comment|commodity|decimal-mark|end|include|payee|tag|D|P|Y)[ \t]\S|^[~=!@]/;
const SEPARATOR = /[ \t]{2,}|\t/;

/**
 * Classifies ONE line and locates its parts (offsets relative to the line). `seenDate` says whether a date line
 * came earlier in the file: it decides what a "*" line is. Used by the parser, the highlighter and the mutations.
 */
export function analyzeTimedotLine(text, { seenDate }) {
  if (!text.trim()) return { kind: "blank" };
  const indented = /^[ \t]/.test(text);
  const first = text.trimStart()[0];
  if (first === "#" || first === ";") return { kind: "comment", indented, semicolon: first === ";" };

  const dm = DATE_SHAPE.exec(text);
  if (dm) {
    const prefix = dm[1] ? { start: 0, end: dm[1].length } : null;
    const ds = dm[1]?.length ?? 0;
    const token = { text: dm[2], start: ds, end: ds + dm[2].length, parsed: parseSimpleDate(dm[2]) };
    const problems = [];
    if (!token.parsed) problems.push({ code: "invalid-date", message: `“${dm[2]}” isn't a full date. Day headings need the year and the same separator twice, like 2026-11-23.`, start: token.start, end: token.end });
    else if (!token.parsed.valid) problems.push({ code: "invalid-date", message: `${dm[2]} is not a real calendar date.`, start: token.start, end: token.end });
    const rest = text.slice(token.end);
    const semi = rest.indexOf(";");
    const body = semi < 0 ? rest : rest.slice(0, semi);
    const trimmed = body.trim();
    return {
      kind: "date", orgPrefix: prefix, date: token, problems,
      description: trimmed ? { text: trimmed, start: token.end + body.indexOf(trimmed), end: token.end + body.indexOf(trimmed) + trimmed.length } : null,
      comment: semi < 0 ? null : { start: token.end + semi, end: text.length, text: rest.slice(semi + 1).trim() },
    };
  }

  const dir = !indented ? DIRECTIVE_RE.exec(text) : null;
  if (dir) return { kind: "directive", name: dir[1] ?? text[0] };

  if (!seenDate) {
    if (first === "*") return { kind: "heading" };
    return { kind: "unsupported" };
  }

  // An entry.
  const problems = [];
  const org = /^\*+[ \t]+/.exec(text);
  const bodyStart = org ? org[0].length : /^[ \t]*/.exec(text)[0].length;
  const rest = text.slice(bodyStart);
  const semi = rest.indexOf(";");
  const body = semi < 0 ? rest : rest.slice(0, semi);
  const trimmed = body.replace(/[ \t]+$/, "");
  const sep = SEPARATOR.exec(trimmed);
  const accText = sep ? trimmed.slice(0, sep.index) : trimmed;
  const account = { text: accText, start: bodyStart, end: bodyStart + accText.length };
  let quantity = null;
  if (sep) {
    const q = trimmed.slice(sep.index + sep[0].length);
    if (q) quantity = { text: q, start: bodyStart + sep.index + sep[0].length, end: bodyStart + trimmed.length };
  }
  const comment = semi < 0 ? null : { start: bodyStart + semi, end: text.length, text: rest.slice(semi + 1).trim() };

  if (!quantity && /(?: |^)(\.[. ]*|\.\d+|\d+\.\d+|\d+(?:\.\d+)?(?:mo|[smhdwy]))$/.test(accText) && / /.test(accText)) {
    problems.push({ code: "missing-double-space", severity: "warning", message: "This looks like a time amount, but only one space separates it from the account, so hledger reads it as part of the account name. Use two or more spaces (or a tab) before the amount.", start: account.start, end: account.end });
  }
  let parsed = null;
  if (quantity) {
    parsed = parseQuantity(quantity.text);
    if (!parsed.ok) problems.push({ code: "invalid-amount", severity: "error", message: parsed.error, start: quantity.start, end: quantity.end });
  }
  return { kind: "posting", orgPrefix: org ? { start: 0, end: org[0].length } : null, indent: org ? "" : text.slice(0, bodyStart), account, quantity, comment, parsed, problems };
}

/* =================================================================== parsing */
/**
 * @returns {{ kind: "timedot", text: string, eol: string, lines: object[], days: object[], postings: object[],
 *   diagnostics: object[], counts: object, totalSeconds: Rat, accounts: string[] }}
 * `days` are the date groups in file order (the same date can appear in several); `postings` is every entry.
 */
export function parseTimedot(text) {
  const lines = splitLines(text);
  const days = [], postings = [], diagnostics = [], lineKinds = [];
  let day = null, owner = null, seenDate = false;
  const span = (line, r) => (r ? { start: line.start + r.start, end: line.start + r.end } : null);

  for (const line of lines) {
    const a = analyzeTimedotLine(line.text, { seenDate });
    const whole = { start: line.start, end: line.end };
    switch (a.kind) {
      case "blank": lineKinds.push("blank"); owner = null; break;
      case "comment":
        if (a.indented && a.semicolon && owner) {
          owner.commentLines.push(line.n);
          owner.comment = [owner.comment, line.text.trim().replace(/^;\s?/, "")].filter((s) => s !== "").join("\n");
          owner.range.end = line.end + line.eol.length;
          lineKinds.push("continuation");
        } else { lineKinds.push("comment"); owner = null; }
        break;
      case "heading": lineKinds.push("heading"); owner = null; break;
      case "unsupported":
        lineKinds.push("unsupported"); owner = null;
        diagnostics.push(diag("error", "unsupported-line", "Expected a date line (like 2026-11-23) before any entries. Only blank lines, # or ; comments and * headings may come before the first date.", line.n, whole));
        break;
      case "directive":
        lineKinds.push("directive"); owner = null;
        diagnostics.push(diag("error", "unsupported-directive", `“${a.name}” is a journal directive. Timedot files have no directives (hledger would read this as an account name), so Wedger leaves the line alone and ignores it.`, line.n, whole));
        break;
      case "date": {
        lineKinds.push("date");
        seenDate = true;
        const ok = a.date.parsed?.valid;
        for (const p of a.problems) diagnostics.push(diag("error", p.code, p.message, line.n, span(line, p)));
        day = {
          id: `d${line.n}`, line: line.n, date: ok ? a.date.parsed.iso : null, dateText: a.date.text,
          description: a.description?.text ?? "", comment: a.comment?.text ?? "", commentLines: [], orgPrefix: !!a.orgPrefix,
          ranges: { line: whole, date: span(line, a.date), description: span(line, a.description), comment: span(line, a.comment) },
          range: { start: line.start, end: line.end + line.eol.length }, insertAt: line.end + line.eol.length,
          postings: [], seconds: ZERO, valid: !!ok,
        };
        days.push(day); owner = day;
        break;
      }
      case "posting": {
        lineKinds.push("posting");
        const q = a.parsed?.ok ? a.parsed : null;
        const p = {
          id: `p${line.n}`, line: line.n, dayId: day.id, date: day.date, account: a.account.text, orgPrefix: !!a.orgPrefix, indent: a.indent,
          raw: a.quantity?.text ?? "", kind: q ? q.kind : a.quantity ? "invalid" : "empty",
          seconds: q ? q.seconds : null, dots: q?.dots ?? 0, unit: q?.unit ?? null, types: q?.types ?? [],
          comment: a.comment?.text ?? "", commentLines: [], problems: a.problems.map((x) => x.code),
          ranges: { line: whole, account: span(line, a.account), amount: span(line, a.quantity), comment: span(line, a.comment) },
          range: { start: line.start, end: line.end + line.eol.length }, valid: !!q || !a.quantity,
        };
        if (!a.quantity) { p.seconds = ZERO; p.valid = true; }
        for (const pr of a.problems) diagnostics.push(diag(pr.severity, pr.code, pr.message, line.n, span(line, pr)));
        if (a.orgPrefix && !a.quantity) {
          diagnostics.push(diag("info", "org-heading-entry", `After the first date, an Org heading is read as an entry: hledger records “${a.account.text}” with 0 h. (Headings before the first date are ignored.)`, line.n, whole));
        }
        day.postings.push(p); postings.push(p);
        day.insertAt = line.end + line.eol.length;
        owner = p;
        break;
      }
      default: break;
    }
  }
  // An owner's continuation comments extend where new entries can be inserted.
  for (const d of days) {
    const last = d.postings[d.postings.length - 1];
    d.insertAt = Math.max(d.range.end, last ? last.range.end : 0);
    d.endLine = last ? Math.max(last.line, ...last.commentLines) : Math.max(d.line, ...d.commentLines);
    d.seconds = sumRats(d.postings.filter((p) => p.valid && d.valid).map((p) => p.seconds));
  }
  const sorted = sortDiagnostics(diagnostics);
  const validDay = new Set(days.filter((d) => d.valid).map((d) => d.id));
  const totalSeconds = sumRats(postings.filter((p) => p.valid && validDay.has(p.dayId)).map((p) => p.seconds));
  return {
    kind: "timedot", text, eol: detectEol(text), lines: lines.map((l, i) => ({ ...l, kind: lineKinds[i] })),
    days, postings, diagnostics: sorted, counts: countDiagnostics(sorted), totalSeconds,
    accounts: [...new Set(postings.map((p) => p.account).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
  };
}

/** Postings that count towards totals: valid amount, on a day with a valid date. */
export const countable = (model) => {
  const ok = new Set(model.days.filter((d) => d.valid).map((d) => d.id));
  return model.postings.filter((p) => p.valid && ok.has(p.dayId));
};

/* ============================================================ source editing */
export function validateAccount(name) {
  const s = String(name ?? "");
  if (!s.trim()) return "Give the entry an account, e.g. work:programming.";
  if (/[\r\n]/.test(s)) return "The account must be on one line.";
  if (s !== s.trim()) return "The account can't start or end with a space.";
  if (s.includes(";")) return "The account can't contain “;” (it starts a comment).";
  if (/[ \t]{2,}|\t/.test(s)) return "The account can't contain a tab or two spaces in a row (that's where the amount starts).";
  if (/^[#*]/.test(s)) return "The account can't start with # or * (those lines are comments and headings).";
  if (DATE_SHAPE.test(s) || DIRECTIVE_RE.test(s)) return "That looks like a date or a journal directive, not an account.";
  return null;
}
const validateComment = (c) => (/[\r\n]/.test(String(c ?? "")) ? "The comment must be on one line." : null);
const validateDate = (iso) => (parseSimpleDate(String(iso ?? ""))?.valid ? null : "Enter a real date.");
const refuse = (error) => ({ ok: false, error });

function accept(before, newText, expectedTotal) {
  const after = parseTimedot(newText);
  const added = newErrors(before, after);
  if (added.length) return refuse(`That change would make the file invalid: ${added[0].message}`);
  if (expectedTotal && !after.totalSeconds.equals(expectedTotal)) return refuse("That change would not leave the totals as expected, so it was not applied. Edit the file in Raw view instead.");
  return { ok: true, text: newText, model: after };
}
const findPosting = (m, id) => m.postings.find((p) => p.id === id) ?? null;
const findDay = (m, id) => m.days.find((d) => d.id === id) ?? null;
const lineOf = (m, n) => m.lines[n - 1];
const entryLine = ({ indent = "", account, quantityText = "", comment = "", amountColumn = null }) => {
  const pad = quantityText ? " ".repeat(Math.max(2, amountColumn != null ? amountColumn - indent.length - account.length : 2)) : "";
  return `${indent}${account}${pad}${quantityText}${comment ? `  ; ${comment}` : ""}`;
};

/**
 * Puts a new day block (heading + optional entries, ending in a line break) into the text: in date order when the file
 * is already in date order (keeping comments that sit right above a date line with that date), else at the end.
 */
function insertDayBlock(text, model, iso, block) {
  const eol = model.eol;
  const dated = model.days.filter((d) => d.date);
  const sortedFile = dated.every((d, i) => i === 0 || dated[i - 1].date <= d.date);
  const later = sortedFile ? dated.find((d) => d.date > iso) : null;
  if (later) {
    let i = later.line - 1;
    while (i > 0 && ["comment", "heading"].includes(model.lines[i - 1].kind)) i--;
    const at = model.lines[i].start;
    const prevBlank = i === 0 || model.lines[i - 1].kind === "blank";
    return text.slice(0, at) + (prevBlank ? "" : eol) + block + eol + text.slice(at);
  }
  const lastLine = model.lines[model.lines.length - 1];
  const needBlank = text.trim() !== "" && lastLine.text.trim() !== "";
  return (text ? (/[\r\n]$/.test(text) ? text : text + eol) : "") + (needBlank ? eol : "") + block;
}

/** Adds an entry under `date`: after that date's last group, else as a new date group (in order when the file is in order). */
export function addPosting(text, { date, account, quantityText = "", comment = "" }) {
  const err = validateDate(date) ?? validateAccount(account) ?? validateComment(comment);
  if (err) return refuse(err);
  const q = parseQuantity(quantityText);
  if (!q.ok) return refuse(q.error);
  const model = parseTimedot(text);
  const eol = model.eol;
  const iso = parseSimpleDate(date).iso;
  const groups = model.days.filter((d) => d.date === iso);
  let next;

  if (groups.length) {
    const g = groups[groups.length - 1];
    const prev = g.postings[g.postings.length - 1];
    const amountColumn = prev?.ranges.amount ? prev.ranges.amount.start - prev.ranges.line.start : null;
    const line = entryLine({ indent: prev && !prev.orgPrefix ? prev.indent : "", account, quantityText: quantityText.trim(), comment: comment.trim(), amountColumn });
    const at = g.insertAt;
    next = text.slice(0, at) + (at > 0 && !/[\r\n]$/.test(text.slice(0, at)) ? eol : "") + line + eol + text.slice(at);
  } else {
    const line = entryLine({ account, quantityText: quantityText.trim(), comment: comment.trim() });
    next = insertDayBlock(text, model, iso, `${iso}${eol}${line}${eol}`);
  }
  return accept(model, next, model.totalSeconds.add(q.seconds));
}

/** Edits one entry. patch: { account?, quantityText?, comment? } — only the spans that change are rewritten. */
export function editPosting(text, postingId, patch) {
  const model = parseTimedot(text);
  const p = findPosting(model, postingId);
  if (!p) return refuse("That entry no longer exists.");
  const err = (patch.account != null ? validateAccount(patch.account) : null) ?? (patch.comment != null ? validateComment(patch.comment) : null);
  if (err) return refuse(err);
  const edits = [];
  const dayOk = findDay(model, p.dayId)?.valid;
  let delta = ZERO;

  if (patch.account != null && patch.account !== p.account) edits.push({ ...p.ranges.account, text: patch.account });

  if (patch.quantityText != null && patch.quantityText.trim() !== p.raw) {
    const q = parseQuantity(patch.quantityText);
    if (!q.ok) return refuse(q.error);
    const t = patch.quantityText.trim();
    if (p.ranges.amount && t) edits.push({ ...p.ranges.amount, text: t });
    else if (p.ranges.amount) edits.push({ start: p.ranges.account.end, end: p.ranges.amount.end, text: "" });
    else if (t) edits.push({ start: p.ranges.account.end, end: p.ranges.account.end, text: `  ${t}` });
    if (dayOk) delta = q.seconds.sub(p.valid ? p.seconds : ZERO);
  }

  if (patch.comment != null && patch.comment.trim() !== p.comment.split("\n")[0]) {
    const c = patch.comment.trim();
    const lineText = lineOf(model, p.line).text;
    const rel = (o) => o - p.ranges.line.start;
    if (p.ranges.comment && c) edits.push({ ...p.ranges.comment, text: `; ${c}` });
    else if (p.ranges.comment) {
      const wsStart = p.ranges.line.start + lineText.slice(0, rel(p.ranges.comment.start)).replace(/[ \t]+$/, "").length;
      edits.push({ start: wsStart, end: p.ranges.comment.end, text: "" });
    } else if (c) edits.push({ start: p.ranges.line.end, end: p.ranges.line.end, text: `  ; ${c}` });
  }
  if (!edits.length) return { ok: true, text, model, unchanged: true };
  return accept(model, applyEdits(text, edits), model.totalSeconds.add(delta));
}

/** Removes one entry and the indented ; comment lines that belong to it. Neighbouring lines are untouched. */
export function deletePosting(text, postingId) {
  const model = parseTimedot(text);
  const p = findPosting(model, postingId);
  if (!p) return refuse("That entry no longer exists.");
  const dayOk = findDay(model, p.dayId)?.valid;
  const loss = dayOk && p.valid ? p.seconds : ZERO;
  return accept(model, applyEdits(text, [{ start: p.range.start, end: p.range.end, text: "" }]), model.totalSeconds.sub(loss));
}

/**
 * Removes several entries in ONE edit (each with the indented ; comment lines that belong to it). Day headings, comments
 * and neighbouring entries are untouched. All or nothing: a missing entry refuses the whole batch, and the totals must
 * drop by exactly what the removed entries were worth.
 * @returns {{ ok: true, text, model, deleted: number } | { ok: false, error }}
 */
export function deletePostings(text, postingIds) {
  const ids = [...new Set(postingIds ?? [])];
  if (!ids.length) return refuse("No entries were selected.");
  const model = parseTimedot(text);
  const validDay = new Set(model.days.filter((d) => d.valid).map((d) => d.id));
  const edits = [];
  let loss = ZERO;
  for (const id of ids) {
    const p = findPosting(model, id);
    if (!p) return refuse(ids.length === 1 ? "That entry no longer exists." : "One of the selected entries no longer exists, so nothing was deleted. Select again.");
    edits.push({ start: p.range.start, end: p.range.end, text: "" });
    if (validDay.has(p.dayId) && p.valid) loss = loss.add(p.seconds);
  }
  const res = accept(model, applyEdits(text, edits), model.totalSeconds.sub(loss));
  return res.ok ? { ...res, deleted: ids.length } : res;
}

/**
 * Edits an entry AND, when `date` differs from its day, moves it (with its indented comment lines) under that date: an
 * existing day group of that date, else a new day heading in date order. Without a date change this is editPosting.
 * patch: { date, account?, quantityText?, comment? }. All or nothing; the totals must come out exactly as expected.
 */
export function movePosting(text, postingId, { date, ...patch }) {
  const bad = validateDate(date);
  if (bad) return refuse(bad);
  const model = parseTimedot(text);
  const p = findPosting(model, postingId);
  if (!p) return refuse("That entry no longer exists.");
  const iso = parseSimpleDate(date).iso;
  const day = findDay(model, p.dayId);
  if (day.date === iso) return editPosting(text, postingId, patch);

  let working = text;
  if (Object.values(patch).some((v) => v != null)) {
    const r = editPosting(text, postingId, patch);
    if (!r.ok) return r;
    working = r.text;
  }
  const m1 = parseTimedot(working);
  const p1 = findPosting(m1, postingId);                          // edits stay inside one line, so the id still points at it
  if (!p1) return refuse("That entry could not be moved. Edit it in Raw view instead.");
  let block = working.slice(p1.range.start, p1.range.end);
  if (!/[\r\n]$/.test(block)) block += m1.eol;
  const removed = applyEdits(working, [{ start: p1.range.start, end: p1.range.end, text: "" }]);
  const m2 = parseTimedot(removed);
  const groups = m2.days.filter((d) => d.date === iso);
  let next;
  if (groups.length) {
    const at = groups[groups.length - 1].insertAt;
    next = removed.slice(0, at) + (at > 0 && !/[\r\n]$/.test(removed.slice(0, at)) ? m2.eol : "") + block + removed.slice(at);
  } else {
    next = insertDayBlock(removed, m2, iso, `${iso}${m2.eol}${block}`);
  }
  const before = day.valid && p1.valid ? p1.seconds : ZERO, after = p1.valid ? p1.seconds : ZERO;
  return accept(m1, next, m1.totalSeconds.sub(before).add(after));
}

/** Adds an empty day heading: `DATE[ DESCRIPTION]`. One day per date: an existing date is refused (add entries to it instead). */
export function addDay(text, { date, description = "" }) {
  const err = validateDate(date) ?? (/[\r\n]/.test(String(description)) ? "The description must be on one line." : null)
    ?? (String(description).includes(";") ? "The description can't contain “;” (it starts a comment)." : null);
  if (err) return refuse(err);
  const model = parseTimedot(text);
  const iso = parseSimpleDate(date).iso;
  const existing = model.days.find((d) => d.date === iso);
  if (existing) return refuse(`${iso} is already in this file (line ${existing.line}). Add entries to that day instead.`);
  const d = String(description).trim();
  const next = insertDayBlock(text, model, iso, `${iso}${d ? ` ${d}` : ""}${model.eol}`);
  return accept(model, next, model.totalSeconds);
}

/** Changes a day heading's date and/or description. */
export function editDay(text, dayId, patch) {
  const model = parseTimedot(text);
  const d = findDay(model, dayId);
  if (!d) return refuse("That day no longer exists.");
  if (patch.date != null) { const e = validateDate(patch.date); if (e) return refuse(e); }
  const e = patch.description != null ? validateComment(patch.description) ?? (patch.description.includes(";") ? "The description can't contain “;” (it starts a comment)." : null) : null;
  if (e) return refuse(e);
  const edits = [];
  if (patch.date != null && patch.date !== d.date) edits.push({ ...d.ranges.date, text: parseSimpleDate(patch.date).iso });
  if (patch.description != null && patch.description.trim() !== d.description) {
    const t = patch.description.trim();
    if (d.ranges.description && t) edits.push({ ...d.ranges.description, text: t });
    else if (d.ranges.description) edits.push({ start: d.ranges.date.end, end: d.ranges.description.end, text: "" });
    else if (t) edits.push({ start: d.ranges.date.end, end: d.ranges.date.end, text: ` ${t}` });
  }
  if (!edits.length) return { ok: true, text, model, unchanged: true };
  return accept(model, applyEdits(text, edits));
}

/** Removes a day heading with all of its entries (and their comment lines). Blank lines and comments between groups stay. */
export function deleteDay(text, dayId) {
  const model = parseTimedot(text);
  const d = findDay(model, dayId);
  if (!d) return refuse("That day no longer exists.");
  const loss = d.valid ? d.seconds : ZERO;
  return accept(model, applyEdits(text, [{ start: d.range.start, end: d.insertAt, text: "" }]), model.totalSeconds.sub(loss));
}

/* ================================================================ summaries */
const accountMatches = (account, wanted) => !wanted || account === wanted || account.startsWith(`${wanted}:`);

/**
 * Totals straight from the parsed quantities. filter: { from, to, account, project, text }.
 * @returns {{ totalSeconds: Rat, postingCount: number, dayCount: number, averageSeconds: Rat|null,
 *   days: object[], byDay: object[], byWeek: object[], byMonth: object[], byAccount: object[], byProject: object[],
 *   byType: object[], firstDate: string|null, lastDate: string|null, excluded: number, incomplete: boolean }}
 */
export function summarizeTimedot(model, filter = {}, { weekStart = "monday" } = {}) {
  const buckets = { day: new Map(), week: new Map(), month: new Map(), account: new Map(), project: new Map(), type: new Map() };
  const dayMap = new Map();
  const add = (kind, key, seconds) => { const b = buckets[kind].get(key) ?? { key, seconds: ZERO, count: 0 }; b.seconds = b.seconds.add(seconds); b.count++; buckets[kind].set(key, b); };
  const dayById = new Map(model.days.map((d) => [d.id, d]));
  let total = ZERO, count = 0, first = null, last = null;

  for (const p of countable(model)) {
    const d = dayById.get(p.dayId);
    if (filter.from && d.date < filter.from) continue;
    if (filter.to && d.date > filter.to) continue;
    if (!accountMatches(p.account, filter.account)) continue;
    if (filter.project && projectOf(p.account) !== filter.project) continue;
    if (filter.text && !matchesText([p.account, p.comment, p.raw, d.description, d.comment, d.date, ...p.types.map((t) => t.type)], filter.text)) continue;
    total = total.add(p.seconds); count++;
    if (!first || d.date < first) first = d.date;
    if (!last || d.date > last) last = d.date;
    add("day", d.date, p.seconds);
    add("week", weekStartIso(d.date, weekStart), p.seconds);
    add("month", monthKey(d.date), p.seconds);
    add("account", p.account, p.seconds);
    add("project", projectOf(p.account), p.seconds);
    for (const t of p.types) add("type", t.type, t.seconds);
    const row = dayMap.get(d.date) ?? { date: d.date, seconds: ZERO, postings: [], groups: [] };
    row.seconds = row.seconds.add(p.seconds); row.postings.push(p);
    if (!row.groups.includes(d)) row.groups.push(d);
    dayMap.set(d.date, row);
  }
  const rows = (kind, cmp) => [...buckets[kind].values()].sort(cmp);
  const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const bySeconds = (a, b) => b.seconds.cmp(a.seconds) || byKey(a, b);
  const excluded = model.postings.length - countable(model).length;
  return {
    totalSeconds: total, postingCount: count, dayCount: dayMap.size,
    averageSeconds: dayMap.size ? total.div(BigInt(dayMap.size)) : null,
    days: [...dayMap.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
    byDay: rows("day", byKey), byWeek: rows("week", byKey), byMonth: rows("month", byKey),
    byAccount: rows("account", bySeconds), byProject: rows("project", bySeconds), byType: rows("type", byKey),
    firstDate: first, lastDate: last, excluded,
    incomplete: excluded > 0 || model.days.some((d) => !d.valid),
  };
}

export const projectsOf = (model) => [...new Set(model.postings.map((p) => projectOf(p.account)))].sort((a, b) => a.localeCompare(b));
