/* dialogs/add-transaction.js — controller for add-transaction.html.
 * Result: { text } (the finished transaction block) or null if cancelled. */
import { h } from "../js/shell/core.js";
import { parseJournal, parseAmountText, buildTransactionText, formatAmount } from "../js/shell/preview-parser.js";

export function mount({ root, params, close }) {
  const { accounts = [], txn = null } = params;
  const $ = (s) => root.querySelector(s);
  const slot = (n) => root.querySelector(`[data-slot="${n}"]`);
  const form = slot("form"), rows = slot("postings"), raw = form.elements.raw;
  let mode = "form";

  $("#atx-accounts").replaceChildren(...accounts.map((a) => h("option", { value: a })));
  const today = new Date(); const pad = (n) => String(n).padStart(2, "0");
  form.elements.date.value = txn?.date ?? `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  form.elements.description.value = txn?.description ?? "";
  if (txn) {
    slot("title").textContent = "Edit transaction";
    slot("subtitle").textContent = "Change the details and save";
    slot("submit").textContent = "Save changes";
  }

  function addRow(account = "", amountText = "") {
    const row = h("div", { class: "atx__posting" },
      h("input", { class: "input", name: "account", list: "atx-accounts", placeholder: "expenses:food", "aria-label": "Account", autocomplete: "off", value: account }),
      h("input", { class: "input", name: "amount", placeholder: "₹ 0.00", "aria-label": "Amount", inputmode: "decimal", autocomplete: "off", value: amountText }),
      h("button", { class: "btn btn--ghost atx__remove", type: "button", "aria-label": "Remove posting", dataset: { act: "remove-posting" } }, "✕"));
    rows.append(row);
  }
  (txn?.postings.length ? txn.postings.map((p) => [p.account, p.inferred ? "" : p.amountText]) : [["", ""], ["", ""]])
    .forEach(([a, m]) => addRow(a, m));

  const readPostings = () => [...rows.children].map((r) => ({
    account: r.querySelector('[name="account"]').value.trim(),
    amountText: r.querySelector('[name="amount"]').value.trim(),
  })).filter((p) => p.account || p.amountText);

  const readForm = () => ({ date: form.elements.date.value, description: form.elements.description.value.trim(), postings: readPostings() });

  /** Difference when every amount is filled in, else null. */
  function imbalance(postings) {
    const amounts = postings.map((p) => parseAmountText(p.amountText ?? ""));
    const filled = amounts.filter(Boolean);
    if (filled.length < 2 || filled.length !== postings.length) return null;
    const sum = filled.reduce((s, a) => s + a.value, 0);
    return Math.abs(sum) > 0.005 ? sum : null;
  }
  function refreshWarning() {
    const diff = mode === "form" ? imbalance(readPostings()) : null;
    const el = slot("warning");
    el.hidden = diff == null;
    if (diff != null) el.textContent = `Postings don't balance: difference ${formatAmount(Math.abs(diff))}.`;
  }

  function showError(msg) { const el = slot("error"); el.textContent = msg ?? ""; el.hidden = !msg; }

  function setMode(next) {
    if (next === mode) return;
    if (next === "raw") raw.value = buildTransactionText(readForm());
    else {
      const parsed = parseJournal(raw.value).transactions[0];
      if (parsed) {
        form.elements.date.value = parsed.date;
        form.elements.description.value = parsed.description;
        rows.replaceChildren();
        parsed.postings.forEach((p) => addRow(p.account, p.inferred ? "" : p.amountText));
      }
    }
    mode = next;
    slot("pane-form").hidden = mode !== "form";
    slot("pane-raw").hidden = mode !== "raw";
    showError(null); refreshWarning();
  }

  root.addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "cancel") close(null);
    if (act === "add-posting") { addRow(); rows.lastElementChild.querySelector("input").focus(); }
    if (act === "remove-posting") { e.target.closest(".atx__posting").remove(); refreshWarning(); }
  });
  root.addEventListener("input", refreshWarning);
  form.querySelectorAll('[name="mode"]').forEach((r) => r.addEventListener("change", () => r.checked && setMode(r.value)));

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    let text;
    if (mode === "raw") {
      text = raw.value.trim();
      if (!parseJournal(text).transactions.length) return showError("Start with a date, e.g. 2026-10-20 Groceries.");
    } else {
      const data = readForm();
      if (!data.date) return showError("Pick a date.");
      if (!data.description) return showError("Add a description.");
      if (data.postings.length < 2 || data.postings.some((p) => !p.account)) return showError("Add at least two postings, each with an account.");
      if (imbalance(data.postings) != null) return showError("The postings need to balance before this can be saved.");
      text = buildTransactionText(data);
    }
    close({ text });
  });

  form.elements.description.focus();
}
