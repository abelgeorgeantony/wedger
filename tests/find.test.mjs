import test from "node:test";
import assert from "node:assert/strict";
import { compileQuery, stepRange } from "../assets/js/shell/find.js";

const ok = (q, o) => { const c = compileQuery(q, o); assert.equal(c.ok, true); return c; };

test("empty query matches nothing", () => {
  const c = ok("");
  assert.equal(c.test("anything"), false);
  assert.deepEqual(c.ranges("anything"), []);
});

test("default is a case-insensitive substring match", () => {
  const c = ok("coffee");
  assert.equal(c.test("Morning COFFEE run"), true);
  assert.equal(c.test("tea"), false);
  assert.deepEqual(c.ranges("Coffee, coffee"), [{ from: 0, to: 6 }, { from: 8, to: 14 }]);
});

test("match case", () => {
  const c = ok("Coffee", { caseSensitive: true });
  assert.equal(c.test("coffee"), false);
  assert.equal(c.test("Coffee"), true);
});

test("regexp off: special characters are literal", () => {
  const c = ok("a.c");
  assert.equal(c.test("abc"), false);
  assert.equal(c.test("a.c"), true);
  assert.equal(ok("a*").test("aaa"), false);
  assert.equal(ok("(x)").test("(x)"), true);
});

test("whole word: colon is a boundary, a word character is not", () => {
  const w = { wholeWord: true };
  assert.equal(ok("bank", w).test("assets:bank:checking"), true);
  assert.equal(ok("exp", w).test("expenses"), false);
  assert.equal(ok("exp", w).test("exp"), true);
  assert.equal(ok("bank", w).test("sandbank"), false);
  assert.equal(ok("bank", w).test("bank_1"), false);
});

test("whole word is Unicode-aware (é is a word character)", () => {
  assert.equal(ok("cafe", { wholeWord: true }).test("café"), false);
  assert.equal(ok("caf", { wholeWord: true }).test("café"), false);
  assert.equal(ok("café", { wholeWord: true }).test("un café noir"), true);
  assert.equal(ok("é", { wholeWord: true }).test("é"), true);
});

test("regexp on", () => {
  const c = ok("^2026-\\d{2}", { regexp: true });
  assert.equal(c.test("2026-01-02"), true);
  assert.deepEqual(ok("c\\w+", { regexp: true }).ranges("cat cow"), [{ from: 0, to: 3 }, { from: 4, to: 7 }]);
});

test("invalid regexp returns { ok: false } with a one-line message and never throws", () => {
  for (const q of ["(", "[a-", "*a", "a{2,1}"]) {
    const c = compileQuery(q, { regexp: true });
    assert.equal(c.ok, false, q);
    assert.equal(typeof c.error, "string");
    assert.ok(c.error.length > 0 && !c.error.includes("\n"));
  }
});

test("wholeWord + regexp wraps the pattern; a pattern that breaks when wrapped is an error", () => {
  const c = ok("ban(k|d)", { regexp: true, wholeWord: true });
  assert.equal(c.test("assets:bank"), true);
  assert.equal(c.test("sandbanks"), false);
  assert.equal(compileQuery("a)(b", { regexp: true, wholeWord: true }).ok, false);
});

test("patterns that can match the empty string do not loop and advance at least one character", () => {
  const c = ok("a*", { regexp: true });
  const r = c.ranges("baac");
  assert.ok(r.length >= 3 && r.length <= 5);
  assert.ok(r.some((x) => x.from === 1 && x.to === 3));
  const dot = ok(".*", { regexp: true }).ranges("ab\ncd");
  assert.ok(dot.length >= 2);
  assert.deepEqual(ok("", { regexp: true }).ranges("abc"), []);
  assert.ok(ok("x*", { regexp: true }).ranges("😀😀").length <= 3);
});

test("ranges are counted per match, including overlapping text across calls", () => {
  assert.equal(ok("aa").ranges("aaaa").length, 2);                  // non-overlapping, like every editor
  assert.equal(ok("Aa", { caseSensitive: true }).ranges("aA Aa aa").length, 1);
});

test("stepRange moves after the selection and wraps once", () => {
  const ranges = [{ from: 2, to: 4 }, { from: 10, to: 12 }, { from: 20, to: 22 }];
  assert.deepEqual(stepRange(ranges, { from: 0, to: 0 }, 1), ranges[0]);
  assert.deepEqual(stepRange(ranges, { from: 2, to: 4 }, 1), ranges[1]);
  assert.deepEqual(stepRange(ranges, { from: 20, to: 22 }, 1), ranges[0]);       // wrap
  assert.deepEqual(stepRange(ranges, { from: 10, to: 12 }, -1), ranges[0]);
  assert.deepEqual(stepRange(ranges, { from: 2, to: 4 }, -1), ranges[2]);        // wrap
  assert.equal(stepRange([], { from: 0, to: 0 }, 1), null);
});
