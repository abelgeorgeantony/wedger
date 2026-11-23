import test from "node:test";
import assert from "node:assert/strict";
import { buildTransactionText, parseTxnText, normalizeAmountInput } from "../assets/js/shell/format.js";

const txn = (postings, extra = {}) => ({ date: "2026-01-02", description: "Test", postings, ...extra });

/** The characters between the end of `account` and the start of `amount` on the emitted posting line. */
function gapOf(text, account, amount) {
  const line = text.split("\n").find((l) => l.startsWith(`    ${account}`) && l.trimEnd().endsWith(amount));
  assert.ok(line, `posting line for ${account.slice(0, 20)}… not found`);
  return line.slice(4 + account.length, line.length - amount.length);
}

test("account lengths round-trip with a gap of at least two spaces", () => {
  for (const n of [1, 30, 31, 32, 33, 64, 200]) {
    const account = "a".repeat(n);
    const text = buildTransactionText(txn([{ account, amountText: "$100.00" }, { account: "equity:x", amountText: "" }]));
    const back = parseTxnText(text);
    assert.equal(back.postings[0].account, account, `length ${n}`);
    assert.equal(back.postings[0].amountText, "$100.00", `length ${n}`);
    assert.match(gapOf(text, account, "$100.00"), /^ {2,}$/, `length ${n}`);
  }
});

test("the 32-character savings account keeps its amount apart, alongside a short account", () => {
  const long = "assets:bank:federal:savings:7714";
  assert.equal(long.length, 32);
  const text = buildTransactionText(txn([
    { account: long, amountText: "$1,234.56" },
    { account: "expenses:food", amountText: "$5.00" },
  ]));
  const back = parseTxnText(text);
  assert.deepEqual(back.postings, [
    { account: long, amountText: "$1,234.56" },
    { account: "expenses:food", amountText: "$5.00" },
  ]);
  const gapLong = gapOf(text, long, "$1,234.56");
  const gapShort = gapOf(text, "expenses:food", "$5.00");
  assert.match(gapLong, /^ {2,}$/);
  assert.match(gapShort, /^ {2,}$/);
  assert.ok(gapShort.length > gapLong.length, "short account lines up with the long one");
});

test("a short-only transaction still lines up at column 32", () => {
  const text = buildTransactionText(txn([{ account: "a", amountText: "$1" }, { account: "expenses:food", amountText: "$2" }]));
  const [, l1, l2] = text.split("\n");
  assert.equal(l1.indexOf("$1"), 4 + 32);
  assert.equal(l2.indexOf("$2"), 4 + 32);
});

test("an account with one internal space is not confused with the separator", () => {
  const account = "assets:bank:joint account";
  const text = buildTransactionText(txn([{ account, amountText: "$10.00" }, { account: "income:pay", amountText: "" }]));
  const back = parseTxnText(text);
  assert.equal(back.postings[0].account, account);
  assert.equal(back.postings[0].amountText, "$10.00");
  assert.match(gapOf(text, account, "$10.00"), /^ {2,}$/);
});

test("whitespace runs inside an account collapse to one space", () => {
  const text = buildTransactionText(txn([{ account: "  assets:bank   joint\taccount ", amountText: " $3.00 " }, { account: "income:pay", amountText: "" }]));
  const back = parseTxnText(text);
  assert.equal(back.postings[0].account, "assets:bank joint account");
  assert.equal(back.postings[0].amountText, "$3.00");
});

test("an empty amount stays empty and does not borrow the other posting's amount", () => {
  const text = buildTransactionText(txn([{ account: "expenses:food", amountText: "$5.00" }, { account: "assets:bank:federal:savings:7714", amountText: "" }]));
  assert.equal(text.split("\n")[2], "    assets:bank:federal:savings:7714");
  const back = parseTxnText(text);
  assert.equal(back.postings[1].account, "assets:bank:federal:savings:7714");
  assert.equal(back.postings[1].amountText, "");
});

test("a posting with neither account nor amount is omitted", () => {
  const text = buildTransactionText(txn([{ account: "a:b", amountText: "$1" }, { account: "", amountText: "" }, { account: "c:d", amountText: "" }]));
  assert.equal(parseTxnText(text).postings.length, 2);
});

test("a bare number gets the default commodity, exactly like normalizeAmountInput, and round-trips", () => {
  const norm = normalizeAmountInput("500", "$");
  assert.equal(norm, "$500");
  const account = "assets:bank:federal:savings:7714";
  const text = buildTransactionText(txn([{ account, amountText: "500" }, { account: "equity:open", amountText: "-500" }]), "$");
  const back = parseTxnText(text);
  assert.equal(back.postings[0].amountText, norm);
  assert.equal(back.postings[1].amountText, normalizeAmountInput("-500", "$"));
});

test("date and description survive", () => {
  const text = buildTransactionText({ date: "2026-10-20", description: "Groceries & more", postings: [{ account: "expenses:food", amountText: "$5" }, { account: "assets:cash", amountText: "" }] });
  const back = parseTxnText(text);
  assert.equal(back.date, "2026-10-20");
  assert.equal(back.description, "Groceries & more");
});

test("throws instead of emitting text that would not round-trip", () => {
  assert.throws(() => buildTransactionText(txn([{ account: "", amountText: "$5" }, { account: "a:b", amountText: "" }])), /round-trip/);
  assert.throws(() => buildTransactionText(txn([{ account: "a:b", amountText: "$5 ; note" }, { account: "c:d", amountText: "" }])), /round-trip/);
});
