/* time-highlight.js — which parts of a .timeclock / .timedot line are which token, for the Raw editor's colouring.
 * Pure. It asks the SAME line analyzers the parsers use (analyzeTimeclockLine / analyzeTimedotLine), so highlighting
 * can never disagree with what the parser understood. CodeMirror turns the spans into decorations (codemirror/entry.js).
 */
import { analyzeTimeclockLine } from "./timeclock.js";
import { analyzeTimedotLine } from "./timedot.js";

/** CSS class suffixes; entry.js styles each as .cm-wt-<name>. */
function timeclockSpans(text) {
  const a = analyzeTimeclockLine(text);
  if (a.kind === "blank") return [];
  if (a.kind === "comment") return [{ from: 0, to: text.length, cls: "comment" }];
  if (a.kind === "unknown") return [{ from: 0, to: text.length, cls: "invalid" }];
  const spans = [{ from: 0, to: 1, cls: a.code === "i" ? "in" : a.code === "o" ? "out" : "ignored" }];
  const put = (t, cls) => { if (t) spans.push({ from: t.start, to: t.end, cls }); };
  if (a.code === "b" || a.code === "h" || a.code === "O") {
    put(a.date, "date"); put(a.time && { start: a.time.start, end: a.tz ? a.tz.start : a.time.end }, "time"); put(a.extra, "comment"); put(a.comment, "comment");
    return spans.sort((x, y) => x.from - y.from);
  }
  put(a.date, a.date?.parsed?.valid ? "date" : "invalid");
  put(a.time && { start: a.time.start, end: a.tz ? a.tz.start : a.time.end }, a.time?.parsed?.valid ? "time" : "invalid");
  put(a.tz, "tz");
  put(a.account, "account");
  put(a.description, "desc");
  put(a.extra, "invalid");
  put(a.comment, "comment");
  return spans.sort((x, y) => x.from - y.from);
}

function timedotSpans(text, seenDate) {
  const a = analyzeTimedotLine(text, { seenDate });
  if (a.kind === "blank") return [];
  if (a.kind === "comment" || a.kind === "heading") return [{ from: 0, to: text.length, cls: "comment" }];
  if (a.kind === "directive" || a.kind === "unsupported") return [{ from: 0, to: text.length, cls: "invalid" }];
  const spans = [];
  const put = (t, cls) => { if (t) spans.push({ from: t.start, to: t.end, cls }); };
  if (a.kind === "date") {
    put(a.orgPrefix, "org"); put(a.date, a.date.parsed?.valid ? "daydate" : "invalid"); put(a.description, "desc"); put(a.comment, "comment");
    return spans.sort((x, y) => x.from - y.from);
  }
  put(a.orgPrefix, "org");
  put(a.account, "account");
  if (a.quantity) {
    const q = a.quantity;
    if (!a.parsed.ok) spans.push({ from: q.start, to: q.end, cls: "invalid" });
    else if (a.parsed.kind === "dots") spans.push({ from: q.start, to: q.end, cls: "dots" });
    else if (a.parsed.kind === "letters") spans.push({ from: q.start, to: q.end, cls: "letters" });
    else {
      const m = /^([\d.]+)(mo|[smhdwy])?$/.exec(q.text);
      const split = q.start + (m?.[1].length ?? q.text.length);
      spans.push({ from: q.start, to: split, cls: "number" });
      if (m?.[2]) spans.push({ from: split, to: q.end, cls: "unit" });
    }
  }
  put(a.comment, "comment");
  return spans.sort((x, y) => x.from - y.from);
}

/**
 * Spans [{ from, to, cls }] (offsets within the line) for one line. For timedot, `seenDate` says whether a day heading
 * came earlier in the document (use firstDateLine to find where it starts).
 */
export function highlightSpans(kind, text, { seenDate = true } = {}) {
  return kind === "timeclock" ? timeclockSpans(text) : kind === "timedot" ? timedotSpans(text, seenDate) : [];
}

/** 1-based number of the first timedot day heading among `count` lines (`lineAt(n)` returns line n's text), or Infinity. Stops at the first one. */
export function firstDateLine(count, lineAt) {
  for (let n = 1; n <= count; n++) if (analyzeTimedotLine(lineAt(n), { seenDate: false }).kind === "date") return n;
  return Infinity;
}
