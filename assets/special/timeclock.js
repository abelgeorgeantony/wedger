/* timeclock.js — the .timeclock viewer (controller for timeclock.html / timeclock-menu.html).
 *
 * A session register, like the journal's transaction register: records only, no dashboards. Reports are on request
 * (Reports menu, js/shell/time-report.js). It draws what the native parser found (js/shell/timeclock.js) and turns every
 * action into a pure text mutation applied through the shared TimeSession, so the rendered page and the Raw editor are
 * always the same file. No hledger engine, no financial helpers.
 *
 * The selectable unit is a SESSION (its clock-in and clock-out together), never a single clock event.
 */
import { h, icon, parseUri } from "../js/shell/core.js";
import { createTimeShell, issuesList } from "../js/shell/time-ui.js";
import {
  clockIn, clockOut, addSession, editSession, deleteEvent, describeEventDeletion, deleteSessions, liveElapsed, projectsOf,
} from "../js/shell/timeclock.js";
import { localNow, formatDuration, formatHours, formatDateLong, shortClock } from "../js/shell/time-format.js";
import { createSelection } from "../js/shell/time-select.js";
import { clockView, groupClockRows, CLOCK_SORTS, DEFAULT_CLOCK_SORT, activeFilterCount } from "../js/shell/time-register.js";
import {
  bindSearch, bindFilters, bindSort, bindReports, paintChips, paintSelection, bindRowSelection, bindSelectionActions, syncRow, shortDate,
} from "../js/shell/time-controls.js";
import { bindShortcutHints } from "../js/shell/keyboard-shortcuts.js";

const NOUN = { one: "session", many: "sessions", Select: "Select sessions" };
const DIALOG = "dialogs/timeclock-session.html", DIALOG_JS = "dialogs/timeclock-session.js";
const secondsOf = (t) => { const [hh, mm, ss = 0] = String(t).split(":").map(Number); return hh * 3600 + mm * 60 + ss; };
let uid = 0;

export function mount({ root, view, host, menubar }) {
  const id = ++uid;
  const selection = createSelection();
  let shown = [];                                                  // the rows the list shows right now, in display order
  let busy = false, pendingExit = false, ticker = null, visible = false;

  const bar = menubar;
  const $s = (n) => root.querySelector(`[data-slot="${n}"]`);
  const $b = (sel) => bar.querySelector(sel);
  const weekStart = () => (host.settings.get("weekStart") === "sunday" ? "sunday" : "monday");
  const fileName = () => parseUri(view.uri).path;

  /* The controls exist before the shell so draw() can always read them; they reach the shell lazily. */
  const lazyMenu = { close: (o) => shell.menu.close(o) };
  const search = bindSearch(bar, { menu: lazyMenu, onChange: () => shell.renderNow() });
  const filter = bindFilters(bar, { fields: ["from", "to", "account", "project", "status"], defaults: { status: "all" }, onChange: () => shell.renderNow() });
  const sorter = bindSort(bar, { sorts: CLOCK_SORTS, def: DEFAULT_CLOCK_SORT, onChange: () => shell.renderNow() });
  const offHints = bindShortcutHints(bar);

  const shell = createTimeShell({
    root, view, host, kind: "timeclock", menubar, render: draw,
    onMenuOpen: (m) => { if (m === "search") search.renderRecent(); },
  });
  const { session } = shell;
  bindReports(bar, { kind: "timeclock", menu: shell.menu, host, getText: () => session.text, getName: fileName, weekStart });

  const accountDatalist = h("datalist", { id: `tc-accounts-${id}` });
  filter.form.elements.account.setAttribute("list", accountDatalist.id);
  filter.form.elements.account.after(accountDatalist);

  /* ============================================================== drawing */
  function draw(model) {
    selection.bind(model.text);                                    // a different text may put other records behind the same ids
    if (pendingExit) { selection.setMode(false); pendingExit = false; }
    selection.prune(new Set(model.sessions.map((s) => s.id)));
    const now = localNow();
    const v = clockView(model, { filters: filter.values, compiled: search.compiled, query: search.query, sort: sorter.value, now });
    shown = v.rows;

    syncMenus(model, v);
    $s("issues").replaceChildren(...(model.counts.error + model.counts.warning ? [issuesList(model, { onGo: shell.gotoLine })] : []));
    paintNotices(model, v);
    paintRunning(model, now);
    paintList(model, v, now);
    paintSelectionUI();
    tick();
  }

  function paintNotices(model, v) {
    const orphans = model.diagnostics.filter((d) => d.code === "unmatched-clock-out").length;
    const notes = [...v.issues];
    if (orphans) notes.push(`${orphans} clock-${orphans === 1 ? "out has" : "outs have"} no matching clock-in, so ${orphans === 1 ? "it isn't" : "they aren't"} listed as a session. Fix ${orphans === 1 ? "it" : "them"} in Raw view.`);
    const box = $s("notice");
    box.hidden = !notes.length;
    box.replaceChildren(...notes.map((n) => h("div", { class: "tv-banner tv-banner--warn", role: "status" }, h("span", {}, n))));
  }

  /* ----- running sessions: always every one of them, whatever the filters say ----- */
  function paintRunning(model, now) {
    const open = model.sessions.filter((s) => s.status === "open").sort((a, b) => a.start.wall - b.start.wall || a.line - b.line);
    const recent = [];
    for (const s of [...model.sessions].sort((a, b) => b.start.wall - a.start.wall)) {
      if (recent.length < 4 && s.account && !recent.includes(s.account) && !open.some((o) => o.account === s.account) && s.status !== "invalid") recent.push(s.account);
    }
    const head = h("div", { class: "tc-running__head" },
      h("h2", { class: "tc-running__title" }, "Running", open.length ? h("span", { class: "tc-running__count" }, String(open.length)) : null),
      h("button", { class: "btn btn--small btn--primary", type: "button", onclick: () => clockInDialog() }, icon("plus"), "Clock in…"));
    const body = open.length
      ? h("ul", { class: "tc-running__list" }, ...open.map((s) => h("li", { class: "tc-run" },
        h("span", { class: "tc-run__dot", "aria-hidden": "true" }),
        h("div", { class: "tc-run__main" },
          h("span", { class: "tc-run__acct", title: s.account }, s.account),
          h("span", { class: "tc-run__meta" }, `since ${s.start.date === now.date ? "" : `${shortDate(s.start.date)} `}${shortClock(s.start.secondsOfDay)}`, s.description ? ` · ${s.description}` : "")),
        h("span", { class: "tc-run__elapsed", title: "Time so far: an estimate, not a recorded duration" },
          h("span", { "data-live-wall": s.start.wall }, formatDuration(liveElapsed(s, now))), h("span", { class: "tc-run__so-far" }, " so far")),
        h("button", { class: "btn btn--small", type: "button", onclick: () => stop(s) }, "Clock out"),
        h("button", { class: "icon-btn", type: "button", title: "More actions", "aria-label": `More actions for ${s.account}`, "aria-haspopup": "menu", onclick: (e) => rowMenu(e.currentTarget, s) }, icon("dots")))))
      : h("p", { class: "tc-running__none" }, "Nothing is running.");
    const again = recent.length
      ? h("div", { class: "tc-running__again" }, h("span", {}, "Start again:"), ...recent.map((a) => h("button", { class: "chip", type: "button", title: `Clock in to ${a} now`, onclick: () => startNow(a) }, a)))
      : null;
    $s("running").replaceChildren(head, body, ...(again ? [again] : []));
  }

  /* ----- the register ----- */
  function paintList(model, v, now) {
    const list = $s("list"), empty = $s("empty"), total = model.sessions.length;
    list.classList.toggle("tv-register--grouped", v.grouped);
    $s("list-meta").textContent = !total ? "" : v.rows.length === total ? `${total} ${total === 1 ? "session" : "sessions"}` : `${v.rows.length} of ${total} sessions`;

    if (!v.rows.length) {
      list.replaceChildren();
      empty.hidden = false;
      empty.replaceChildren(
        h("p", {}, !total ? "No sessions in this file yet." : v.invalidSearch ? "That search pattern isn't valid." : "No sessions match the current filters or search."),
        !total
          ? h("div", { class: "tv-empty__actions" }, h("button", { class: "btn btn--primary", type: "button", onclick: () => clockInDialog() }, "Clock in…"), h("button", { class: "btn", type: "button", onclick: () => addSessionDialog() }, "Add past session…"))
          : h("div", { class: "tv-empty__actions" }, h("button", { class: "btn", type: "button", onclick: resetAll }, "Reset filters and search")));
    } else {
      empty.hidden = true;
      list.replaceChildren(...(v.grouped
        ? groupClockRows(v.rows).map((g) => h("section", { class: "tv-day", "aria-label": formatDateLong(g.date) },
          h("div", { class: "tv-day__head" }, h("h3", { class: "tv-day__date" }, formatDateLong(g.date)), h("span", { class: "tv-day__count" }, `${g.items.length} ${g.items.length === 1 ? "session" : "sessions"}`)),
          ...g.items.map((s) => sessionRow(s, now))))
        : v.rows.map((s) => sessionRow(s, now))));
    }
    paintChipsRow();
  }

  function sessionRow(s, now) {
    const open = s.status === "open", bad = s.status === "invalid", crosses = !!s.end && s.end.date !== s.start.date;
    const status = open ? h("span", { class: "pill pill--ok tv-pill" }, h("span", { class: "tv-pill__dot", "aria-hidden": "true" }), "Running")
      : bad ? h("span", { class: "pill pill--error tv-pill" }, "Problem")
      : s.problems.length ? h("span", { class: "pill pill--warn tv-pill", title: s.problems.join(", ") }, "Check") : null;
    const range = open ? `${shortClock(s.start.secondsOfDay)} – now` : s.end ? `${shortClock(s.start.secondsOfDay)} – ${shortClock(s.end.secondsOfDay)}` : shortClock(s.start.secondsOfDay);
    const full = `${s.account || "No account"}, ${formatDateLong(s.start.date)}, ${range}${crosses ? `, ends ${formatDateLong(s.end.date)}` : ""}, ${open ? "running" : bad ? "problem" : formatDuration(s.durationSeconds)}`;
    const selected = selection.has(s.id);
    return h("article", { class: `tv-row tv-row--clock${open ? " is-open" : ""}${bad ? " is-problem" : ""}${selected ? " is-selected" : ""}`, "data-id": s.id, "aria-label": full },
      h("label", { class: "tv-row__select", title: `Select ${s.account}` },
        h("input", { type: "checkbox", checked: selected, "aria-label": `Select ${full}` })),
      h("time", { class: "tv-row__date", datetime: s.start.date, "aria-hidden": "true" },
        h("span", { class: "tv-row__day" }, String(Number(s.start.date.slice(8, 10)))), h("span", { class: "tv-row__wd" }, shortDate(s.start.date).slice(0, 3))),
      h("div", { class: "tv-row__main" },
        h("div", { class: "tv-row__head" }, h("span", { class: "tv-row__acct", title: s.account }, s.account || "(no account)"), status),
        s.description ? h("div", { class: "tv-row__desc", title: s.description }, s.description) : null,
        s.comment ? h("div", { class: "tv-row__comment" }, s.comment.split("\n")[0]) : null),
      h("div", { class: "tv-row__when" },
        h("span", { class: "tv-row__range" }, range),
        crosses ? h("span", { class: "tv-row__span" }, `${shortDate(s.start.date)} → ${shortDate(s.end.date)}`) : null),
      h("div", { class: "tv-row__amount" },
        open ? h("span", { class: "tv-dur", "data-live-wall": s.start.wall, title: "Time so far: an estimate, not a recorded duration" }, formatDuration(liveElapsed(s, now)))
          : h("span", { class: "tv-dur" }, bad ? "—" : formatDuration(s.durationSeconds)),
        h("span", { class: "tv-row__sub" }, open ? "so far (estimate)" : bad ? "no valid duration" : `${formatHours(s.durationSeconds)} h`)),
      h("div", { class: "tv-row__actions" },
        h("button", { class: "icon-btn", type: "button", title: "Edit session", "aria-label": `Edit ${full}`, onclick: () => editDialog(s) }, icon("edit")),
        h("button", { class: "icon-btn", type: "button", title: "More actions", "aria-label": `More actions for ${full}`, "aria-haspopup": "menu", onclick: (e) => rowMenu(e.currentTarget, s) }, icon("dots")),
        h("button", { class: "icon-btn icon-btn--danger", type: "button", title: "Delete session", "aria-label": `Delete ${full}`, onclick: () => removeSession(s) }, icon("trash"))));
  }

  /* ----- what is narrowing the list ----- */
  function paintChipsRow() {
    const f = filter.values, items = [];
    const clearField = (k, dflt = "") => () => { filter.values[k] = dflt; filter.sync(); shell.renderNow(); };
    if (f.from) items.push(["From", f.from, "Remove the From date", clearField("from")]);
    if (f.to) items.push(["To", f.to, "Remove the To date", clearField("to")]);
    if (f.account) items.push(["Account", f.account, "Remove the account filter", clearField("account")]);
    if (f.project) items.push(["Project", f.project, "Remove the project filter", clearField("project")]);
    if (f.status && f.status !== "all") items.push(["Status", f.status, "Remove the status filter", clearField("status", "all")]);
    if (search.query) items.push(["Search", search.query, "Clear the search", () => { search.clear(); shell.renderNow(); }]);
    if (sorter.value !== DEFAULT_CLOCK_SORT) items.push(["Sort", CLOCK_SORTS[sorter.value].label, "Back to the default sort", () => { sorter.reset(); shell.renderNow(); }]);
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
    const n = activeFilterCount(filter.values, { status: true });
    const badge = $b("[data-slot=filter-count]");
    badge.hidden = !n; badge.textContent = String(n);
    $b("[data-form=filters] [data-act=clear-filters]").disabled = !n;
    const err = $b("[data-slot=filter-error]");
    err.hidden = !v.issues.length; err.textContent = v.issues.join(" ");
    const total = model.sessions.length;
    search.paintCount(`${v.rows.length} of ${total} ${total === 1 ? "session matches" : "sessions match"}`);
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
    const targets = selection.visible(shown);                      // only what the list shows: hidden records are never touched
    if (!targets.length) { host.notify("Nothing is selected in the current list.", "info"); return; }
    if (session.text !== selection.boundText) { host.notify("The file changed since you selected. Select again.", "error"); return; }
    const hidden = selection.hiddenCount(shown);
    const preview = targets.slice(0, 4).map((s) => `• ${s.account || "(no account)"} on ${shortDate(s.start.date)} ${shortClock(s.start.secondsOfDay)}${s.end ? ` – ${shortClock(s.end.secondsOfDay)}` : " (running)"}`).join("\n");
    const ok = await host.dialogs.confirm({
      title: `Delete ${targets.length} ${targets.length === 1 ? "session" : "sessions"}?`, confirmLabel: `Delete ${targets.length}`, danger: true,
      message: `${preview}${targets.length > 4 ? `\n…and ${targets.length - 4} more` : ""}\n\nEach session's clock-in and clock-out are removed together; nothing else in the file changes.${hidden ? `\n\n${hidden} other selected ${hidden === 1 ? "session is" : "sessions are"} hidden by filters and will NOT be deleted.` : ""}`,
    });
    if (!ok) return;
    if (session.text !== selection.boundText) { host.notify("The file changed while you were deciding. Nothing was deleted; select again.", "error"); return; }
    busy = true; pendingExit = true; paintSelectionUI();
    const res = session.apply((t) => deleteSessions(t, targets.map((s) => s.id)));      // ONE edit: one reparse, one refresh
    busy = false;
    if (!res.ok) { pendingExit = false; paintSelectionUI(); host.notify(res.error, "error"); return; }
    session.save();                                                // a deliberate deletion is saved at once, like the journal's
    host.notify(`${res.deleted} ${res.deleted === 1 ? "session" : "sessions"} deleted`, "ok");
  }

  bindRowSelection({ list: $s("list"), selection, find: (rid) => shown.find((s) => s.id === rid), shown: () => shown, paint: paintSelectionUI });
  bindSelectionActions({ root, bar, menu: shell.menu, actions: { toggle: toggleMode, selectAll: selectAllVisible, clear: clearSelection, deleteSelected, exit: exitSelect } });

  /* ============================================================== actions */
  const accounts = () => session.model.accounts;
  const attempt = (fn) => { const r = session.apply(fn); return r.ok ? null : r.error; };       // the refusal text (or null) goes back into the dialog

  function startNow(account) {
    const n = localNow();
    const r = session.apply((t) => clockIn(t, { date: n.date, time: n.time, account }));
    host.notify(r.ok ? `Clocked in to ${account}.` : r.error, r.ok ? "ok" : "error");
  }

  function stop(s) {
    const n = localNow();
    const r = session.apply((t) => clockOut(t, s.id, { date: n.date, time: n.time }));                 // exactly THIS session, by id
    if (!r.ok) { host.notify(r.error, "error"); return; }
    const done = r.model.sessions.find((x) => x.inEvent.line === s.line);
    host.notify(`Clocked out of ${s.account}${done?.durationSeconds != null ? ` — ${formatDuration(done.durationSeconds)}` : ""}.`, "ok");
  }

  function clockInDialog() {
    return host.dialogs.openTemplate(DIALOG, {
      controller: DIALOG_JS, label: "Clock in",
      params: {
        mode: "in", accounts: accounts(),
        submit: async (v) => {
          const err = attempt((t) => clockIn(t, { date: v.start.date, time: v.start.time, account: v.account, description: v.description }));
          if (!err) host.notify(`Clocked in to ${v.account}.`, "ok");
          return err;
        },
      },
    });
  }

  function addSessionDialog() {
    return host.dialogs.openTemplate(DIALOG, {
      controller: DIALOG_JS, label: "Add a past session",
      params: {
        mode: "add", accounts: accounts(),
        submit: async (v) => {
          const err = attempt((t) => addSession(t, { account: v.account, description: v.description, start: v.start, end: v.end }));
          if (!err) host.notify("Session added", "ok");
          return err;
        },
      },
    });
  }

  function editDialog(s) {
    return host.dialogs.openTemplate(DIALOG, {
      controller: DIALOG_JS, label: "Edit session",
      params: {
        mode: "edit", session: s, accounts: accounts(), openRaw: (line) => shell.gotoLine(line),
        submit: async (v) => {
          // Only what changed is sent. A running session has no end, so editing it can never complete it.
          const patch = {};
          if (v.account !== s.account) patch.account = v.account;
          if (v.description !== s.description) patch.description = v.description;
          if (v.start.date !== s.start.date || secondsOf(v.start.time) !== s.start.secondsOfDay) patch.start = v.start;
          if (v.end && s.end && (v.end.date !== s.end.date || secondsOf(v.end.time) !== s.end.secondsOfDay)) patch.end = v.end;
          if (!Object.keys(patch).length) return null;
          const err = attempt((t) => editSession(t, s.id, patch));
          if (!err) host.notify("Session updated", "ok");
          return err;
        },
      },
    });
  }

  function clockOutDialog(s) {
    return host.dialogs.openTemplate("dialogs/timeclock-clock-out.html", {
      controller: "dialogs/timeclock-clock-out.js", label: "Clock out",
      params: {
        session: s,
        submit: async (v) => {
          const err = attempt((t) => clockOut(t, s.id, { date: v.date, time: v.time, comment: v.comment }));
          if (!err) host.notify(`Clocked out of ${s.account}.`, "ok");
          return err;
        },
      },
    });
  }

  async function removeSession(s) {
    const ok = await host.dialogs.confirm({
      title: "Delete this session?", confirmLabel: "Delete session", danger: true,
      message: `“${s.account}” on ${shortDate(s.start.date)} ${shortClock(s.start.secondsOfDay)}${s.end ? ` – ${shortClock(s.end.secondsOfDay)}` : ""} will be removed from the file: its clock-in${s.outEvent ? " and its clock-out" : ""} together. Nothing else changes.`,
    });
    if (!ok) return;
    const res = session.apply((t) => deleteSessions(t, [s.id]));
    if (!res.ok) { host.notify(res.error, "error"); return; }
    session.save();
    host.notify("Session deleted", "ok");
  }

  async function removeEvent(ev, what) {
    const ok = await host.dialogs.confirm({ title: `Delete only the ${what}?`, message: describeEventDeletion(session.model, ev.id) ?? "", confirmLabel: `Delete ${what}`, danger: true });
    if (ok) shell.run((t) => deleteEvent(t, ev.id));
  }

  function rowMenu(anchor, s) {
    host.dialogs.menu(anchor, [
      { label: "Edit…", onSelect: () => editDialog(s) },
      ...(s.status === "open" ? [{ label: "Clock out now", onSelect: () => stop(s) }, { label: "Clock out at a different time…", onSelect: () => clockOutDialog(s) }] : []),
      { label: "Show in Raw view", onSelect: () => shell.gotoLine(s.line) },
      { separator: true },
      ...(s.outEvent ? [{ label: "Delete only the clock-out (reopens it)…", danger: true, onSelect: () => removeEvent(s.outEvent, "clock-out") }] : []),
      { label: s.outEvent ? "Delete only the clock-in…" : "Delete…", danger: true, onSelect: () => (s.outEvent ? removeEvent(s.inEvent, "clock-in") : removeSession(s)) },
    ]);
  }

  /* ============================================================ menu wiring */
  bar.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;
    if (act === "clock-in") { shell.menu.close(); clockInDialog(); }
    else if (act === "add-session") { shell.menu.close(); addSessionDialog(); }
    else if (act === "clear-filters") { filter.clear(); shell.renderNow(); }
  });

  const help = $b("[data-slot=search-help]");
  const paintSearchHelp = (rendered) => {
    search.setEnabled(rendered);
    help.textContent = rendered ? "Matches account, description, comments, tags, dates, times and status." : "In Raw view, press Ctrl+F (⌘F) in the editor to search the text.";
  };
  shell.on("mode", (m) => {
    const rendered = m === "rendered";
    paintSearchHelp(rendered);
    if (!rendered) { selection.setMode(false); stopTicker(); } else startTicker();
    paintSelectionUI();
  });
  paintSearchHelp(shell.mode === "rendered");

  /* ============================================================ live clock */
  function tick() {
    if (!visible || shell.mode !== "rendered") return;
    const n = localNow();
    for (const el of root.querySelectorAll("[data-live-wall]")) el.textContent = formatDuration(Math.max(0, n.wall - Number(el.dataset.liveWall)));
  }
  function startTicker() { if (!ticker && visible) ticker = setInterval(tick, 1000); }
  function stopTicker() { if (ticker) { clearInterval(ticker); ticker = null; } }

  return {
    onShow() { visible = true; shell.onShow(); startTicker(); tick(); },
    onHide() { visible = false; stopTicker(); shell.onHide(); },
    save: () => shell.save(),
    canFocusSearch: () => shell.mode === "rendered",
    focusSearch() { shell.menu.open("search", { focusFirst: true }); search.input.focus({ preventScroll: true }); search.input.select(); },
    dispose() { stopTicker(); search.dispose(); filter.dispose(); offHints?.(); shell.dispose(); },
  };
}
