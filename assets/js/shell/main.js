/* main.js — bootstrap. Order matters: settings -> manifest -> editors -> sidebar -> welcome tab. */
import { registry } from "./registry.js";
import { host } from "./host.js";
import { editors } from "./editor-service.js";
import { initSidebar } from "./sidebar.js";
import { fileUri, parseUri } from "./core.js";

const $ = (id) => document.getElementById(id);

function tabOptionsMenu() {
  const hasTabs = editors.tabs.length > 0;
  host.dialogs.menu($("file-tab-options-btn"), [
    { label: "Close tab", disabled: !hasTabs, onSelect: () => editors.activeId && editors.close(editors.activeId) },
    { label: "Close other tabs", disabled: editors.tabs.length < 2, onSelect: () => editors.closeWhere((t) => t.id !== editors.activeId) },
    { label: "Close all tabs", disabled: !hasTabs, onSelect: () => editors.closeWhere(() => true) },
    { separator: true },
    { label: "Open Welcome", onSelect: () => host.open("wedger:welcome") },
  ]);
}

async function boot() {
  const overlay = $("loading-overlay");
  try {
    host.settings.init();
    $("loading-details").textContent = "Loading the file viewer…";
    await registry.load();

    editors.init({ tabs: $("file-tabs"), menuBar: $("file-menu-bar"), area: $("editor-area"), empty: $("editor-empty") }, host);
    host.bind(editors);

    // Keep open tabs truthful when files are renamed or deleted.
    host.files.on("changed", (ev) => {
      if (ev.kind === "rename") editors.retarget(fileUri(ev.oldName), fileUri(ev.name), ev.name);
      if (ev.kind === "remove") editors.closeByUri(fileUri(ev.name));
    });

    initSidebar({ host, editors });
    $("file-tab-options-btn").addEventListener("click", tabOptionsMenu);
    $("editor-empty").querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => host.open(b.dataset.open)));

    await editors.open("wedger:welcome");
    overlay.hidden = true;
  } catch (err) {
    console.error(err);
    overlay.classList.add("is-error");
    $("loading-details").textContent = `Wedger couldn't start: ${err.message} Make sure you're serving the site over http (not file://).`;
    $("loading-retry").hidden = false;
  }
}

$("loading-retry")?.addEventListener("click", () => location.reload());
boot();
