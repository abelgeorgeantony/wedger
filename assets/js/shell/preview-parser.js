/* preview-parser.js — UI-PHASE ONLY.
 *
 * A deliberately tiny journal reader so the rendered view, timeline and
 * add-transaction dialog have something to show. It is NOT hledger and is
 * replaced by the real engine (parseJournal/getJournalJSON) in the
 * integration phase.
 */

const TXN = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:=\S+)?\s+(?:[*!]\s*)?(?:\(([^)]*)\)\s*)?(.*)$/;
const pad = (n) => String(n).padStart(2, "0");

export function parseAmountText(s) {
  if (!s) return null;
  const m = /([-+])?\s*([₹$€£]|[A-Za-z]{2,})?\s*([-+])?\s*(\d[\d,]*(?:\.\d+)?)\s*([A-Za-z]{2,})?/.exec(s.trim());
  if (!m) return null;
  const neg = m[1] === "-" || m[3] === "-";
  const value = parseFloat(m[4].replace(/,/g, "")) * (neg ? -1 : 1);
  return { value, commodity: m[2] || m[5] || "₹" };
}

function parsePosting(line) {
  const body = line.replace(/\s;.*$/, "");
  const m = /^\s+(\S.*?)(?:\s{2,}|\t+)(.+?)\s*$/.exec(body);
  const account = (m ? m[1] : body).trim();
  const amountText = m ? m[2].trim() : "";
  const amt = parseAmountText(amountText);
  return { account, amountText, amount: amt?.value ?? null, commodity: amt?.commodity ?? null, inferred: false };
}

export function parseJournal(text) {
  const lines = text.split("\n");
  const transactions = [];
  let cur = null;
  lines.forEach((line, i) => {
    const m = TXN.exec(line);
    if (m) {
      cur = { date: `${m[1]}-${pad(m[2])}-${pad(m[3])}`, description: m[5].trim(), postings: [], start: i, end: i };
      transactions.push(cur);
    } else if (cur && /^\s+\S/.test(line)) {
      if (!/^\s*[;#]/.test(line)) cur.postings.push(parsePosting(line));
      cur.end = i;
    } else {
      cur = null;
    }
  });
  for (const t of transactions) {
    const missing = t.postings.filter((p) => p.amount == null);
    if (missing.length === 1 && t.postings.length > 1) {
      const known = t.postings.filter((p) => p.amount != null);
      missing[0].amount = -known.reduce((s, p) => s + p.amount, 0);
      missing[0].commodity = known[0]?.commodity ?? "₹";
      missing[0].inferred = true;
    }
    t.magnitude = Math.max(0, ...t.postings.map((p) => Math.abs(p.amount ?? 0)));
  }
  return { transactions };
}

export function formatAmount(n, commodity = "₹") {
  const num = Math.abs(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const body = /^[^A-Za-z]$/.test(commodity) ? `${commodity}${num}` : `${num} ${commodity}`;
  return n < 0 ? `-${body}` : body;
}

/** "500" -> "₹500.00"; anything else is kept exactly as typed. */
export function normalizeAmountInput(raw) {
  const s = (raw ?? "").trim();
  if (/^[-+]?[\d,]*\.?\d+$/.test(s)) {
    const n = parseFloat(s.replace(/,/g, ""));
    return `${n < 0 ? "-" : ""}₹${Math.abs(n).toFixed(2)}`;
  }
  return s;
}

export function buildTransactionText({ date, description, postings }) {
  const rows = postings.map((p) => {
    const amt = normalizeAmountInput(p.amountText);
    return amt ? `    ${p.account.padEnd(32)}${amt}` : `    ${p.account}`;
  });
  return [`${date} ${description}`.trimEnd(), ...rows].join("\n");
}

export function listAccounts(text) {
  const set = new Set();
  for (const t of parseJournal(text).transactions) t.postings.forEach((p) => set.add(p.account));
  for (const m of text.matchAll(/^account\s+(\S.*)$/gm)) set.add(m[1].trim());
  return [...set].sort();
}
