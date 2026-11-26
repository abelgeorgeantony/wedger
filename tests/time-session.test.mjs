import test from "node:test";
import assert from "node:assert/strict";
import { Emitter } from "../assets/js/shell/core.js";
import { TimeSession } from "../assets/js/shell/time-session.js";
import { clockIn, clockOut } from "../assets/js/shell/timeclock.js";
import { addPosting, editPosting } from "../assets/js/shell/timedot.js";

/** A stand-in for host.files / host.settings with the same surface the session uses. */
function fakeHost(initial = {}, { autoSave = true } = {}) {
  const store = new Map(Object.entries(initial));
  const files = Object.assign(new Emitter(), {
    writes: [],
    get: (n) => (store.has(n) ? { name: n, content: store.get(n) } : null),
    exists: (n) => store.has(n),
    write(n, c) { if (!store.has(n)) throw new Error(`"${n}" was not found.`); if (store.get(n) === c) return; store.set(n, c); this.writes.push([n, c]); this.emit("changed", { kind: "write", name: n }); },
  });
  const values = { autoSave };
  const settings = Object.assign(new Emitter(), { get: (k) => values[k], set(k, v) { values[k] = v; this.emit(k, v); } });
  return { store, files, settings };
}
const mk = (initial, opts, name = "w.timeclock") => {
  const h = fakeHost(initial, opts);
  const dirty = [];
  const s = new TimeSession({ ...h, name: () => name, setDirty: (d) => dirty.push(d), autosaveMs: 5 });
  return { ...h, s, dirty };
};

test("raw edits update the parsed model; the text is the single copy", () => {
  const { s } = mk({ "w.timeclock": "" });
  assert.equal(s.model.sessions.length, 0);
  s.setText("i 2026-11-23 09:00 a\no 2026-11-23 10:00 a\n");
  assert.equal(s.model.sessions[0].durationSeconds, 3600);
  assert.equal(s.model, s.model);                                                       // cached until the text changes
});

test("a rendered mutation updates the raw text and the model together", () => {
  const { s } = mk({ "w.timeclock": "# log\n" });
  const events = [];
  s.on("text", (e) => events.push(e.source));
  const r = s.apply((t) => clockIn(t, { date: "2026-11-23", time: "09:00:00", account: "a" }));
  assert.ok(r.ok);
  assert.equal(s.text, "# log\ni 2026-11-23 09:00:00 a\n");
  assert.equal(s.model.sessions[0].status, "open");
  const id = s.model.sessions[0].id;
  s.apply((t) => clockOut(t, id, { date: "2026-11-23", time: "09:30:00" }));
  assert.equal(s.model.sessions[0].durationSeconds, 1800);
  assert.deepEqual(events, ["mutation", "mutation"]);
});

test("a refused mutation changes nothing", () => {
  const { s, dirty } = mk({ "w.timeclock": "i 2026-11-23 09:00 a\n" });
  const before = s.text;
  const r = s.apply((t) => clockIn(t, { date: "2026-11-23", time: "10:00", account: "a" }));
  assert.equal(r.ok, false);
  assert.equal(s.text, before); assert.equal(s.isDirty, false); assert.deepEqual(dirty, []);
});

test("save() persists through host.files.write; dirty tracks accurately with auto-save off", () => {
  const { s, files, dirty, store } = mk({ "w.timeclock": "" }, { autoSave: false });
  s.setText("i 2026-11-23 09:00 a\n");
  assert.equal(s.isDirty, true); assert.equal(dirty.at(-1), true);
  assert.equal(files.writes.length, 0);
  assert.equal(s.save(), true);
  assert.deepEqual(files.writes, [["w.timeclock", "i 2026-11-23 09:00 a\n"]]);
  assert.equal(store.get("w.timeclock"), "i 2026-11-23 09:00 a\n");
  assert.equal(s.isDirty, false); assert.equal(dirty.at(-1), false);
  s.setText("x"); s.setText("i 2026-11-23 09:00 a\n");                                   // back to the saved text
  assert.equal(s.isDirty, false);
});

test("auto-save debounces, never shows the dirty dot, and flushes on dispose", async () => {
  const { s, files, dirty } = mk({ "w.timedot": "" }, {}, "w.timedot");
  s.setText("2026-11-23\na  .\n"); s.setText("2026-11-23\na  ..\n");
  assert.equal(files.writes.length, 0);
  assert.ok(dirty.every((d) => d === false));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(files.writes.length, 1);
  s.setText("2026-11-23\na  ...\n");
  s.dispose();                                                                          // closing the tab must not lose the edit
  assert.equal(files.writes.length, 2);
  assert.equal(files.get("w.timedot").content, "2026-11-23\na  ...\n");
});

test("with auto-save off, dispose does not silently write (the tab asked first)", () => {
  const { s, files } = mk({ "w.timeclock": "" }, { autoSave: false });
  s.setText("i 2026-11-23 09:00 a\n");
  s.dispose();
  assert.equal(files.writes.length, 0);
});

test("turning auto-save on saves pending edits", async () => {
  const { s, files, settings } = mk({ "w.timeclock": "" }, { autoSave: false });
  s.setText("i 2026-11-23 09:00 a\n");
  settings.set("autoSave", true);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(files.writes.length, 1);
});

test("external changes are adopted when clean, ignored when there are unsaved edits", () => {
  const h = mk({ "w.timeclock": "a" }, { autoSave: false });
  const seen = [];
  h.s.on("text", (e) => seen.push(e.source));
  h.store.set("w.timeclock", "b"); h.files.emit("changed", { kind: "reload" });
  assert.equal(h.s.text, "b"); assert.deepEqual(seen, ["external"]);
  h.s.setText("mine");
  h.store.set("w.timeclock", "c"); h.files.emit("changed", { kind: "write", name: "w.timeclock" });
  assert.equal(h.s.text, "mine");
});

test("a failed write is reported and keeps the edit dirty", () => {
  const h = mk({ "w.timeclock": "" }, { autoSave: false });
  h.files.write = () => { throw new Error("storage full"); };
  const errors = [];
  h.s.on("error", (m) => errors.push(m));
  h.s.setText("x");
  assert.equal(h.s.save(), false);
  assert.deepEqual(errors, ["storage full"]); assert.equal(h.s.isDirty, true);
});

test("renamed files: the session follows name() and still saves", () => {
  const h = fakeHost({ "a.timedot": "" }, { autoSave: false });
  let name = "a.timedot";
  const s = new TimeSession({ ...h, name: () => name });
  s.setText("2026-11-23\nx  .\n");
  h.store.set("b.timedot", h.store.get("a.timedot")); h.store.delete("a.timedot"); name = "b.timedot";
  assert.equal(s.save(), true);
  assert.equal(h.store.get("b.timedot"), "2026-11-23\nx  .\n");
});

test("timedot edits from the rendered view round-trip through the same text", () => {
  const { s } = mk({ "w.timedot": "2026-11-23\na  ..\n" }, {}, "w.timedot");
  assert.ok(s.apply((t) => addPosting(t, { date: "2026-11-23", account: "b", quantityText: "1h" })).ok);
  assert.ok(s.apply((t) => editPosting(t, s.model.postings[0].id, { quantityText: "..." })).ok);
  assert.equal(s.text, "2026-11-23\na  ...\nb  1h\n");
  s.setText("2026-11-23\na  .\n");                                                      // raw edit replaces everything
  assert.equal(s.model.postings.length, 1);
});

test("a non-time file name is refused", () => {
  const h = fakeHost({ "a.journal": "" });
  assert.throws(() => new TimeSession({ ...h, name: () => "a.journal" }));
});
