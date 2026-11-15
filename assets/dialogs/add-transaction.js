/* dialogs/add-transaction.js — controller for add-transaction.html.
 *
 * params:
 *   txn              existing transaction to edit ({ date, description, postings, rawText }) or null
 *   accounts         Promise<string[]> | string[]  (for autocomplete)
 *   defaultCommodity "" | "₹" ...   put in front of bare numbers
 *   submit(text)     async; resolves null on success or an error message to show inline.
 *                    hledger itself decides whether the transaction is valid and balanced.
 */
import { h } from "../js/shell/core.js";
import { buildTransactionText, parseTxnText, needsRawEditing, parseAmountText, todayIso, normalizeAmountInput, formatMoney } from "../js/shell/format.js";

export function mount({ root, params, close }) {
  const { txn = null, accounts = [], defaultCommodity = "", submit } = params;
  const $ = (s) => root.querySelector(s);
  const slot = (n) => root.querySelector(`[data-slot="${n}"]`);
  const form = slot("form"), rows = slot("postings"), raw = form.elements.raw, submitBtn = slot("submit");
  let mode = "form", busy = false;

  Promise.resolve(accounts).then((list) => $("#atx-accounts").replaceChildren(...(list ?? []).map((a) => h("option", { value: a })))).catch(() => {});

  // The engine's own text for the transaction; rebuilt from its fields if it didn't send one.
  const sourceText = txn ? (txn.rawText?.trim() || buildTransactionText({ date: txn.date, description: txn.description, postings: txn.postings.map((p) => ({ account: p.account, amountText: p.amount })) })) : "";
  const parsed = txn ? parseTxnText(sourceText) : null;
  form.elements.date.value = txn?.date || todayIso();
  form.elements.description.value = txn?.description ?? "";
  if (txn) {
    slot("title").textContent = "Edit transaction";
    slot("subtitle").textContent = "hledger checks that it still balances before anything is saved.";
    submitBtn.textContent = "Save changes";
  }

  const placeholder = defaultCommodity ? `${defaultCommodity} 0.00` : "Amount";
  function addRow(account = "", amountText = "") {
    rows.append(h("div", { class: "atx__posting" },
      h("input", { class: "input", name: "account", list: "atx-accounts", placeholder: "expenses:food", "aria-label": "Account", autocomplete: "off", value: account }),
      h("input", { class: "input", name: "amount", placeholder, "aria-label": "Amount", inputmode: "decimal", autocomplete: "off", value: amountText }),
      h("button", { class: "btn btn--ghost atx__remove", type: "button", "aria-label": "Remove posting", dataset: { act: "remove-posting" } }, "✕")));
  }
  (txn?.postings.length ? txn.postings.map((p) => [p.account, p.amount]) : [["", ""], ["", ""]]).forEach(([a, m]) => addRow(a, m));

  const readPostings = () => [...rows.children].map((r) => ({
    account: r.querySelector('[name="account"]').value.trim(),
    amountText: r.querySelector('[name="amount"]').value.trim(),
  })).filter((p) => p.account || p.amountText);
  const readForm = () => ({ date: form.elements.date.value, description: form.elements.description.value.trim(), postings: readPostings() });

  /** A heads-up (never a block) when every amount is filled in and they clearly don't add up. */
  function refreshWarning() {
    const el = slot("warning");
    el.hidden = true;
    if (mode !== "form") return;
    const postings = readPostings();
    const amounts = postings.map((p) => parseAmountText(normalizeAmountInput(p.amountText, defaultCommodity)));
    if (postings.length < 2 || amounts.some((a) => !a)) return;
    const byCommodity = new Map();
    for (const a of amounts) byCommodity.set(a.commodity, (byCommodity.get(a.commodity) ?? 0) + a.value);
    if (byCommodity.size > 1) return;                       // multi-commodity: let hledger decide
    const [commodity, sum] = [...byCommodity.entries()][0];
    if (Math.abs(sum) > 0.005) {
      el.textContent = `These postings differ by ${formatMoney(Math.abs(sum), { commodity, side: amounts[0].side, spaced: amounts[0].spaced, places: 2 })}.`;
      el.hidden = false;
    }
  }

  function showError(msg) {
    const el = slot("error");
    el.replaceChildren();
    el.hidden = !msg;
    if (msg) el.append(h("strong", {}, "hledger said:"), h("pre", { class: "banner__pre" }, msg));
  }

  function setMode(next) {
    if (next === mode) return;
    if (next === "raw") raw.value = buildTransactionText(readForm(), defaultCommodity);
    else {
      const p = parseTxnText(raw.value);
      if (p) {
        form.elements.date.value = p.date;
        form.elements.description.value = p.description;
        rows.replaceChildren();
        p.postings.forEach((x) => addRow(x.account, x.amountText));
        if (!p.postings.length) { addRow(); addRow(); }
      }
    }
    mode = next;
    slot("pane-form").hidden = mode !== "form";
    slot("pane-raw").hidden = mode !== "raw";
    for (const r of form.querySelectorAll('[name="mode"]')) r.checked = r.value === mode;
    showError(null); refreshWarning();
  }

  // A transaction with comments, tags or a status mark would lose them in the form: edit it as text instead.
  if (txn && (needsRawEditing(sourceText) || !parsed)) {
    raw.value = sourceText;
    mode = "raw";
    slot("pane-form").hidden = true; slot("pane-raw").hidden = false;
    form.querySelector('[name="mode"][value="raw"]').checked = true;
    const n = slot("notice");
    n.textContent = "This transaction has comments, tags or a status mark, so it opens as raw text to keep them.";
    n.hidden = false;
  }

  root.addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "cancel") close(null);
    if (act === "add-posting") { addRow(); rows.lastElementChild.querySelector("input").focus(); }
    if (act === "remove-posting") { e.target.closest(".atx__posting").remove(); refreshWarning(); }
  });
  root.addEventListener("input", () => { refreshWarning(); if (!slot("error").hidden) showError(null); });
  form.querySelectorAll('[name="mode"]').forEach((r) => r.addEventListener("change", () => r.checked && setMode(r.value)));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy) return;
    let text;
    if (mode === "raw") {
      text = raw.value.trim();
      if (!parseTxnText(text)) return showError("Start with a date, e.g. 2026-10-20 Groceries.");
    } else {
      const data = readForm();
      if (!data.date) return showError("Pick a date.");
      if (!data.description) return showError("Add a description.");
      if (data.postings.length < 2 || data.postings.some((p) => !p.account)) return showError("Add at least two postings, each with an account.");
      text = buildTransactionText(data, defaultCommodity);
    }
    busy = true; submitBtn.disabled = true;
    const label = submitBtn.textContent; submitBtn.textContent = "Checking…";
    let error;
    try { error = await submit(text); } catch (err) { error = err?.message ?? String(err); }
    busy = false; submitBtn.disabled = false; submitBtn.textContent = label;
    if (error) showError(error); else close(true);
  });

  (mode === "raw" ? raw : form.elements.description).focus();
}
