/* dialogs/timeclock-clock-out.js — controller for timeclock-clock-out.html.
 *
 * params:
 *   session    the running session to close (parsed model object)
 *   submit(v)  async; v = { date, time, comment }. Resolves null on success or an error message to show inline.
 *              The viewer closes exactly THIS session (by id), never "the most recent open one".
 */
import { bindDialog } from "../js/shell/time-dialog.js";
import { validateDescription } from "../js/shell/timeclock.js";
import { parseSimpleDate, parseClockTime, wallSeconds, formatDuration, formatHours, localNow, formatDateLabel, shortClock } from "../js/shell/time-format.js";

export function mount({ root, params, close }) {
  const { session: s, submit } = params;
  const slot = (n) => root.querySelector(`[data-slot="${n}"]`);
  const form = slot("form"), f = form.elements;
  slot("subtitle").textContent = `“${s.account}”, running since ${formatDateLabel(s.start.date)} ${shortClock(s.start.secondsOfDay)}.`;
  const n = localNow();
  f.ed.value = n.date; f.et.value = n.time;

  function read() {
    const d = parseSimpleDate(f.ed.value);
    if (!d?.valid) return { error: { field: "ed", message: "End: enter a real date." } };
    const t = parseClockTime(f.et.value);
    if (!t?.valid || t.tz) return { error: { field: "et", message: "End: enter a time like 09:30 or 09:30:15." } };
    const wall = wallSeconds(d.iso, t.seconds);
    if (wall < s.start.wall) return { error: { field: "et", message: `The end is before the clock-in (${s.start.date} ${shortClock(s.start.secondsOfDay)}). Check the date and time.` }, wall };
    return { value: { date: d.iso, time: f.et.value }, wall };
  }
  const summary = slot("summary");
  function refresh() {
    const r = read();
    summary.classList.toggle("is-error", !!r.error && r.wall != null);
    summary.textContent = r.wall == null ? "" : r.error ? "The end is before the start." : `Duration: ${formatDuration(r.wall - s.start.wall)} (${formatHours(r.wall - s.start.wall)} h)`;
  }
  form.addEventListener("input", refresh);
  root.addEventListener("click", (e) => {
    if (e.target.closest("[data-now]")) { const t = localNow(); f.ed.value = t.date; f.et.value = t.time; refresh(); }
  });
  refresh();

  bindDialog({
    root, close, busyLabel: "Clocking out…",
    run: async () => {
      const r = read();
      if (r.error) return r.error;
      const bad = validateDescription(f.comment.value.trim());
      if (bad) return { field: "comment", message: bad };
      return submit({ ...r.value, comment: f.comment.value.trim() });
    },
  });
  f.et.focus();
  return {};
}
