// Static contracts between the time viewers' controllers and their templates, menus and dialogs: every slot a
// controller asks for exists, every menu button is wired, every dialog follows the template contract of time-dialog.js.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../assets/${p}`, import.meta.url), "utf8");
const slotsIn = (html) => new Set([...html.matchAll(/data-slot="([^"]+)"/g)].map((m) => m[1]));
const idsIn = (html) => new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

for (const kind of ["timeclock", "timedot"]) {
  const html = read(`special/${kind}.html`), menu = read(`special/${kind}-menu.html`), ctl = read(`special/${kind}.js`);
  const shared = read("js/shell/time-controls.js"), ui = read("js/shell/time-ui.js");

  test(`${kind}: has no Overview, Totals or inline add form (reports are on request only)`, () => {
    for (const bad of ["tv-figures", "tv-fig", "tv-sum", "tv-add", "Overview", "overview(", "summarySection", "barTable", "figure(", "formDialog"]) {
      assert.equal((html + ctl + ui).includes(bad), false, `${bad} must be gone`);
    }
    const css = read("css/time.css");
    for (const dead of [".tv-figures", ".tv-fig", ".tv-sum", ".tv-add", ".tv-running__row", ".tv-chip "]) assert.equal(css.includes(dead), false, `${dead} is dead CSS`);
  });

  test(`${kind}: every [data-slot] the controller and the shell read exists in the template`, () => {
    const have = slotsIn(html);
    const wanted = [...ctl.matchAll(/\$s\("([^"]+)"\)/g)].map((m) => m[1]);
    for (const s of ["page", "content", "render-error", "text", "status", "raw-issues", "selbar", "sel-count", "sel-note"]) wanted.push(s);
    for (const s of wanted) assert.ok(have.has(s), `${kind}.html is missing data-slot="${s}"`);
  });

  test(`${kind}: every menu button is wired (no dead buttons) and the menu has the journal's structure`, () => {
    const acts = [...menu.matchAll(/data-act="([^"]+)"/g)].map((m) => m[1]);
    for (const a of acts) assert.ok(ctl.includes(`"${a}"`) || shared.includes(`"${a}"`), `data-act="${a}" has no handler`);
    const items = [...menu.matchAll(/data-menu="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(items, [kind === "timeclock" ? "sessions" : "entries", "reports", "filters", "sort", "search", "view"]);
    for (const a of ["toggle-select", "select-visible", "clear-selection", "delete-selected"]) assert.ok(acts.includes(a), a);
    assert.match(menu, /data-file-action="download"/);
    // the slots controls read from the menu
    const have = slotsIn(menu);
    for (const s of ["sel-badge", "filter-count", "filter-error", "search-count", "search-help", "recent", "recent-group", "presets", "report-error"]) assert.ok(have.has(s), `${kind}-menu.html is missing data-slot="${s}"`);
    for (const f of ["from", "to", "account", "project"]) assert.match(menu, new RegExp(`data-form="filters"[\\s\\S]*name="${f}"`));
    assert.equal(/name="sort" value="date-desc"/.test(menu) && /name="sort" value="duration-desc"/.test(menu), true);
  });

  test(`${kind}: filters and sort are separate top-level menus that apply immediately (no Apply / Cancel)`, () => {
    assert.equal(/>\s*Apply\s*</.test(menu) || /type="submit"/.test(menu), false);
    assert.match(menu, /data-menu="filters"[\s\S]*data-menu="sort"/);
  });
}

test("timeclock menu: status filter and the Running sessions report exist only for timeclock", () => {
  assert.match(read("special/timeclock-menu.html"), /name="status"/);
  assert.match(read("special/timeclock-menu.html"), /data-report="running"/);
  assert.equal(/name="status"/.test(read("special/timedot-menu.html")), false);
  assert.match(read("special/timedot-menu.html"), /data-report="by-type"/);
});

/* ---------------------------------------------------------------- dialogs */
const DIALOGS = ["timeclock-session", "timeclock-clock-out", "timedot-entry", "timedot-day"];
for (const name of DIALOGS) {
  test(`dialog ${name}: follows the template contract (form, labels, submit, cancel, error banner, field errors)`, () => {
    const html = read(`dialogs/${name}.html`), js = read(`dialogs/${name}.js`);
    assert.match(html, /<form data-slot="form"/);
    assert.match(html, /data-slot="submit"/);
    assert.match(html, /data-act="cancel"/);
    assert.match(html, /data-slot="error"[^>]*role="alert"/);
    assert.match(js, /export function mount\(/);
    assert.match(js, /bindDialog\(/);
    const ids = idsIn(html);
    ids.add("amount");                                                      // the amount input is created by amountControl()
    for (const m of html.matchAll(/<label[^>]*\bfor="([^"]+)"/g)) assert.ok(ids.has(m[1]), `label for="${m[1]}" points at nothing`);
    const names = new Set([...html.matchAll(/\bname="([^"]+)"/g)].map((m) => m[1]));
    names.add("amount");
    for (const m of html.matchAll(/data-error-for="([^"]+)"/g)) assert.ok(names.has(m[1]), `field error for unknown field "${m[1]}"`);
    // every data-slot the controller reads exists
    const have = slotsIn(html);
    for (const m of js.matchAll(/slot\("([^"]+)"\)/g)) assert.ok(have.has(m[1]), `${name}.html is missing data-slot="${m[1]}"`);
    // visible fields are labelled (aria-label or <label for>)
    for (const m of html.matchAll(/<input\b([^>]*)>/g)) {
      if (/type="checkbox"/.test(m[1])) continue;
      const id = /\bid="([^"]+)"/.exec(m[1])?.[1];
      assert.ok(/aria-label=/.test(m[1]) || (id && new RegExp(`for="${id}"`).test(html)), `unlabelled input: ${m[1].trim()}`);
    }
  });
}

test("dialogs: Cancel and Escape can never call submit(); submit is only reached through the form", () => {
  const dlg = read("js/shell/time-dialog.js");
  assert.match(dlg, /data-act="cancel"[\s\S]{0,60}close\(null\)/);
  assert.equal((dlg.match(/await run\(\)/g) ?? []).length, 1);
  for (const name of DIALOGS) {
    const js = read(`dialogs/${name}.js`);
    assert.match(js, /\bsubmit\(/, `${name} calls the viewer's submit()`);
    assert.equal(/addEventListener\("key(?:down|up)"/.test(js), false, `${name} has no key handler that could submit around the form`);
  }
});
