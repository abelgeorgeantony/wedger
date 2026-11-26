/* time-ui.js — the parts of the .timeclock and .timedot viewers that are the same for both.
 *
 *   createTimeShell   Raw + Rendered panes over ONE TimeSession: CodeMirror editor, view switching, status bar,
 *                     issues list, save / auto-save / dirty, cleanup. A viewer only draws its own page.
 *   issuesList        the diagnostics list (each row jumps to its line in Raw view).
 *
 * Nothing here knows what a session or a posting is; the parsers and mutations live in timeclock.js / timedot.js.
 * Dialogs are templates under assets/dialogs/ (opened with host.dialogs.openTemplate); shared dialog helpers are in
 * time-dialog.js, and the shared menu/list controls are in time-controls.js.
 */
import { Emitter, h, icon, parseUri, debounce } from "./core.js";
import { initMenubar } from "./menubar.js";
import { TimeSession } from "./time-session.js";
import { createBoundEditor } from "../codemirror/bundle.js";

const SEV_LABEL = { error: "Error", warning: "Warning", info: "Note" };
/**
 * A diagnostics list. Each row names the line and jumps to it in Raw view. Errors and warnings first; notes only on request.
 * `summary` (a <details>) is for the rendered page; without it the bare list is returned (the Raw view's drawer).
 */
export function issuesList(model, { onGo, showInfo = false, limit = 100, summary = true, open = false } = {}) {
  const all = model.diagnostics.filter((d) => showInfo || d.severity !== "info");
  const c = model.counts;
  const items = all.slice(0, limit).map((d) => h("li", { class: "tv-issue" },
    h("span", { class: `tv-issue__sev tv-issue__sev--${d.severity}` }, SEV_LABEL[d.severity]),
    h("span", { class: "tv-issue__msg" }, d.message),
    h("button", { class: "tv-issue__go", type: "button", title: "Show this line in the Raw view", onclick: () => onGo?.(d.line) }, `Line ${d.line}`)));
  const list = h("ul", { class: "tv-issues__list" }, ...items);
  if (all.length > limit) list.append(h("li", { class: "tv-issues__more tv-note" }, `…and ${all.length - limit} more. Fix the first ones and the list shortens.`));
  if (!summary) return all.length ? list : h("p", { class: "tv-note", style: "padding:.4rem .2rem" }, "No problems found.");
  const bits = [c.error && `${c.error} ${c.error === 1 ? "error" : "errors"}`, c.warning && `${c.warning} ${c.warning === 1 ? "warning" : "warnings"}`].filter(Boolean);
  return h("details", { class: "tv-issues", open: open || c.error > 0 ? "" : null },
    h("summary", {}, icon("warning"), `${bits.join(" and ")} in this file`,
      h("span", { class: "tv-note", style: "font-weight:400" }, "Click a line number to fix it in Raw view.")),
    list);
}

/* ================================================================== the shell */
const SYNC_TEXT = { local: "Saved on this device", pending: "Syncing to Drive…", synced: "Synced to Drive", error: "Drive sync failed" };

/**
 * @param {{ root: HTMLElement, view: object, host: object, kind: "timeclock"|"timedot", menubar: HTMLElement,
 *   render: (model: object, shell: object) => void, onMenuOpen?: (id: string, panel: HTMLElement) => void }} o
 */
export function createTimeShell({ root, view, host, kind, menubar, render, onMenuOpen }) {
  const shell = new Emitter();
  const $ = (sel, scope = root) => scope.querySelector(sel);
  const slot = (n, scope = root) => scope.querySelector(`[data-slot="${n}"]`);
  const name = () => parseUri(view.uri).path;

  const session = new TimeSession({ files: host.files, settings: host.settings, name, setDirty: (d) => view.setDirty(d), notify: host.notify });
  const menu = initMenubar(menubar, { onOpen: (id, panel) => onMenuOpen?.(id, panel) });
  const rendered = $("[data-pane=rendered]"), rawPane = $("[data-pane=raw]");
  const page = slot("page");
  const content = slot("content"), renderError = slot("render-error");     // templates that have them keep their skeleton on a failed draw
  let mode = host.settings.get("defaultView") === "raw" ? "raw" : "rendered";
  let stale = true, disposed = false, issuesOpen = false;

  /* ----- raw editor: the textarea is the value bridge, CodeMirror the editor; undo survives rendered edits ----- */
  const ta = slot("text");
  const editor = createBoundEditor(ta, {
    dispatchInput: true, resetHistoryOnSet: false, lineWrapping: false, language: kind,
    lineNumbers: !!host.settings.get("lineNumbers"), onSelection: () => updatePos(),
  });
  ta.value = session.text;
  ta.addEventListener("input", () => session.setText(ta.value, "raw"));
  editor.wrapper.addEventListener("focusout", () => session.flush());

  function updatePos() {
    const el = slot("status-pos");
    if (mode !== "raw") { el.textContent = ""; return; }
    const { line, col } = editor.getCursor();
    el.textContent = `Ln ${line}, Col ${col}`;
  }

  /* ----- rendering ----- */
  function renderNow() {
    if (disposed) return;
    if (mode !== "rendered") { stale = true; return; }
    stale = false;
    const keep = rendered.scrollTop;
    try {
      render(session.model, shell);
      if (renderError) { renderError.hidden = true; if (content) content.hidden = false; }
    } catch (err) {
      console.error(`Couldn't render ${name()}`, err);
      const banner = h("div", { class: "tv-banner tv-banner--error", role: "alert" },
        h("strong", {}, "This file couldn't be drawn."), h("span", {}, `${err?.message ?? err} Your text is safe — open the Raw view to read or fix it.`),
        h("button", { class: "btn btn--small", type: "button", onclick: () => setMode("raw") }, "Open Raw view"));
      if (renderError && content) { content.hidden = true; renderError.hidden = false; renderError.replaceChildren(banner); }
      else page.replaceChildren(banner);
    }
    rendered.scrollTop = keep;
  }
  const renderSoon = debounce(renderNow, 200);

  session.on("text", ({ source }) => {
    if (source !== "raw") ta.value = session.text;               // programmatic: no input event, undo history kept
    if (source === "raw") { stale = true; if (mode === "rendered") renderSoon(); }
    else renderNow();
    renderStatus({ deferIssues: source === "raw" });
  });
  session.on("saved", renderStatus);

  /* ----- status bar (Raw view only) ----- */
  // Line count and saved state are cheap and update at once; the problem count needs a parse, so while someone is
  // typing in a very large file it waits for a short pause instead of re-parsing on every keystroke.
  function renderStatus({ deferIssues = false } = {}) {
    const bar = slot("status");
    bar.hidden = mode !== "raw";
    if (mode !== "raw") return;
    const n = editor.view.state.doc.lines;
    slot("status-lines").textContent = `${n} ${n === 1 ? "line" : "lines"}`;
    const st = host.sync.statusOf(name());
    const sync = slot("status-sync");
    sync.textContent = SYNC_TEXT[st];
    sync.classList.toggle("statusbar__warn", st === "error");
    sync.title = st === "error" ? (host.sync.errorOf(name()) ?? "") : "";
    slot("status-saved").textContent = session.isDirty ? "Unsaved changes" : "Saved";
    if (deferIssues) renderIssuesSoon(); else renderIssuesPart();
  }
  function renderIssuesPart() {
    if (disposed || mode !== "raw") return;
    const c = session.model.counts;
    const btn = slot("status-issues");
    const problems = c.error + c.warning;
    btn.hidden = !problems;
    btn.classList.toggle("is-error", c.error > 0);
    btn.textContent = [c.error && `${c.error} ${c.error === 1 ? "error" : "errors"}`, c.warning && `${c.warning} ${c.warning === 1 ? "warning" : "warnings"}`].filter(Boolean).join(", ");
    btn.setAttribute("aria-expanded", String(issuesOpen && !!problems));
    drawRawIssues(problems);
  }
  const renderIssuesSoon = debounce(renderIssuesPart, 300);
  function drawRawIssues(problems) {
    const box = slot("raw-issues");
    box.hidden = !(issuesOpen && problems);
    if (!box.hidden) box.replaceChildren(issuesList(session.model, { summary: false, onGo: gotoLine }));
  }
  slot("status-issues").addEventListener("click", () => { issuesOpen = !issuesOpen; renderStatus(); });

  /* ----- modes ----- */
  function setMode(next) {
    mode = next === "raw" ? "raw" : "rendered";
    rendered.hidden = mode !== "rendered";
    rawPane.hidden = mode !== "raw";
    for (const r of menubar.querySelectorAll("[name=view]")) r.checked = r.value === mode;
    for (const el of menubar.querySelectorAll("[data-needs=rendered]")) el.disabled = mode !== "rendered";
    menu.close();
    if (mode === "rendered") { if (stale) renderNow(); }
    else { ta.value = session.text; requestAnimationFrame(() => editor.refresh()); updatePos(); }
    renderStatus();
    shell.emit("mode", mode);
  }
  for (const r of menubar.querySelectorAll("[name=view]")) r.addEventListener("change", () => { if (r.checked) setMode(r.value); });

  /** Shows a source line in the Raw editor (used by every "Line N" button). */
  function gotoLine(n) {
    setMode("raw");
    const line = session.model.lines[n - 1];
    if (!line) return;
    requestAnimationFrame(() => { editor.refresh(); editor.setSelection(line.start, line.end); editor.focus(); updatePos(); });
  }

  /* ----- housekeeping ----- */
  const flushNow = () => session.flush();
  const onHidden = () => { if (document.visibilityState === "hidden") flushNow(); };
  window.addEventListener("pagehide", flushNow);
  document.addEventListener("visibilitychange", onHidden);
  const offs = [
    host.settings.on("lineNumbers", () => editor.setLineNumbers(!!host.settings.get("lineNumbers"))),
    host.settings.on("autoSave", renderStatus),
    host.sync.on("changed", renderStatus),
    host.auth.on("changed", renderStatus),
    () => { window.removeEventListener("pagehide", flushNow); document.removeEventListener("visibilitychange", onHidden); },
  ];

  Object.assign(shell, {
    session, editor, menu, page, root, $, slot, get mode() { return mode; },
    setMode, gotoLine, renderNow, renderSoon,
    /** Runs a mutation; on refusal tells the person why and returns false. */
    run(mutation) {
      const res = session.apply(mutation);
      if (!res.ok) { host.notify(res.error, "error"); return false; }
      return true;
    },
    onShow() { editor.refresh(); setMode(mode); if (mode === "raw") { editor.focus(); updatePos(); } shell.emit("show"); },
    onHide() { session.flush(); shell.emit("hide"); },
    save: () => session.save(),
    dispose() {
      if (disposed) return;
      session.dispose();                                          // flushes auto-save (or cancels it), unsubscribes
      disposed = true;
      renderSoon.cancel();
      renderIssuesSoon.cancel();
      offs.forEach((off) => off());
      menu.dispose();
      editor.destroy();
      shell.emit("dispose");
    },
  });
  // First paint happens in onShow(): the viewer's own controls exist by then, so its render function can use them.
  rendered.hidden = mode !== "rendered";
  rawPane.hidden = mode !== "raw";
  return shell;
}
