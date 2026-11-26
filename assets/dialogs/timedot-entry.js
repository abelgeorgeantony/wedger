/* dialogs/timedot-entry.js — controller for timedot-entry.html.
 *
 * params:
 *   mode       "add" | "edit"
 *   posting    the entry being edited (edit only): { id, date, account, raw, kind, comment, ... }
 *   date       the date to start from (add): a day's "+" button passes that day, else today
 *   accounts   string[] for autocomplete
 *   submit(v)  async; v = { date, account, quantityText, comment }. Resolves null on success or an error message.
 *
 * The amount keeps the live reading from amountControl(): what the input means, never rounded. Editing starts in
 * "As written", so an entry's notation (including letters and their types) is only rewritten when the person
 * deliberately changes the amount or its notation. Cancel and Escape never call submit().
 */
import { bindDialog, fillDatalist, amountControl, KEEP_OPEN } from "../js/shell/time-dialog.js";
import { validateAccount } from "../js/shell/timedot.js";
import { parseSimpleDate, todayLocal, formatDateLong } from "../js/shell/time-format.js";

export function mount({ root, params, close }) {
  const { mode = "add", posting = null, date = todayLocal(), accounts = [], submit } = params;
  const slot = (n) => root.querySelector(`[data-slot="${n}"]`);
  const form = slot("form"), f = form.elements;
  const edit = mode === "edit";

  slot("title").textContent = edit ? "Edit entry" : "Add entry";
  slot("subtitle").textContent = edit
    ? `${posting.date ? formatDateLong(posting.date) : "Unreadable date"}. Only the parts you change are rewritten; the rest of the line stays as it is.`
    : "Adds a line under that day in the file. A new day heading is created if the date isn't there yet.";
  slot("submit").textContent = edit ? "Save changes" : "Add entry";
  slot("again-row").hidden = edit;
  fillDatalist(root.querySelector("#tde-accounts"), accounts);

  const amount = amountControl(edit
    ? { id: "amount", mode: "raw", value: posting.raw, allowAsWritten: true, allowEmpty: true }
    : { id: "amount", mode: "h" });
  slot("amount").append(amount.el);

  f.date.value = edit ? (posting.date ?? "") : date;
  f.account.value = edit ? posting.account : "";
  f.comment.value = edit ? posting.comment.split("\n")[0] : "";

  const status = slot("status");
  let added = 0;
  const ui = bindDialog({
    root, close, busyLabel: edit ? "Saving…" : "Adding…",
    run: async () => {
      const d = parseSimpleDate(f.date.value);
      if (!d?.valid) return { field: "date", message: "Enter a real date." };
      const account = f.account.value.trim();
      const bad = validateAccount(account);
      if (bad) return { field: "account", message: bad };
      const q = amount.evaluate();
      if (!q.ok) { amount.refresh(); return { field: "amount", message: q.error ?? "Enter an amount of time." }; }
      const problem = await submit({ date: d.iso, account, quantityText: q.text, comment: f.comment.value.trim() });
      if (problem) return problem;
      if (!edit && f.again.checked) {
        added++;
        status.textContent = `Added ${added} ${added === 1 ? "entry" : "entries"}. Add another, or press Done to finish.`;
        root.querySelector("[data-act=cancel]").textContent = "Done";             // what was added is already saved; nothing is pending
        f.account.value = ""; f.comment.value = ""; amount.input.value = ""; amount.refresh();
        f.account.focus();
        ui.clear();
        return KEEP_OPEN;
      }
      return null;
    },
  });
  f.account.focus();
  return {};
}
