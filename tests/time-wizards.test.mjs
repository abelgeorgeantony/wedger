import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mountSpecial, load, disposeAll } from "./dom-harness.mjs";
import { resolveTemplate } from "../assets/js/shell/templates.js";

const env = await load();
after(disposeAll);
const skip = env ? false : "jsdom is not installed (npm install)";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const templates = JSON.parse(readFileSync(new URL("../assets/special/templates.json", import.meta.url), "utf8"));
const ev = (t) => new window.Event(t, { bubbles: true, cancelable: true });
const names = (m) => [...m.root.querySelectorAll(".template-card__name")].map((e) => e.textContent);

test("create file: .timeclock and .timedot offer their own templates, never the journal ones", { skip }, async () => {
  const m = await mountSpecial("create-file", { assetsJson: { "special/templates.json": templates } });
  const setExt = (v) => { m.form.elements.ext.value = v; m.form.elements.ext.dispatchEvent(ev("change")); };
  setExt(".timeclock");
  assert.ok(names(m).includes("Timeclock starter") && names(m).includes("Blank"));
  assert.ok(!names(m).some((n) => ["Personal finances", "Household budget", "Timedot starter"].includes(n)), names(m).join());
  setExt(".timedot");
  assert.ok(names(m).includes("Timedot starter") && names(m).includes("Project tracker") && names(m).includes("Time by type"));
  assert.ok(!names(m).includes("Timeclock starter"));
  setExt(".journal");
  assert.ok(!names(m).some((n) => /Timeclock|Timedot|Project tracker/.test(n)));
});

test("create file: choosing a time template writes a valid file, opens it and closes the wizard", { skip }, async () => {
  for (const [ext, id] of [[".timeclock", "timeclock-starter"], [".timedot", "timedot-starter"]]) {
    const m = await mountSpecial("create-file", { assetsJson: { "special/templates.json": templates } });
    m.form.elements.ext.value = ext; m.form.elements.ext.dispatchEvent(ev("change"));
    const radio = m.root.querySelector(`input[name=template][value=${id}]`);
    radio.checked = true; radio.dispatchEvent(ev("change"));
    m.form.elements.name.value = "log";
    m.form.dispatchEvent(ev("submit"));
    await wait(10);
    const expected = resolveTemplate(templates.find((t) => t.id === id), new Date().getFullYear());
    assert.deepEqual(m.raw.files.creates, [[`log${ext}`, expected]]);
    assert.deepEqual(m.raw.opened, [`file:log${ext}`]);
    assert.equal(m.closed.length, 1);
  }
});

/* ------------------------------------------------------------------- import */
const paste = async (m, kind, text) => {
  m.root.querySelector("[data-src=paste]").dispatchEvent(ev("click"));
  m.form.elements.pasteType.value = kind; m.form.elements.pasteType.dispatchEvent(ev("change"));
  m.form.elements.pasteText.value = text; m.form.elements.pasteText.dispatchEvent(ev("input"));
  await wait(200);
};
const slot = (m, n) => m.root.querySelector(`[data-slot=${n}]`);
const submit = async (m) => { m.form.dispatchEvent(ev("submit")); await wait(20); };
const setDest = (m, v) => { const r = m.form.querySelector(`[name=dest][value=${v}]`); r.checked = true; r.dispatchEvent(ev("change")); };

test("import: a valid timeclock paste is checked natively and imported verbatim", { skip }, async () => {
  const m = await mountSpecial("import-file");                         // the host proxy throws if the engine is touched
  const text = "i 2026-11-23 09:00 a  \no 2026-11-23 10:30 a\ni 2026-11-23 11:00 b\n";
  await paste(m, ".timeclock", text);
  assert.equal(slot(m, "pill").textContent, "Ready");
  assert.match(slot(m, "preview").textContent, /1 completed session.*1h 30m \(1\.50 h\).*1 still running/);
  assert.equal(slot(m, "submit").disabled, false);
  await submit(m);
  assert.deepEqual(m.raw.files.creates, [["imported.timeclock", text]], "text unchanged, including trailing spaces");
  assert.deepEqual(m.raw.opened, ["file:imported.timeclock"]);
});

test("import: an uploaded file is imported byte for byte (CRLF, trailing spaces, odd lines)", { skip }, async () => {
  const m = await mountSpecial("import-file");
  const text = "; log\r\ni 2026-11-23 09:00 a   \r\no 2026-11-23 10:30 a\r\n\r\n";
  const fileInput = m.form.elements.file;
  Object.defineProperty(fileInput, "files", { value: [{ name: "march.timeclock", size: text.length, text: async () => text }], configurable: true });
  fileInput.dispatchEvent(ev("change"));
  await wait(200);
  assert.equal(slot(m, "pill").textContent, "Ready");
  await submit(m);
  assert.deepEqual(m.raw.files.creates, [["march.timeclock", text]]);
});

test("import: a timedot paste shows days, entries, hours and letter types", { skip }, async () => {
  const m = await mountSpecial("import-file");
  await paste(m, ".timedot", "2026-11-23\nwork  ccec\nhome  1h\n2026-11-24\nx  ..\n");
  const t = slot(m, "preview").textContent;
  assert.match(t, /2 days.*3 entries.*2h 30m/);
  assert.match(t, /By type:.*c.*e/);
  await submit(m);
  assert.equal(m.raw.files.creates[0][0], "imported.timedot");
});

test("import: errors block the import until it is explicitly chosen for repair; nothing is called valid", { skip }, async () => {
  const m = await mountSpecial("import-file");
  const text = "o 2026-11-23 10:00 a\nnonsense\n";
  await paste(m, ".timeclock", text);
  assert.equal(slot(m, "pill").textContent, "Has errors");
  assert.match(slot(m, "preview").textContent, /2 errors/);
  assert.match(slot(m, "preview").textContent, /This isn't a valid file yet/);
  assert.equal(slot(m, "submit").disabled, true);
  await submit(m);
  assert.equal(m.raw.files.creates.length, 0);
  const box = m.root.querySelector("input[name=repair]");
  box.checked = true; box.dispatchEvent(ev("change"));
  assert.equal(slot(m, "submit").disabled, false);
  assert.equal(slot(m, "submit").textContent, "Import for repair");
  await submit(m);
  assert.deepEqual(m.raw.files.creates, [["imported.timeclock", text]]);
});

test("import: warnings alone never block", { skip }, async () => {
  const m = await mountSpecial("import-file");
  await paste(m, ".timeclock", "i 2026-11-23 10:00 a\ni 2026-11-23 09:00 b\no 2026-11-23 11:00 b\no 2026-11-23 12:00 a\n");
  assert.equal(slot(m, "pill").textContent, "Ready, with warnings");
  assert.equal(slot(m, "submit").disabled, false);
});

test("import: append validates the merged file and only offers files of the same type", { skip }, async () => {
  const m = await mountSpecial("import-file", { files: { "log.timeclock": "i 2026-11-23 09:00 a\n", "other.timeclock": "", "week.timedot": "2026-11-23\nx  .\n", "j.journal": "" } });
  await paste(m, ".timeclock", "o 2026-11-23 10:00 a\n");
  assert.equal(slot(m, "pill").textContent, "Has errors");                  // alone it has no clock-in to close…
  setDest(m, "append"); await wait(200);
  const options = [...m.form.elements.target.options].map((o) => o.value);
  assert.deepEqual(options.sort(), ["log.timeclock", "other.timeclock"]);   // no timedot, no journal
  m.form.elements.target.value = "log.timeclock"; m.form.elements.target.dispatchEvent(ev("change")); await wait(200);
  assert.equal(slot(m, "pill").textContent, "Ready");                      // …but merged, it closes the open session
  assert.match(slot(m, "preview").textContent, /closes “a”/);
  await submit(m);
  assert.equal(m.raw.store.get("log.timeclock"), "i 2026-11-23 09:00 a\no 2026-11-23 10:00 a\n");
  assert.equal(m.raw.store.get("week.timedot"), "2026-11-23\nx  .\n");
});

test("import: replace targets only the same type and keeps the text exactly", { skip }, async () => {
  const m = await mountSpecial("import-file", { files: { "a.timedot": "old\n", "b.timeclock": "old\n" } });
  await paste(m, ".timedot", "2026-11-23\nx  ..\n");
  setDest(m, "replace");
  assert.deepEqual([...m.form.elements.replaceTarget.options].map((o) => o.value), ["a.timedot"]);
  await submit(m);
  assert.equal(m.raw.store.get("a.timedot"), "2026-11-23\nx  ..\n");
  assert.equal(m.raw.store.get("b.timeclock"), "old\n");
});

test("import: timedot entries without a date join the file's last day, and the page says so", { skip }, async () => {
  const m = await mountSpecial("import-file", { files: { "w.timedot": "2026-11-23\na  .\n" } });
  await paste(m, ".timedot", "b  ..\n");
  setDest(m, "append"); await wait(200);
  assert.match(slot(m, "preview").textContent, /added to the 2026-11-23 day already in the file/);
  await submit(m);
  assert.equal(m.raw.store.get("w.timedot"), "2026-11-23\na  .\n\nb  ..\n");
});
