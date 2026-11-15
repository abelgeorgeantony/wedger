/* special/settings.js — binds the Settings page to host.settings.
 *
 * Text size is the delicate one. Every size in the app is relative to the root font size, so changing it
 * rescales the whole page, including the very buttons and slider you are using. That is what made the old
 * control jump around under the pointer. Two things fix it for good:
 *
 *   1. This page holds still. While you adjust the size, the Settings page is counter-zoomed by the exact
 *      inverse of the change, so every control stays at the same pixel position while the sidebar, tabs and
 *      open files rescale live next to it. (Reopen the tab, or switch away and back, and it catches up.)
 *   2. Nothing inside the control changes size: fixed-width readout, a permanent "Default" mark instead of
 *      text that appears and disappears, buttons that disable in place, a fixed-height preview.
 *
 * Browsers without CSS `zoom` fall back to applying the size when the slider is released.
 */
import { formatBytes } from "../js/shell/core.js";

/* ------------------------------------------------------------------ backup zip */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (bytes) => { let c = 0xFFFFFFFF; for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };

/** A minimal, uncompressed .zip (journals are small text files). entries: [{ name, data: Uint8Array }] */
export function makeZip(entries, now = new Date()) {
  const enc = new TextEncoder();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((Math.max(1980, now.getFullYear()) - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = [], central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = enc.encode(name), crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);   // 0x0800: UTF-8 names
    local.setUint16(10, time, true); local.setUint16(12, date, true);
    local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, data);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true); entry.setUint16(4, 20, true); entry.setUint16(6, 20, true); entry.setUint16(8, 0x0800, true);
    entry.setUint16(12, time, true); entry.setUint16(14, date, true);
    entry.setUint32(16, crc, true); entry.setUint32(20, data.length, true); entry.setUint32(24, data.length, true);
    entry.setUint16(28, nameBytes.length, true); entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of all) { out.set(c, at); at += c.length; }
  return out;
}

/* -------------------------------------------------------------------- page */
export function mount({ root, host }) {
  const S = host.settings;
  const $ = (sel) => root.querySelector(sel);
  const slot = (n) => root.querySelector(`[data-slot="${n}"]`);

  /* ---- switches, selects, text inputs ---- */
  const plain = [...root.querySelectorAll("[data-setting]")].filter((el) => !el.classList.contains("seg") && el.type !== "range");
  const paintPlain = (el) => {
    const v = S.get(el.dataset.setting);
    if (el.type === "checkbox") el.checked = !!v; else el.value = v;
  };
  plain.forEach((el) => {
    paintPlain(el);
    el.addEventListener("change", () => S.set(el.dataset.setting, el.type === "checkbox" ? el.checked : el.value.trim()));
  });

  /* ---- segmented choices ---- */
  const segs = [...root.querySelectorAll(".seg[data-setting]")];
  const paintSeg = (seg) => seg.querySelectorAll("[data-value]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.value === S.get(seg.dataset.setting))));
  segs.forEach((seg) => {
    paintSeg(seg);
    seg.addEventListener("click", (e) => { const b = e.target.closest("[data-value]"); if (b) S.set(seg.dataset.setting, b.dataset.value); });
  });

  /* ---- text size ---- */
  const { min, max, default: def } = S.schema("fontSize");
  const slider = $('[data-setting="fontSize"]');
  const dec = $('[data-act="font-dec"]'), inc = $('[data-act="font-inc"]'), reset = $('[data-act="font-reset"]');
  Object.assign(slider, { min, max, step: 1 });

  const mark = (value, label) => {
    const f = String((value - min) / (max - min));
    const tick = document.createElement("i"); tick.style.setProperty("--f", f);
    if (value === def) tick.className = "is-default";
    const out = [tick];
    if (label) { const b = document.createElement("b"); b.style.setProperty("--f", f); b.textContent = label; out.push(b); }
    return out;
  };
  slot("marks").replaceChildren(...Array.from({ length: max - min + 1 }, (_, i) => {
    const v = min + i;
    return mark(v, v === min ? String(min) : v === max ? String(max) : v === def ? "Default" : "");
  }).flat());

  const CAN_HOLD_STILL = !!globalThis.CSS?.supports?.("zoom", "1");
  let heldAt = S.get("fontSize");             // the size this page was laid out for
  let zoom = 1;
  const holdStill = () => {
    zoom = CAN_HOLD_STILL ? heldAt / S.get("fontSize") : 1;
    root.style.zoom = zoom === 1 ? "" : String(zoom);
  };

  const showSize = (px) => {
    slot("font-value").textContent = `${px} px`;
    slot("preview").style.fontSize = `${px / zoom}px`;      // the preview shows the real size, whatever the page zoom is
    slider.value = px;
    slider.setAttribute("aria-valuetext", `${px} pixels${px === def ? ", the default" : ""}`);
    dec.disabled = px <= min; inc.disabled = px >= max; reset.disabled = px === def;
  };
  const paintSize = () => showSize(S.get("fontSize"));
  holdStill(); paintSize();

  // With the page held still it is safe to rescale the app live while dragging; otherwise wait for release.
  slider.addEventListener("input", () => { const v = Number(slider.value); if (CAN_HOLD_STILL) S.set("fontSize", v); else showSize(v); });
  slider.addEventListener("change", () => S.set("fontSize", Number(slider.value)));
  reset.addEventListener("click", () => S.set("fontSize", def));

  // A− / A+ : press once to step, press and hold to keep going. Keyboard (Enter/Space) arrives as a click with detail 0.
  let delay = null, repeat = null;
  const stop = () => { clearTimeout(delay); clearInterval(repeat); delay = repeat = null; };
  const step = (dir) => {
    const next = Math.min(max, Math.max(min, S.get("fontSize") + dir));
    if (next === S.get("fontSize")) { stop(); return; }
    S.set("fontSize", next);
  };
  for (const [btn, dir] of [[dec, -1], [inc, 1]]) {
    btn.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      step(dir);
      delay = setTimeout(() => { repeat = setInterval(() => step(dir), 90); }, 380);
    });
    for (const ev of ["pointerup", "pointerleave", "pointercancel", "blur"]) btn.addEventListener(ev, stop);
    btn.addEventListener("click", (e) => { if (e.detail === 0) step(dir); });
  }

  /* ---- backup ---- */
  const backupBtn = $('[data-act="backup"]');
  function paintData() {
    const list = host.files.list();
    const bytes = list.reduce((n, f) => n + new Blob([host.files.get(f.name).content]).size, 0);
    slot("backup-desc").textContent = list.length
      ? `${list.length} ${list.length === 1 ? "file" : "files"}, ${formatBytes(bytes)} on this device. Download them all as one .zip.`
      : "You don't have any files yet.";
    backupBtn.disabled = !list.length;
  }
  backupBtn.addEventListener("click", () => {
    const enc = new TextEncoder();
    const entries = host.files.list().map((f) => ({ name: f.name, data: enc.encode(host.files.get(f.name).content) }));
    if (!entries.length) return;
    const d = new Date(), pad = (n) => String(n).padStart(2, "0");
    host.download(`wedger-backup-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.zip`, makeZip(entries, d), "application/zip");
    host.notify(`Downloaded ${entries.length} ${entries.length === 1 ? "file" : "files"}`, "ok");
  });
  paintData();

  /* ---- reset ---- */
  root.addEventListener("click", (e) => {
    if (!e.target.closest('[data-act="reset-all"]')) return;
    const names = [...new Set([...root.querySelectorAll("[data-setting]")].map((el) => el.dataset.setting))];   // only what this page shows
    host.dialogs.confirm({ title: "Reset these settings?", message: "Every setting on this page goes back to its default. Your files aren't touched.", confirmLabel: "Reset" })
      .then((ok) => { if (ok) S.reset(names); });
  });

  /* ---- keep everything in step with the store ---- */
  const repaint = () => { holdStill(); plain.forEach(paintPlain); segs.forEach(paintSeg); paintSize(); };
  const offs = [S.on("*", repaint), host.files.on("changed", paintData)];
  return {
    onShow() { heldAt = S.get("fontSize"); repaint(); },     // coming back to the tab: catch up to the current size
    dispose() { stop(); offs.forEach((o) => o()); },
  };
}
