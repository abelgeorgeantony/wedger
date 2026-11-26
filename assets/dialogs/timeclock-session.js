/* dialogs/timeclock-session.js — controller for timeclock-session.html.
 *
 * params:
 *   mode       "in" (clock in) | "add" (a completed session) | "edit"
 *   session    the parsed session being edited (edit only)
 *   accounts   string[] for autocomplete
 *   submit(v)  async; v = { account, description, start: {date, time}, end: {date, time} | null }.
 *              Resolves null on success or an error message to show inline. The viewer applies it through TimeSession.
 *   openRaw(line)  show a source line in the Raw view (edit only)
 *
 * The dialog validates what it can see (required fields, real dates and times, end not before start) so a mistake is
 * explained next to its field; the mutation behind submit() still has the last word and refuses anything invalid.
 * Cancel and Escape close without calling submit(), so they never touch the file.
 */
import { bindDialog, fillDatalist, shiftNow } from "../js/shell/time-dialog.js";
import { validateAccount, validateDescription } from "../js/shell/timeclock.js";
import {
  parseSimpleDate, parseClockTime, wallSeconds, formatDuration, formatHours, clockText, localNow, formatDateLabel,
} from "../js/shell/time-format.js";

const COPY = {
  in: { title: "Clock in", subtitle: "Starts a session at the time below. Change the date or time to record a start in the past.", submit: "Clock in", busy: "Clocking in…" },
  add: { title: "Add a past session", subtitle: "Records a finished session: a clock-in and a clock-out for the same account.", submit: "Add session", busy: "Adding…" },
  edit: { title: "Edit session", subtitle: "Only the parts you change are rewritten; everything else on its lines stays as it is.", submit: "Save changes", busy: "Saving…" },
};

export function mount({ root, params, close }) {
  const { mode = "in", session = null, accounts = [], submit, openRaw } = params;
  const slot = (n) => root.querySelector(`[data-slot="${n}"]`);
  const form = slot("form");
  const f = form.elements;
  const copy = COPY[mode];
  const open = mode === "edit" && session.status === "open";        // a running session has no end to edit
  const hasEnd = mode === "add" || (mode === "edit" && !open);

  slot("title").textContent = copy.title;
  slot("subtitle").textContent = copy.subtitle;
  slot("submit").textContent = copy.submit;
  fillDatalist(root.querySelector("#tcs-accounts"), accounts);
  slot("end-group").hidden = !hasEnd;

  /* ----- defaults ----- */
  const n = localNow();
  if (mode === "edit") {
    f.account.value = session.account; f.description.value = session.description;
    f.sd.value = session.start.date; f.st.value = clockText(session.start.secondsOfDay);
    if (hasEnd) { f.ed.value = session.end.date; f.et.value = clockText(session.end.secondsOfDay); }
  } else if (mode === "add") {
    const s = shiftNow(-3600, n);
    f.sd.value = s.date; f.st.value = s.time; f.ed.value = n.date; f.et.value = n.time;
  } else {
    f.sd.value = n.date; f.st.value = n.time;
  }

  /* ----- what can't be shown in the form is kept, and the Raw view is one click away ----- */
  if (mode === "edit") {
    const kept = [];
    if (session.comment) kept.push("a ; comment");
    if (session.inEvent.tz || session.outEvent?.tz) kept.push("a time-zone offset");
    const notes = [];
    if (kept.length) notes.push(`This session has ${kept.join(" and ")}. ${kept.length > 1 ? "They stay" : "It stays"} exactly as written. To change ${kept.length > 1 ? "them" : "it"}, edit the line in Raw view.`);
    if (open) notes.push("It is still running, so it has no end time. Use Clock out to finish it; editing the account or description keeps it running.");
    if (session.outEvent && !session.outEvent.account) notes.push("Its clock-out has no account. If you rename the account, the new name is written into the clock-out too, so the pair stays together.");
    if (notes.length) {
      slot("notice-text").textContent = notes.join(" ");
      slot("notice").hidden = false;
      slot("notice").querySelector("[data-act=raw]").hidden = !kept.length;
    }
  }
  root.addEventListener("click", (e) => {
    if (e.target.closest("[data-act=raw]")) { close(null); openRaw?.(session.line); }
    const now = e.target.closest("[data-now]")?.dataset.now;
    if (now) {
      const t = localNow();
      if (now === "start") { f.sd.value = t.date; f.st.value = t.time; } else { f.ed.value = t.date; f.et.value = t.time; }
      refreshSummary();
    }
  });

  /* ----- reading and checking the form ----- */
  const stamp = (label, dateName, timeName) => {
    const d = parseSimpleDate(f[dateName].value);
    if (!d?.valid) return { error: { field: dateName, message: `${label}: enter a real date.` } };
    const t = parseClockTime(f[timeName].value);
    if (!t?.valid || t.tz) return { error: { field: timeName, message: `${label}: enter a time like 09:30 or 09:30:15.` } };
    return { value: { date: d.iso, time: f[timeName].value }, wall: wallSeconds(d.iso, t.seconds) };
  };
  function read() {
    const v = { account: f.account.value.trim(), description: f.description.value.trim(), start: null, end: null };
    const issues = [];
    const bad = validateAccount(v.account) ?? null;
    if (bad) issues.push({ field: "account", message: bad });
    const d = validateDescription(v.description);
    if (d) issues.push({ field: "description", message: d });
    const a = stamp("Start", "sd", "st");
    if (a.error) issues.push(a.error); else v.start = a.value;
    let b = null;
    if (hasEnd) { b = stamp("End", "ed", "et"); if (b.error) issues.push(b.error); else v.end = b.value; }
    if (a.wall != null && b?.wall != null && b.wall < a.wall) {
      issues.push({ field: "et", message: "The end is before the start. If the session runs past midnight, set the end date to the next day." });
    }
    return { v, issues, span: a.wall != null && b?.wall != null ? b.wall - a.wall : null, a, b };
  }

  const summary = slot("summary");
  function refreshSummary() {
    summary.classList.remove("is-error");
    if (!hasEnd) { summary.textContent = ""; return; }
    const { span, a, b } = read();
    if (span == null) { summary.textContent = ""; return; }
    if (span < 0) { summary.textContent = "The end is before the start."; summary.classList.add("is-error"); return; }
    const crosses = a.value.date !== b.value.date;
    summary.textContent = `Duration: ${formatDuration(span)} (${formatHours(span)} h)${crosses ? ` · runs from ${formatDateLabel(a.value.date)} to ${formatDateLabel(b.value.date)}` : ""}`;
  }
  form.addEventListener("input", refreshSummary);
  form.addEventListener("change", refreshSummary);
  refreshSummary();

  bindDialog({
    root, close, busyLabel: copy.busy,
    run: async () => {
      const { v, issues } = read();
      if (issues.length) return issues[0];
      return submit(v);
    },
  });

  f.account.focus();
  f.account.select();
  return {};
}
