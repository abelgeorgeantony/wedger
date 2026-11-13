/* host.js — the Host API.
 *
 * The ONLY surface special files and renderers may talk to. Today it is
 * backed by in-memory mock state (UI phase). In the integration phase the
 * same shape gets backed by state.js / storage.js / the hledger engine and
 * no special file has to change.
 */
import { Emitter, mock, extOf } from "./core.js";
import { assets } from "./registry.js";
import * as overlays from "./overlays.js";
import { SEED_FILES } from "./mock-data.js";

/* ------------------------------------------------------------------ settings */
const SCHEMA = {
  darkMode:    { key: "wedger_dark_mode",    type: "bool",   default: false },
  fontSize:    { key: "wedger_font_size",    type: "number", default: 14, min: 11, max: 20 },
  defaultView: { key: "wedger_default_view", type: "string", default: "rendered", options: ["rendered", "raw"] },
  lineNumbers: { key: "wedger_line_numbers", type: "bool",   default: true },
  syncAuto:    { key: "wedger_sync_auto",    type: "bool",   default: true },
};

class Settings extends Emitter {
  #values = {};
  init() {
    for (const [name, def] of Object.entries(SCHEMA)) {
      let raw = null;
      try { raw = localStorage.getItem(def.key); } catch { /* storage blocked */ }
      this.#values[name] = raw == null ? def.default : this.#parse(def, raw);
      this.#apply(name);
    }
  }
  #parse(def, raw) {
    if (def.type === "bool") return raw === "1";
    if (def.type === "number") { const n = Number(raw); return Number.isFinite(n) ? n : def.default; }
    return def.options && !def.options.includes(raw) ? def.default : raw;
  }
  #apply(name) {
    const v = this.#values[name];
    if (name === "darkMode") document.documentElement.classList.toggle("dark-mode", !!v);
    if (name === "fontSize") document.documentElement.style.setProperty("--base-font-size", `${v}px`);
  }
  get(name) { return this.#values[name]; }
  schema(name) { return SCHEMA[name]; }
  set(name, value) {
    const def = SCHEMA[name];
    if (!def) throw new Error(`Unknown setting "${name}".`);
    if (def.type === "number") value = Math.min(def.max ?? Infinity, Math.max(def.min ?? -Infinity, Number(value)));
    this.#values[name] = value;
    try { localStorage.setItem(def.key, def.type === "bool" ? (value ? "1" : "0") : String(value)); } catch { /* ignore */ }
    this.#apply(name);
    this.emit(name, value);
    this.emit("*", { name, value });
  }
  reset() { for (const [name, def] of Object.entries(SCHEMA)) this.set(name, def.default); }
  onChange(name, fn) { return this.on(name, fn); }
}

/* --------------------------------------------------------------------- files */
const KNOWN_EXTS = [".journal", ".timeclock", ".timedot", ".csv", ".rules"];

class Files extends Emitter {
  #items = new Map();
  constructor(seed) {
    super();
    for (const [name, content] of Object.entries(seed)) this.#items.set(name, { name, content, modified: Date.now() });
  }
  list() { return [...this.#items.values()].map(({ name }) => ({ name })).sort((a, b) => a.name.localeCompare(b.name)); }
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
    if (name.startsWith(".")) return "Filename cannot start with a dot.";
    if (name.length > 100) return "Filename is too long.";
    if (!KNOWN_EXTS.includes(extOf(name))) return `Use one of: ${KNOWN_EXTS.join(", ")}`;
    if (name !== ignore && this.#items.has(name)) return `A file named "${name}" already exists.`;
    return null;
  }

  create(name, content = "") {
    const err = this.validateName(name);
    if (err) throw new Error(err);
    this.#items.set(name, { name, content, modified: Date.now() });
    this.emit("changed", { kind: "create", name });
    return this.get(name);
  }
  write(name, content) {
    const f = this.#items.get(name);
    if (!f) throw new Error(`"${name}" was not found.`);
    f.content = content; f.modified = Date.now();
    this.emit("changed", { kind: "write", name });
  }
  rename(oldName, newName) {
    const f = this.#items.get(oldName);
    if (!f) throw new Error(`"${oldName}" was not found.`);
    const err = this.validateName(newName, { ignore: oldName });
    if (err) throw new Error(err);
    this.#items.delete(oldName);
    this.#items.set(newName, { ...f, name: newName });
    this.emit("changed", { kind: "rename", name: newName, oldName });
  }
  remove(name) {
    if (this.#items.delete(name)) this.emit("changed", { kind: "remove", name });
  }
  duplicate(name) {
    const f = this.#items.get(name);
    const ext = extOf(name), base = name.slice(0, name.length - ext.length);
    let copy = `${base}-copy${ext}`, n = 2;
    while (this.#items.has(copy)) copy = `${base}-copy-${n++}${ext}`;
    return this.create(copy, f.content);
  }
}

/* ---------------------------------------------------------------------- auth */
class Auth extends Emitter {
  #user = mock.has("signedin") ? { name: "Wedger Tester", email: "wedgertester@gmail.com", picture: null } : null;
  get user() { return this.#user; }
  async signIn() {          // TODO(integration): StorageManager Google sign-in
    this.#user = { name: "Wedger Tester", email: "wedgertester@gmail.com", picture: null };
    sync.touch();
    this.emit("changed", this.#user);
    overlays.toast(`Signed in as ${this.#user.email}`, "ok");
  }
  async signOut() {
    this.#user = null;
    this.emit("changed", null);
    overlays.toast("Logged out", "info");
  }
}

/* ---------------------------------------------------------------------- sync */
class Sync extends Emitter {
  lastSync = mock.has("signedin") ? Date.now() - 2 * 60 * 1000 : null;
  touch() { this.lastSync = Date.now(); }
  /** "synced" | "local" | "error" */
  statusOf(name) {
    if (!auth.user) return "local";
    if (mock.has("sync-error") && name === "work.timeclock") return "error";
    return "synced";
  }
  errorOf(name) {
    return this.statusOf(name) === "error" ? `Couldn't sync ${name}. Check your connection and refresh.` : null;
  }
  async refresh() {
    await new Promise((r) => setTimeout(r, 700));
    this.touch();
    this.emit("changed");
  }
}

/* ------------------------------------------------------------------- reports */
class Reports extends Emitter {
  entries = [];
  #seq = 0;
  run(type, { file, query = "" }) {
    this.entries.unshift({ id: ++this.#seq, type, file, query, at: Date.now() });
    this.emit("changed");
    host.open("wedger:reports-output");
  }
  clear() { this.entries = []; this.emit("changed"); }
}

/* ---------------------------------------------------------------- the object */
const files = new Files(mock.has("empty") ? {} : SEED_FILES);
const settings = new Settings();
const auth = new Auth();
const sync = new Sync();
const reports = new Reports();
let editors = null;

function download(name, content) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const actions = {
  async rename(name) {
    const ext = extOf(name);
    const next = await overlays.prompt({
      title: "Rename journal", label: "New filename", value: name, confirmLabel: "Rename",
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
        ? "This removes the file here and from Drive. It can't be undone."
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

export const host = {
  files, settings, auth, sync, reports, actions, assets,
  dialogs: overlays,
  notify: overlays.toast,

  /** UI-phase stand-in for the hledger engine. Replaced in the integration phase. */
  engine: {
    ready: false,
    async convertCsv(csv /* , rules */) {
      const commented = csv.split(/\r?\n/).map((l) => `; ${l}`).join("\n");
      return `; CSV import preview — real conversion arrives with the hledger engine\n${commented}\n`;
    },
  },

  /** Called once by main.js so special files can open/close tabs without importing the editor service. */
  bind(editorService) { editors = editorService; },
  open: (uri, opts) => editors.open(uri, opts),
  close: (uri) => editors.closeByUri(uri),
};
