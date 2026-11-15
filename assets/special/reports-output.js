/* special/reports-output.js — every report you run lands here.
 *
 * Rendered view draws trees and tables; Raw shows exactly what hledger returned.
 * The menu bar has View, Filter, Search and Output (re-run, copy, download, clear).
 */
import { h, icon, relativeTime } from "../js/shell/core.js";
import { initMenubar } from "../js/shell/menubar.js";
import { buildModel, rawText, modelToCsv } from "../js/shell/report-model.js";
import { renderModel, setAllOpen } from "../js/shell/report-view.js";

export function mount({ root, host, menubar }) {
  const slot = (n, scope = root) => scope.querySelector(`[data-slot="${n}"]`);
  const menu = initMenubar(menubar, { onOpen: (id) => { if (id === "filter") paintFilterOptions(); } });
  const grouping = () => host.settings.get("numberGrouping");

  const view = { mode: "rendered", order: "newest", types: new Set(), file: "", search: "" };
  const collapsed = new Set();
  const modelCache = new WeakMap();           // entry.result -> model (rebuilt only when the result changes)

  const modelOf = (entry) => {
    if (!entry.result) return null;
    if (!modelCache.has(entry.result)) modelCache.set(entry.result, buildModel(entry.type, entry.result));
    return modelCache.get(entry.result);
  };
  const raw = (entry) => (entry.status === "error" ? `Error: ${entry.error}` : entry.result ? rawText(entry.result) : "");

  function shown() {
    const q = view.search.trim().toLowerCase();
    let list = host.reports.entries.filter((e) =>
      (!view.types.size || view.types.has(e.type)) && (!view.file || e.file === view.file) &&
      (!q || `${e.label} ${e.query} ${e.file} ${raw(e)}`.toLowerCase().includes(q)));
    if (view.order === "oldest") list = [...list].reverse();
    return list;
  }

  /* ----------------------------------------------------------------- entries */
  function entryBody(entry) {
    if (entry.status === "running") return h("div", { class: "ro-entry__status" }, h("span", { class: "spinner spinner--inline" }), host.engine.ready ? "Running…" : "Waiting for the accounting engine…");
    if (entry.status === "error") return h("div", { class: "banner banner--error", role: "alert" }, h("strong", {}, "This report failed."), h("pre", { class: "banner__pre" }, entry.error));
    if (view.mode === "raw") return h("pre", { class: "ro-raw", tabindex: "0" }, raw(entry));
    return renderModel(modelOf(entry), { grouping: grouping() });
  }

  function entryEl(entry) {
    const isCollapsed = collapsed.has(entry.id);
    const meta = [entry.file, entry.forecast ? "with forecast" : null, entry.status === "running" ? null : `${entry.ms} ms`, relativeTime(entry.at)].filter(Boolean).join(" · ");
    const btn = (label, name, onclick, extra = "") => h("button", { class: `icon-btn${extra}`, type: "button", "aria-label": label, title: label, onclick }, icon(name));
    return h("article", { class: `ro-entry${isCollapsed ? " is-collapsed" : ""}`, dataset: { id: entry.id } },
      h("header", { class: "ro-entry__head" },
        h("button", { class: "ro-entry__toggle", type: "button", "aria-expanded": String(!isCollapsed), "aria-label": `${isCollapsed ? "Expand" : "Collapse"} ${entry.label}`,
          onclick: () => { collapsed.has(entry.id) ? collapsed.delete(entry.id) : collapsed.add(entry.id); paint(); } },
          h("span", { class: "ro-entry__chev" }, icon("chevron")),
          h("span", { class: "ro-entry__title" }, entry.label),
          entry.query && h("span", { class: "ro-entry__query", title: "Query" }, entry.query),
          h("span", { class: "ro-entry__meta" }, meta)),
        h("div", { class: "ro-entry__actions" },
          btn("Run again", "refresh", () => host.reports.rerun(entry.id)),
          btn("Copy", "copy", () => copy(textFor(entry))),
          btn("Download", "download", () => downloadEntry(entry)),
          btn("Remove", "close", () => host.reports.remove(entry.id)))),
      h("div", { class: "ro-entry__body" }, entryBody(entry)));
  }

  /* -------------------------------------------------------------- export helpers */
  const stamp = (e) => `${e.label}${e.query ? ` — ${e.query}` : ""} (${e.file})`;
  const textFor = (e) => raw(e);
  async function copy(text, what = "Copied to clipboard") {
    try { await navigator.clipboard.writeText(text); host.notify(what, "ok"); }
    catch { host.notify("Your browser wouldn't allow copying. Use Download instead.", "error"); }
  }
  function downloadEntry(e) {
    const model = e.status === "ok" ? modelOf(e) : null;
    const csv = view.mode === "rendered" && model ? modelToCsv(model, grouping()) : null;
    const base = `${e.type}-${e.file.replace(/\.[^.]+$/, "")}`;
    if (csv != null) host.download(`${base}.csv`, csv, "text/csv"); else host.download(`${base}.txt`, textFor(e));
  }
  const combined = (list) => list.map((e) => `# ${stamp(e)}\n${textFor(e)}`).join("\n\n");

  /* ------------------------------------------------------------------- painting */
  function paintFilterOptions() {
    const entries = host.reports.entries;
    const types = [...new Map(entries.map((e) => [e.type, e.label])).entries()];
    slot("type-filters", menubar).replaceChildren(...(types.length ? types.map(([type, label]) => h("label", { class: "menubar__check" },
      h("input", { type: "checkbox", value: type, checked: view.types.has(type), onchange: (ev) => { ev.target.checked ? view.types.add(type) : view.types.delete(type); paint(); } }), ` ${label}`))
      : [h("p", { class: "menubar__hint" }, "Nothing to filter yet.")]));
    const sel = menubar.querySelector("[name=file]");
    const files = [...new Set(entries.map((e) => e.file))];
    sel.replaceChildren(h("option", { value: "" }, "All files"), ...files.map((f) => h("option", { value: f }, f)));
    sel.value = files.includes(view.file) ? view.file : "";
  }

  function paint() {
    const all = host.reports.entries, list = shown();
    const filtered = view.types.size || view.file || view.search.trim();
    slot("list").replaceChildren(...list.map(entryEl));

    const empty = slot("empty");
    empty.hidden = list.length > 0;
    empty.replaceChildren();
    if (!all.length) empty.append(h("strong", {}, "No reports yet"), "Open a journal and choose a report from its Reports menu. The output appears here.");
    else if (!list.length) empty.append(h("strong", {}, "No reports match"), h("button", { class: "btn", type: "button", style: "margin-top:.8rem", onclick: resetFilters }, "Reset filters"));

    const chips = slot("chips");
    const items = [...view.types].map((t) => [all.find((e) => e.type === t)?.label ?? t, () => { view.types.delete(t); paint(); }]);
    if (view.file) items.push([view.file, () => { view.file = ""; paint(); }]);
    if (view.search.trim()) items.push([`“${view.search.trim()}”`, () => { view.search = ""; menubar.querySelector("[name=search]").value = ""; paint(); }]);
    chips.hidden = !items.length;
    chips.replaceChildren(...items.map(([label, remove]) => h("span", { class: "jv-chip" }, label, h("button", { type: "button", "aria-label": `Remove filter ${label}`, onclick: remove }, icon("close")))));

    const badge = slot("filter-count", menubar);
    const n = view.types.size + (view.file ? 1 : 0);
    badge.hidden = !n; badge.textContent = n;

    slot("status-count").textContent = filtered ? `${list.length} of ${all.length} reports` : `${all.length} ${all.length === 1 ? "report" : "reports"}`;
    slot("status-mode").textContent = view.mode === "rendered" ? "Rendered" : "Raw";
    slot("status-engine").textContent = host.engine.status === "ready" ? "" : host.engine.status === "error" ? "Engine unavailable" : "Engine loading…";
    for (const id of ["expand-all", "collapse-all", "rerun-all", "copy-all", "download-all", "clear"]) menubar.querySelector(`[data-act="${id}"]`).disabled = !list.length;
  }

  function resetFilters() {
    view.types.clear(); view.file = ""; view.search = "";
    menubar.querySelector("[name=search]").value = "";
    paintFilterOptions(); paint();
  }

  /* ---------------------------------------------------------------- menu wiring */
  menubar.addEventListener("change", (e) => {
    const t = e.target;
    if (t.name === "mode") { view.mode = t.value; paint(); }
    else if (t.name === "order") { view.order = t.value; paint(); }
    else if (t.name === "file") { view.file = t.value; paint(); }
  });
  menubar.querySelector("[name=search]").addEventListener("input", (e) => {
    view.search = e.target.value;
    paint();
    slot("search-count", menubar).textContent = view.search.trim() ? `${shown().length} matching reports` : "Shows only reports whose output contains the text.";
  });

  menubar.addEventListener("click", async (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    const list = shown();
    if (act === "expand-all") { collapsed.clear(); paint(); root.querySelectorAll(".rv-tree").forEach((t) => setAllOpen(t, true)); menu.close(); }
    else if (act === "collapse-all") { list.forEach((en) => collapsed.add(en.id)); paint(); menu.close(); }
    else if (act === "reset-filters") resetFilters();
    else if (act === "rerun-all") { menu.close(); await Promise.all(list.map((en) => host.reports.rerun(en.id))); }
    else if (act === "copy-all") { menu.close(); copy(combined(list), `Copied ${list.length} ${list.length === 1 ? "report" : "reports"}`); }
    else if (act === "download-all") { menu.close(); host.download("wedger-reports.txt", combined(list)); }
    else if (act === "clear") {
      menu.close();
      const ok = await host.dialogs.confirm({ title: "Clear all report output?", message: `${host.reports.entries.length} ${host.reports.entries.length === 1 ? "report" : "reports"} will be removed from this list. Your journals aren't affected.`, confirmLabel: "Clear output", danger: true });
      if (ok) { host.reports.clear(); collapsed.clear(); }
    }
  });

  paint();
  const offs = [host.reports.on("changed", paint), host.engine.on("status", paint), host.settings.on("numberGrouping", paint)];
  return { dispose() { offs.forEach((o) => o()); menu.dispose(); } };
}
