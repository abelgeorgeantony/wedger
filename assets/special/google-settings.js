/* special/google-settings.js — account + Drive sync status, backed by host.auth and host.sync. */
import { h, relativeTime } from "../js/shell/core.js";

const STATUS_LABEL = { synced: "Synced", pending: "Waiting to sync", error: "Failed", local: "On this device" };

export function mount({ root, host }) {
  const slot = (n) => root.querySelector(`[data-slot="${n}"]`);
  const autoSwitch = root.querySelector('[data-act="auto-sync"]');

  function paintAccount() {
    const user = host.auth.user;
    if (!user) return;
    const name = user.name || user.email;
    slot("avatar").replaceChildren(user.picture ? h("img", { src: user.picture, alt: "", referrerpolicy: "no-referrer" }) : document.createTextNode(name.charAt(0).toUpperCase()));
    slot("name").textContent = name;
    slot("email").textContent = user.email;
  }

  function paintSync() {
    if (!host.auth.user) return;
    const { sync } = host;
    const failed = host.files.list().filter((f) => sync.statusOf(f.name) === "error").length;
    const main = slot("sync-main"), sub = slot("sync-sub"), btn = root.querySelector('[data-act="sync-now"]');
    if (sync.syncing) { main.textContent = "Syncing…"; sub.textContent = "Talking to Google Drive."; }
    else if (failed) { main.textContent = `${failed} ${failed === 1 ? "file" : "files"} couldn't sync`; sub.textContent = "Details are listed below. Sync now to try again."; }
    else if (sync.pending) { main.textContent = `${sync.pending} ${sync.pending === 1 ? "change" : "changes"} waiting`; sub.textContent = host.settings.get("syncAuto") ? "They'll upload in a moment." : "Automatic sync is off. Use Sync now."; }
    else { main.textContent = "Everything is up to date"; sub.textContent = sync.lastSync ? `Last synced ${relativeTime(sync.lastSync)}.` : "Not synced yet in this session."; }
    btn.disabled = sync.syncing;
    slot("sync-btn-label").textContent = sync.syncing ? "Syncing…" : "Sync now";
    autoSwitch.checked = !!host.settings.get("syncAuto");
  }

  function paintFiles() {
    const box = slot("files");
    if (!host.auth.user) return;
    const files = host.files.list();
    if (!files.length) { box.replaceChildren(h("p", { class: "gs-note", style: "margin:0" }, "No files yet.")); return; }
    box.replaceChildren(h("table", { class: "gs-files" },
      h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "File"), h("th", { scope: "col" }, "Edited"), h("th", { scope: "col" }, "Status"))),
      h("tbody", {}, ...files.map((f) => {
        const st = host.sync.statusOf(f.name);
        const err = host.sync.errorOf(f.name);
        return h("tr", {},
          h("td", { class: "gs-files__name" }, f.name, err && h("div", { class: "gs-files__err" }, err)),
          h("td", {}, relativeTime(f.modified)),
          h("td", {}, h("span", { class: `pill${st === "synced" ? " pill--ok" : st === "error" ? " pill--error" : ""}` }, STATUS_LABEL[st])));
      }))));
  }

  const paint = () => { paintAccount(); paintSync(); paintFiles(); };

  root.addEventListener("click", async (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "sync-now") { await host.sync.flush(); await host.sync.refresh(); }
    if (act === "sign-out") {
      const unsynced = host.sync.pending;
      const ok = await host.dialogs.confirm({
        title: "Sign out of Google?",
        message: `${unsynced ? `${unsynced} ${unsynced === 1 ? "change hasn't" : "changes haven't"} synced yet; Wedger will try to upload ${unsynced === 1 ? "it" : "them"} first. ` : ""}Your journals stay in Google Drive, but the copies on this device are removed. Sign in again to bring them back.`,
        confirmLabel: "Sign out", danger: true,
      });
      if (ok) host.auth.signOut();
    }
  });
  autoSwitch.addEventListener("change", () => host.settings.set("syncAuto", autoSwitch.checked));

  paint();
  const ticker = setInterval(paintSync, 30000);          // keeps "Last synced 2 min ago" honest
  const offs = [host.auth.on("changed", paint), host.sync.on("changed", () => { paintSync(); paintFiles(); }), host.files.on("changed", paintFiles), host.settings.on("syncAuto", paintSync)];
  return { dispose() { clearInterval(ticker); offs.forEach((o) => o()); } };
}
