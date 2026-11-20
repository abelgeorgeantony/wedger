/* special/settings.js — binds the Settings page to host.settings and host.shortcuts.
 *
 * Text size is just another setting: host.settings sets --base-font-size on the root, every size in the app (this
 * page included) follows it live, and this controller only repaints the readout, the buttons and the slider.
 * To keep the control under the pointer while the text around it grows or shrinks, the slider block is laid out in
 * fixed pixels (see settings.html) and setSize() cancels any vertical drift by nudging the page's scroll position.
 *
 * Keyboard shortcuts are configured here but owned by assets/js/shell/keyboard-shortcuts.js. This file adds no
 * global listener: capturing a key combination is a mode of that single service.
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

  const scroller = root.closest(".view");
  /** Applies a size and, if the layout above the slider moved because the text rescaled, scrolls by the difference so the control stays put. */
  const setSize = (px) => {
    const before = slider.getBoundingClientRect().top;
    S.set("fontSize", px);
    if (!scroller) return;
    const drift = slider.getBoundingClientRect().top - before;
    if (drift) scroller.scrollTop += drift;
  };

  const showSize = (px) => {
    slot("font-value").textContent = `${px} px`;
    slider.value = px;
    slider.setAttribute("aria-valuetext", `${px} pixels${px === def ? ", the default" : ""}`);
    dec.disabled = px <= min; inc.disabled = px >= max; reset.disabled = px === def;
  };
  const paintSize = () => showSize(S.get("fontSize"));
  paintSize();

  // The whole app rescales as the slider moves (input), and once more on commit (change) for keyboards that only fire that.
  slider.addEventListener("input", () => setSize(Number(slider.value)));
  slider.addEventListener("change", () => setSize(Number(slider.value)));
  reset.addEventListener("click", () => setSize(def));

  // A− / A+ : press once to step, press and hold to keep going. Keyboard (Enter/Space) arrives as a click with detail 0.
  let delay = null, repeat = null;
  const stop = () => { clearTimeout(delay); clearInterval(repeat); delay = repeat = null; };
  const step = (dir) => {
    const next = Math.min(max, Math.max(min, S.get("fontSize") + dir));
    if (next === S.get("fontSize")) { stop(); return; }
    setSize(next);
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

  /* ---- keyboard shortcuts ---- */
  const K = host.shortcuts;
  const keyList = slot("shortcut-list"), keyStatus = slot("shortcut-status");
  const rows = new Map();                          // command id -> { li, kbd, change, clear, error }
  let capturing = null;                            // { id, end }
  let sayTimer = null;
  /** Announces through the polite live region (cleared first so an identical message is still read). */
  const say = (msg) => { keyStatus.textContent = ""; clearTimeout(sayTimer); sayTimer = setTimeout(() => { keyStatus.textContent = msg; }, 30); };

  for (const cmd of K.all()) {
    const kbd = document.createElement("kbd"); kbd.className = "st-key__binding"; kbd.id = `st-key-${cmd.id}`;
    const change = Object.assign(document.createElement("button"), { type: "button", className: "btn btn--small" });
    change.setAttribute("aria-pressed", "false"); change.setAttribute("aria-describedby", kbd.id);
    const clear = Object.assign(document.createElement("button"), { type: "button", className: "btn btn--small btn--ghost", textContent: "Clear" });
    clear.setAttribute("aria-label", `Clear the shortcut for ${cmd.label}`);
    const error = Object.assign(document.createElement("p"), { className: "field__error st-key__error", hidden: true });
    error.setAttribute("role", "alert");
    const text = document.createElement("div"); text.className = "st-row__text";
    const label = Object.assign(document.createElement("div"), { className: "st-row__label", textContent: cmd.label });
    text.append(label);
    if (cmd.hint) text.append(Object.assign(document.createElement("div"), { className: "st-row__desc", textContent: cmd.hint }));
    const controls = document.createElement("div"); controls.className = "st-key__controls";
    controls.append(kbd, change);
    if (cmd.clearable) controls.append(clear);
    const li = document.createElement("li"); li.className = "st-key";
    li.append(text, controls, error);
    keyList.append(li);
    rows.set(cmd.id, { li, kbd, change, clear, error, cmd });

    change.addEventListener("click", () => { if (capturing?.id === cmd.id) return; startCapture(cmd.id); });
    change.addEventListener("blur", () => { if (capturing?.id === cmd.id) { stopCapture(); say(`Stopped changing the shortcut for ${cmd.label}.`); } });
    clear.addEventListener("click", () => {
      const res = K.clear(cmd.id);
      if (res.ok) { error.hidden = true; say(`The shortcut for ${cmd.label} was cleared.`); change.focus(); }
      else { error.textContent = res.error; error.hidden = false; say(res.error); }
    });
  }

  function paintKeys() {
    for (const c of K.all()) {
      const r = rows.get(c.id);
      if (!r) continue;
      const on = capturing?.id === c.id;
      r.kbd.textContent = on ? "Press the new keys…" : c.binding ? c.display : "Not set";
      r.kbd.classList.toggle("is-unset", !c.binding && !on);
      r.kbd.classList.toggle("is-capturing", on);
      r.change.textContent = on ? "Press keys (Esc cancels)" : "Change";
      r.change.setAttribute("aria-pressed", String(on));
      r.change.setAttribute("aria-label", on ? `Press the new keys for ${c.label}. Escape cancels.` : `Change the shortcut for ${c.label}`);
      r.clear.hidden = !c.binding;
    }
  }

  function stopCapture() {
    if (!capturing) return;
    capturing.end();
    capturing = null;
    paintKeys();
  }

  function startCapture(id) {
    stopCapture();
    const r = rows.get(id);
    r.error.hidden = true;
    const end = K.beginCapture((ev) => {
      if (ev.kind === "cancel") {
        stopCapture();
        if (ev.reason === "escape") { r.change.focus(); say(`Cancelled. “${r.cmd.label}” keeps ${K.get(id) ? K.label(K.get(id)) : "no shortcut"}.`); }
        return;
      }
      if (ev.kind === "error") { r.error.textContent = ev.message; r.error.hidden = false; say(`${ev.message} Try another combination, or press Escape to cancel.`); return; }
      const res = K.set(id, ev.binding);
      if (!res.ok) { r.error.textContent = res.error; r.error.hidden = false; say(`${res.error} Try another combination, or press Escape to cancel.`); return; }
      stopCapture();
      r.error.hidden = true;
      r.change.focus();
      say(`“${r.cmd.label}” is now ${K.label(ev.binding)}.`);
    });
    capturing = { id, end };
    paintKeys();
    say(`Press the new keys for ${r.cmd.label}. Escape cancels.`);
  }

  $('[data-act="shortcuts-reset"]').addEventListener("click", () => {
    stopCapture();
    K.reset();
    for (const r of rows.values()) r.error.hidden = true;
    say("All shortcuts were reset to their defaults.");
  });
  paintKeys();

  /* ---- reset ---- */
  root.addEventListener("click", (e) => {
    if (!e.target.closest('[data-act="reset-all"]')) return;
    const names = [...new Set([...root.querySelectorAll("[data-setting]")].map((el) => el.dataset.setting))];   // only what this page shows
    host.dialogs.confirm({ title: "Reset these settings?", message: "Every setting on this page, keyboard shortcuts included, goes back to its default. Your files aren't touched.", confirmLabel: "Reset" })
      .then((ok) => { if (ok) { stopCapture(); S.reset(names); K.reset(); } });
  });

  /* ---- keep everything in step with the store ---- */
  const repaint = () => { plain.forEach(paintPlain); segs.forEach(paintSeg); paintSize(); };
  const offs = [S.on("*", repaint), host.files.on("changed", paintData), K.on("changed", paintKeys)];
  return {
    onShow() { repaint(); paintKeys(); },
    onHide() { stopCapture(); },
    dispose() { stop(); stopCapture(); clearTimeout(sayTimer); offs.forEach((o) => o()); },
  };
}
