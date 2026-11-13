/* special/create-file.js — the "Create file" wizard.
 * Creates the file, opens it in the viewer, then closes its own tab. */
import { h, fileUri } from "../js/shell/core.js";

const RULES_STARTER = "skip 1\nfields date, description, amount\ndate-format %d/%m/%Y\ncurrency ₹\naccount1 assets:bank\n";

export async function mount({ root, view, host, assets }) {
  const form = root.querySelector('[data-slot="form"]');
  const grid = root.querySelector('[data-slot="templates"]');
  const errorEl = root.querySelector('[data-slot="error"]');
  const year = String(new Date().getFullYear());
  let selected = "blank";
  let templates = [];

  const resolve = (t) => t.content.replaceAll("{{year}}", year);
  const previewOf = (t) => {
    const lines = resolve(t).split("\n").filter((l) => l.trim());
    return lines.length ? lines.slice(0, 4).join("\n") : "Empty file";
  };
  const showError = (msg) => {
    errorEl.textContent = msg ?? ""; errorEl.hidden = !msg;
    form.elements.name.toggleAttribute("aria-invalid", !!msg);
  };

  function renderTemplates() {
    const ext = form.elements.ext.value;
    const usable = (t) => t.types.includes("*") || t.types.includes(ext);
    if (!usable(templates.find((t) => t.id === selected) ?? {})) selected = "blank";
    grid.replaceChildren(...templates.map((t) => {
      const ok = usable(t);
      return h("label", { class: `template-card${t.id === selected ? " is-selected" : ""}${ok ? "" : " is-disabled"}` },
        h("input", { type: "radio", name: "template", value: t.id, checked: t.id === selected, disabled: !ok }),
        h("pre", { class: "template-card__preview", "aria-hidden": "true" }, previewOf(t)),
        h("span", { class: "template-card__name" }, t.name),
        h("span", { class: "template-card__desc" }, t.description));
    }));
  }

  templates = await assets.json("special/templates.json");
  renderTemplates();

  grid.addEventListener("change", (e) => { selected = e.target.value; renderTemplates(); });
  form.elements.ext.addEventListener("change", renderTemplates);
  form.elements.name.addEventListener("input", () => showError(null));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const ext = form.elements.ext.value;
    const base = form.elements.name.value.trim();
    const name = base.toLowerCase().endsWith(ext) ? base : `${base}${ext}`;
    const err = base ? host.files.validateName(name) : "Give the file a name.";
    if (err) { showError(err); form.elements.name.focus(); return; }

    const tpl = templates.find((t) => t.id === selected);
    host.files.create(name, tpl ? resolve(tpl) : "");
    if (ext === ".csv" && !host.files.exists(`${name}.rules`)) host.files.create(`${name}.rules`, RULES_STARTER);
    await host.open(fileUri(name));
    view.close();
  });

  form.elements.name.focus();
}
