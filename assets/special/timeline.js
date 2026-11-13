/* special/timeline.js — month calendar over the (mock) journals. UI phase only. */
import { h } from "../js/shell/core.js";
import { parseJournal, formatAmount } from "../js/shell/preview-parser.js";

export function mount({ root, host }) {
  const slot = (n) => root.querySelector(`[data-slot="${n}"]`);
  const pad = (n) => String(n).padStart(2, "0");
  const now = new Date();
  let year = now.getFullYear(), month = now.getMonth(), selected = null;

  function byDate() {
    const map = new Map();
    for (const { name } of host.files.list().filter((f) => f.name.endsWith(".journal"))) {
      for (const t of parseJournal(host.files.get(name).content).transactions) {
        if (!map.has(t.date)) map.set(t.date, []);
        map.get(t.date).push({ ...t, file: name });
      }
    }
    return map;
  }

  function render() {
    const map = byDate();
    // First render: jump to the month of the latest transaction so the demo isn't empty.
    if (!render.jumped) {
      render.jumped = true;
      const latest = [...map.keys()].sort().pop();
      if (latest) { year = +latest.slice(0, 4); month = +latest.slice(5, 7) - 1; }
    }
    slot("month").textContent = new Date(year, month, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
    const first = (new Date(year, month, 1).getDay() + 6) % 7; // Monday-first
    const days = new Date(year, month + 1, 0).getDate();
    const cells = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => h("div", { class: "tl__dow", role: "columnheader" }, d));
    for (let i = 0; i < first; i++) cells.push(h("div", { class: "tl__day tl__day--blank", "aria-hidden": "true" }));
    for (let d = 1; d <= days; d++) {
      const iso = `${year}-${pad(month + 1)}-${pad(d)}`;
      const n = map.get(iso)?.length ?? 0;
      const isToday = iso === `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      cells.push(h("button", {
        class: `tl__day${iso === selected ? " is-selected" : ""}${isToday ? " is-today" : ""}`, type: "button", role: "gridcell",
        "aria-label": `${d}, ${n} transactions`, dataset: { date: iso },
      }, h("span", { class: "tl__num" }, String(d)), n > 0 && h("span", { class: "tl__count" }, String(n))));
    }
    slot("grid").replaceChildren(...cells);

    const detail = slot("detail");
    detail.hidden = !selected;
    if (selected) {
      const list = map.get(selected) ?? [];
      detail.replaceChildren(
        h("div", { class: "card__title" }, new Date(`${selected}T00:00:00`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })),
        ...(list.length ? list.map((t) => h("div", { class: "tl__txn" },
          h("div", {}, t.description, h("small", {}, t.file)),
          h("div", {}, formatAmount(t.magnitude)))) : [h("p", { class: "field__hint" }, "No transactions on this day.")]));
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

  const off = host.files.on("changed", render);
  render();
  return { dispose: off };
}
