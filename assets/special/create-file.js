/* special/create-file.js — the "Create file" wizard.
 * Creates the file, opens it in the viewer, then closes its own tab. */
import { h, fileUri } from "../js/shell/core.js";
import { templatesFor, resolveTemplate, previewOf as previewTemplate } from "../js/shell/templates.js";

const RULES_STARTER = "skip 1\nfields date, description, amount\ndate-format %d/%m/%Y\ncurrency ₹\naccount1 assets:bank\n";

export async function mount({ root, view, host, assets }) {
  const form = root.querySelector('[data-slot="form"]');
  const grid = root.querySelector('[data-slot="templates"]');
  const errorEl = root.querySelector('[data-slot="error"]');
  const year = String(new Date().getFullYear());
  let selected = "blank";
  let templates = [];

  const resolve = (t) => resolveTemplate(t, year);
  const previewOf = (t) => previewTemplate(t, year);
  const showError = (msg) => {
    errorEl.textContent = msg ?? ""; errorEl.hidden = !msg;
    form.elements.name.toggleAttribute("aria-invalid", !!msg);
  };

  function renderTemplates() {
    // Only templates made for the chosen type are offered: journal templates never appear for .timeclock / .timedot.
    const usable = templatesFor(templates, form.elements.ext.value);
    if (!usable.some((t) => t.id === selected)) selected = "blank";
    grid.replaceChildren(...usable.map((t) =>
      h("label", { class: `template-card${t.id === selected ? " is-selected" : ""}` },
        h("input", { type: "radio", name: "template", value: t.id, checked: t.id === selected }),
        h("pre", { class: "template-card__preview", "aria-hidden": "true" }, previewOf(t)),
        h("span", { class: "template-card__name" }, t.name),
        h("span", { class: "template-card__desc" }, t.description))));
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

    try {
      const tpl = templatesFor(templates, ext).find((t) => t.id === selected);
      host.files.create(name, tpl ? resolve(tpl) : "");
      if (ext === ".csv" && !host.files.exists(`${name}.rules`)) host.files.create(`${name}.rules`, RULES_STARTER);
    } catch (failure) { showError(failure.message); return; }      // e.g. device storage full
    await host.open(fileUri(name));
    view.close();
  });

  form.elements.name.focus();
}

