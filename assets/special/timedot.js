/* timedot.js — the .timedot viewer (controller for timedot.html / timedot-menu.html).
 *
 * A time-entry register grouped by day, like the journal's transaction register: records only, no dashboards. Reports
 * are on request (Reports menu, js/shell/time-report.js). It draws what the native parser found (js/shell/timedot.js)
 * and turns every action into a pure text mutation applied through the shared TimeSession, so the rendered page and
 * the Raw editor are always the same file. No hledger engine, no financial helpers.
 *
 * The selectable unit is an ENTRY (one posting line with its comment lines). Adding and editing happen in dialogs
 * (assets/dialogs/timedot-entry.*, timedot-day.*); the page itself has no permanent form.
 */
import { h, icon, parseUri } from "../js/shell/core.js";
import { createTimeShell, issuesList } from "../js/shell/time-ui.js";
import { addPosting, movePosting, deletePostings, addDay, editDay, deleteDay, projectsOf } from "../js/shell/timedot.js";
import { formatDuration, formatHours, formatDateLong, todayLocal } from "../js/shell/time-format.js";
import { createSelection } from "../js/shell/time-select.js";
import { dotView, DOT_SORTS, DEFAULT_DOT_SORT, activeFilterCount, dayTotalText } from "../js/shell/time-register.js";
import {
  bindSearch, bindFilters, bindSort, bindReports, paintChips, paintSelection, bindRowSelection, bindSelectionActions, syncRow, shortDate,
} from "../js/shell/time-controls.js";
import { bindShortcutHints } from "../js/shell/keyboard-shortcuts.js";

const NOUN = { one: "entry", many: "entries", Select: "Select entries" };
const entriesWord = (n) => (n === 1 ? "entry" : "entries");
let uid = 0;

export function mount({ root, view, host, menubar }) {
  const id = ++uid;
  const selection = createSelection();
  let shown = [];                                                  // the entries the list shows right now, in display order
  let dayById = new Map();
  let busy = false, pendingExit = false;

  const bar = menubar;
  const $s = (n) => root.querySelector(`[data-slot="${n}"]`);
  const $b = (sel) => bar.querySelector(sel);
  const weekStart = () => (host.settings.get("weekStart") === "sunday" ? "sunday" : "monday");
  const fileName = () => parseUri(view.uri).path;

  /* The controls exist before the shell so draw() can always read them; they reach the shell lazily. */
  const lazyMenu = { close: (o) => shell.menu.close(o) };
  const search = bindSearch(bar, { menu: lazyMenu, onChange: () => shell.renderNow() });
  const filter = bindFilters(bar, { fields: ["from", "to", "account", "project"], onChange: () => shell.renderNow() });
  const sorter = bindSort(bar, { sorts: DOT_SORTS, def: DEFAULT_DOT_SORT, onChange: () => shell.renderNow() });
  const offHints = bindShortcutHints(bar);

  const shell = createTimeShell({
    root, view, host, kind: "timedot", menubar, render: draw,
    onMenuOpen: (m) => { if (m === "search") search.renderRecent(); },
  });
  const { session } = shell;
  bindReports(bar, { kind: "timedot", menu: shell.menu, host, getText: () => session.text, getName: fileName, weekStart });

  const accountDatalist = h("datalist", { id: `td-accounts-${id}` });
  filter.form.elements.account.setAttribute("list", accountDatalist.id);
  filter.form.elements.account.after(accountDatalist);

  /* ============================================================== drawing */
  function draw(model) {
    selection.bind(model.text);                                    // a different text may put other entries behind the same ids
    if (pendingExit) { selection.setMode(false); pendingExit = false; }
    selection.prune(new Set(model.postings.map((p) => p.id)));
    dayById = new Map(model.days.map((d) => [d.id, d]));
    const v = dotView(model, { filters: filter.values, compiled: search.compiled, query: search.query, sort: sorter.value });
    shown = v.rows;

    syncMenus(model, v);
    $s("issues").replaceChildren(...(model.counts.error + model.counts.warning ? [issuesList(model, { onGo: shell.gotoLine })] : []));
    const notes = [...v.issues];
    $s("notice").hidden = !notes.length;
    $s("notice").replaceChildren(...notes.map((n) => h("div", { class: "tv-banner tv-banner--warn", role: "status" }, h("span", {}, n))));
    paintList(model, v);
    paintSelectionUI();
  }

  function paintList(model, v) {
    const list = $s("list"), empty = $s("empty"), total = model.postings.length;
    list.classList.toggle("tv-register--grouped", v.grouped);
    $s("list-meta").textContent = !total ? "" : v.rows.length === total ? `${total} ${entriesWord(total)}` : `${v.rows.length} of ${total} entries`;

    const nothing = v.grouped ? !v.days.length : !v.rows.length;
    if (nothing) {
      list.replaceChildren();
      const none = model.days.length === 0 && total === 0;
      empty.hidden = false;
      empty.replaceChildren(
        h("p", {}, none ? "No entries in this file yet." : v.invalidSearch ? "That search pattern isn't valid." : "No entries match the current filters or search."),
        none
          ? h("div", { class: "tv-empty__actions" }, h("button", { class: "btn btn--primary", type: "button", onclick: () => addEntryDialog() }, "Add entry…"), h("button", { class: "btn", type: "button", onclick: () => addDayDialog() }, "Add day…"))
          : h("div", { class: "tv-empty__actions" }, h("button", { class: "btn", type: "button", onclick: resetAll }, "Reset filters and search")));
    } else {
      empty.hidden = true;
      list.replaceChildren(...(v.grouped ? v.days.map(dayBlock) : v.rows.map((p) => entryRow(p, { showDate: true }))));
    }
    paintChipsRow();
  }

  function dayBlock(day) {
    const label = day.date ? formatDateLong(day.date) : `Unreadable date: ${day.dateText}`;
    const desc = day.groups.map((g) => g.description).filter(Boolean).join(" · ");
    const total = dayTotalText(day);
    return h("section", { class: "tv-day", "aria-label": label },
      h("div", { class: "tv-day__head" },
        h("h3", { class: "tv-day__date" }, label),
        day.valid ? null : h("span", { class: "pill pill--error tv-pill" }, "Problem"),
        desc ? h("span", { class: "tv-day__desc", title: desc }, desc) : null,
        h("span", { class: "tv-day__spacer" }),
        total ? h("span", { class: "tv-day__total", title: "Time in this day's entries shown below" }, total) : null,
        h("span", { class: "tv-day__tools" },
          day.date ? h("button", { class: "icon-btn", type: "button", title: "Add an entry to this day", "aria-label": `Add an entry to ${label}`, onclick: () => addEntryDialog(day.date) }, icon("plus")) : null,
          h("button", { class: "icon-btn", type: "button", title: "Day actions", "aria-label": `Actions for ${label}`, "aria-haspopup": "menu", onclick: (e) => dayMenu(e.currentTarget, day) }, icon("dots")))),
      ...(day.postings.length ? day.postings.map((p) => entryRow(p, { showDate: false })) : [h("p", { class: "tv-day__empty" }, "No entries yet.")]));
  }

  function entryRow(p, { showDate }) {
    const day = dayById.get(p.dayId);
    const bad = !p.valid || !day?.valid;
    const selected = selection.has(p.id);
    const full = `${p.account}, ${p.raw || "no amount"}, ${bad ? "problem" : formatDuration(p.seconds)}${day?.date ? `, ${formatDateLong(day.date)}` : ""}`;
    return h("article", { class: `tv-row tv-row--dot${bad ? " is-problem" : ""}${selected ? " is-selected" : ""}`, "data-id": p.id, "aria-label": full },
      h("label", { class: "tv-row__select", title: `Select ${p.account}` }, h("input", { type: "checkbox", checked: selected, "aria-label": `Select ${full}` })),
      h("div", { class: "tv-row__main" },
        h("div", { class: "tv-row__head" },
          h("span", { class: "tv-row__acct", title: p.account }, p.account),
          bad ? h("span", { class: "pill pill--error tv-pill" }, "Problem") : null,
          showDate && day?.date ? h("span", { class: "tv-row__where" }, shortDate(day.date)) : null),
        p.types.length ? h("div", { class: "tv-types", "aria-label": "Time by type" }, ...p.types.map((t) => h("span", { class: "tv-type" }, h("b", {}, t.type), formatDuration(t.seconds)))) : null,
        p.comment ? h("div", { class: "tv-row__comment" }, p.comment.split("\n")[0]) : null),
      h("div", { class: "tv-row__note" }, p.raw ? h("span", { class: "tv-notation", title: "As written in the file" }, p.raw) : h("span", { class: "tv-row__sub" }, "no amount")),
      h("div", { class: "tv-row__amount" },
        h("span", { class: "tv-dur" }, bad ? "—" : p.seconds.isZero() ? "0m" : formatDuration(p.seconds)),
        h("span", { class: "tv-row__sub" }, bad ? (p.valid ? "unreadable date" : "unreadable amount") : `${formatHours(p.seconds)} h`)),
      h("div", { class: "tv-row__actions" },
        h("button", { class: "icon-btn", type: "button", title: "Edit entry", "aria-label": `Edit ${full}`, onclick: () => editEntryDialog(p) }, icon("edit")),
        h("button", { class: "icon-btn", type: "button", title: "Show in Raw view", "aria-label": `Show ${p.account} in Raw view`, onclick: () => shell.gotoLine(p.line) }, icon("file")),
        h("button", { class: "icon-btn icon-btn--danger", type: "button", title: "Delete entry", "aria-label": `Delete ${full}`, onclick: () => removeEntry(p) }, icon("trash"))));
  }

  /* ----- what is narrowing the list ----- */
  function paintChipsRow() {
    const f = filter.values, items = [];
    const clearField = (k) => () => { filter.values[k] = ""; filter.sync(); shell.renderNow(); };
    if (f.from) items.push(["From", f.from, "Remove the From date", clearField("from")]);
    if (f.to) items.push(["To", f.to, "Remove the To date", clearField("to")]);
    if (f.account) items.push(["Account", f.account, "Remove the account filter", clearField("account")]);
    if (f.project) items.push(["Project", f.project, "Remove the project filter", clearField("project")]);
    if (search.query) items.push(["Search", search.query, "Clear the search", () => { search.clear(); shell.renderNow(); }]);
    if (sorter.value !== DEFAULT_DOT_SORT) items.push(["Sort", DOT_SORTS[sorter.value].label, "Back to the default sort", () => { sorter.reset(); shell.renderNow(); }]);
    paintChips($s("chips"), items, resetAll);
  }
  function resetAll() { filter.clear(); search.clear(); sorter.reset(); shell.renderNow(); }

  /* ----- menus ----- */
  function syncMenus(model, v) {
    const projects = projectsOf(model);
    const sel = filter.form.elements.project;
    if (filter.values.project && !projects.includes(filter.values.project)) filter.values.project = "";
    sel.replaceChildren(h("option", { value: "" }, "All projects"), ...projects.map((p) => h("option", { value: p }, p)));
    sel.value = filter.values.project;
    accountDatalist.replaceChildren(...model.accounts.map((a) => h("option", { value: a })));
    const n = activeFilterCount(filter.values);
    const badge = $b("[data-slot=filter-count]");
    badge.hidden = !n; badge.textContent = String(n);
    $b("[data-form=filters] [data-act=clear-filters]").disabled = !n;
    const err = $b("[data-slot=filter-error]");
    err.hidden = !v.issues.length; err.textContent = v.issues.join(" ");
    const total = model.postings.length;
    search.paintCount(`${v.rows.length} of ${total} ${total === 1 ? "entry matches" : "entries match"}`);
  }

  /* ============================================================ selection */
  function paintSelectionUI() {
    paintSelection({ bar, root, selection, shown, noun: NOUN, ready: shell.mode === "rendered", busy });
    $s("list").classList.toggle("is-selecting", selection.mode);
  }
  function toggleMode() { selection.setMode(!selection.mode); shell.renderNow(); }
  function selectAllVisible() {
    if (!selection.mode) selection.setMode(true);
    selection.selectAll(shown);
    shell.renderNow();
  }
  function clearSelection() {
    for (const rid of selection.list()) syncRow($s("list"), rid, false);
    selection.clear();
    paintSelectionUI();
  }
  function exitSelect() { selection.setMode(false); shell.renderNow(); }

  async function deleteSelected() {
    if (busy) return;
    const targets = selection.visible(shown);                      // only what the list shows: hidden entries are never touched
    if (!targets.length) { host.notify("Nothing is selected in the current list.", "info"); return; }
    if (session.text !== selection.boundText) { host.notify("The file changed since you selected. Select again.", "error"); return; }
    const hidden = selection.hiddenCount(shown);
    const preview = targets.slice(0, 4).map((p) => `• ${p.account}${p.raw ? ` (${p.raw})` : ""}${dayById.get(p.dayId)?.date ? ` on ${shortDate(dayById.get(p.dayId).date)}` : ""}`).join("\n");
    const ok = await host.dialogs.confirm({
      title: `Delete ${targets.length} ${entriesWord(targets.length)}?`, confirmLabel: `Delete ${targets.length}`, danger: true,
      message: `${preview}${targets.length > 4 ? `\n…and ${targets.length - 4} more` : ""}\n\nEach entry is removed with the comment lines under it. Day headings, other comments and the other entries stay.${hidden ? `\n\n${hidden} other selected ${entriesWord(hidden)} ${hidden === 1 ? "is" : "are"} hidden by filters and will NOT be deleted.` : ""}`,
    });
    if (!ok) return;
    if (session.text !== selection.boundText) { host.notify("The file changed while you were deciding. Nothing was deleted; select again.", "error"); return; }
    busy = true; pendingExit = true; paintSelectionUI();
    const res = session.apply((t) => deletePostings(t, targets.map((p) => p.id)));        // ONE edit: one reparse, one refresh
    busy = false;
    if (!res.ok) { pendingExit = false; paintSelectionUI(); host.notify(res.error, "error"); return; }
    session.save();                                                // a deliberate deletion is saved at once, like the journal's
    host.notify(`${res.deleted} ${entriesWord(res.deleted)} deleted`, "ok");
  }

  bindRowSelection({ list: $s("list"), selection, find: (rid) => shown.find((p) => p.id === rid), shown: () => shown, paint: paintSelectionUI });
  bindSelectionActions({ root, bar, menu: shell.menu, actions: { toggle: toggleMode, selectAll: selectAllVisible, clear: clearSelection, deleteSelected, exit: exitSelect } });

  /* ============================================================== actions */
  const accounts = () => session.model.accounts;
  const attempt = (fn) => { const r = session.apply(fn); return r.ok ? null : r.error; };       // the refusal text (or null) goes back into the dialog

  function addEntryDialog(date = todayLocal()) {
    return host.dialogs.openTemplate("dialogs/timedot-entry.html", {
      controller: "dialogs/timedot-entry.js", label: "Add entry",
      params: {
        mode: "add", date, accounts: accounts(),
        submit: async (v) => {
          const err = attempt((t) => addPosting(t, { date: v.date, account: v.account, quantityText: v.quantityText, comment: v.comment }));
          if (!err) host.notify(`Added ${v.account} on ${v.date}`, "ok");
          return err;
        },
      },
    });
  }

  function editEntryDialog(p) {
    const day = dayById.get(p.dayId);
    return host.dialogs.openTemplate("dialogs/timedot-entry.html", {
      controller: "dialogs/timedot-entry.js", label: "Edit entry",
      params: {
        mode: "edit", posting: { ...p, date: day?.date ?? null }, accounts: accounts(),
        submit: async (v) => {
          // Only what changed is rewritten; the notation stays exactly as written unless it was deliberately changed.
          const patch = {};
          if (v.account !== p.account) patch.account = v.account;
          if (v.quantityText !== p.raw) patch.quantityText = v.quantityText;
          if (v.comment !== p.comment.split("\n")[0]) patch.comment = v.comment;
          const err = attempt((t) => movePosting(t, p.id, { date: v.date, ...patch }));          // moves it when the date changed
          if (!err) host.notify("Entry updated", "ok");
          return err;
        },
      },
    });
  }

  async function removeEntry(p) {
    const day = dayById.get(p.dayId);
    const ok = await host.dialogs.confirm({
      title: "Delete this entry?", confirmLabel: "Delete entry", danger: true,
      message: `“${p.account}”${p.raw ? ` (${p.raw})` : ""} will be removed from ${day?.date ? formatDateLong(day.date) : "the file"}, together with any comment lines under it. Nothing else changes.`,
    });
    if (!ok) return;
    const res = session.apply((t) => deletePostings(t, [p.id]));
    if (!res.ok) { host.notify(res.error, "error"); return; }
    session.save();
    host.notify("Entry deleted", "ok");
  }

  function addDayDialog(date = todayLocal()) {
    return host.dialogs.openTemplate("dialogs/timedot-day.html", {
      controller: "dialogs/timedot-day.js", label: "Add day",
      params: {
        mode: "add", date,
        submit: async (v) => {
          const err = attempt((t) => addDay(t, { date: v.date, description: v.description }));
          if (!err) host.notify(`Day ${v.date} added`, "ok");
          return err;
        },
        afterAdd: (d) => addEntryDialog(d),
      },
    });
  }

  function editDayDialog(g) {
    return host.dialogs.openTemplate("dialogs/timedot-day.html", {
      controller: "dialogs/timedot-day.js", label: "Edit day",
      params: {
        mode: "edit", day: g,
        submit: async (v) => {
          const err = attempt((t) => editDay(t, g.id, { date: v.date, description: v.description }));
          if (!err) host.notify("Day updated", "ok");
          return err;
        },
      },
    });
  }

  async function removeDay(g) {
    const n = g.postings.length;
    const ok = await host.dialogs.confirm({
      title: "Delete this day?", confirmLabel: "Delete day", danger: true,
      message: `The heading for ${g.dateText} and its ${n} ${entriesWord(n)} (with their comments) will be removed. Blank lines and comments between days stay.`,
    });
    if (!ok) return;
    const res = session.apply((t) => deleteDay(t, g.id));
    if (!res.ok) { host.notify(res.error, "error"); return; }
    session.save();
    host.notify("Day deleted", "ok");
  }

  function dayMenu(anchor, day) {
    const many = day.groups.length > 1;
    const tag = (g) => (many ? ` (line ${g.line})` : "");
    host.dialogs.menu(anchor, [
      ...day.groups.map((g) => ({ label: `Edit day${tag(g)}…`, onSelect: () => editDayDialog(g) })),
      { label: "Show in Raw view", onSelect: () => shell.gotoLine(day.groups[0].line) },
      { separator: true },
      ...day.groups.map((g) => ({ label: `Delete day${tag(g)}…`, danger: true, onSelect: () => removeDay(g) })),
    ]);
  }

  /* ============================================================ menu wiring */
  bar.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;
    if (act === "add-entry") { shell.menu.close(); addEntryDialog(); }
    else if (act === "add-day") { shell.menu.close(); addDayDialog(); }
    else if (act === "clear-filters") { filter.clear(); shell.renderNow(); }
  });

  const help = $b("[data-slot=search-help]");
  const paintSearchHelp = (rendered) => {
    search.setEnabled(rendered);
    help.textContent = rendered ? "Matches account, comments, original notation, day descriptions, dates and letter types." : "In Raw view, press Ctrl+F (⌘F) in the editor to search the text.";
  };
  shell.on("mode", (m) => {
    const rendered = m === "rendered";
    paintSearchHelp(rendered);
    if (!rendered) selection.setMode(false);
    paintSelectionUI();
  });
  paintSearchHelp(shell.mode === "rendered");

  return {
    onShow() { shell.onShow(); },
    onHide() { shell.onHide(); },
    save: () => shell.save(),
    canFocusSearch: () => shell.mode === "rendered",
    focusSearch() { shell.menu.open("search", { focusFirst: true }); search.input.focus({ preventScroll: true }); search.input.select(); },
    dispose() { search.dispose(); filter.dispose(); offHints?.(); shell.dispose(); },
  };
}
