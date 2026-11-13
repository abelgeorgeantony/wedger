/* renderers/journal.js — the default viewer for every "file:" URI.
 * Lowest-priority contribution in the manifest, so it is the fallback for
 * anything without a special renderer.
 *
 * UI phase: reads/writes the mock file store and uses preview-parser.js.
 * Rendered view only exists for .journal; other types open in Raw.
 */
import { h, parseUri, extOf } from "../core.js";
import { parseJournal, formatAmount, buildTransactionText, listAccounts } from "../preview-parser.js";

const fmtDate = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
};
const monthLabel = (iso) => {
  const [y, m] = iso.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "short", year: "numeric" });
};

export default {
  async mount(view, { host, assets, contrib }) {
    const name = () => parseUri(view.uri).path;
    const [html, menuHtml] = await Promise.all([assets.text(contrib.template), assets.text(contrib.menuTemplate)]);

    const root = h("div", { class: "jv" });
    root.innerHTML = html;
    view.container.append(root);
    view.menubar.innerHTML = menuHtml;
    const bar = view.menubar;

    const $ = (sel) => root.querySelector(sel);
    const slot = (n) => root.querySelector(`[data-slot="${n}"]`);
    const bslot = (n) => bar.querySelector(`[data-slot="${n}"]`);
    const ta = slot("text"), gutter = slot("gutter");

    /* ---------- state ---------- */
    let text = host.files.get(name())?.content ?? "";
    let savedText = text;
    const canRender = () => extOf(name()) === ".journal";
    let mode = canRender() ? host.settings.get("defaultView") : "raw";
    let filters = { account: "", desc: "", from: "", to: "", min: "", max: "" };
    let sort = "date-desc";
    let query = "";
    const recent = [];
    const isDirty = () => text !== savedText;

    /* ---------- filtering ---------- */
    const matches = (t) => {
      const f = filters, q = query.trim().toLowerCase();
      if (f.account && !t.postings.some((p) => p.account.toLowerCase().includes(f.account.toLowerCase()))) return false;
      if (f.desc && !t.description.toLowerCase().includes(f.desc.toLowerCase())) return false;
      if (f.from && t.date < f.from) return false;
      if (f.to && t.date > f.to) return false;
      if (f.min !== "" && t.magnitude < Number(f.min)) return false;
      if (f.max !== "" && t.magnitude > Number(f.max)) return false;
      if (q && ![t.description, t.date, ...t.postings.map((p) => p.account)].some((s) => s.toLowerCase().includes(q))) return false;
      return true;
    };
    const sorters = {
      "date-desc": (a, b) => b.date.localeCompare(a.date) || b.start - a.start,
      "date-asc": (a, b) => a.date.localeCompare(b.date) || a.start - b.start,
      "desc-asc": (a, b) => a.description.localeCompare(b.description),
      "amount-desc": (a, b) => b.magnitude - a.magnitude,
    };
    const filtersActive = () => Object.values(filters).some((v) => v !== "") || sort !== "date-desc";

    /* ---------- rendering ---------- */
    function renderStats(all) {
      const latest = all.reduce((m, t) => (t.date > m ? t.date : m), "");
      const month = latest.slice(0, 7);
      let assets_ = 0, expenses = 0, income = 0;
      for (const t of all) for (const p of t.postings) {
        const a = p.amount ?? 0;
        if (p.account.startsWith("assets")) assets_ += a;
        if (t.date.startsWith(month) && p.account.startsWith("expenses")) expenses += a;
        if (t.date.startsWith(month) && p.account.startsWith("income")) income -= a;
      }
      const card = (label, value, cls = "") => h("div", { class: "jv-stat" },
        h("div", { class: "jv-stat__label" }, label), h("div", { class: `jv-stat__value ${cls}` }, formatAmount(value)));
      const when = latest ? ` · ${monthLabel(latest)}` : "";
      slot("stats").replaceChildren(card("Assets", assets_), card(`Expenses${when}`, expenses, "jv-stat__value--neg"), card(`Income${when}`, income, "jv-stat__value--pos"));
    }

    function txnCard(t) {
      return h("article", { class: "jv-txn" },
        h("div", { class: "jv-txn__main" },
          h("div", { class: "jv-txn__desc" }, t.description || "(no description)"),
          h("div", { class: "jv-txn__date" }, fmtDate(t.date)),
          h("div", { class: "jv-txn__postings" }, t.postings.flatMap((p) => [
            h("span", {}, p.account),
            h("span", { class: `jv-txn__amount${p.inferred ? " jv-txn__amount--inferred" : ""}`, title: p.inferred ? "Inferred" : null },
              p.amount == null ? "" : formatAmount(p.amount, p.commodity ?? "₹")),
          ]))),
        h("div", { class: "jv-txn__actions" },
          h("button", { class: "btn btn--small", type: "button", dataset: { act: "edit-txn", start: t.start } }, "Edit"),
          h("button", { class: "btn btn--small btn--danger", type: "button", dataset: { act: "delete-txn", start: t.start } }, "Delete")));
    }

    function renderList() {
      const { transactions } = parseJournal(text);
      renderStats(transactions);
      const shown = transactions.filter(matches).sort(sorters[sort]);
      const listEl = slot("list"), emptyEl = slot("empty");
      const dateGrouped = sort.startsWith("date");
      const nodes = [];
      let lastDate = null;
      for (const t of shown) {
        if (dateGrouped && t.date !== lastDate) { nodes.push(h("h2", { class: "jv__date" }, fmtDate(t.date))); lastDate = t.date; }
        nodes.push(txnCard(t));
      }
      listEl.replaceChildren(...nodes);
      emptyEl.hidden = shown.length > 0;
      if (!shown.length) {
        emptyEl.replaceChildren(transactions.length
          ? h("p", {}, "No transactions match your filters or search.")
          : h("p", {}, "No transactions yet. Add one to get started."));
      }
      const sync = host.sync.statusOf(name());
      const where = sync === "synced" ? "synced to Drive" : sync === "error" ? "Drive sync failed" : "saved on this device";
      const count = shown.length === transactions.length ? `${transactions.length} transactions` : `${shown.length} of ${transactions.length} transactions shown`;
      slot("meta").textContent = `${count} · ${isDirty() ? "unsaved changes" : where}`;
      return shown.length;
    }

    function updateGutter() {
      const n = ta.value.split("\n").length;
      gutter.textContent = Array.from({ length: n }, (_, i) => i + 1).join("\n");
    }
    function updateStatus() {
      slot("status-view").textContent = `View: ${mode === "raw" ? "Raw" : "Rendered"}`;
      slot("status-saved").textContent = isDirty() ? "Unsaved" : "Saved";
      const pos = ta.selectionStart, before = ta.value.slice(0, pos);
      slot("status-pos").textContent = mode === "raw" ? `Ln ${before.split("\n").length}, Col ${pos - before.lastIndexOf("\n")}` : "";
    }

    function render() {
      slot("title").textContent = name();
      $('[data-pane="rendered"]').hidden = mode !== "rendered";
      $('[data-pane="raw"]').hidden = mode !== "raw";
      bar.querySelectorAll('[name="view"]').forEach((r) => {
        r.checked = r.value === mode;
        if (r.value === "rendered") { r.disabled = !canRender(); r.parentElement.classList.toggle("is-disabled", !canRender()); }
      });
      const fb = bar.querySelector('[data-needs="rendered"]');
      fb.disabled = mode !== "rendered";
      fb.title = mode !== "rendered" ? "Filters and sorts apply to the rendered view" : "";
      if (mode === "rendered") renderList();
      else { if (ta.value !== text) ta.value = text; updateGutter(); }
      gutter.hidden = !host.settings.get("lineNumbers");
      updateStatus();
      updateSearchCount();
    }

    function setMode(m) {
      if (m === "rendered" && !canRender()) return;
      mode = m;
      closeMenus();
      render();
    }

    /* ---------- editing ---------- */
    function commit(next) {                  // rendered-view edits save immediately
      text = next;
      host.files.write(name(), text);
      savedText = text;
      view.setDirty(false);
      render();
    }
    const lines = () => text.split("\n");

    async function openTxnDialog(txn) {
      const result = await host.dialogs.openTemplate("dialogs/add-transaction.html", {
        controller: "dialogs/add-transaction.js", label: txn ? "Edit transaction" : "Add transaction", wide: true,
        params: { accounts: listAccounts(text), txn },
      });
      if (!result) return;
      if (txn) {
        const l = lines();
        l.splice(txn.start, txn.end - txn.start + 1, ...result.text.split("\n"));
        commit(l.join("\n"));
      } else {
        commit(`${text.replace(/\s*$/, "")}\n\n${result.text}\n`);
      }
    }

    root.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === "rename") await host.actions.rename(name());
      else if (act === "delete") await host.actions.remove(name());
      else if (act === "add-txn") await openTxnDialog(null);
      else if (act === "edit-txn" || act === "delete-txn") {
        const t = parseJournal(text).transactions.find((x) => x.start === Number(btn.dataset.start));
        if (!t) return;
        if (act === "edit-txn") await openTxnDialog(t);
        else if (await host.dialogs.confirm({ title: "Delete transaction?", message: `${fmtDate(t.date)} · ${t.description}`, confirmLabel: "Delete", danger: true })) {
          const l = lines();
          const trailingBlank = l[t.end + 1]?.trim() === "" ? 1 : 0;
          l.splice(t.start, t.end - t.start + 1 + trailingBlank);
          commit(l.join("\n"));
        }
      }
    });

    ta.addEventListener("input", () => {
      text = ta.value;
      view.setDirty(isDirty());
      updateGutter(); updateStatus(); updateSearchCount();
    });
    for (const ev of ["keyup", "click", "select"]) ta.addEventListener(ev, updateStatus);
    ta.addEventListener("scroll", () => { gutter.scrollTop = ta.scrollTop; });

    async function save() {
      if (!isDirty()) return;
      host.files.write(name(), text);
      savedText = text;
      view.setDirty(false);
      render();
    }

    /* ---------- menu bar ---------- */
    const items = [...bar.querySelectorAll(".menubar__item")];
    function closeMenus(except = null) {
      for (const it of items) if (it !== except) {
        it.querySelector(".menubar__btn").setAttribute("aria-expanded", "false");
        it.querySelector(".menubar__panel").hidden = true;
      }
    }
    bar.addEventListener("click", (e) => {
      const btn = e.target.closest(".menubar__btn");
      if (btn && !btn.disabled) {
        const item = btn.closest(".menubar__item");
        const wasOpen = btn.getAttribute("aria-expanded") === "true";
        closeMenus(wasOpen ? null : item);
        btn.setAttribute("aria-expanded", String(!wasOpen));
        item.querySelector(".menubar__panel").hidden = wasOpen;
        if (!wasOpen) item.querySelector("input:not([type=radio]):not([disabled])")?.focus();
        return;
      }
      const rep = e.target.closest("[data-report]");
      if (rep) {
        const type = rep.dataset.report;
        closeMenus();
        if (type === "export") host.actions.export(name());
        else if (type === "clear") host.reports.clear();
        else host.reports.run(type, { file: name(), query: bar.querySelector('[name="query"]').value.trim() });
        return;
      }
      const chip = e.target.closest("[data-recent]");
      if (chip) { const s = bar.querySelector('[name="search"]'); s.value = chip.dataset.recent; s.dispatchEvent(new Event("input")); }
      if (e.target.closest('[data-act="clear-filters"]')) {
        bar.querySelector("form").reset();
        filters = { account: "", desc: "", from: "", to: "", min: "", max: "" }; sort = "date-desc";
        render();
      }
    });
    bar.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenus(); });
    const onOutside = (e) => { if (!bar.contains(e.target)) closeMenus(); };
    document.addEventListener("pointerdown", onOutside);

    bar.querySelector("form").addEventListener("submit", (e) => {
      e.preventDefault();
      const fd = new FormData(e.currentTarget);
      filters = Object.fromEntries(["account", "desc", "from", "to", "min", "max"].map((k) => [k, String(fd.get(k) ?? "").trim()]));
      sort = fd.get("sort") || "date-desc";
      closeMenus();
      render();
    });
    bar.querySelectorAll('[name="view"]').forEach((r) => r.addEventListener("change", () => setMode(r.value)));

    function updateSearchCount() {
      const out = bslot("search-count");
      const q = query.trim();
      if (!q) { out.textContent = ""; return; }
      const n = mode === "rendered"
        ? parseJournal(text).transactions.filter(matches).length
        : text.toLowerCase().split(q.toLowerCase()).length - 1;
      out.textContent = `${n} ${n === 1 ? "match" : "matches"}`;
    }
    const searchInput = bar.querySelector('[name="search"]');
    searchInput.addEventListener("input", () => {
      query = searchInput.value;
      if (mode === "rendered") renderList();
      updateSearchCount();
    });
    searchInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const q = query.trim();
      if (!q) return;
      const i = recent.indexOf(q); if (i >= 0) recent.splice(i, 1);
      recent.unshift(q); recent.length = Math.min(recent.length, 5);
      bslot("recent-group").hidden = false;
      bslot("recent").replaceChildren(...recent.map((r) => h("button", { class: "chip", type: "button", dataset: { recent: r } }, r)));
      if (mode === "raw") {                       // jump to next occurrence
        const hay = ta.value.toLowerCase();
        let at = hay.indexOf(q.toLowerCase(), ta.selectionEnd);
        if (at < 0) at = hay.indexOf(q.toLowerCase());
        if (at >= 0) { closeMenus(); ta.focus(); ta.setSelectionRange(at, at + q.length); }
      }
    });

    /* ---------- reactions to the outside world ---------- */
    const offFiles = host.files.on("changed", (ev) => {
      if (ev.name !== name()) return;
      const f = host.files.get(name());
      if (f && f.content !== savedText && !isDirty()) { text = savedText = f.content; }
      render();
    });
    const offSync = host.sync.on("changed", () => mode === "rendered" && renderList());
    const offAuth = host.auth.on("changed", () => mode === "rendered" && renderList());
    const offLines = host.settings.onChange("lineNumbers", () => { gutter.hidden = !host.settings.get("lineNumbers"); });

    render();

    return {
      save,
      onHide: () => closeMenus(),
      dispose() {
        document.removeEventListener("pointerdown", onOutside);
        offFiles(); offSync(); offAuth(); offLines();
      },
    };
  },
};
