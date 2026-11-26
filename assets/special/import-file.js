/* special/import-file.js — import a journal, time log or bank CSV.
 *
 * Journals and CSVs are previewed with the real hledger engine before anything is saved: a CSV is converted with
 * its rules, a journal is parsed. .timeclock and .timedot text never goes near the engine: Wedger's own parsers
 * (js/shell/time-import.js) check it, and when text is added to an existing time file the MERGED file is checked.
 * The Import button only unlocks once there is something valid to import — except that a time file with errors can
 * be imported on purpose, as is, to repair it in the editor (an explicit choice, never the default).
 */
import { h, extOf, fileUri, debounce, formatBytes } from "../js/shell/core.js";
import { createBoundEditor } from "../js/codemirror/bundle.js";
import { timeKindOf, formatDuration, formatHours, formatDateLabel, plural } from "../js/shell/time-format.js";
import { planTimeImport } from "../js/shell/time-import.js";

const SUPPORTED = [".journal", ".timeclock", ".timedot", ".csv"];
const PREVIEW_LINES = 14;

/* ----------------------------------------------------------------- CSV peek */
/** Small CSV reader for the preview table only (hledger does the real parsing). */
export function peekCsv(text, maxRows = 6) {
  const first = text.split(/\r?\n/).find((l) => l.trim()) ?? "";
  const sep = [",", ";", "\t", "|"].map((s) => [s, first.split(s).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length && rows.length <= maxRows; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  if ((cell || row.length) && rows.length <= maxRows) { row.push(cell); if (row.some((x) => x.trim())) rows.push(row); }
  const total = text.split(/\r?\n/).filter((l) => l.trim()).length;
  return { separator: sep, header: rows[0] ?? [], rows: rows.slice(1, maxRows + 1), totalLines: total };
}

/** Best-effort starter rules from the header row. Always shown as a suggestion to review. */
export function suggestRules(peek, defaultCommodity = "") {
  const names = peek.header.map((raw) => {
    const n = raw.trim().toLowerCase();
    if (/^(txn |transaction |value |posting )?date$|^date\b/.test(n)) return "date";
    if (/desc|narrat|particular|memo|detail|payee|remark/.test(n)) return "description";
    if (/^(debit|withdraw|paid out|dr)\b|withdrawal/.test(n)) return "amount-out";
    if (/^(credit|deposit|paid in|cr)\b/.test(n)) return "amount-in";
    if (/amount/.test(n)) return "amount";
    if (/balance/.test(n)) return "balance";
    if (/^currency$/.test(n)) return "currency";
    return "";
  });
  const dateCol = names.indexOf("date");
  const sample = dateCol >= 0 ? (peek.rows[0]?.[dateCol] ?? "").trim() : "";
  let fmt = "%Y-%m-%d";
  const m = /^(\d{1,4})([-/.])(\d{1,2})[-/.](\d{1,4})$/.exec(sample);
  if (m) {
    const [, a, sep, b, c] = m;
    if (a.length === 4) fmt = `%Y${sep}%m${sep}%d`;
    else if (Number(a) > 12) fmt = `%d${sep}%m${sep}${c.length === 4 ? "%Y" : "%y"}`;
    else if (Number(b) > 12) fmt = `%m${sep}%d${sep}${c.length === 4 ? "%Y" : "%y"}`;
    else fmt = `%d${sep}%m${sep}${c.length === 4 ? "%Y" : "%y"}`;       // ambiguous: day-first, the common case in India
  }
  const lines = ["skip 1", `fields ${names.join(", ")}`, `date-format ${fmt}`];
  if (peek.separator !== ",") lines.splice(1, 0, `separator ${peek.separator === "\t" ? "TAB" : peek.separator}`);
  if (defaultCommodity) lines.push(`currency ${defaultCommodity}`);
  lines.push("account1 assets:bank");
  return lines.join("\n") + "\n";
}

/* ---------------------------------------------------------------- controller */
export function mount({ root, view, host }) {
  const form = root.querySelector('[data-slot="form"]');
  const el = form.elements;
  // Both text boxes are CodeMirror editors over their textareas (value bridges), destroyed when the view closes.
  const mountEditor = (ta) => createBoundEditor(ta, { dispatchInput: true, lineWrapping: false, lineNumbers: !!host.settings.get("lineNumbers") });
  const editors = [mountEditor(el.pasteText), mountEditor(el.rules)];
  const refreshEditors = () => requestAnimationFrame(() => editors.forEach((ed) => ed.refresh()));   // they measure 0 while hidden
  const slot = (n) => root.querySelector(`[data-slot="${n}"]`);
  const st = { src: "file", picked: null, preview: { state: "empty" }, busy: false };
  let seq = 0, planned = Promise.resolve();

  /* ---------- source ---------- */
  const source = () => {
    if (st.src === "file") return st.picked;
    const text = el.pasteText.value;
    return text.trim() ? { name: `pasted${el.pasteType.value}`, text, size: new Blob([text]).size } : null;
  };
  const ext = () => extOf(source()?.name ?? "");
  const isCsv = () => ext() === ".csv";
  const targetExt = () => (isCsv() ? ".journal" : ext());
  const timeKind = () => timeKindOf(source()?.name ?? "");
  const TIME_STATES = ["time-ok", "time-warn", "time-error"];

  function setSrc(next) {
    st.src = next;
    root.querySelectorAll("[data-src]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.src === next)));
    slot("src-file").hidden = next !== "file";
    slot("src-paste").hidden = next !== "paste";
    refreshEditors();
    onSourceChanged();
  }
  root.querySelectorAll("[data-src]").forEach((b) => b.addEventListener("click", () => setSrc(b.dataset.src)));

  async function pick(file) {
    if (!file) return;
    if (!SUPPORTED.includes(extOf(file.name)) && !/\.txt$/i.test(file.name)) {
      return host.notify("That file type isn't supported. Choose a .journal, .csv, .timeclock or .timedot file.", "error");
    }
    let text;
    try { text = await file.text(); } catch { return host.notify("That file couldn't be read.", "error"); }
    st.picked = { name: SUPPORTED.includes(extOf(file.name)) ? file.name : `${file.name.replace(/\.txt$/i, "")}.journal`, text, size: file.size };
    el.newName.value = "";
    onSourceChanged();
  }
  el.file.addEventListener("change", () => { pick(el.file.files[0]); el.file.value = ""; });
  const dz = slot("dropzone");
  dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("is-over"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("is-over"));
  dz.addEventListener("drop", (e) => { e.preventDefault(); dz.classList.remove("is-over"); pick(e.dataTransfer.files[0]); });
  el.pasteText.addEventListener("input", onSourceChanged);
  el.pasteType.addEventListener("change", onSourceChanged);
  root.addEventListener("click", async (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "remove-file") { st.picked = null; onSourceChanged(); }
    if (act === "suggest-rules") {
      const src = source();
      if (!src) return;
      if (el.rules.value.trim() && !(await host.dialogs.confirm({ title: "Replace your rules?", message: "The rules you've written will be replaced by a suggestion based on the CSV's columns.", confirmLabel: "Replace" }))) return;
      el.rules.value = suggestRules(peekCsv(src.text), host.settings.get("defaultCommodity"));
      replan();
    }
  });

  /* ---------- rules ---------- */
  function renderSavedRules() {
    const rules = host.files.list().filter((f) => f.name.endsWith(".rules"));
    el.savedRules.replaceChildren(h("option", { value: "" }, rules.length ? "Use a saved rules file…" : "No saved rules files yet"),
      ...rules.map((f) => h("option", { value: f.name }, f.name)));
    el.savedRules.disabled = !rules.length;
  }
  el.savedRules.addEventListener("change", () => {
    if (!el.savedRules.value) return;
    el.rules.value = host.files.get(el.savedRules.value)?.content ?? "";
    el.saveRules.checked = false; el.savedRules.value = "";
    replan();
  });
  el.rulesFile.addEventListener("change", async () => {
    const f = el.rulesFile.files[0];
    if (f) { el.rules.value = await f.text(); el.saveRules.checked = false; replan(); }
    el.rulesFile.value = "";
  });
  el.rules.addEventListener("input", () => replan());

  /* ---------- destination ---------- */
  function renderTargets() {
    // Exactly the same type: time logs are never added to (or replacing) a journal, and timeclock never meets timedot.
    const options = host.files.list().filter((f) => extOf(f.name) === (targetExt() || ".journal")).map((f) => f.name);
    for (const sel of [el.target, el.replaceTarget]) {
      const keep = sel.value;
      sel.replaceChildren(...options.map((n) => h("option", { value: n }, n)));
      if (options.includes(keep)) sel.value = keep;
      sel.disabled = !options.length;
    }
  }
  function showDest() {
    const dest = form.elements.dest.value;
    root.querySelectorAll("[data-for]").forEach((f) => { f.hidden = f.dataset.for !== dest; });
    updateSubmit();
  }
  form.querySelectorAll('[name="dest"]').forEach((r) => r.addEventListener("change", () => { showDest(); if (timeKind()) replan(); }));
  el.target.addEventListener("change", () => { if (timeKind()) replan(); });
  const destError = (msg) => { const p = slot("dest-error"); p.textContent = msg ?? ""; p.hidden = !msg; };
  el.newName.addEventListener("input", () => destError(null));

  /* ---------- preview ---------- */
  const PILLS = {
    empty: ["Waiting for a file", ""], "needs-rules": ["Rules needed", "warn"], loading: ["Checking…", ""],
    ok: ["Ready", "ok"], "ok-unchecked": ["Ready", "ok"], error: ["Needs attention", "error"], "engine-error": ["Not checked", "warn"],
    "time-ok": ["Ready", "ok"], "time-warn": ["Ready, with warnings", "warn"], "time-error": ["Has errors", "error"],
  };
  const entries = (n) => (n === 1 ? "entry" : "entries");
  // "Allow importing with errors" is remembered across re-renders of the preview; it resets when the source changes.
  const repair = h("input", { type: "checkbox", name: "repair" });
  repair.addEventListener("change", updateSubmit);
  const repairRow = h("label", { class: "check", style: "margin-top:.8rem" }, repair,
    h("span", {}, "Import it anyway, exactly as it is, so I can fix the errors in the editor."));

  /** What the native parser found, as preview elements. */
  function timeBlocks(p) {
    const plan = p.plan, st2 = plan.stats, out = [];
    const facts = [];
    if (plan.kind === "timeclock") {
      facts.push(`${st2.completed} completed ${plural(st2.completed, "session")}`, `${formatDuration(st2.completedSeconds)} (${formatHours(st2.completedSeconds)} h)`);
      if (st2.running) facts.push(`${st2.running} still running`);
      if (st2.invalid) facts.push(`${st2.invalid} with problems`);
      if (st2.accounts.length) facts.push(`${st2.accounts.length} ${plural(st2.accounts.length, "account")}`);
    } else {
      facts.push(`${st2.days} ${plural(st2.days, "day")}`, `${st2.postings} ${entries(st2.postings)}`, `${formatDuration(st2.totalSeconds)} (${formatHours(st2.totalSeconds)} h)`);
      if (st2.skipped) facts.push(`${st2.skipped} can't be counted`);
    }
    if (st2.firstDate) facts.push(st2.firstDate === st2.lastDate ? formatDateLabel(st2.firstDate) : `${formatDateLabel(st2.firstDate)} – ${formatDateLabel(st2.lastDate)}`);
    out.push(h("div", { class: "imp-preview__label" }, "What's in it"), h("div", { class: "tv-filters", style: "margin-bottom:.4rem" }, ...facts.map((f) => h("span", { class: "chip" }, f))));
    if (plan.kind === "timedot" && st2.types.length) out.push(h("div", { class: "tv-filters" }, "By type:", ...st2.types.map((t) => h("span", { class: "tv-chip" }, h("b", {}, t.type), formatDuration(t.seconds)))));
    for (const n of plan.notes) out.push(h("div", { class: "banner banner--warn", style: "margin-top:.6rem" }, n));
    if (plan.issues.length) {
      const where = (d) => { const l = d.line - plan.lineOffset; return plan.mode === "append" && l > 0 ? `line ${l} of this text` : `line ${d.line}${plan.mode === "append" ? " of the file" : ""}`; };
      out.push(h("div", { class: "imp-preview__label", style: "margin-top:.8rem" }, `${plan.counts.error ? `${plan.counts.error} ${plural(plan.counts.error, "error")}` : ""}${plan.counts.error && plan.counts.warning ? ", " : ""}${plan.counts.warning ? `${plan.counts.warning} ${plural(plan.counts.warning, "warning")}` : ""}`),
        h("ul", { class: "tv-issues__list", style: "padding:0" }, ...plan.issues.slice(0, 10).map((d) => h("li", { class: "tv-issue" },
          h("span", { class: `tv-issue__sev tv-issue__sev--${d.severity}` }, d.severity === "error" ? "Error" : "Warning"),
          h("span", { class: "tv-issue__msg" }, d.message), h("span", { class: "tv-note" }, where(d))))),
        plan.issues.length > 10 ? h("p", { class: "imp-preview__more" }, `…and ${plan.issues.length - 10} more`) : null);
    }
    if (plan.counts.error) {
      out.push(h("div", { class: "banner banner--error", role: "alert", style: "margin-top:.8rem" },
        h("strong", {}, "This isn't a valid file yet."), " Totals leave out whatever has an error. You can import it as it is and fix it in the editor."), repairRow);
    }
    return out.filter(Boolean);
  }

  const codeBlock = (text, lines = PREVIEW_LINES) => {
    const all = text.replace(/\s+$/, "").split("\n");
    return [h("pre", { class: "imp-code", tabindex: "0" }, all.slice(0, lines).join("\n")),
      all.length > lines ? h("p", { class: "imp-preview__more" }, `…and ${all.length - lines} more lines`) : null];
  };
  const tableBlock = (peek) => h("div", { class: "imp-table-wrap", tabindex: "0" }, h("table", { class: "imp-table" },
    h("thead", {}, h("tr", {}, ...peek.header.map((c) => h("th", { scope: "col" }, c)))),
    h("tbody", {}, ...peek.rows.map((r) => h("tr", {}, ...peek.header.map((_, i) => h("td", {}, r[i] ?? "")))))));

  function setPreview(p) {
    st.preview = p;
    const [label, tone] = PILLS[p.state];
    const pill = slot("pill");
    pill.textContent = p.state === "ok" && p.count != null ? `${p.count} ${p.count === 1 ? "transaction" : "transactions"}` : label;
    if (TIME_STATES.includes(p.state)) pill.textContent = label;
    pill.className = `pill${tone ? ` pill--${tone}` : ""}`;
    const box = slot("preview");
    box.replaceChildren();
    if (p.state === "empty") box.append(h("p", { class: "imp-preview__empty" }, "Choose a file or paste some text and a preview will appear here."));
    if (p.table) box.append(h("div", { class: "imp-preview__label" }, `Your CSV · ${p.table.totalLines - 1} rows`), tableBlock(p.table));
    if (p.state === "needs-rules") box.append(h("div", { class: "banner banner--warn", style: "margin-top:.9rem" }, "Add rules to see how this CSV turns into transactions. “Suggest from columns” gives you a starting point."));
    if (p.state === "loading") box.append(h("div", { class: "imp-preview__empty" }, h("div", { class: "spinner", style: "margin:0 auto .5rem" }), host.engine.ready ? "Converting with hledger…" : "Loading the accounting engine…"));
    if (p.state === "error") box.append(h("div", { class: "banner banner--error", role: "alert", style: "margin-top:.9rem" }, h("strong", {}, "hledger said:"), h("pre", { class: "banner__pre" }, p.message)));
    if (p.state === "engine-error") box.append(h("div", { class: "banner banner--warn", style: "margin-top:.9rem" }, `The accounting engine isn't available, so this can't be checked first. ${p.message}`));
    if (TIME_STATES.includes(p.state)) {
      box.append(...timeBlocks(p));
      box.append(h("div", { class: "imp-preview__label", style: "margin-top:.8rem" }, p.plan.mode === "append" ? "Text to add" : "File contents"), ...codeBlock(p.text).filter(Boolean));
    }
    if (p.text != null && (p.state === "ok" || p.state === "ok-unchecked" || p.state === "engine-error")) {
      box.append(h("div", { class: "imp-preview__label" }, isCsv() ? "Becomes" : "File contents"), ...codeBlock(p.text).filter(Boolean));
    }
    updateSubmit();
  }

  async function plan() {
    const mine = ++seq;
    const src = source();
    if (!src) return setPreview({ state: "empty" });
    const e = extOf(src.name);
    const kind = timeKindOf(src.name);
    if (kind) return setPreview(timePreview(src, kind));
    const table = e === ".csv" ? peekCsv(src.text) : null;
    if (e === ".csv") {
      slot("columns").replaceChildren(...table.header.map((c) => h("span", { class: "chip" }, c || "(blank)")));
      if (!el.rules.value.trim()) return setPreview({ state: "needs-rules", table });
    }

    setPreview({ state: "loading", table });
    try { await host.engine.whenReady(); }
    catch (err) { if (mine === seq) setPreview({ state: "engine-error", table, text: e === ".journal" ? src.text : null, message: err.message }); return; }
    const res = e === ".csv" ? await host.engine.convertCsv(src.text, el.rules.value) : await host.engine.inspectJournal(src.text);
    if (mine !== seq) return;
    if (!res.ok) return setPreview({ state: "error", table, message: res.error });
    setPreview({ state: "ok", table, count: res.count, text: e === ".csv" ? res.text : src.text });
  }
  /** Native check of time-log text, in the context of where it's going (append => the merged file is parsed). */
  function timePreview(src, kind) {
    const mode = form.elements.dest.value;
    const existing = mode === "append" ? (host.files.get(el.target.value)?.content ?? "") : "";
    const plan = planTimeImport({ kind, fragment: src.text, mode, existing });
    return { state: plan.status === "error" ? "time-error" : plan.status === "warning" ? "time-warn" : "time-ok", kind, plan, text: src.text };
  }
  const planSoon = debounce(() => { planned = plan(); }, 350);
  const planSoonTime = debounce(() => { planned = plan(); }, 120);        // no engine involved, so no "Checking…" flash
  const replan = () => {
    if (timeKind()) return planSoonTime();
    setPreview({ ...st.preview, state: st.preview.state === "empty" ? "empty" : "loading" });
    planSoon();
  };

  function onSourceChanged() {
    const src = source();
    repair.checked = false;
    slot("dropzone").hidden = !!(st.src === "file" && st.picked);
    slot("file-card").hidden = !(st.src === "file" && st.picked);
    if (st.picked) { slot("file-name").textContent = st.picked.name; slot("file-meta").textContent = `${formatBytes(st.picked.size)} · ${st.picked.text.split(/\r?\n/).length} lines`; }
    slot("rules-step").hidden = !isCsv();
    refreshEditors();
    slot("dest-num").textContent = isCsv() ? "3" : "2";
    if (src && !el.newName.value.trim()) el.newName.placeholder = (isCsv() ? src.name.replace(/\.csv$/i, ".journal") : src.name).replace(/^pasted/, "imported");
    const rulesName = src && st.src === "file" ? `${src.name}.rules` : "imported.csv.rules";
    slot("rules-name").textContent = rulesName;
    renderTargets();
    if (!src) return setPreview({ state: "empty" });
    replan();
  }

  function updateSubmit() {
    const p = st.preview;
    const time = TIME_STATES.includes(p.state);
    const ok = !st.busy && (["ok", "ok-unchecked", "engine-error"].includes(p.state) && (p.state !== "engine-error" || !isCsv())
      || p.state === "time-ok" || p.state === "time-warn" || (p.state === "time-error" && repair.checked));
    slot("submit").disabled = !ok;
    slot("submit").textContent = p.state === "time-error" ? "Import for repair" : "Import";
    const src = source();
    const stats = p.plan?.stats;
    slot("summary").textContent = !src ? "" : time
      ? (p.state === "time-error" ? "Has errors — tick the box above to import it as it is." : p.plan.kind === "timeclock" ? `${stats.completed} completed ${plural(stats.completed, "session")}${stats.running ? ` and ${stats.running} running` : ""} will be imported.` : `${stats.postings} ${entries(stats.postings)} on ${stats.days} ${plural(stats.days, "day")} will be imported.`)
      : p.state === "ok" && p.count != null ? `${p.count} ${p.count === 1 ? "transaction" : "transactions"} will be imported.` : p.state === "error" ? "Fix the problem above to import." : "";
  }

  /* ---------- submit ---------- */
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (st.busy) return;
    destError(null);
    await planned;                                           // never import from a stale preview
    const p = st.preview, src = source();
    const kind = timeKind();
    if (!src || ![...TIME_STATES, "ok", "ok-unchecked", "engine-error"].includes(p.state)) return;
    const text = isCsv() ? p.text : src.text;
    const dest = form.elements.dest.value;

    let name;
    if (dest === "new") {
      name = host.files.normalize(el.newName.value.trim() || el.newName.placeholder, targetExt() || ".journal");
      const err = host.files.validateName(name);
      if (err) return destError(err);
    } else {
      name = dest === "append" ? el.target.value : el.replaceTarget.value;
      if (!name) return destError(`There's no ${targetExt() || ".journal"} file to ${dest === "append" ? "add to" : "replace"}. Create a new file instead.`);
    }
    if (dest !== "new" && extOf(name) !== targetExt()) return destError(`${name} is not a ${targetExt()} file, so it can't take this ${targetExt().slice(1)} data. Choose a ${targetExt()} file or create a new one.`);
    let timePlan = null;
    if (kind) {                                                         // re-check against the file as it is NOW, never a stale preview
      timePlan = planTimeImport({ kind, fragment: src.text, mode: dest, existing: dest === "append" ? (host.files.get(name)?.content ?? "") : "" });
      if (timePlan.status === "error" && !repair.checked) { setPreview(timePreview(src, kind)); return destError("This has errors. Tick “Import it anyway” to import it as it is."); }
    }
    if (dest === "replace") {
      const ok = await host.dialogs.confirm({ title: `Replace ${name}?`, message: "Everything currently in this file will be overwritten.", confirmLabel: "Replace", danger: true });
      if (!ok) return;
    }

    st.busy = true; updateSubmit();
    const btn = slot("submit");
    const label = btn.textContent;
    btn.replaceChildren(h("span", { class: "spinner spinner--inline" }), " Importing…");
    try {
      if (dest === "new") host.files.create(name, text);
      else if (dest === "replace") host.files.write(name, text);
      else if (timePlan) host.files.write(name, timePlan.finalText);       // the imported text verbatim, added after the existing text
      else {
        const current = host.files.get(name).content.replace(/\s*$/, "");
        const merged = current ? `${current}\n\n${text.replace(/^\s+/, "")}` : text;
        if (name.endsWith(".journal") && host.engine.ready) {              // don't let an import break a working journal
          const [before, after] = [await host.engine.inspectJournal(current), await host.engine.inspectJournal(merged)];
          if (before.ok && !after.ok) throw new Error(`Adding this would make ${name} invalid:\n${after.error}`);
        }
        host.files.write(name, merged);
      }
      if (isCsv() && el.saveRules.checked && el.rules.value.trim() && st.src === "file") {
        const rulesName = `${src.name}.rules`;
        if (!host.files.exists(rulesName)) host.files.create(rulesName, el.rules.value);
      }
      host.notify(dest === "new" ? `Imported as ${name}` : dest === "append" ? `Added to ${name}` : `Replaced ${name}`, "ok");
      await host.open(fileUri(name));
      view.close();
    } catch (err) {
      st.busy = false;
      btn.textContent = label;
      destError(err.message);
      updateSubmit();
    }
  });

  renderSavedRules(); renderTargets(); showDest(); setPreview({ state: "empty" });
  const offs = [
    host.files.on("changed", () => { renderSavedRules(); renderTargets(); if (timeKind() && form.elements.dest.value === "append") replan(); }),
    host.settings.on("lineNumbers", () => editors.forEach((ed) => ed.setLineNumbers(!!host.settings.get("lineNumbers")))),
  ];
  return { dispose() { offs.forEach((o) => o()); planSoon.cancel(); planSoonTime.cancel(); seq++; editors.forEach((ed) => ed.destroy()); } };
}
