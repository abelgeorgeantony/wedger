/* time-dialog.js — the parts the .timeclock / .timedot dialogs share (assets/dialogs/timeclock-*.js, timedot-*.js).
 *
 * Each dialog is its own template + small controller opened with host.dialogs.openTemplate(), like Add transaction.
 * What they have in common lives here, so no controller grows into a generic form engine:
 *
 *   bindDialog     submit / cancel wiring: busy state, inline errors (banner or beside a field), focus, aria
 *   fillDatalist   account autocomplete
 *   amountControl  the timedot "how it's written + amount" field with its live reading
 *   shiftNow       "now, N seconds ago" as local date + time strings
 *
 * Template contract (see the .html files): a <form data-slot="form"> holding the fields, [data-slot="error"] (the
 * banner), [data-slot="submit"], [data-act="cancel"], and for a field-level message <p data-error-for="fieldName">.
 */
import { h } from "./core.js";
import { buildQuantity, parseQuantity, UNIT_LABELS } from "./timedot.js";
import { formatDuration, formatHours, localNow, isoFromDays, clockText } from "./time-format.js";

/** Replaces the options of a <datalist> with the given values. */
export function fillDatalist(list, values) {
  list.replaceChildren(...(values ?? []).map((v) => h("option", { value: v })));
}

/** The current local moment moved by `seconds` (negative = earlier), as { date, time } strings. */
export function shiftNow(seconds = 0, now = localNow()) {
  const wall = now.wall + seconds;
  const day = Math.floor(wall / 86400);
  return { date: isoFromDays(day), time: clockText(wall - day * 86400) };
}

/** Return this from run() when the work succeeded but the dialog should stay open (the "add another" flow). */
export const KEEP_OPEN = Symbol("keep-open");

/**
 * Wires a dialog template's form.
 *   run()  async; validates and applies. Returns null/undefined on success (the dialog closes), KEEP_OPEN, a message
 *          string, or { field, message } for a refusal.
 * Cancel and Escape never call run(), so they can never modify the file. While run() is pending the submit button is
 * disabled and marked busy; a refusal re-enables it and shows the reason, with focus moved to the offending field.
 */
export function bindDialog({ root, close, run, busyLabel = "Saving…" }) {
  const form = root.querySelector('[data-slot="form"]');
  const submit = root.querySelector('[data-slot="submit"]');
  const banner = root.querySelector('[data-slot="error"]');
  const idleLabel = submit.textContent;
  let busy = false;

  const clear = () => {
    banner.hidden = true; banner.replaceChildren();
    for (const el of form.querySelectorAll("[aria-invalid]")) { el.removeAttribute("aria-invalid"); el.removeAttribute("aria-describedby"); }
    for (const el of form.querySelectorAll("[data-error-for]")) { el.hidden = true; el.textContent = ""; }
  };
  /** Shows a message beside `field` (and focuses it), or in the banner when it isn't about one field. */
  const fail = (problem) => {
    const { field = null, message } = typeof problem === "string" ? { message: problem } : problem;
    const target = field ? form.elements[field] : null;
    const slot = field ? form.querySelector(`[data-error-for="${field}"]`) : null;
    if (target && slot) {
      slot.textContent = message; slot.hidden = false;
      slot.id ||= `err-${field}-${Math.random().toString(36).slice(2, 7)}`;
      target.setAttribute("aria-invalid", "true"); target.setAttribute("aria-describedby", slot.id);
      target.focus();
    } else {
      banner.replaceChildren(h("span", {}, message)); banner.hidden = false;
    }
  };

  root.addEventListener("click", (e) => { if (e.target.closest('[data-act="cancel"]')) close(null); });
  form.addEventListener("input", () => { if (!busy) clear(); });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy) return;
    clear();
    busy = true; submit.disabled = true; submit.setAttribute("aria-busy", "true"); submit.textContent = busyLabel;
    let problem = null;
    try { problem = await run(); } catch (err) { problem = err?.message ?? String(err); }
    busy = false; submit.disabled = false; submit.removeAttribute("aria-busy"); submit.textContent = idleLabel;
    if (problem === KEEP_OPEN) return;
    if (problem) fail(problem); else close(true);
  });
  return { clear, fail, form, get busy() { return busy; } };
}

const MODES = [
  ["h", "Hours"], ["m", "Minutes"], ["dots", "Dots (¼ h each)"], ["letters", "Letters (¼ h each)"],
  ["s", "Seconds"], ["d", "Days"], ["w", "Weeks"], ["mo", "Months"], ["y", "Years"],
];
const HINTS = {
  dots: "Type dots (. = 15 min, spaces only group them), or hours in steps of 0.25.",
  letters: "Each letter is 15 minutes and counts as its own type, e.g. ccec.",
};

/**
 * The timedot amount field: a "how it's written" select and a text box, with a live reading of what it means
 * ("= 1h 30m (1.50 h)", the types of a letters entry, any refusal). It never rounds: a value that can't be written
 * exactly in the chosen notation is refused with the reason.
 *   allowAsWritten  adds "As written", which keeps an existing entry's notation character for character
 *   allowEmpty      an empty box is a valid "no amount"
 */
export function amountControl({ id = "amount", mode = "h", value = "", allowAsWritten = false, allowEmpty = false, onChange = () => {} } = {}) {
  const sel = h("select", { class: "select", name: `${id}-mode`, "aria-label": "How the time is written" },
    ...(allowAsWritten ? [h("option", { value: "raw" }, "As written")] : []),
    ...MODES.map(([v, t]) => h("option", { value: v }, t)));
  const hint = h("p", { class: "tv-amount__hint", id: `${id}-hint`, "aria-live": "polite" });
  const input = h("input", { class: "input", id, name: id, type: "text", autocomplete: "off", spellcheck: "false", "aria-describedby": hint.id });
  sel.value = mode; input.value = value;

  const evaluate = () => {
    const m = sel.value, v = input.value;
    if (m === "raw") {
      const q = parseQuantity(v);
      return q.ok ? { ok: true, text: v.trim(), parsed: q, empty: v.trim() === "" } : { ok: false, error: q.error };
    }
    if (!v.trim() && allowEmpty) return { ok: true, text: "", parsed: parseQuantity(""), empty: true };
    return buildQuantity(m, v);
  };
  const refresh = () => {
    const r = evaluate();
    const empty = !input.value.trim();
    input.placeholder = sel.value === "dots" ? ".... .." : sel.value === "letters" ? "ccec" : "e.g. 1.5";
    hint.classList.toggle("is-error", !r.ok && !empty);
    if (empty && !r.ok) hint.textContent = HINTS[sel.value] ?? (sel.value === "raw" ? "" : `Enter ${UNIT_LABELS[sel.value] ?? "a number"}, e.g. 1.5. A decimal point, no unit.`);
    else if (!r.ok) hint.textContent = r.error;
    else {
      const q = r.parsed;
      hint.textContent = `${q.seconds.isZero() ? "0m" : `= ${formatDuration(q.seconds)} (${formatHours(q.seconds)} h)`}${r.text && r.text !== input.value.trim() ? ` · written as ${r.text}` : ""}${q.types.length ? ` · ${q.types.map((t) => `${t.type}: ${formatDuration(t.seconds)}`).join(", ")}` : ""}`;
    }
    onChange(r);
  };
  sel.addEventListener("change", refresh);
  input.addEventListener("input", refresh);
  refresh();
  const el = h("div", { class: "tv-amount" }, h("div", { class: "tv-amount__row" }, sel, input), hint);
  return { el, sel, input, hint, evaluate, refresh, focus: () => input.focus() };
}
