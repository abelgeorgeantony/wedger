/* sidebar.js — the left sidebar: journal list, Timeline / Reports output
 * entries, Google button / avatar, settings gear, hide/show. It never
 * renders anything itself: every click is host.open(uri). */
import { h, icon, fileUri, parseUri } from "./core.js";

export function initSidebar({ host, editors }) {
  const $ = (id) => document.getElementById(id);
  const list = $("journals-list");
  const toggle = $("journals-dropdown-btn");
  const isMobile = () => window.matchMedia("(max-width: 720px)").matches;
  const hideOnMobile = () => { if (isMobile()) document.body.classList.add("sidebar-hidden"); };

  /* ---------- journal list ---------- */
  function fileItem({ name }) {
    const uri = fileUri(name);
    const status = host.sync.statusOf(name);
    const label = { synced: "Synced to Drive", error: "Sync failed", local: "Stored on this device" }[status];
    return h("li", { class: "sidebar__file", dataset: { name }, oncontextmenu: (e) => { e.preventDefault(); openMenu(name, { x: e.clientX, y: e.clientY }); } },
      h("button", { class: "sidebar__row", type: "button", dataset: { uri }, onclick: () => { host.open(uri); hideOnMobile(); } },
        icon("file"),
        h("span", { class: "sidebar__row-name" }, name),
        h("span", { class: `sync-dot sync-dot--${status}`, title: label, role: "img", "aria-label": label })),
      h("button", { class: "icon-btn sidebar__file-menu", type: "button", "aria-label": `Actions for ${name}`, "aria-haspopup": "menu",
        onclick: (e) => openMenu(name, e.currentTarget) }, icon("dots")));
  }

  function openMenu(name, anchor) {
    host.dialogs.menu(anchor, [
      { label: "Open", onSelect: () => host.open(fileUri(name)) },
      { label: "Rename", onSelect: () => host.actions.rename(name) },
      { label: "Duplicate", onSelect: () => host.actions.duplicate(name) },
      { label: "Export", onSelect: () => host.actions.export(name) },
      { separator: true },
      { label: "Delete", danger: true, onSelect: () => host.actions.remove(name) },
    ]);
  }

  function renderList() {
    const files = host.files.list();
    list.replaceChildren(...(files.length
      ? files.map(fileItem)
      : [h("li", { class: "sidebar__files-empty" }, "No journals yet. Create one or import a CSV or journal file.")]));
    markActive();
  }

  function markActive() {
    const uri = editors.active?.uri;
    document.querySelectorAll("#sidebar-left .sidebar__row[data-uri]").forEach((b) =>
      b.classList.toggle("is-active", b.dataset.uri === uri));
  }

  toggle.addEventListener("click", () => {
    const open = toggle.getAttribute("aria-expanded") !== "false";
    toggle.setAttribute("aria-expanded", String(!open));
    list.hidden = open;
  });

  /* ---------- entries that open special files ---------- */
  document.querySelectorAll("#sidebar-left [data-open]").forEach((b) =>
    b.addEventListener("click", () => { host.open(b.dataset.open); hideOnMobile(); }));

  /* ---------- footer: auth + sync status ---------- */
  function renderFooter() {
    const user = host.auth.user;
    $("google-login-btn").hidden = !!user;
    $("user-profile-container").hidden = !user;
    $("sidebar-sync-status").hidden = !user;
    if (user) {
      const avatar = $("user-avatar");
      avatar.replaceChildren(user.picture
        ? h("img", { src: user.picture, alt: "", referrerpolicy: "no-referrer" })
        : document.createTextNode(user.name.charAt(0).toUpperCase()));
      $("user-avatar-btn").title = `${user.name} — Google settings`;
      const failed = host.files.list().some((f) => host.sync.statusOf(f.name) === "error");
      $("sidebar-sync-status").replaceChildren(
        h("span", { class: `sync-dot sync-dot--${failed ? "error" : "synced"}` }),
        failed ? "Sync problem" : "Synced to Drive");
    }
  }
  $("google-login-btn").addEventListener("click", () => host.auth.signIn());
  $("user-avatar-btn").addEventListener("click", () => host.open("wedger:google-settings"));
  $("settings-btn").addEventListener("click", () => host.open("wedger:settings"));

  /* ---------- show / hide ---------- */
  const setHidden = (hidden) => {
    document.body.classList.toggle("sidebar-hidden", hidden);
    $("show-sidebar-btn").hidden = !hidden;
  };
  $("slide-btn").addEventListener("click", () => setHidden(true));
  $("show-sidebar-btn").addEventListener("click", () => setHidden(false));
  // tapping the dimmed area on phones closes the slide-over
  $("workbench").addEventListener("click", (e) => {
    if (isMobile() && !document.body.classList.contains("sidebar-hidden") && e.target === $("workbench")) setHidden(true);
  });
  new MutationObserver(() => { $("show-sidebar-btn").hidden = !document.body.classList.contains("sidebar-hidden"); })
    .observe(document.body, { attributes: true, attributeFilter: ["class"] });
  if (isMobile()) setHidden(true);

  /* ---------- wiring ---------- */
  host.files.on("changed", () => { renderList(); renderFooter(); });
  host.auth.on("changed", () => { renderList(); renderFooter(); });
  host.sync.on("changed", () => { renderList(); renderFooter(); });
  editors.on("activechange", markActive);
  renderList();
  renderFooter();
}
