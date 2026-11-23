/* find.js — one implementation of "find" for the rendered list and the raw editor. No DOM.
 *
 *   compileQuery(query, { caseSensitive, wholeWord, regexp })
 *     -> { ok: true, test(haystack): boolean, ranges(haystack): [{ from, to }, ...] }
 *      | { ok: false, error: string }
 *
 * An empty query matches nothing (callers treat that as "no search"). Matching is Unicode-aware: the `u` flag always,
 * `i` unless caseSensitive. "Whole word" means the match is not glued to a letter, number or underscore on either
 * side (so a colon is a boundary: `bank` is a word inside `assets:bank:checking`). \b is ASCII-only, hence lookarounds.
 */
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\\/-]/g, "\\$&");
const WORD = String.raw`[\p{L}\p{N}_]`;

// "Invalid regular expression: /((/giu: Unterminated group" -> "Unterminated group"
const oneLine = (msg) => String(msg ?? "Invalid regular expression").split("\n")[0]
  .replace(/^Invalid regular expression:\s*/i, "").replace(/^\/.*\/[a-z]*:\s*/, "").slice(0, 140);

export function compileQuery(query, { caseSensitive = false, wholeWord = false, regexp = false } = {}) {
  const q = String(query ?? "");
  if (q === "") return { ok: true, test: () => false, ranges: () => [] };

  const flags = `gu${caseSensitive ? "" : "i"}`;
  // The pattern must be valid on its own: wrapping it must not be able to "repair" something like `a)(b`.
  if (regexp) { try { new RegExp(q, flags); } catch (err) { return { ok: false, error: oneLine(err?.message) }; } }
  const core = regexp ? q : escapeRegExp(q);
  const source = wholeWord ? `(?<!${WORD})(?:${core})(?!${WORD})` : core;
  let re;
  try { re = new RegExp(source, flags); }
  catch (err) { return { ok: false, error: oneLine(err?.message) }; }

  const ranges = (haystack) => {
    const text = String(haystack ?? "");
    const out = [];
    const rx = new RegExp(re.source, re.flags);
    let m;
    while ((m = rx.exec(text)) !== null) {
      out.push({ from: m.index, to: m.index + m[0].length });
      if (m[0].length === 0) {                                  // zero-length match: step over one code point, never loop
        const cp = text.codePointAt(rx.lastIndex);
        rx.lastIndex += cp !== undefined && cp > 0xffff ? 2 : 1;
        if (rx.lastIndex > text.length) break;
      }
    }
    return out;
  };
  const test = (haystack) => {
    const rx = new RegExp(re.source, re.flags.replace("g", ""));
    return rx.test(String(haystack ?? ""));
  };
  return { ok: true, test, ranges };
}

/**
 * The next range after `from` (dir = 1) or before `to` (dir = -1), wrapping once; null when there are none.
 * `sel` is the current selection { from, to }.
 */
export function stepRange(ranges, sel, dir = 1) {
  if (!ranges.length) return null;
  if (dir >= 0) return ranges.find((r) => r.from >= sel.to) ?? ranges[0];
  for (let i = ranges.length - 1; i >= 0; i--) if (ranges[i].to <= sel.from) return ranges[i];
  return ranges[ranges.length - 1];
}
