import test from "node:test";
import assert from "node:assert/strict";
import { createSelection } from "../assets/js/shell/time-select.js";

const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: `r${i + 1}` }));

test("selecting one record, then several, then clearing", () => {
  const sel = createSelection();
  const shown = rows(5);
  assert.deepEqual(sel.set(shown[1], true, { shown }), ["r2"]);
  assert.equal(sel.size, 1);
  sel.set(shown[3], true, { shown });
  assert.deepEqual(sel.list().sort(), ["r2", "r4"]);
  sel.set(shown[1], false, { shown });
  assert.deepEqual(sel.list(), ["r4"]);
  assert.equal(sel.clear(), true);
  assert.equal(sel.size, 0);
  assert.equal(sel.clear(), false);
});

test("shift-click selects the range between the last toggled row and this one, in the shown order", () => {
  const sel = createSelection();
  const shown = rows(6);
  sel.set(shown[1], true, { shown });
  const touched = sel.set(shown[4], true, { shown, range: true });
  assert.deepEqual(touched, ["r2", "r3", "r4", "r5"]);
  // and backwards
  sel.clear();
  sel.set(shown[4], true, { shown });
  sel.set(shown[2], true, { shown, range: true });
  assert.deepEqual(sel.list().sort(), ["r3", "r4", "r5"]);
});

test("a range never selects rows the list does not show, nor rows that are not selectable", () => {
  const sel = createSelection();
  const shown = [{ id: "a" }, { id: "locked", locked: true }, { id: "c" }];
  sel.set(shown[0], true, { shown });
  sel.set(shown[2], true, { shown, range: true, selectable: (r) => !r.locked });
  assert.deepEqual(sel.list().sort(), ["a", "c"]);
});

test("select all visible only takes what is shown; filtered-out selections are counted, kept and never visible", () => {
  const sel = createSelection();
  const all = rows(6);
  sel.selectAll(all);
  assert.equal(sel.size, 6);
  const shown = all.slice(0, 2);                          // a filter now hides r3..r6
  assert.deepEqual(sel.visible(shown).map((r) => r.id), ["r1", "r2"]);
  assert.equal(sel.hiddenCount(shown), 4);
  sel.clear();
  assert.equal(sel.selectAll(shown), 2);
  assert.equal(sel.size, 2);                              // r3..r6 were NOT added
  assert.equal(sel.hiddenCount(shown), 0);
});

test("leaving selection mode forgets the selection; entering it keeps nothing", () => {
  const sel = createSelection();
  assert.equal(sel.setMode(true), true);
  sel.set({ id: "x" }, true);
  assert.equal(sel.setMode(true), false);
  assert.equal(sel.size, 1);
  sel.setMode(false);
  assert.equal(sel.size, 0);
  assert.equal(sel.mode, false);
});

test("ids belong to one text: binding a different text drops the selection, the same text keeps it", () => {
  const sel = createSelection();
  sel.bind("text one");
  sel.set({ id: "s1" }, true);
  assert.equal(sel.bind("text one"), false);
  assert.equal(sel.size, 1);
  assert.equal(sel.bind("text two"), true);
  assert.equal(sel.size, 0);
});

test("prune drops ids that no longer exist", () => {
  const sel = createSelection();
  for (const id of ["a", "b", "c"]) sel.set({ id }, true);
  assert.equal(sel.prune(new Set(["a", "c"])), 1);
  assert.deepEqual(sel.list().sort(), ["a", "c"]);
});
