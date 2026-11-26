// DOM-level tests of the .timeclock / .timedot viewers and their dialogs: the real templates and controllers run in
// jsdom with the real TimeSession, against a stub host (and a stub for the CodeMirror bundle, which needs a browser).
//
// jsdom is NOT a dependency of this project, so these tests skip themselves when it isn't installed.
// To run them:   npm install --no-save jsdom   &&   npm test
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { TIMECLOCK, TIMEDOT } from "./time-fixtures.mjs";

const jsdom = await import("jsdom").catch(() => null);

if (!jsdom) {
  test("time viewer DOM tests (skipped: jsdom is not installed; run `npm install --no-save jsdom`)", { skip: true }, () => {});
} else {
  const REPO = new URL("../", import.meta.url).href;
  const html = (p) => readFileSync(new URL(p, REPO), "utf8");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const flush = async (n = 3) => { for (let i = 0; i < n; i++) await tick(); };

  // CodeMirror needs a real browser layout engine; everything else here is the real code.
  const stub = `export function createBoundEditor(){ return { wrapper: document.createElement("div"), view:{state:{doc:{lines:1}}}, refresh(){}, focus(){}, getCursor(){return {line:1,col:1};}, setSelection(){}, destroy(){} }; }`;
  register("data:text/javascript," + encodeURIComponent(`export async function resolve(s,c,n){ if (s.endsWith("codemirror/bundle.js")) return { url: "data:text/javascript,"+encodeURIComponent(${JSON.stringify(stub)}), shortCircuit: true }; return n(s,c); }`));

  const dom = new jsdom.JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
  const w = dom.window;
  for (const k of ["document", "window", "Event", "MouseEvent", "KeyboardEvent", "HTMLElement", "Node", "localStorage", "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle", "DOMParser", "MutationObserver"]) {
    Object.defineProperty(globalThis, k, { value: w[k] ?? w, configurable: true, writable: true });
  }
  globalThis.CSS = { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&") };
  const fire = (el, type, init = {}) => el.dispatchEvent(new w.Event(type, { bubbles: true, cancelable: true, ...init }));
  const click = (el, init = {}) => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
  const D = (name) => import(REPO + `assets/dialogs/${name}.js`);

  // ---------------------------------------------------------------- dialogs
  function open(tpl) {
    const root = document.createElement("div");
    root.innerHTML = html(`assets/dialogs/${tpl}.html`);
    document.body.append(root);
    return root;
  }
  const set = (root, name, value) => { const el = root.querySelector(`[name="${name}"]`); el.value = value; fire(el, "input"); return el; };
  const submit = async (root) => { fire(root.querySelector("form"), "submit"); await flush(); };
  const err = (root, field) => root.querySelector(`[data-error-for="${field}"]`);

  /* ---------- timeclock session ---------- */

  test('dialogs: clock in / add past session / edit session (timeclock-session)', async (t) => {    const { mount } = await D("timeclock-session");
    // clock in
    let calls = [], closed = [];
    let root = open("timeclock-session");
    mount({ root, close: (v) => closed.push(v), params: { mode: "in", accounts: ["work:a", "home:b"], submit: async (v) => { calls.push(v); return null; } } });
    assert.equal(root.querySelector("[data-slot=title]").textContent, "Clock in");
    assert.equal(root.querySelector("[data-slot=end-group]").hidden, true, "no end fields when clocking in");
    assert.equal(root.querySelectorAll("#tcs-accounts option").length, 2);
    assert.ok(root.querySelector("[name=sd]").value.match(/^\d{4}-\d\d-\d\d$/), "defaults to today");
    assert.ok(root.querySelector("[name=st]").value.match(/^\d\d:\d\d(:\d\d)?$/), "defaults to now");
    await submit(root);                                                    // empty account
    assert.equal(calls.length, 0);
    assert.match(err(root, "account").textContent, /account/i);
    assert.equal(root.querySelector("[name=account]").getAttribute("aria-invalid"), "true");
    assert.equal(err(root, "account").hidden, false);
    set(root, "account", "  work:a  ");
    assert.equal(err(root, "account").hidden, true, "typing clears the error");
    await submit(root);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].account, "work:a");
    assert.equal(calls[0].end, null);
    assert.deepEqual(closed, [true]);
    t.diagnostic('clock in: defaults, required field, inline error, trimmed submit, closes on success');

    // refusal from the mutation stays in the dialog, re-enables the button
    closed = []; root = open("timeclock-session");
    mount({ root, close: (v) => closed.push(v), params: { mode: "in", accounts: [], submit: async () => "Something refused." } });
    set(root, "account", "x"); await submit(root);
    assert.equal(closed.length, 0);
    assert.equal(root.querySelector("[data-slot=error]").hidden, false);
    assert.match(root.querySelector("[data-slot=error]").textContent, /Something refused/);
    assert.equal(root.querySelector("[data-slot=submit]").disabled, false);
    t.diagnostic('a refused mutation leaves the dialog open with the reason and a usable button');

    // busy state while pending
    closed = []; root = open("timeclock-session");
    let release; const gate = new Promise((r) => (release = r));
    mount({ root, close: (v) => closed.push(v), params: { mode: "in", accounts: [], submit: () => gate.then(() => null) } });
    set(root, "account", "x"); fire(root.querySelector("form"), "submit"); await flush(1);
    const btn = root.querySelector("[data-slot=submit]");
    assert.equal(btn.disabled, true); assert.equal(btn.getAttribute("aria-busy"), "true"); assert.equal(btn.textContent, "Clocking in…");
    fire(root.querySelector("form"), "submit"); await flush(1);          // a second submit while busy is ignored
    release(); await flush();
    assert.deepEqual(closed, [true]); assert.equal(btn.disabled, false); assert.equal(btn.textContent, "Clock in");
    t.diagnostic('submit is disabled/aria-busy while pending, double-submit ignored, label restored');

    // cancel never submits
    calls = []; closed = []; root = open("timeclock-session");
    mount({ root, close: (v) => closed.push(v), params: { mode: "in", accounts: [], submit: async (v) => { calls.push(v); } } });
    set(root, "account", "x"); click(root.querySelector("[data-act=cancel]"));
    assert.deepEqual(closed, [null]); assert.equal(calls.length, 0);
    t.diagnostic('Cancel closes without calling submit');

    // add past session: crossing midnight and negative duration
    calls = []; closed = []; root = open("timeclock-session");
    mount({ root, close: (v) => closed.push(v), params: { mode: "add", accounts: [], submit: async (v) => { calls.push(v); return null; } } });
    assert.equal(root.querySelector("[data-slot=end-group]").hidden, false);
    set(root, "account", "night"); set(root, "sd", "2026-11-20"); set(root, "st", "23:00:00"); set(root, "ed", "2026-11-21"); set(root, "et", "01:30:00");
    assert.match(root.querySelector("[data-slot=summary]").textContent, /Duration: 2h 30m/);
    assert.match(root.querySelector("[data-slot=summary]").textContent, /to /);
    await submit(root);
    assert.equal(calls.length, 1); assert.deepEqual(calls[0].end, { date: "2026-11-21", time: "01:30:00" });
    t.diagnostic('add session: midnight crossing shows a live duration and is submitted');

    calls = []; closed = []; root = open("timeclock-session");
    mount({ root, close: (v) => closed.push(v), params: { mode: "add", accounts: [], submit: async (v) => { calls.push(v); return null; } } });
    set(root, "account", "x"); set(root, "sd", "2026-11-20"); set(root, "st", "12:00"); set(root, "ed", "2026-11-20"); set(root, "et", "11:00");
    assert.equal(root.querySelector("[data-slot=summary]").classList.contains("is-error"), true);
    await submit(root);
    assert.equal(calls.length, 0); assert.match(err(root, "et").textContent, /end is before the start/i);
    t.diagnostic('add session: a negative duration is explained and never submitted');

    set(root, "sd", "2026-02-30"); await submit(root);
    assert.match(err(root, "sd").textContent, /real date/);
    t.diagnostic('an impossible date is refused beside its field');

    // edit open session: no end fields, notice; patch fields
    calls = []; closed = [];
    const open1 = { account: "work:code", description: "d", status: "open", start: { date: "2026-11-25", secondsOfDay: 8 * 3600 }, end: null, comment: "a note", inEvent: { tz: null }, outEvent: null, line: 7 };
    root = open("timeclock-session");
    let rawLine = null;
    mount({ root, close: (v) => closed.push(v), params: { mode: "edit", session: open1, accounts: [], openRaw: (l) => (rawLine = l), submit: async (v) => { calls.push(v); return null; } } });
    assert.equal(root.querySelector("[data-slot=end-group]").hidden, true, "a running session has no end fields");
    assert.equal(root.querySelector("[data-slot=notice]").hidden, false);
    assert.match(root.querySelector("[data-slot=notice-text]").textContent, /; comment.*exactly as written/);
    assert.match(root.querySelector("[data-slot=notice-text]").textContent, /still running/);
    assert.equal(root.querySelector("[name=account]").value, "work:code");
    assert.equal(root.querySelector("[name=st]").value, "08:00:00");
    click(root.querySelector("[data-act=raw]"));
    assert.equal(rawLine, 7); assert.deepEqual(closed, [null]);
    t.diagnostic('edit (running): no end fields, comment preserved with a Raw-view path, still running');

    // edit closed session prefilled
    const closed1 = { account: "a", description: "", status: "closed", start: { date: "2026-11-23", secondsOfDay: 9 * 3600 }, end: { date: "2026-11-23", secondsOfDay: 11 * 3600 + 1800 }, comment: "", inEvent: {}, outEvent: { account: null }, line: 1 };
    root = open("timeclock-session"); calls = [];
    mount({ root, close: () => {}, params: { mode: "edit", session: closed1, accounts: [], submit: async (v) => { calls.push(v); return null; } } });
    assert.equal(root.querySelector("[name=et]").value, "11:30:00");
    assert.equal(root.querySelector("[data-slot=end-group]").hidden, false);
    assert.match(root.querySelector("[data-slot=notice-text]").textContent, /no account/);
    await submit(root);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].start, { date: "2026-11-23", time: "09:00:00" });
    t.diagnostic('edit (completed): prefilled with start and end, clock-out notice shown');
  });

  test('dialogs: clock out (timeclock-clock-out)', async (t) => {    const { mount } = await D("timeclock-clock-out");
    const s = { account: "work:code", start: { date: "2000-01-01", secondsOfDay: 8 * 3600, wall: Date.UTC(2000, 0, 1, 8) / 1000 } };
    let calls = [], closed = []; let root = open("timeclock-clock-out");
    mount({ root, close: (v) => closed.push(v), params: { session: s, submit: async (v) => { calls.push(v); return null; } } });
    assert.match(root.querySelector("[data-slot=subtitle]").textContent, /work:code/);
    set(root, "comment", "wrapped up"); await submit(root);
    assert.equal(calls.length, 1); assert.equal(calls[0].comment, "wrapped up"); assert.match(calls[0].date, /^\d{4}-/);
    t.diagnostic('clock out dialog: defaults to now, submits the chosen time and comment');

    calls = []; root = open("timeclock-clock-out");
    mount({ root, close: () => {}, params: { session: s, submit: async (v) => { calls.push(v); return null; } } });
    set(root, "ed", "1999-12-31"); set(root, "et", "10:00"); await submit(root);
    assert.equal(calls.length, 0); assert.match(err(root, "et").textContent, /before the clock-in/);
    t.diagnostic('clock out dialog: an end before the clock-in is refused beside the field');
  });

  test('dialogs: add / edit entry (timedot-entry)', async (t) => {    const { mount } = await D("timedot-entry");
    let calls = [], closed = []; let root = open("timedot-entry");
    mount({ root, close: (v) => closed.push(v), params: { mode: "add", date: "2026-11-23", accounts: ["a", "b"], submit: async (v) => { calls.push(v); return null; } } });
    assert.equal(root.querySelector("[name=date]").value, "2026-11-23");
    const amt = root.querySelector("#amount"), mode = root.querySelector("[name=amount-mode]");
    const hint = () => root.querySelector(".tv-amount__hint").textContent;
    amt.value = "1.5"; fire(amt, "input");
    assert.match(hint(), /= 1h 30m \(1\.50 h\)/);
    mode.value = "letters"; fire(mode, "change"); amt.value = "ccec"; fire(amt, "input");
    assert.match(hint(), /c: 45m, e: 15m/);
    mode.value = "dots"; fire(mode, "change"); amt.value = "...."; fire(amt, "input");
    assert.match(hint(), /= 1h/);
    mode.value = "m"; fire(mode, "change"); amt.value = "90"; fire(amt, "input");
    assert.match(hint(), /1h 30m/);
    t.diagnostic('entry dialog: the live reading of hours, letters (with types), dots and minutes');

    // all modes accepted
    for (const [m, v] of [["h", "2"], ["m", "30"], ["s", "45"], ["d", "1"], ["w", "1"], ["mo", "1"], ["y", "1"], ["dots", "..."], ["letters", "abc"]]) {
      mode.value = m; fire(mode, "change"); amt.value = v; fire(amt, "input");
      assert.equal(root.querySelector(".tv-amount__hint").classList.contains("is-error"), false, `${m} ${v}: ${hint()}`);
    }
    t.diagnostic('entry dialog: hours, minutes, seconds, days, weeks, months, years, dots and letters are all accepted');

    // invalid amount
    mode.value = "h"; fire(mode, "change"); amt.value = "1,5"; fire(amt, "input");
    set(root, "account", "a"); await submit(root);
    assert.equal(calls.length, 0); assert.equal(err(root, "amount").hidden, false);
    t.diagnostic('entry dialog: an unusable amount is refused beside the amount');

    // missing account / bad date
    amt.value = "1"; fire(amt, "input"); set(root, "account", ""); await submit(root);
    assert.match(err(root, "account").textContent, /account/i);
    set(root, "account", "a"); set(root, "date", "2026-02-31"); await submit(root);
    assert.match(err(root, "date").textContent, /real date/);
    t.diagnostic('entry dialog: account and date are validated');

    // success + add another
    set(root, "date", "2026-11-23"); root.querySelector("[name=again]").checked = true; set(root, "account", "a"); amt.value = "1"; fire(amt, "input");
    await submit(root);
    assert.equal(calls.length, 1); assert.deepEqual(calls[0], { date: "2026-11-23", account: "a", quantityText: "1h", comment: "" });
    assert.deepEqual(closed, [], "stays open for the next entry");
    assert.match(root.querySelector("[data-slot=status]").textContent, /Added 1 entry/);
    assert.equal(root.querySelector("[name=account]").value, ""); assert.equal(root.querySelector("[data-act=cancel]").textContent, "Done");
    assert.equal(root.querySelector("[name=date]").value, "2026-11-23", "the date is kept");
    root.querySelector("[name=again]").checked = false; set(root, "account", "b"); amt.value = "2"; fire(amt, "input");
    await submit(root);
    assert.equal(calls.length, 2); assert.deepEqual(closed, [true]);
    t.diagnostic("entry dialog: 'keep open' adds several entries then closes");

    // edit: letters preserved
    calls = []; closed = [];
    const p = { id: "p3", account: "home:read", raw: "ccec", comment: "evening", date: "2026-11-23" };
    root = open("timedot-entry");
    mount({ root, close: (v) => closed.push(v), params: { mode: "edit", posting: p, accounts: [], submit: async (v) => { calls.push(v); return null; } } });
    assert.equal(root.querySelector("[name=amount-mode]").value, "raw"); assert.equal(root.querySelector("#amount").value, "ccec");
    assert.equal(root.querySelector("[data-slot=again-row]").hidden, true);
    await submit(root);
    assert.deepEqual(calls[0], { date: "2026-11-23", account: "home:read", quantityText: "ccec", comment: "evening" });
    t.diagnostic("edit entry: prefilled 'As written' so a letters entry round-trips unchanged");

    // empty amount is allowed when editing ("no amount")
    calls = []; root = open("timedot-entry");
    mount({ root, close: () => {}, params: { mode: "edit", posting: { ...p, raw: "" }, accounts: [], submit: async (v) => { calls.push(v); return null; } } });
    await submit(root);
    assert.equal(calls.length, 1);
    t.diagnostic('edit entry: an entry without an amount can be saved as is');
  });

  test('dialogs: add / edit day (timedot-day)', async (t) => {    const { mount } = await D("timedot-day");
    let calls = [], closed = [], after = []; let root = open("timedot-day");
    mount({ root, close: (v) => closed.push(v), params: { mode: "add", date: "2026-11-26", submit: async (v) => { calls.push(v); return null; }, afterAdd: (d) => after.push(d) } });
    set(root, "description", "Conference"); await submit(root); await flush();
    assert.deepEqual(calls[0], { date: "2026-11-26", description: "Conference" });
    assert.deepEqual(after, ["2026-11-26"]); assert.deepEqual(closed, [true]);
    t.diagnostic('add day: submits and offers to add an entry afterwards');

    calls = []; after = []; root = open("timedot-day");
    mount({ root, close: () => {}, params: { mode: "add", date: "2026-11-26", submit: async (v) => { calls.push(v); return null; }, afterAdd: (d) => after.push(d) } });
    root.querySelector("[name=then]").checked = false; await submit(root); await flush();
    assert.equal(after.length, 0);
    set(root, "description", "a;b"); await submit(root);
    assert.match(err(root, "description").textContent, /“;”/);
    t.diagnostic("add day: 'then add an entry' is optional; ';' in the description is refused");

    calls = []; root = open("timedot-day");
    mount({ root, close: () => {}, params: { mode: "edit", day: { date: "2026-11-23", description: "Mon", postings: [1, 2, 3] }, submit: async (v) => { calls.push(v); return null; } } });
    assert.equal(root.querySelector("[name=date]").value, "2026-11-23"); assert.equal(root.querySelector("[name=description]").value, "Mon");
    assert.match(root.querySelector("[data-slot=subtitle]").textContent, /3 entries/);
    assert.equal(root.querySelector("[data-slot=then-row]").hidden, true);
    set(root, "date", "2026-11-24"); await submit(root);
    assert.deepEqual(calls[0], { date: "2026-11-24", description: "Mon" });
    t.diagnostic('edit day: prefilled, shows how many entries stay with it');
  });

  // ---------------------------------------------------------------- viewers
  function makeHost(name, content, { autoSave = false, confirmAnswer = true } = {}) {
    const store = new Map([[name, { content }]]);
    const rec = { writes: [], notes: [], confirms: [], dialogs: [], reports: [], exports: [], menus: [] };
    const host = {
      files: { get: (n) => store.get(n), exists: (n) => store.has(n), write(n, c) { rec.writes.push(c); store.set(n, { content: c }); }, on: () => () => {} },
      settings: { get: (k) => ({ autoSave, defaultView: "rendered", lineNumbers: false, weekStart: "monday" })[k], on: () => () => {} },
      notify: (m, t) => rec.notes.push([m, t]),
      sync: { statusOf: () => "local", errorOf: () => null, on: () => () => {} },
      dialogs: { confirm: async (o) => { rec.confirms.push(o); return rec.answer ?? confirmAnswer; }, menu: (a, items) => rec.menus.push(items), openTemplate: async (tpl, o) => { rec.dialogs.push([tpl, o]); } },
      reports: { runNative: async (o) => { rec.reports.push(o); return o; } },
      actions: { export: (n) => rec.exports.push(n) },
      auth: { on: () => () => {} },
    };
    return { host, rec, store };
  }

  async function mountViewer(kind, content, opts) {
    const name = `a.${kind}`;
    const { host, rec, store } = makeHost(name, content, opts);
    const root = document.createElement("div"); root.className = `sf sf-${kind}`;
    root.innerHTML = html(`assets/special/${kind}.html`);
    const menubar = document.createElement("div"); menubar.innerHTML = html(`assets/special/${kind}-menu.html`);
    document.body.append(menubar, root);
    const { mount } = await import(REPO + `assets/special/${kind}.js`);
    const view = { uri: `file:${name}`, setDirty() {} };
    const ctl = mount({ root, view, host, menubar: menubar.firstElementChild });
    ctl.onShow();
    await flush();
    const q = (s, scope = root) => scope.querySelector(s);
    const qa = (s, scope = root) => [...scope.querySelectorAll(s)];
    const bar = menubar.firstElementChild;
    const act = async (a) => { const b = q(`[data-act="${a}"]`, bar); assert.ok(b, a); assert.equal(b.disabled, false, `${a} enabled`); click(b); await flush(); };
    const setField = async (form, name, value, evt = "change") => { const el = q(`[data-form="${form}"] [name="${name}"]`, bar); el.value = value; fire(el, "input"); fire(el, evt); await flush(); };
    return { ctl, root, bar, host, rec, store, q, qa, act, setField, name };
  }


  /* =============================================================== timeclock */

  test('timeclock viewer: register, selection, filters, bulk delete, search, sort, reports, dialogs, clock out', async (t) => {    const V = await mountViewer("timeclock", TIMECLOCK);
    const { q, qa, root, bar } = V;
    // --- the register, no dashboards
    assert.equal(qa(".tv-row").length, 4, "four session rows");
    assert.equal(qa(".tv-day").length, 3, "three day groups");
    assert.equal(qa(".tv-figures, .tv-fig, .tv-sum, .tv-add, [aria-label=Overview], [aria-label=Totals]").length, 0, "no dashboards");
    assert.equal(qa(".tc-run").length, 1, "one running session in the operational strip");
    assert.match(q(".tc-run").textContent, /work:code/);
    assert.match(q("[data-slot=list-meta]").textContent, /4 sessions/);
    const first = q(".tv-row");
    assert.match(first.getAttribute("aria-label"), /work:code.*running/);
    assert.ok(q(".pill", first).textContent.includes("Running"));
    const night = qa(".tv-row").find((r) => r.textContent.includes("home:chores"));
    assert.match(night.querySelector(".tv-row__span").textContent, /Mon 23 Nov → Tue 24 Nov/, "a session crossing midnight shows both dates");
    t.diagnostic('timeclock: register of sessions, running strip, no dashboards, midnight span shown');

    // --- selection mode
    assert.equal(q("[data-slot=selbar]").hidden, true);
    await V.act("toggle-select");
    assert.equal(q("[data-slot=selbar]").hidden, false);
    assert.equal(q("[data-slot=list]").classList.contains("is-selecting"), true);
    assert.equal(q("[data-act=toggle-select]", bar).textContent, "Exit selection mode");
    const rows = () => qa(".tv-row");
    click(rows()[0]);                                                      // click a row toggles it
    assert.equal(rows()[0].classList.contains("is-selected"), true);
    assert.equal(q("[data-slot=sel-count]").textContent, "1 selected");
    assert.equal(q("[data-slot=sel-badge]", bar).hidden, false); assert.match(q("[data-slot=sel-badge]", bar).textContent, /^1/);
    click(rows()[2], { shiftKey: true });                                  // shift-click selects the range
    assert.equal(q("[data-slot=sel-count]").textContent, "3 selected");
    assert.deepEqual(rows().map((r) => r.classList.contains("is-selected")), [true, true, true, false]);
    click(q(".tv-row__actions .icon-btn", rows()[0]));                      // action buttons never toggle selection
    assert.equal(q("[data-slot=sel-count]").textContent, "3 selected");
    const cb = q(".tv-row__select input", rows()[3]); click(cb);                                   // a real click toggles the checkbox itself
    assert.equal(q("[data-slot=sel-count]").textContent, "4 selected");
    t.diagnostic("timeclock selection: row click, shift-range, checkbox, count and badge; action buttons don't select");

    await V.act("clear-selection");
    assert.equal(q("[data-slot=sel-count]").textContent, "0 selected");
    assert.equal(qa(".tv-row.is-selected").length, 0);
    await V.act("select-visible");
    assert.equal(q("[data-slot=sel-count]").textContent, "4 selected");
    assert.match(q("[data-act=select-visible]", bar).textContent, /Select all visible \(4\)/);
    t.diagnostic('timeclock: clear selection, select all visible');

    // --- filters hide selected records; they are counted, kept and NOT deleted
    await V.setField("filters", "project", "home");
    assert.equal(qa(".tv-row").length, 1);
    assert.match(q("[data-slot=sel-note]").textContent, /3 hidden by filters, not deleted/);
    assert.equal(q("[data-slot=filter-count]", bar).textContent, "1");
    assert.match(q("[data-slot=chips]").textContent, /Project: home/);
    assert.match(q("[data-slot=list-meta]").textContent, /1 of 4 sessions/);
    assert.match(q("[data-act=delete-selected]", bar).textContent, /Delete selected \(1\)/);
    await V.act("delete-selected");
    assert.equal(V.rec.confirms.length, 1);
    assert.match(V.rec.confirms[0].title, /Delete 1 session\?/);
    assert.match(V.rec.confirms[0].message, /3 other selected sessions are hidden by filters and will NOT be deleted/);
    assert.equal(V.rec.writes.length, 1, "saved once");
    assert.equal(V.rec.writes[0].includes("home:chores"), false);
    assert.equal(V.rec.writes[0].includes("work:mail"), true, "hidden selected sessions survived");
    assert.equal(V.rec.writes[0].includes("work:code"), true);
    assert.deepEqual(V.rec.notes.at(-1), ["1 session deleted", "ok"]);
    assert.equal(V.rec.notes.length, 1, "one meaningful notification");
    assert.equal(q("[data-slot=selbar]").hidden, true, "selection mode is left after a delete");
    assert.equal(q("[data-slot=sel-badge]", bar).hidden, true);
    assert.equal(V.store.get("a.timeclock").content, V.rec.writes[0]);
    t.diagnostic('timeclock: filters + hidden selection; only the visible selected session is deleted, saved once, one notification');

    // --- cancel in the confirm leaves everything alone
    await V.setField("filters", "project", "");
    V.rec.answer = false; V.rec.confirms.length = 0;
    await V.act("toggle-select"); await V.act("select-visible"); await V.act("delete-selected");
    assert.equal(V.rec.confirms.length, 1); assert.equal(V.rec.writes.length, 1, "nothing more was written");
    V.rec.answer = true;
    await V.act("toggle-select");                                           // exit selection mode
    t.diagnostic('timeclock: cancelling the confirmation writes nothing');

    // --- search
    const s = q("[name=search]", bar);
    s.value = "mail"; fire(s, "input"); await sleep(220);
    assert.equal(qa(".tv-row").length, 1); assert.match(q("[data-slot=chips]").textContent, /Search: mail/);
    assert.match(q("[data-slot=search-count]", bar).textContent, /1 of 3 sessions match/);
    s.value = "2026-11-24"; fire(s, "input"); await sleep(220);              // hyphens work in a plain search
    assert.equal(qa(".tv-row").length, 1);
    s.value = "("; q("[name=findRegexp]", bar).click(); await sleep(220);
    assert.match(q("[data-slot=search-count]", bar).textContent, /Invalid pattern/);
    assert.match(q("[data-slot=empty]").textContent, /isn't valid/);
    click(q(".tv-chips__clear") ?? q("[data-slot=empty] button")); await flush();
    assert.equal(s.value, ""); assert.equal(qa(".tv-row").length, 3);
    t.diagnostic('timeclock search: matches, hyphenated dates, invalid regex handled, reset all');

    // --- sort
    const r = q(`[data-form="sort"] [value="account-asc"]`, bar); r.checked = true; fire(r, "change"); await flush();
    assert.equal(qa(".tv-day").length, 0, "flat list for a non-date sort");
    assert.deepEqual(qa(".tv-row__acct").map((e) => e.textContent), ["work:code", "work:code", "work:mail"]);
    assert.match(q("[data-slot=chips]").textContent, /Sort: Account A–Z/);
    const r2 = q(`[data-form="sort"] [value="date-desc"]`, bar); r2.checked = true; fire(r2, "change"); await flush();
    assert.equal(qa(".tv-day").length > 0, true);
    t.diagnostic('timeclock sort: applies immediately and independently of filters');

    // --- reports
    click(q(`[data-report="daily"]`, bar)); await flush();
    assert.equal(V.rec.reports.length, 1);
    const rp = V.rec.reports[0];
    assert.equal(rp.type, "timeclock:daily"); assert.equal(rp.file, "a.timeclock"); assert.equal(rp.label, "Daily report");
    const out = rp.compute(rp.text); assert.equal(out.ok, true); assert.equal(out.native.rows.length, 2);
    q("[name=from]", q("[data-form=reports]", bar)).value = "2026-11-25"; q("[name=to]", q("[data-form=reports]", bar)).value = "2026-11-01";
    click(q(`[data-report="register"]`, bar)); await flush();
    assert.equal(V.rec.reports.length, 1, "an invalid range does not run");
    assert.match(q("[data-slot=report-error]", bar).textContent, /after/); assert.equal(q("[data-slot=report-error]", bar).hidden, false);
    click(q(".chip[title*='this month' i]", q("[data-form=reports]", bar)) ?? q("[data-slot=presets] .chip", bar));
    click(q(`[data-report="running"]`, bar)); await flush();
    assert.equal(V.rec.reports.length, 2); assert.equal(V.rec.reports[1].query, "running now");
    click(q("[data-file-action=download]", bar)); assert.deepEqual(V.rec.exports, ["a.timeclock"]);
    t.diagnostic('timeclock reports: runs native reports with the right type/file, validates the range, running ignores the period, download works');

    // --- dialogs: clock in, then edit keeps a running session running, then clock out
    await V.act("clock-in");
    let [tpl, o] = V.rec.dialogs.at(-1);
    assert.equal(tpl, "dialogs/timeclock-session.html"); assert.equal(o.params.mode, "in");
    assert.deepEqual(o.params.accounts, ["work:code", "work:mail"], "autocomplete offers the accounts in the file");
    const err = await o.params.submit({ account: "side:project", description: "x", start: { date: "2020-01-01", time: "12:00:00" }, end: null });
    assert.equal(err, null);
    assert.equal(qa(".tc-run").length, 2, "the new running session appears");
    assert.ok(V.store.get("a.timeclock").content.length > 0);
    // edit the running one: description only
    const running = qa(".tv-row").find((rw) => rw.textContent.includes("side:project"));
    click(q(".icon-btn[title='Edit session']", running)); await flush();
    [tpl, o] = V.rec.dialogs.at(-1); assert.equal(o.params.mode, "edit"); assert.equal(o.params.session.status, "open");
    assert.equal(await o.params.submit({ account: "side:project", description: "renamed", start: { date: "2020-01-01", time: "12:00:00" }, end: null }), null);
    assert.equal(qa(".tc-run").length, 2, "still running after an edit");
    // clock out exactly that one
    click(qa(".tc-run").find((li) => li.textContent.includes("side:project")).querySelector(".btn")); await flush();
    assert.equal(qa(".tc-run").length, 1);
    assert.match(V.rec.notes.at(-1)[0], /Clocked out of side:project/);
    t.diagnostic('timeclock: clock in, edit keeps it running, clock out stops only the intended session');

    // --- raw mode leaves selection mode
    await V.act("toggle-select"); assert.equal(q("[data-slot=selbar]").hidden, false);
    V.ctl.onHide();
  });

  test('timedot viewer: register, add day/entry, edit date, selection, bulk delete, reports, search, sort', async (t) => {    const V = await mountViewer("timedot", TIMEDOT);
    const { q, qa, bar } = V;
    assert.equal(qa(".tv-day").length, 2); assert.equal(qa(".tv-row").length, 4);
    assert.equal(qa("form, .tv-add").filter((f) => !f.closest("nav")).length, 0, "no inline add form on the page");
    assert.deepEqual(qa(".tv-day__date").map((e) => e.textContent), ["Tuesday, 24 November 2026", "Monday, 23 November 2026"]);
    const letters = qa(".tv-row").find((r) => r.textContent.includes("home:read"));
    assert.equal(q(".tv-notation", letters).textContent, "ccec");
    assert.deepEqual(qa(".tv-type", letters).map((e) => e.textContent), ["c45m", "e15m"]);
    assert.match(q(".tv-row__comment", letters).textContent, /evening/);
    assert.match(qa(".tv-day__total")[1].textContent, /3h 30m/);
    t.diagnostic('timedot: register by day with notation, letter types, comment and day totals; no inline add form');

    // add day, then entries
    await V.act("add-day");
    let [tpl, o] = V.rec.dialogs.at(-1); assert.equal(tpl, "dialogs/timedot-day.html");
    assert.equal(await o.params.submit({ date: "2026-11-25", description: "Wed" }), null);
    assert.equal(qa(".tv-day").length, 3);
    assert.match(qa(".tv-day").find((d) => d.textContent.includes("25 November")).textContent, /No entries yet\./);
    assert.match(V.rec.notes.at(-1)[0], /Day 2026-11-25 added/);
    const dup = await o.params.submit({ date: "2026-11-25" }); assert.match(dup, /already/);
    click(q(".tv-day__tools .icon-btn[title^='Add an entry']", qa(".tv-day")[0])); await flush();
    [tpl, o] = V.rec.dialogs.at(-1); assert.equal(tpl, "dialogs/timedot-entry.html"); assert.equal(o.params.date, "2026-11-25");
    assert.equal(await o.params.submit({ date: "2026-11-25", account: "talk", quantityText: "1h", comment: "" }), null);
    assert.equal(qa(".tv-day")[0].querySelectorAll(".tv-row").length, 1);
    t.diagnostic("timedot: add day (empty day shown), duplicate refused, add entry from the day's + button");

    // edit entry: change date and comment, letters preserved
    const row = qa(".tv-row").find((r) => r.textContent.includes("home:read"));
    click(q(".icon-btn[title='Edit entry']", row)); await flush();
    [tpl, o] = V.rec.dialogs.at(-1); assert.equal(o.params.mode, "edit"); assert.equal(o.params.posting.raw, "ccec"); assert.equal(o.params.posting.date, "2026-11-23");
    assert.equal(await o.params.submit({ date: "2026-11-24", account: "home:read", quantityText: "ccec", comment: "evening" }), null);
    const moved = qa(".tv-row").find((r) => r.textContent.includes("home:read"));
    assert.match(moved.closest(".tv-day").textContent, /24 November/);
    assert.equal(q(".tv-notation", moved).textContent, "ccec"); assert.equal(qa(".tv-type", moved).length, 2);
    t.diagnostic('timedot: editing the date moves the entry; letters and types are preserved');

    // selection with filters
    await V.act("toggle-select"); await V.act("select-visible");
    assert.match(q("[data-slot=sel-count]").textContent, /^5 selected/);
    await V.setField("filters", "project", "work");
    assert.match(q("[data-slot=sel-note]").textContent, /hidden by filters, not deleted/);
    const hidden = Number(/(\d+) hidden/.exec(q("[data-slot=sel-note]").textContent)[1]);
    await V.act("delete-selected");
    assert.match(V.rec.confirms.at(-1).message, new RegExp(`${hidden} other selected (entry is|entries are) hidden by filters and will NOT be deleted`));
    const text = V.store.get("a.timedot").content;
    assert.ok(text.includes("home:read") && text.includes("talk"), "the hidden selected entries survived (home:read and talk are not in the work project)");
    assert.equal(text.includes("work:code"), false); assert.equal(text.includes("work:mail"), false);
    assert.ok(/2026-11-23 Mon/.test(text) && /2026-11-25 Wed/.test(text), "day headings survive");
    assert.equal(V.rec.writes.length, 1, "one save for the bulk deletion");
    t.diagnostic('timedot: bulk delete is source-preserving; hidden selected entries and headings survive; one save');

    // reports
    click(q(`[data-report="by-type"]`, bar)); await flush();
    const rp = V.rec.reports.at(-1); assert.equal(rp.type, "timedot:by-type");
    const out = rp.compute(rp.text); assert.equal(out.ok, true);
    assert.deepEqual(out.native.rows.map((r) => r[0]).sort(), ["t:c", "t:e"]);
    t.diagnostic('timedot reports: the type report runs from the menu');

    // search by letter type and sort flatten
    await V.setField("filters", "project", "");
    const s = q("[name=search]", bar); s.value = "t:e"; fire(s, "input"); await sleep(220);
    assert.equal(qa(".tv-row").length, 1);
    s.value = ""; fire(s, "input"); await sleep(220);
    const r = q(`[data-form="sort"] [value="duration-desc"]`, bar); r.checked = true; fire(r, "change"); await flush();
    assert.equal(qa(".tv-day").length, 0); assert.ok(q(".tv-row__where"), "flat rows show their date");
    t.diagnostic('timedot: search by letter type; non-date sort flattens the list with dates on each row');
  });

  // ---------------------------------------------------------------- icons and navigation
  test("sidebar: the section is Files; each file gets its type icon, unknown types the generic icon, broken icons fall back", async (t) => {
    const { initSidebar } = await import(REPO + "assets/js/shell/sidebar.js");
    const { fileIconEl, FILE_ICON_PATHS } = await import(REPO + "assets/js/shell/file-icons.js");
    const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(html("index.html"))[1].replace(/<script[\s\S]*?<\/script>/g, "");
    document.body.innerHTML = body;
    w.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    const names = ["main.journal", "week.timeclock", "notes.timedot", "bank.csv", "bank.rules", "readme.txt", "UPPER.JOURNAL"];
    const listeners = [];
    const host = {
      files: { list: () => names.map((name) => ({ name })), on: (e, cb) => listeners.push(cb) },
      sync: { statusOf: () => "ok", errorOf: () => null, on: () => {} },
      auth: { user: null, on: () => {}, signIn() {} }, open() {}, dialogs: { menu() {} }, actions: {}, settings: { get: () => null, on: () => {} },
    };
    initSidebar({ host, editors: { active: null, on: () => {} } });
    const toggle = document.getElementById("files-dropdown-btn");
    assert.match(toggle.textContent, /Files/);
    assert.doesNotMatch(toggle.textContent, /Journals/);
    assert.equal(toggle.getAttribute("aria-controls"), "files-list");
    assert.ok(document.getElementById("files-list"));
    const rows = [...document.querySelectorAll("#files-list .sidebar__row")];
    assert.equal(rows.length, names.length);
    const iconOf = (name) => rows.find((r) => r.title === name).firstElementChild;
    const srcs = ["main.journal", "week.timeclock", "notes.timedot", "bank.csv", "bank.rules"].map((n) => iconOf(n).getAttribute("src"));
    assert.equal(new Set(srcs).size, 5, "five different icons in the sidebar");
    for (const [n, ext] of [["main.journal", ".journal"], ["week.timeclock", ".timeclock"], ["notes.timedot", ".timedot"], ["bank.csv", ".csv"], ["bank.rules", ".rules"]]) {
      assert.equal(iconOf(n).tagName, "IMG"); assert.ok(iconOf(n).getAttribute("src").endsWith("/assets/" + FILE_ICON_PATHS[ext]), n);
      assert.equal(iconOf(n).getAttribute("alt"), ""); assert.equal(iconOf(n).getAttribute("aria-hidden"), "true");
    }
    assert.equal(iconOf("UPPER.JOURNAL").getAttribute("src"), iconOf("main.journal").getAttribute("src"), "extensions are case-insensitive");
    assert.equal(iconOf("readme.txt").tagName, "SPAN"); assert.ok(iconOf("readme.txt").classList.contains("icon--file"), "unknown types use the generic file icon");
    // a missing icon file turns itself into the generic icon instead of a broken image
    const img = fileIconEl("x.timeclock"); document.body.append(img);
    fire(img, "error");
    assert.equal(document.body.contains(img), false);
    assert.ok(document.body.querySelector(".file-icon-fallback.icon--file"));
    // the empty state names files, not journals
    host.files.list = () => [];
    listeners.forEach((cb) => cb());
    assert.match(document.getElementById("files-list").textContent, /No files yet\. Create a file, or import one/);
    t.diagnostic("sidebar icons, Files heading, fallback and empty state");
  });

  test("tabs: a file tab shows its type icon; special tabs have none", async (t) => {
    const src = readFileSync(new URL("assets/js/shell/editor-service.js", REPO), "utf8");
    assert.match(src, /parseUri\(tab\.uri\)\.scheme === "file" && fileIconEl\(parseUri\(tab\.uri\)\.path, \{ className: "tab__icon" \}\)/);
    const { parseUri, fileUri } = await import(REPO + "assets/js/shell/core.js");
    const { fileIconEl } = await import(REPO + "assets/js/shell/file-icons.js");
    assert.equal(parseUri(fileUri("week.timeclock")).scheme, "file");
    assert.equal(parseUri("wedger:settings").scheme, "wedger");
    const el = fileIconEl(parseUri(fileUri("week.timeclock")).path, { className: "tab__icon" });
    assert.ok(el.classList.contains("tab__icon") && el.tagName === "IMG");
    t.diagnostic("tab icon wiring");
  });
}
