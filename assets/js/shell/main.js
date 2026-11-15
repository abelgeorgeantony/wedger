/* main.js — bootstrap. Order matters: settings -> manifest -> host (files, sign-in) -> editors -> sidebar -> tabs.
 * The accounting engine downloads in the background; the shell is usable straight away. */
import { registry } from "./registry.js";
import { host } from "./host.js";
import { engine } from "./engine.js";
import { editors } from "./editor-service.js";
import { initSidebar } from "./sidebar.js";
import { fileUri, parseUri } from "./core.js";

const $ = (id) => document.getElementById(id);
const TABS_KEY = "wedger_open_tabs";

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

/* ---- remember which tabs were open, so a reload puts you back where you were ---- */
function saveTabs() {
  try {
    const open = editors.tabs.map((t) => t.uri);
    localStorage.setItem(TABS_KEY, JSON.stringify({ open, active: editors.active?.uri ?? null }));
  } catch { /* storage blocked */ }
}

async function restoreTabs() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(TABS_KEY) ?? "null"); } catch { /* ignore */ }
  const valid = (uri) => {
    const { scheme, path } = parseUri(uri);
    return scheme === "wedger" ? !!registry.resolve(uri) : scheme === "file" && host.files.exists(path);
  };
  const uris = (saved?.open ?? []).filter((u) => typeof u === "string" && valid(u));
  if (!uris.length) { await editors.open("wedger:welcome"); return; }
  // Tabs are added synchronously (so their order is kept) and mount in parallel.
  await Promise.all(uris.map((uri) => editors.open(uri, { focus: false })));
  await editors.open(valid(saved.active) ? saved.active : uris[0]);
}

async function boot() {
  const overlay = $("loading-overlay");
  try {
    host.settings.init();
    $("loading-details").textContent = "Loading the file viewer…";
    await registry.load();

    host.init();                                      // files, sign-in, file mirror
    engine.init().catch(() => { /* surfaced inside journal views and reports, with a Retry */ });

    editors.init({ tabs: $("file-tabs"), menuBar: $("file-menu-bar"), area: $("editor-area"), empty: $("editor-empty") }, host);
    host.bind(editors);

    // Keep open tabs truthful when files are renamed, deleted, or swapped out by a sign-in / sign-out.
    host.files.on("changed", (ev) => {
      if (ev.kind === "rename") editors.retarget(fileUri(ev.oldName), fileUri(ev.name), ev.name);
      if (ev.kind === "remove") editors.closeByUri(fileUri(ev.name));
      if (ev.kind === "reload") {
        for (const t of [...editors.tabs]) {
          const { scheme, path } = parseUri(t.uri);
          if (scheme === "file" && !host.files.exists(path)) editors.close(t.id, { force: true });
        }
      }
    });

    initSidebar({ host, editors });
    $("file-tab-options-btn").addEventListener("click", tabOptionsMenu);
    $("editor-empty").querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => host.open(b.dataset.open)));

    await restoreTabs();
    editors.on("activechange", saveTabs);
    editors.on("closed", saveTabs);
    saveTabs();

    // Don't lose unsaved raw edits to an accidental reload.
    window.addEventListener("beforeunload", (e) => {
      if (editors.tabs.some((t) => t.dirty)) { e.preventDefault(); e.returnValue = ""; }
    });

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
