/* special/reports-output.js — lists report runs. UI phase: no engine yet, so entries are placeholders. */
import { h } from "../js/shell/core.js";

export function mount({ root, host }) {
  const slot = (n) => root.querySelector(`[data-slot="${n}"]`);
  const clear = root.querySelector('[data-act="clear"]');

  function render() {
    const entries = host.reports.entries;
    slot("empty").hidden = entries.length > 0;
    clear.disabled = entries.length === 0;
    slot("list").replaceChildren(...entries.map((e) => h("article", { class: "card ro__entry" },
      h("div", { class: "ro__entry-head" },
        h("span", { class: "ro__type" }, e.type, e.query && ` · ${e.query}`),
        h("span", { class: "ro__meta" }, `${e.file} · ${new Date(e.at).toLocaleTimeString()}`)),
      h("pre", { class: "ro__body" }, "Output will appear here once the accounting engine is connected."))));
  }

  clear.addEventListener("click", () => host.reports.clear());
  const off = host.reports.on("changed", render);
  render();
  return { dispose: off };
}
