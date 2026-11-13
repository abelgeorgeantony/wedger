/* special/import-file.js — import from local files / CSV.
 * Journal files import as-is. CSV goes through host.engine.convertCsv (a stub in the UI phase). */
import { h, extOf, fileUri } from "../js/shell/core.js";

export function mount({ root, view, host }) {
  const form = root.querySelector('[data-slot="form"]');
  const slot = (n) => root.querySelector(`[data-slot="${n}"]`);
  const el = form.elements;
  let picked = null;   // { name, text }
  const isCsv = () => picked && extOf(picked.name) === ".csv";

  const showError = (msg) => { const b = slot("error"); b.textContent = msg ?? ""; b.hidden = !msg; if (msg) b.scrollIntoView({ block: "nearest" }); };

  function renderTargets() {
    const files = host.files.list();
    el.target.replaceChildren(...files.map((f) => h("option", { value: f.name }, f.name)));
    el.target.disabled = files.length === 0;
  }

  function refresh() {
    slot("rules-step").hidden = !isCsv();
    slot("dest-title").textContent = isCsv() ? "3 · Destination" : "2 · Destination";
    slot("file-name").textContent = picked ? picked.name : "No file chosen · .journal, .timeclock, .timedot or .csv";
  }

  async function pick(file) {
    showError(null);
    if (!file) return;
    if (![".journal", ".timeclock", ".timedot", ".csv"].includes(extOf(file.name))) {
      picked = null; refresh();
      return showError("That file type isn't supported. Choose a .journal, .timeclock, .timedot or .csv file.");
    }
    picked = { name: file.name, text: await file.text() };
    if (!el.newName.value) el.newName.value = host.files.exists(picked.name) ? "" : picked.name;
    refresh();
  }

  el.file.addEventListener("change", () => pick(el.file.files[0]));
  const dz = slot("dropzone");
  dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("is-over"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("is-over"));
  dz.addEventListener("drop", (e) => { e.preventDefault(); dz.classList.remove("is-over"); pick(e.dataTransfer.files[0]); });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    showError(null);
    el.rules.removeAttribute("aria-invalid");
    if (!picked) return showError("Can't import yet. Choose a file first.");
    if (isCsv() && !el.rules.value.trim()) {
      el.rules.setAttribute("aria-invalid", "true");
      return showError("Can't import yet. CSV files need CSV rules.");
    }

    const dest = el.dest.value;
    let targetName;
    if (dest === "new") {
      targetName = host.files.normalize(el.newName.value, isCsv() ? ".journal" : extOf(picked.name));
      const err = host.files.validateName(targetName);
      if (err) return showError(err);
    } else {
      targetName = el.target.value;
      if (!targetName) return showError("There are no files to append to. Import as a new file instead.");
    }

    const btn = slot("submit");
    btn.classList.add("is-busy");
    btn.replaceChildren(h("span", { class: "spinner spinner--inline" }), " Importing…");
    try {
      const text = isCsv() ? await host.engine.convertCsv(picked.text, el.rules.value) : picked.text;
      if (dest === "new") host.files.create(targetName, text);
      else host.files.write(targetName, `${host.files.get(targetName).content.replace(/\s*$/, "")}\n\n${text}`);
      host.notify(dest === "new" ? `Imported as ${targetName}` : `Appended to ${targetName}`, "ok");
      await host.open(fileUri(targetName));
      view.close();
    } catch (err) {
      showError(err.message);
      btn.classList.remove("is-busy");
      btn.textContent = "Import";
    }
  });

  renderTargets();
  refresh();
  return { dispose: host.files.on("changed", renderTargets) };
}
