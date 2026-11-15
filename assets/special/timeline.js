/* special/timeline.js — a month calendar over every journal, read through the hledger engine. */
import { h, fileUri, debounce } from "../js/shell/core.js";
import { fmtDateLong, txnHeadline, todayIso } from "../js/shell/format.js";

export function mount({ root, host }) {
  const slot = (n) => root.querySelector(`[data-slot="${n}"]`);
  const pad = (n) => String(n).padStart(2, "0");
  const now = new Date();
  let year = now.getFullYear(), month = now.getMonth(), selected = null;
  let byDate = new Map(), loaded = false, failures = [], jumped = false, token = 0;

  async function load() {
    const mine = ++token;
    const map = new Map(), failed = [];
    for (const { name } of host.files.list().filter((f) => f.name.endsWith(".journal"))) {
      const res = await host.engine.transactions(name, host.files.get(name).content);
      if (mine !== token) return;
      if (!res.ok) { failed.push(name); continue; }
      for (const t of res.data) {
        const date = String(t.date);
        if (!map.has(date)) map.set(date, []);
        map.get(date).push({ description: t.description, file: name, headline: txnHeadline(t) });
      }
    }
    byDate = map; failures = failed; loaded = true;
    if (!jumped) {                                              // first load: land on the month of the latest transaction
      jumped = true;
      const latest = [...map.keys()].sort().pop();
      if (latest) { year = +latest.slice(0, 4); month = +latest.slice(5, 7) - 1; }
    }
    render();
  }
  const reload = debounce(load, 250);

  function render() {
    slot("month").textContent = new Date(year, month, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
    const dows = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => h("div", { class: "tl__dow", role: "columnheader" }, d));
    if (!loaded) { slot("grid").replaceChildren(...dows, h("div", { class: "tl__loading" }, host.engine.ready ? "Reading your journals…" : "Loading the accounting engine…")); return; }
    const first = (new Date(year, month, 1).getDay() + 6) % 7;      // Monday first
    const days = new Date(year, month + 1, 0).getDate();
    const cells = [...dows];
    for (let i = 0; i < first; i++) cells.push(h("div", { class: "tl__day tl__day--blank", "aria-hidden": "true" }));
    for (let d = 1; d <= days; d++) {
      const iso = `${year}-${pad(month + 1)}-${pad(d)}`;
      const n = byDate.get(iso)?.length ?? 0;
      cells.push(h("button", {
        class: `tl__day${iso === selected ? " is-selected" : ""}${iso === todayIso() ? " is-today" : ""}`, type: "button", role: "gridcell",
        "aria-label": `${d}, ${n} ${n === 1 ? "transaction" : "transactions"}`, dataset: { date: iso },
      }, h("span", { class: "tl__num" }, String(d)), n > 0 && h("span", { class: "tl__count" }, String(n))));
    }
    slot("grid").replaceChildren(...cells);

    const detail = slot("detail");
    detail.hidden = !selected && !failures.length;
    detail.replaceChildren();
    if (failures.length) detail.append(h("p", { class: "banner banner--warn" }, `Skipped ${failures.join(", ")}: hledger couldn't read ${failures.length === 1 ? "it" : "them"}. Open ${failures.length === 1 ? "it" : "them"} to see why.`));
    if (selected) {
      const list = byDate.get(selected) ?? [];
      detail.append(h("div", { class: "card__title" }, fmtDateLong(selected)),
        ...(list.length ? list.map((t) => h("div", { class: "tl__txn" },
          h("div", {}, h("strong", {}, t.description || "(no description)"), h("small", {}, h("button", { class: "link-btn", type: "button", onclick: () => host.open(fileUri(t.file)) }, t.file))),
          h("div", { class: "tl__amount" }, t.headline))) : [h("p", { class: "field__hint" }, "No transactions on this day.")]));
    }
  }

  root.addEventListener("click", (e) => {
    const day = e.target.closest("[data-date]");
    if (day) { selected = day.dataset.date; render(); return; }
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "prev") { month--; if (month < 0) { month = 11; year--; } }
    else if (act === "next") { month++; if (month > 11) { month = 0; year++; } }
    else if (act === "today") { year = now.getFullYear(); month = now.getMonth(); }
    else return;
    render();
  });

  render();
  load();
  const offs = [host.files.on("changed", reload), host.engine.on("status", (s) => { if (s === "ready") load(); })];
  return { dispose() { token++; reload.cancel(); offs.forEach((o) => o()); } };
}
