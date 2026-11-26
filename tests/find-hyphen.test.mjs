import test from "node:test";
import assert from "node:assert/strict";
import { compileQuery } from "../assets/js/shell/find.js";

// A plain search containing a hyphen (a date, "e-mail", "assets:bank-fees") used to fail with "Invalid escape".
test("plain searches may contain hyphens and still match literally", () => {
  const r = compileQuery("2026-11-24");
  assert.equal(r.ok, true);
  assert.equal(r.test("on 2026-11-24 at noon"), true);
  assert.equal(r.test("2026/11/24"), false);
  assert.equal(compileQuery("bank-fees", { wholeWord: true }).test("assets:bank-fees"), true);
});

test("other regex characters are still matched literally in a plain search", () => {
  for (const s of ["a.b", "a+b", "(x)", "[x]", "a/b", "$5", "a|b", "^x", "a\\b"]) {
    const r = compileQuery(s);
    assert.equal(r.ok, true, s);
    assert.equal(r.test(`..${s}..`), true, s);
  }
  assert.equal(compileQuery("a.b").test("axb"), false);
});
