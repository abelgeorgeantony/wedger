/* main.js — bootstrap. Order matters: settings -> manifest -> host (files, sign-in) -> editors -> sidebar -> tabs.
 * The accounting engine downloads in the background; the shell is usable straight away. */
import { registry } from "./registry.js";
import { host } from "./host.js";
import { engine } from "./engine.js";
import { editors } from "./editor-service.js";
import { initSidebar } from "./sidebar.js";
import { shortcuts } from "./keyboard-shortcuts.js";
import { fileUri, parseUri } from "./core.js";

const $ = (id) => document.getElementById(id);
const TABS_KEY = "wedger_open_tabs";

function tabOptionsMenu() {
  const hasTabs = editors.tabs.length > 0;
  const closeKeys = shortcuts.get("closeTab");                  // read when the menu opens, so it is never stale
  host.dialogs.menu($("file-tab-options-btn"), [
    { label: "Close tab", shortcut: closeKeys ? shortcuts.label(closeKeys) : null, disabled: !hasTabs, onSelect: () => editors.activeId && editors.close(editors.activeId) },
    { label: "Close other tabs", disabled: editors.tabs.length < 2, onSelect: () => editors.closeWhere((t) => t.id !== editors.activeId) },
    { label: "Close all tabs", disabled: !hasTabs, onSelect: () => editors.closeWhere(() => true) },
    { separator: true },
    { label: "Move tab left", disabled: !hasTabs || editors.tabs[0]?.id === editors.activeId, onSelect: () => editors.activeId && editors.moveBy(editors.activeId, -1) },
    { label: "Move tab right", disabled: !hasTabs || editors.tabs[editors.tabs.length - 1]?.id === editors.activeId, onSelect: () => editors.activeId && editors.moveBy(editors.activeId, 1) },
    { separator: true },
    { label: "Open Welcome", onSelect: () => host.open("wedger:welcome") },
  ]);
}

/* ---- keyboard shortcuts: one listener, real commands, each safe to fire when it doesn't apply ---- */
function initShortcuts() {
  const view = () => editors.active?.instance ?? null;
  shortcuts.attach({
    save: { run: () => editors.saveActive() },                                   // always handled, so the browser's own "save page" never pops up
    focusSearch: { isEnabled: () => view()?.canFocusSearch?.() === true, run: () => view().focusSearch() },
    addTransaction: { isEnabled: () => view()?.canAddTransaction?.() === true, run: () => view().addTransaction() },
    newFile: { run: () => host.open("wedger:create-file") },
    nextTab: { isEnabled: () => editors.tabs.length > 1, run: () => editors.activateRelative(1) },
    prevTab: { isEnabled: () => editors.tabs.length > 1, run: () => editors.activateRelative(-1) },
    closeTab: { isEnabled: () => !!editors.activeId, run: () => editors.close(editors.activeId) },   // asks first when there are unsaved changes
    openSettings: { run: () => host.open("wedger:settings") },
  });
  shortcuts.init();
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
  const uris = host.settings.get("restoreTabs") ? (saved?.open ?? []).filter((u) => typeof u === "string" && valid(u)) : [];
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
    initShortcuts();

    // Keep open tabs truthful when files are renamed, deleted, or swapped out by a sign-in / sign-out.
    host.files.on("changed", (ev) => {
      if (ev.kind === "rename") {
        const [oldUri, newUri] = [fileUri(ev.oldName), fileUri(ev.name)];
        const tab = editors.tabs.find((t) => t.uri === oldUri);
        editors.retarget(oldUri, newUri, ev.name);
        // Renaming across kinds (e.g. work.journal -> work.timeclock) needs a different viewer: save, close, reopen.
        const wanted = registry.resolve(newUri);
        if (tab && wanted && tab.contrib?.viewType !== wanted.viewType) {
          const focus = editors.activeId === tab.id;
          Promise.resolve(tab.instance?.save?.()).catch(() => {}).then(() => editors.close(tab.id, { force: true })).then(() => editors.open(newUri, { focus }));
        }
      }
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
    editors.on("reordered", saveTabs);
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

