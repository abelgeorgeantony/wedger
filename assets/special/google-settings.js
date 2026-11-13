/* special/google-settings.js — account + Drive sync status. Mock data in the UI phase. */
import { h } from "../js/shell/core.js";

export function mount({ root, host }) {
  const slot = (n) => root.querySelector(`[data-slot="${n}"]`);
  const toggle = root.querySelector('[data-setting="syncAuto"]');
  const refreshBtn = slot("refresh");

  const ago = (t) => {
    if (!t) return "Never synced";
    const m = Math.round((Date.now() - t) / 60000);
    return m < 1 ? "Last sync just now" : `Last sync ${m} ${m === 1 ? "minute" : "minutes"} ago`;
  };

  function render() {
    const user = host.auth.user;
    if (!user) return;
    slot("email").textContent = user.email;
    slot("name").textContent = user.name;
    slot("email2").textContent = user.email;
    slot("avatar").textContent = user.name.charAt(0).toUpperCase();
    slot("last-sync").textContent = ago(host.sync.lastSync);

    const files = host.files.list();
    const failed = files.filter((f) => host.sync.statusOf(f.name) === "error");
    const summary = slot("summary");
    summary.className = `banner ${failed.length ? "banner--error" : "banner--ok"}`;
    summary.textContent = files.length === 0 ? "No files to sync yet."
      : failed.length ? `${failed.length} ${failed.length === 1 ? "file" : "files"} failed to sync.` : "All files synced.";

    slot("files").replaceChildren(...files.map((f) => {
      const status = host.sync.statusOf(f.name);
      const err = host.sync.errorOf(f.name);
      return h("li", { class: "gs__file gs__file-wrap" },
        h("span", {}, f.name),
        h("span", { class: `pill ${status === "synced" ? "pill--ok" : status === "error" ? "pill--error" : "pill--muted"}` },
          status === "synced" ? "Synced" : status === "error" ? "Upload failed" : "Local only"),
        err && h("div", { class: "banner banner--error gs__file-err", role: "alert" }, err));
    }));
    toggle.checked = host.settings.get("syncAuto");
  }

  toggle.addEventListener("change", () => host.settings.set("syncAuto", toggle.checked));
  refreshBtn.addEventListener("click", async () => {
    refreshBtn.classList.add("is-busy");
    refreshBtn.replaceChildren(h("span", { class: "spinner spinner--inline" }), " Refreshing…");
    await host.sync.refresh();
    refreshBtn.classList.remove("is-busy");
    refreshBtn.replaceChildren(h("span", { class: "icon icon--refresh", "aria-hidden": "true" }), " Refresh");
  });

  const offs = [host.auth.on("changed", render), host.files.on("changed", render), host.sync.on("changed", render), host.settings.onChange("syncAuto", render)];
  render();
  return { dispose: () => offs.forEach((off) => off()) };
}
