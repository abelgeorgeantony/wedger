/* dialogs/timedot-day.js — controller for timedot-day.html.
 *
 * params:
 *   mode         "add" | "edit"
 *   day          the day group being edited (edit): { date, dateText, description, postings }
 *   date         the date to start from (add)
 *   submit(v)    async; v = { date, description }. Resolves null on success or an error message to show inline.
 *   afterAdd(d)  called with the ISO date after a day was added with "Then add an entry" ticked (the viewer opens
 *                the entry dialog on that day)
 * Cancel and Escape never call submit(), so they never touch the file.
 */
import { bindDialog } from "../js/shell/time-dialog.js";
import { parseSimpleDate, todayLocal } from "../js/shell/time-format.js";

export function mount({ root, params, close }) {
  const { mode = "add", day = null, date = todayLocal(), submit, afterAdd } = params;
  const slot = (n) => root.querySelector(`[data-slot="${n}"]`);
  const form = slot("form"), f = form.elements;
  const edit = mode === "edit";

  slot("title").textContent = edit ? "Edit day" : "Add day";
  slot("submit").textContent = edit ? "Save changes" : "Add day";
  slot("then-row").hidden = edit;
  slot("subtitle").textContent = edit
    ? `Changes the heading line only. ${(day.postings?.length ?? 0) === 1 ? "Its 1 entry stays" : `Its ${(day.postings?.length ?? 0)} entries stay`} with it.`
    : "Adds a day heading to the file, in date order. You can add entries to it afterwards.";
  f.date.value = edit ? (day.date ?? "") : date;
  f.description.value = edit ? day.description : "";

  bindDialog({
    root, close, busyLabel: edit ? "Saving…" : "Adding…",
    run: async () => {
      const d = parseSimpleDate(f.date.value);
      if (!d?.valid) return { field: "date", message: "Enter a real date." };
      const description = f.description.value.trim();
      if (description.includes(";")) return { field: "description", message: "The description can't contain “;” (it starts a comment)." };
      const problem = await submit({ date: d.iso, description });
      if (problem) return problem;
      if (!edit && f.then.checked) setTimeout(() => afterAdd?.(d.iso), 0);      // after this dialog has closed
      return null;
    },
  });
  f.date.focus();
  return {};
}
