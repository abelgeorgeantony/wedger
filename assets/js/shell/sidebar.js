/* sidebar.js — the left sidebar: file list, Timeline / Reports output entries,
 * account area, settings gear, hide/show. It never renders anything itself:
 * every click is host.open(uri). */
import { h, icon, fileUri } from "./core.js";

export function initSidebar({ host, editors }) {
  const $ = (id) => document.getElementById(id);
  const list = $("journals-list");
  const toggle = $("journals-dropdown-btn");
  const isMobile = () => window.matchMedia("(max-width: 720px)").matches;
  const hideOnMobile = () => { if (isMobile()) setHidden(true); };

  /* ---------- file list ---------- */
  function fileItem({ name }) {
    const uri = fileUri(name);
    const failed = host.sync.statusOf(name) === "error";
    return h("li", { class: "sidebar__file", dataset: { name }, oncontextmenu: (e) => { e.preventDefault(); openMenu(name, { x: e.clientX, y: e.clientY }); } },
      h("button", { class: "sidebar__row", type: "button", dataset: { uri }, title: name, onclick: () => { host.open(uri); hideOnMobile(); } },
        icon("file"),
        h("span", { class: "sidebar__row-name" }, name)),
      // Only problems get a marker. A healthy file shows nothing.
      failed && h("span", { class: "sidebar__flag", role: "img", title: host.sync.errorOf(name) ?? "Sync failed", "aria-label": "Sync failed" }, icon("warning")),
      h("button", { class: "icon-btn sidebar__file-menu", type: "button", "aria-label": `Actions for ${name}`, "aria-haspopup": "menu",
        onclick: (e) => openMenu(name, e.currentTarget) }, icon("dots")));
  }

  function openMenu(name, anchor) {
    host.dialogs.menu(anchor, [
      { label: "Open", onSelect: () => host.open(fileUri(name)) },
      { label: "Rename", onSelect: () => host.actions.rename(name) },
      { label: "Duplicate", onSelect: () => host.actions.duplicate(name) },
      { label: "Download", onSelect: () => host.actions.export(name) },
      { separator: true },
      { label: "Delete", danger: true, onSelect: () => host.actions.remove(name) },
    ]);
  }

  function renderList() {
    const files = host.files.list();
    list.replaceChildren(...(files.length
      ? files.map(fileItem)
      : [h("li", { class: "sidebar__files-empty" }, "No files yet. Create one, or import a journal or CSV.")]));
    markActive();
  }

  function markActive() {
    const uri = editors.active?.uri;
    document.querySelectorAll("#sidebar-left .sidebar__row[data-uri]").forEach((b) => {
      const on = b.dataset.uri === uri;
      b.classList.toggle("is-active", on);
      if (on) b.setAttribute("aria-current", "true"); else b.removeAttribute("aria-current");
    });
  }

  toggle.addEventListener("click", () => {
    const open = toggle.getAttribute("aria-expanded") !== "false";
    toggle.setAttribute("aria-expanded", String(!open));
    list.hidden = open;
  });

  /* ---------- entries that open special files ---------- */
  document.querySelectorAll("#sidebar-left [data-open]").forEach((b) =>
    b.addEventListener("click", () => { host.open(b.dataset.open); hideOnMobile(); }));

  /* ---------- footer: account + settings ---------- */
  function renderFooter() {
    const user = host.auth.user;
    $("google-login-btn").hidden = !!user;
    $("user-profile-container").hidden = !user;
    if (!user) return;
    const name = user.name || user.email;
    $("user-avatar").replaceChildren(user.picture
      ? h("img", { src: user.picture, alt: "", referrerpolicy: "no-referrer" })
      : document.createTextNode(name.charAt(0).toUpperCase()));
    $("user-name").textContent = name;
    $("user-email").textContent = user.email;
    $("user-avatar-btn").title = `${name} — Google settings`;
  }
  $("google-login-btn").addEventListener("click", () => host.auth.signIn());
  $("user-avatar-btn").addEventListener("click", () => { host.open("wedger:google-settings"); hideOnMobile(); });
  $("settings-btn").addEventListener("click", () => { host.open("wedger:settings"); hideOnMobile(); });

  /* ---------- show / hide ---------- */
  function setHidden(hidden) {
    document.body.classList.toggle("sidebar-hidden", hidden);
    $("show-sidebar-btn").hidden = !hidden;
  }
  $("slide-btn").addEventListener("click", () => setHidden(true));
  $("show-sidebar-btn").addEventListener("click", () => setHidden(false));
  // tapping the dimmed area on phones closes the slide-over
  $("workbench").addEventListener("click", (e) => {
    if (isMobile() && !document.body.classList.contains("sidebar-hidden") && e.target === $("workbench")) setHidden(true);
  });
  if (isMobile()) setHidden(true);

  /* ---------- wiring ---------- */
  // The list only needs repainting when names or sync problems change, not on every keystroke-save.
  let lastKey = "";
  const keyOf = () => host.files.list().map((f) => `${f.name}:${host.sync.statusOf(f.name) === "error"}`).join("|");
  const repaintIfNeeded = () => { const k = keyOf(); if (k !== lastKey) { lastKey = k; renderList(); } };
  host.files.on("changed", repaintIfNeeded);
  host.sync.on("changed", repaintIfNeeded);
  host.auth.on("changed", () => { lastKey = ""; repaintIfNeeded(); renderFooter(); });
  editors.on("activechange", markActive);
  lastKey = keyOf();
  renderList();
  renderFooter();
}
