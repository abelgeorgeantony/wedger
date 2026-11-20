/* host.js — the Host API.
 *
 * The ONLY surface special files and renderers talk to. It is backed by the
 * real thing: localStorage (via storage.js) for files, Google Identity
 * Services + the Drive API for sign-in and sync, and the hledger WASM engine
 * for everything accounting. Special files never import any of those.
 */
import { Emitter, extOf } from "./core.js";
import { assets } from "./registry.js";
import * as overlays from "./overlays.js";
import { engine } from "./engine.js";
import { shortcuts } from "./keyboard-shortcuts.js";
import { StorageManager } from "../storage.js";

/* ------------------------------------------------------------------ settings */
const SCHEMA = {
  theme:            { key: "wedger_theme",             type: "string", default: "system", options: ["system", "light", "dark"] },
  fontSize:         { key: "wedger_font_size",         type: "number", default: 14, min: 11, max: 20 },
  defaultView:      { key: "wedger_default_view",      type: "string", default: "rendered", options: ["rendered", "raw"] },
  lineNumbers:      { key: "wedger_line_numbers",      type: "bool",   default: true },
  autoSave:         { key: "wedger_auto_save",         type: "bool",   default: true },
  numberGrouping:   { key: "wedger_number_grouping",   type: "string", default: "auto", options: ["auto", "indian", "international", "none"] },
  defaultCommodity: { key: "wedger_default_commodity", type: "string", default: "" },
  restoreTabs:      { key: "wedger_restore_tabs",      type: "bool",   default: true },
  weekStart:        { key: "wedger_week_start",        type: "string", default: "monday", options: ["monday", "sunday"] },
  // Lives on the Google settings page, not the Settings page: it only means something when signed in.
  syncAuto:         { key: "wedger_sync_auto",         type: "bool",   default: true },
};
const defaultOf = (def) => (typeof def.default === "function" ? def.default() : def.default);

class Settings extends Emitter {
  #values = {};
  init() {
    for (const [name, def] of Object.entries(SCHEMA)) {
      let raw = null;
      try { raw = localStorage.getItem(def.key); } catch { /* storage blocked */ }
      if (name === "theme" && raw == null) raw = this.#legacyTheme();
      this.#values[name] = raw == null ? defaultOf(def) : this.#parse(def, raw);
      this.#apply(name);
    }
    // "System" follows the OS live: switching it at sunset repaints the app without a reload.
    const watch = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
    watch?.addEventListener?.("change", () => { if (this.#values.theme === "system") this.#apply("theme"); });
  }
  /** Before there was a Theme setting there was a Dark mode switch ("1" / "0"). Keep what people chose. */
  #legacyTheme() {
    try {
      const old = localStorage.getItem("wedger_dark_mode");
      return old == null ? null : old === "1" ? "dark" : "light";
    } catch { return null; }
  }
  #parse(def, raw) {
    if (def.type === "bool") return raw === "1";
    if (def.type === "number") {
      const n = Number(raw);
      return Number.isFinite(n) ? Math.min(def.max, Math.max(def.min, Math.round(n))) : defaultOf(def);
    }
    return def.options && !def.options.includes(raw) ? defaultOf(def) : raw;
  }
  #apply(name) {
    const v = this.#values[name];
    if (name === "theme") {
      const dark = v === "dark" || (v === "system" && !!globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches);
      document.documentElement.classList.toggle("dark-mode", dark);
    }
    if (name === "fontSize") document.documentElement.style.setProperty("--base-font-size", `${v}px`);
  }
  get(name) { return this.#values[name]; }
  schema(name) { return SCHEMA[name]; }
  set(name, value) {
    const def = SCHEMA[name];
    if (!def) throw new Error(`Unknown setting "${name}".`);
    if (def.type === "number") value = Math.min(def.max ?? Infinity, Math.max(def.min ?? -Infinity, Math.round(Number(value))));
    if (def.type === "string" && def.options && !def.options.includes(value)) value = defaultOf(def);
    if (this.#values[name] === value) return;
    this.#values[name] = value;
    try { localStorage.setItem(def.key, def.type === "bool" ? (value ? "1" : "0") : String(value)); } catch { /* ignore */ }
    this.#apply(name);
    this.emit(name, value);
    this.emit("*", { name, value });
  }
  /** Back to defaults. Pass names to reset only some (the Settings page leaves out settings that live elsewhere). */
  reset(names = Object.keys(SCHEMA)) { for (const name of names) this.set(name, defaultOf(SCHEMA[name])); }
  onChange(name, fn) { return this.on(name, fn); }
}

/* --------------------------------------------------------------------- files */
const KNOWN_EXTS = [".journal", ".timeclock", ".timedot", ".csv", ".rules"];

/** Files live in localStorage (per signed-in user, see storage.js) and are mirrored into the engine. */
class Files extends Emitter {
  #items = new Map();

  /** (Re)reads everything from this user's local store. */
  load({ silent = false } = {}) {
    this.#items.clear();
    for (const name of StorageManager.listLocalFiles()) {
      const meta = StorageManager.getLocalFileMetadata(name);
      if (!meta) continue;
      this.#items.set(name, { name, content: meta.content ?? "", modified: Date.parse(meta.modifiedTime) || 0, driveId: null });
    }
    if (!silent) this.emit("changed", { kind: "reload" });
  }

  list() {
    return [...this.#items.values()]
      .map(({ name, modified, driveId }) => ({ name, modified, driveId }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  contents() { return new Map([...this.#items].map(([name, f]) => [name, f.content])); }
  get(name) { const f = this.#items.get(name); return f ? { ...f } : null; }
  exists(name) { return this.#items.has(name); }

  /** Appends `fallbackExt` when no known extension is present. */
  normalize(raw, fallbackExt = ".journal") {
    const name = (raw ?? "").trim();
    if (!name) return "";
    return KNOWN_EXTS.some((e) => name.toLowerCase().endsWith(e)) ? name : `${name}${fallbackExt}`;
  }
  /** Returns an error message, or null when the name is acceptable. */
  validateName(name, { ignore = null } = {}) {
    if (!name) return "Filename cannot be empty.";
    if (/[\\/]/.test(name)) return "Filename cannot contain slashes.";
    if (/['"<>|?*]/.test(name)) return "Filename cannot contain quotes or any of < > | ? *.";
    if (name.startsWith(".")) return "Filename cannot start with a dot.";
    if (name.length > 100) return "Filename is too long.";
    if (!KNOWN_EXTS.includes(extOf(name))) return `Use one of: ${KNOWN_EXTS.join(", ")}`;
    if (name !== ignore && this.#items.has(name)) return `A file named "${name}" already exists.`;
    return null;
  }

  #persist(name, content) {
    try { StorageManager.saveLocalFile(name, content); }
    catch (err) { throw new Error(err?.name === "QuotaExceededError" ? "This device's browser storage is full, so the file couldn't be saved." : `Couldn't save "${name}": ${err?.message ?? err}`); }
  }

  create(name, content = "") {
    const err = this.validateName(name);
    if (err) throw new Error(err);
    this.#persist(name, content);
    this.#items.set(name, { name, content, modified: Date.now(), driveId: null });
    this.emit("changed", { kind: "create", name });
    return this.get(name);
  }
  write(name, content) {
    const f = this.#items.get(name);
    if (!f) throw new Error(`"${name}" was not found.`);
    if (f.content === content) return;
    this.#persist(name, content);
    f.content = content; f.modified = Date.now();
    this.emit("changed", { kind: "write", name });
  }
  rename(oldName, newName) {
    const f = this.#items.get(oldName);
    if (!f) throw new Error(`"${oldName}" was not found.`);
    const err = this.validateName(newName, { ignore: oldName });
    if (err) throw new Error(err);
    if (newName === oldName) return;
    this.#persist(newName, f.content);
    StorageManager.deleteLocalFile(oldName);
    this.#items.delete(oldName);
    this.#items.set(newName, { ...f, name: newName });
    this.emit("changed", { kind: "rename", name: newName, oldName, driveId: f.driveId });
  }
  remove(name) {
    const f = this.#items.get(name);
    if (!f) return;
    StorageManager.deleteLocalFile(name);
    this.#items.delete(name);
    this.emit("changed", { kind: "remove", name, driveId: f.driveId });
  }
  duplicate(name) {
    const f = this.#items.get(name);
    const ext = extOf(name), base = name.slice(0, name.length - ext.length);
    let copy = `${base}-copy${ext}`, n = 2;
    while (this.#items.has(copy)) copy = `${base}-copy-${n++}${ext}`;
    return this.create(copy, f.content);
  }

  /** Bookkeeping from the sync layer (Drive id, ...). Never touches content. */
  setMeta(name, patch) {
    const f = this.#items.get(name);
    if (!f) return;
    Object.assign(f, patch);
    this.emit("changed", { kind: "meta", name });
  }
  /** After a full Drive sync: re-read the local store (downloads landed there) and attach Drive ids. */
  reconcile(results) {
    this.load({ silent: true });
    for (const r of results) {
      const f = this.#items.get(r.name);
      if (f && r.id) f.driveId = r.id;
    }
    this.emit("changed", { kind: "reload" });
  }
}

/* ---------------------------------------------------------------------- auth */
const AUTH_ERRORS = {
  popup_closed: "Sign-in was cancelled.",
  popup_failed_to_open: "Your browser blocked the Google sign-in window. Allow pop-ups for this site and try again.",
  profile_unavailable: "Signed in, but Google didn't share your profile. Please try again.",
};

class Auth extends Emitter {
  #user = null;
  #interactive = false;

  get user() { return this.#user; }
  /** False while Google's sign-in script is still loading (or blocked). */
  get available() { return StorageManager.isReady; }

  init() {
    StorageManager.onError = (err) => {
      this.#interactive = false;
      overlays.toast(AUTH_ERRORS[err?.type] ?? "Couldn't sign in with Google. Please try again.", "error");
    };
    // Calls back immediately when a saved session is still valid, and again after each interactive sign-in.
    StorageManager.init((profile) => this.#adopt(profile));
  }

  #adopt(profile) {
    const announce = this.#interactive;
    this.#interactive = false;
    this.#user = { name: profile.name || profile.email, email: profile.email, picture: profile.picture || null };
    files.load();                       // the local store is now this user's
    this.emit("changed", this.#user);
    if (announce) overlays.toast(`Signed in as ${this.#user.email}`, "ok");
    sync.syncAll();
  }

  signIn() {
    this.#interactive = true;
    if (!StorageManager.promptLogin()) {
      this.#interactive = false;
      overlays.toast("Google sign-in is still loading, or your browser is blocking it. Try again in a moment.", "error");
    }
  }

  async signOut() {
    await sync.flush().catch(() => {});
    StorageManager.logout();            // revokes the token and removes this user's local copies
    this.#user = null;
    sync.reset();
    files.load();
    this.emit("changed", null);
    overlays.toast("Logged out. Your journals are still in Google Drive.", "info");
  }

  /** The token couldn't be renewed: keep working locally, ask to sign in again. */
  expire() {
    if (!this.#user) return;
    StorageManager.accessToken = null;
    this.#user = null;
    this.emit("changed", null);
    overlays.toast("Your Google session expired. Sign in again to keep syncing.", "error");
  }
}

/* ---------------------------------------------------------------------- sync */
const is401 = (e) => /401/.test(e?.message ?? "");

/** Debounced upload queue + full Drive reconcile. Local files are always the working copy. */
class Sync extends Emitter {
  lastSync = null;
  syncing = false;
  #queue = new Set();               // names with changes Drive hasn't seen yet
  #errors = new Map();              // name -> message
  #timer = null;
  #running = null;
  #reconciling = false;             // a full Drive sync is in flight (Drive ids aren't known yet)

  attach() {
    files.on("changed", (ev) => this.#onFile(ev));
    settings.onChange("syncAuto", (on) => { if (on && this.#queue.size) this.#schedule(); this.emit("changed"); });
  }

  /** "local" (not signed in) | "pending" | "synced" | "error" */
  statusOf(name) {
    if (!auth.user) return "local";
    if (this.#errors.has(name)) return "error";
    const f = files.get(name);
    if (!f) return "local";
    return this.#queue.has(name) || !f.driveId ? "pending" : "synced";
  }
  errorOf(name) { return this.#errors.get(name) ?? null; }
  get pending() { return this.#queue.size; }

  reset() {
    clearTimeout(this.#timer);
    this.#queue.clear(); this.#errors.clear(); this.lastSync = null;
    this.emit("changed");
  }

  #onFile(ev) {
    if (!auth.user) return;
    if (ev.kind === "create" || ev.kind === "write") {
      this.#queue.add(ev.name);
      this.#errors.delete(ev.name);
      this.#schedule();
    } else if (ev.kind === "rename") {
      const wasQueued = this.#queue.delete(ev.oldName);
      this.#errors.delete(ev.oldName);
      if (ev.driveId) {
        this.#withAuth(() => StorageManager.renameInDrive(ev.driveId, ev.name))
          .catch((e) => { this.#errors.set(ev.name, `Couldn't rename it in Drive (${e.message}).`); this.emit("changed"); });
      }
      if (!ev.driveId || wasQueued) this.#queue.add(ev.name);       // still has changes Drive hasn't seen
      this.#schedule();
    } else if (ev.kind === "remove") {
      this.#queue.delete(ev.name);
      this.#errors.delete(ev.name);
      if (ev.driveId) {
        this.#withAuth(() => StorageManager.deleteFromDrive(ev.driveId))
          .catch((e) => overlays.toast(`"${ev.name}" was removed here but couldn't be removed from Drive (${e.message}).`, "error"));
      }
    }
    this.emit("changed");
  }

  #schedule() {
    if (!settings.get("syncAuto")) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.flush(), 2000);
  }

  /** Runs `fn`; on an expired token renews it once and retries. */
  async #withAuth(fn) {
    try { return await fn(); }
    catch (e) {
      if (!is401(e)) throw e;
      try { await StorageManager.refreshToken(); }
      catch { auth.expire(); throw new Error("Session expired"); }
      return fn();
    }
  }

  /** Uploads everything queued. Safe to call any time. */
  flush() {
    if (this.#running) return this.#running;
    if (!auth.user || !this.#queue.size) return Promise.resolve();
    if (this.#reconciling) return Promise.resolve();                // syncAll() flushes when it's done; uploading now could duplicate files
    this.#running = (async () => {
      this.syncing = true; this.emit("changed");
      let failed = false;
      for (const name of [...this.#queue]) {
        const f = files.get(name);
        if (!f) { this.#queue.delete(name); continue; }
        try {
          const res = await this.#withAuth(() => StorageManager.saveToDrive(name, f.content, f.driveId));
          files.setMeta(name, { driveId: res.id });
          if (files.get(name)?.modified === f.modified) this.#queue.delete(name);   // edited again meanwhile? stays queued
          this.#errors.delete(name);
        } catch (e) {
          failed = true;
          if (!auth.user) break;                                        // session expired
          console.error("Drive upload failed for", name, e);
          this.#errors.set(name, `Couldn't upload to Drive (${e.message}).`);
        }
      }
      if (!failed) this.lastSync = Date.now();
      this.syncing = false;
      this.#running = null;
      this.emit("changed");
      if (failed && auth.user) this.#timer = setTimeout(() => this.flush(), 30000);   // try again later
      else if (this.#queue.size) this.#schedule();
    })();
    return this.#running;
  }

  /** Full two-way reconcile with Drive (on sign-in, and from the "Sync now" button). */
  async syncAll() {
    if (!auth.user || this.syncing || this.#reconciling) return;
    this.syncing = true; this.#reconciling = true; this.emit("changed");
    try {
      const results = await this.#withAuth(() => StorageManager.syncAllDriveFiles());
      files.reconcile(results);
      for (const r of results) {
        if (r.status === "error") this.#errors.set(r.name, r.error ?? "Couldn't download it from Drive.");
        else this.#errors.delete(r.name);
        if (r.status === "synced_local_newer") this.#queue.add(r.name);
      }
      this.lastSync = Date.now();
    } catch (e) {
      console.error("Drive sync failed", e);
      if (auth.user) overlays.toast("Couldn't reach Google Drive. Working offline; changes will sync later.", "error");
    } finally {
      this.syncing = false; this.#reconciling = false;
      this.emit("changed");
    }
    if (this.#queue.size) this.flush();
  }
  refresh() { return this.syncAll(); }
}

/* ------------------------------------------------------------------- reports */
export const REPORT_LABELS = {
  check: "Check", checkstrict: "Strict check", accounts: "Accounts", payees: "Payees", commodities: "Commodities",
  tags: "Tags", balance: "Balance", register: "Register", print: "Print", prices: "Prices",
  balancesheet: "Balance sheet", incomestatement: "Income statement", cashflow: "Cash flow", budget: "Budget report",
  printtext: "Journal text",
};
const MAX_REPORTS = 40;

class Reports extends Emitter {
  entries = [];
  #seq = 0;

  /** Runs a report and shows it in Reports output. `text` is the journal text to run on (defaults to the saved file). */
  async run(type, { file, text, query = "", forecast = false, focus = true }) {
    const entry = {
      id: ++this.#seq, type, label: REPORT_LABELS[type] ?? type, file, query, forecast,
      at: Date.now(), ms: null, status: "running", result: null, error: null,
    };
    this.entries.unshift(entry);
    if (this.entries.length > MAX_REPORTS) this.entries.length = MAX_REPORTS;
    this.emit("changed");
    if (focus) host.open("wedger:reports-output");
    await this.#execute(entry, text);
    return entry;
  }

  async rerun(id) {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return;
    Object.assign(entry, { status: "running", result: null, error: null, at: Date.now() });
    this.emit("changed");
    await this.#execute(entry, undefined);
  }

  async #execute(entry, text) {
    const t0 = performance.now();
    try {
      const source = text ?? files.get(entry.file)?.content;
      if (source == null) throw new Error(`"${entry.file}" no longer exists.`);
      const result = await engine.report(entry.type, source, { query: entry.query, forecast: entry.forecast });
      entry.result = result;
      entry.status = result?.ok === false ? "error" : "ok";
      entry.error = result?.ok === false ? (result.error ?? "The report failed.") : null;
    } catch (err) {
      entry.status = "error";
      entry.error = err?.message ?? String(err);
    }
    entry.ms = Math.round(performance.now() - t0);
    this.emit("changed");
  }

  remove(id) { this.entries = this.entries.filter((e) => e.id !== id); this.emit("changed"); }
  clear() { this.entries = []; this.emit("changed"); }
}

/* ---------------------------------------------------------------- the object */
const files = new Files();
const settings = new Settings();
const auth = new Auth();
const sync = new Sync();
const reports = new Reports();
let editors = null;

function download(name, content, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([content], { type: `${type};charset=utf-8` }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const actions = {
  async rename(name) {
    const ext = extOf(name);
    const next = await overlays.prompt({
      title: "Rename file", label: "New filename", value: name, confirmLabel: "Rename",
      validate: (v) => files.validateName(files.normalize(v, ext), { ignore: name }),
    });
    if (next == null) return null;
    const final = files.normalize(next, ext);
    if (final !== name) files.rename(name, final);
    return final;
  },
  async remove(name) {
    const ok = await overlays.confirm({
      title: `Delete ${name}?`,
      message: auth.user
        ? "This removes the file from this device and from Google Drive. It can't be undone."
        : "This removes the file from this device. It can't be undone.",
      confirmLabel: "Delete", danger: true,
    });
    if (ok) files.remove(name);
    return ok;
  },
  duplicate(name) {
    const copy = files.duplicate(name);
    host.open(`file:${copy.name}`);
    return copy.name;
  },
  export(name) {
    const f = files.get(name);
    if (f) download(name, f.content);
  },
};

let initialised = false;

export const host = {
  files, settings, auth, sync, reports, actions, assets, engine, download, shortcuts,
  dialogs: overlays,
  notify: overlays.toast,

  /** Starts storage, sign-in and the file mirror. Call once, after settings.init(). */
  init() {
    if (initialised) return;
    initialised = true;
    files.load({ silent: true });
    engine.replaceAllFiles(files.contents());
    files.on("changed", (ev) => {                                   // keep the engine's virtual filesystem identical to the file store
      if (ev.kind === "reload") engine.replaceAllFiles(files.contents());
      else if (ev.kind === "create" || ev.kind === "write") engine.setFile(ev.name, files.get(ev.name).content);
      else if (ev.kind === "rename") { engine.removeFile(ev.oldName); engine.setFile(ev.name, files.get(ev.name).content); }
      else if (ev.kind === "remove") engine.removeFile(ev.name);
    });
    sync.attach();
    auth.init();                                                    // may restore a saved session and start a Drive sync
  },

  /** Called once by main.js so special files can open/close tabs without importing the editor service. */
  bind(editorService) { editors = editorService; },
  open: (uri, opts) => editors.open(uri, opts),
  close: (uri) => editors.closeByUri(uri),
};

