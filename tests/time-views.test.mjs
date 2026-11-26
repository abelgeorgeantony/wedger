import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mountViewer, load, disposeAll } from "./dom-harness.mjs";

const env = await load();
after(disposeAll);
const skip = env ? false : "jsdom is not installed (npm install)";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const page = (m) => m.root.querySelector("[data-slot=page]");
const rawText = (m) => m.root.querySelector("textarea").value;
const setRaw = async (m, text) => { const ta = m.root.querySelector("textarea"); ta.value = text; ta.dispatchEvent(new window.Event("input", { bubbles: true })); };
const switchTo = (m, mode) => { const r = m.menubar.querySelector(`[name=view][value=${mode}]`); r.checked = true; r.dispatchEvent(new window.Event("change", { bubbles: true })); };
const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const byText = (scope, sel, text) => [...scope.querySelectorAll(sel)].find((e) => e.textContent.trim() === text || e.textContent.includes(text));
const fill = (form, values) => { for (const [n, v] of Object.entries(values)) { const el = form.elements[n]; el.value = v; el.dispatchEvent(new window.Event("input", { bubbles: true })); el.dispatchEvent(new window.Event("change", { bubbles: true })); } };
const submit = async (form) => { form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); await wait(5); };

const CLOCK = "i 2026-11-23 09:00:00 work:a  Hello\no 2026-11-23 10:30:00 work:a\ni 2026-11-24 08:00:00 open:x\n";

test("timeclock viewer draws overview, running sessions, totals and sessions from the parsed file", { skip }, async () => {
  const m = await mountViewer("timeclock", CLOCK);
  const t = page(m).textContent;
  assert.match(t, /Completed1h 30m1\.50 h/);
  assert.match(t, /Running nowClock in…open:x/);
  assert.match(t, /Sessions \(2\)/);
  assert.ok(m.root.querySelector(".tv-row.is-open"), "running session is visually distinct");
  assert.equal(m.root.querySelectorAll(".tv-row").length, 2);
  m.api.dispose();
});

test("timeclock: Raw edits update the rendered model; rendered actions update the Raw text — one copy", { skip }, async () => {
  const m = await mountViewer("timeclock", "", { autoSave: false });
  assert.match(page(m).textContent, /No sessions in this file yet/);
  switchTo(m, "raw");
  await setRaw(m, "i 2026-11-23 09:00 a\no 2026-11-23 11:00 a\n");
  assert.equal(m.isDirty(), true);
  switchTo(m, "rendered");
  assert.match(page(m).textContent, /Completed2h/);
  // a rendered action → raw text
  click(m.menubar.querySelector("[data-act=clock-in]"));
  const form = document.querySelector(".test-dialog form");
  fill(form, { account: "work:b", description: "Docs", date: "2026-11-25", time: "09:15:30" });
  await submit(form);
  assert.ok(rawText(m).endsWith("i 2026-11-25 09:15:30 work:b  Docs\n"), rawText(m));
  assert.match(page(m).textContent, /work:b/);
  assert.equal(m.raw.files.writes.length, 0, "auto-save is off: nothing written yet");
  m.api.save();
  assert.equal(m.raw.store.get(m.name), rawText(m));
  assert.equal(m.isDirty(), false);
  m.api.dispose();
});

test("timeclock: Clock out closes exactly the chosen session and writes a named clock-out", { skip }, async () => {
  const m = await mountViewer("timeclock", "i 2026-11-23 09:00 a\ni 2026-11-23 09:10 b\n", { autoSave: false });
  const rows = [...m.root.querySelectorAll(".tv-running__row")];
  assert.equal(rows.length, 2);
  click(byText(rows.find((r) => r.textContent.includes("a")), "button", "Clock out"));
  assert.match(m.root.querySelector("textarea").value, /\no 20\d\d-\d\d-\d\d \d\d:\d\d:\d\d a\n$/);
  assert.equal(m.root.querySelectorAll(".tv-running__row").length, 1);
  assert.match(page(m).textContent, /Running now.*b/);
  m.api.dispose();
});

test("timeclock: ambiguous / invalid sequences show diagnostics and exclude the records from totals", { skip }, async () => {
  const m = await mountViewer("timeclock", "i 2026-11-23 09:00 a\ni 2026-11-23 09:30 a\no 2026-11-23 10:00 a\no 2026-11-23 11:00 zzz\n");
  const t = page(m).textContent;
  assert.match(t, /2 errors in this file/);
  assert.match(t, /Totals are incomplete/);
  assert.match(t, /overlap|already clocked in/i);
  // a diagnostic's "Line N" opens the Raw view at that line
  click(byText(m.root, ".tv-issue__go", "Line 2"));
  assert.equal(m.root.querySelector("[data-pane=raw]").hidden, false);
  assert.equal(m.root.querySelector("[data-pane=rendered]").hidden, true);
  m.api.dispose();
});

test("timeclock: deleting a session removes its clock-in and clock-out together", { skip }, async () => {
  const m = await mountViewer("timeclock", "# top\n" + CLOCK, { autoSave: false });
  click(m.root.querySelector(".tv-row[data-session=s2] [title='Delete session']"));
  await wait(5);
  assert.equal(rawText(m), "# top\ni 2026-11-24 08:00:00 open:x\n");
  m.raw.dialogs.confirmAnswer = false;                                                 // ids follow lines: open:x is now line 2
  click(m.root.querySelector(".tv-row[data-session=s2] [title='Delete session']"));
  await wait(5);
  assert.match(rawText(m), /open:x/);
  m.api.dispose();
});

test("timeclock: filters and search work on structured data", { skip }, async () => {
  const m = await mountViewer("timeclock", "i 2026-11-22 09:00 work:a\no 2026-11-22 10:00 work:a\ni 2026-11-23 09:00 home:b  groceries\no 2026-11-23 09:30 home:b\n");
  const form = m.menubar.querySelector("form[data-form=filters]");
  fill(form, { project: "home" });
  await wait(260);
  assert.equal(m.root.querySelectorAll(".tv-row").length, 1);
  assert.match(page(m).textContent, /Completed30m/);
  fill(form, { project: "", from: "2026-11-22", to: "2026-11-22" });
  await wait(260);
  assert.match(page(m).textContent, /Completed1h/);
  const search = m.menubar.querySelector("[name=search]");
  fill(form, { from: "", to: "" }); search.value = "grocer"; search.dispatchEvent(new window.Event("input", { bubbles: true }));
  await wait(260);
  assert.equal(m.root.querySelectorAll(".tv-row").length, 1);
  m.api.dispose();
});

test("auto-save: a rendered edit is written through host.files, and closing the tab flushes it", { skip }, async () => {
  const m = await mountViewer("timeclock", "", { autoSave: true });
  m.api.canFocusSearch();
  click(m.menubar.querySelector("[data-act=add-session]"));
  const form = document.querySelector(".test-dialog form");
  fill(form, { account: "meet", sd: "2026-11-20", st: "09:00", ed: "2026-11-20", et: "09:45" });
  await submit(form);
  assert.equal(m.raw.files.writes.length, 0);
  m.api.dispose();                                                                      // closing the tab flushes the debounce
  assert.equal(m.raw.store.get(m.name), "i 2026-11-20 09:00:00 meet\no 2026-11-20 09:45:00 meet\n");
});

test("a file that can't be drawn never hides its text", { skip }, async () => {
  const m = await mountViewer("timeclock", "garbage\n\u0000\n");
  assert.match(page(m).textContent, /errors? in this file/);
  assert.equal(rawText(m), "garbage\n\u0000\n");
  m.api.dispose();
});

/* ---------------------------------------------------------------------- timedot */
const DOT = "2026-11-23 Monday\nwork:programming  .... ....\nwork:admin  ccecces  ; mail\n\n2026-11-22\nhome  1.5h\n";

test("timedot viewer: overview, daily groups, notation and letter types", { skip }, async () => {
  const m = await mountViewer("timedot", DOT);
  const t = page(m).textContent;
    assert.match(t, /Total time5h 15m5\.25 h/);                                          // 2h + 1h45m + 1h30m
  assert.match(t, /Days logged2/);
  assert.match(t, /Entries3/);
  assert.match(t, /By type:c1h.*e30m.*s15m/);
  const notations = [...m.root.querySelectorAll(".tv-notation")].map((e) => e.textContent);
  assert.ok(notations.includes(".... ....") && notations.includes("ccecces") && notations.includes("1.5h"), `original notation shown: ${notations}`);
  assert.equal(m.root.querySelectorAll(".tv-day").length, 2);
  m.api.dispose();
});

test("timedot: quick-add writes a valid line and never rounds", { skip }, async () => {
  const m = await mountViewer("timedot", "2026-11-23\nwork  .\n", { autoSave: false });
  const form = m.root.querySelector("form.tv-add");
  form.elements.date.value = "2026-11-23";
  form.elements.account.value = "home:chores";
  const sel = form.querySelector("select"), input = form.querySelector(".tv-add__amount input");
  sel.value = "dots"; sel.dispatchEvent(new window.Event("change", { bubbles: true }));
  input.value = "0.3"; input.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.match(form.querySelector(".tv-add__hint").textContent, /15-minute/);
  await submit(form);
  assert.equal(rawText(m), "2026-11-23\nwork  .\n", "refused: nothing written");
  assert.ok(m.raw.toasts.some(([t]) => t === "error"));
  input.value = "1.25"; input.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.match(form.querySelector(".tv-add__hint").textContent, /1h 15m/);
  await submit(form);
  assert.equal(rawText(m), "2026-11-23\nwork  .\nhome:chores  .... .\n");
  sel.value = "m"; sel.dispatchEvent(new window.Event("change", { bubbles: true }));
  form.elements.account.value = "x"; input.value = "90";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  await submit(form);
  assert.match(rawText(m), /\nx +90m\n$/);                                            // aligned with the amounts above it
  m.api.dispose();
});

test("timedot: adding for a new date creates a date group; Raw edits flow back into the page", { skip }, async () => {
  const m = await mountViewer("timedot", DOT, { autoSave: false });
  const form = m.root.querySelector("form.tv-add");
  form.elements.date.value = "2026-11-30"; form.elements.account.value = "new";
  form.querySelector(".tv-add__amount input").value = "2";
  form.querySelector(".tv-add__amount input").dispatchEvent(new window.Event("input", { bubbles: true }));
  await submit(form);
  assert.ok(rawText(m).endsWith("\n\n2026-11-30\nnew  2h\n"));
  assert.equal(m.root.querySelectorAll(".tv-day").length, 3);
  switchTo(m, "raw");
  await setRaw(m, "2026-12-01\nz  ..\n");
  switchTo(m, "rendered");
  assert.equal(m.root.querySelectorAll(".tv-day").length, 1);
  assert.match(page(m).textContent, /Total time30m/);
  m.api.dispose();
});

test("timedot: editing an amount rewrites only that span; deleting removes only that line", { skip }, async () => {
  const m = await mountViewer("timedot", DOT, { autoSave: false });
  const row = [...m.root.querySelectorAll(".tv-row")].find((r) => r.textContent.includes("work:admin"));
  click(row.querySelector("[title='Edit entry']"));
  const form = document.querySelector(".test-dialog form");
  const inputs = form.querySelectorAll(".tv-add__amount input");
  assert.equal(inputs[0].value, "ccecces", "starts from the original notation");
  fill(form, { account: "work:mail" });
  await submit(form);
  assert.equal(rawText(m), DOT.replace("work:admin", "work:mail"), "letters and the comment are untouched");
  click(m.root.querySelector(".tv-row[data-posting=p6] [title='Delete entry']"));
  await wait(5);
  assert.ok(!rawText(m).includes("home  1.5h"));
  assert.match(rawText(m), /work:mail {2}ccecces {2}; mail/);
  m.api.dispose();
});

test("timedot: unreadable entries are named and left out of the totals", { skip }, async () => {
  const m = await mountViewer("timedot", "2026-11-23\nok  1h\nbad  1,5\n");
  const t = page(m).textContent;
  assert.match(t, /Totals are incomplete/);
  assert.match(t, /Left out of the totals \(1\)/);
  assert.match(t, /Total time1h/);
  m.api.dispose();
});

test("viewers never touch the hledger engine (the host proxy would throw)", { skip }, async () => {
  for (const kind of ["timeclock", "timedot"]) {
    const m = await mountViewer(kind, kind === "timeclock" ? CLOCK : DOT);
    assert.ok(page(m).children.length > 0);
    m.api.dispose();
  }
});
