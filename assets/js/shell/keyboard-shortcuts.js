/* keyboard-shortcuts.js — the ONE owner of Wedger's global key bindings.
 *
 *   - COMMANDS is the authoritative registry: ids, labels, defaults. Stored data can only refer to these ids.
 *   - A binding is a normalised string: modifiers in a fixed order, then KeyboardEvent.code
 *       "Mod+S" is written "Mod+KeyS", "Mod+Shift+A" is "Mod+Shift+KeyA", "Alt+Shift+W" is "Alt+Shift+KeyW".
 *     `Mod` is Ctrl on Windows/Linux and Command on macOS. Display labels are built from the string, never parsed back.
 *   - Preferences live in localStorage under a versioned key as { v: 1, bindings: { commandId: binding | null } }.
 *     Nothing executable is ever stored; malformed or stale data falls back to the defaults.
 *   - main.js attaches command handlers with attach() and calls init() once. Settings talks to the same instance
 *     (set / clear / reset / beginCapture); it never adds a global listener of its own.
 *
 * The pure helpers (eventToBinding, validateBinding, sanitizeStored, ...) have no DOM dependency so they can be unit tested.
 */
import { Emitter } from "./core.js";

export const STORAGE_KEY = "wedger_shortcuts_v1";

/** id, label, what it does, default binding, whether it may be unassigned, whether it still fires while typing. */
export const COMMANDS = [
  { id: "save", label: "Save active file", hint: "Saves the file in the current tab.", default: "Mod+KeyS", clearable: false, inEditable: true },
  { id: "focusSearch", label: "Search the journal", hint: "Opens Search in the current journal.", default: "Mod+KeyK", clearable: true },
  { id: "addTransaction", label: "Add transaction", hint: "Rendered journals only.", default: "Mod+Alt+KeyA", clearable: true },
  { id: "newFile", label: "New file", hint: "Opens the Create file page.", default: "Mod+Alt+KeyN", clearable: true },
  { id: "nextTab", label: "Next tab", hint: "Wraps from the last tab to the first.", default: "Mod+Alt+PageDown", clearable: true },
  { id: "prevTab", label: "Previous tab", hint: "Wraps from the first tab to the last.", default: "Mod+Alt+PageUp", clearable: true },
  { id: "closeTab", label: "Close tab", hint: "Asks first if the tab has unsaved changes.", default: "Alt+Shift+KeyW", clearable: true },
  { id: "openSettings", label: "Open Settings", hint: "", default: "Mod+Comma", clearable: true },
];
const BY_ID = new Map(COMMANDS.map((c) => [c.id, c]));
export const commandById = (id) => BY_ID.get(id) ?? null;

/* ------------------------------------------------------------ binding helpers */
export const isMacPlatform = () => /Mac|iPhone|iPad|iPod/i.test(globalThis.navigator?.userAgentData?.platform ?? globalThis.navigator?.platform ?? "");

const MODIFIER_CODES = new Set(["ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight", "OS", "AltGraph", "CapsLock", "NumLock", "Fn"]);
// Keys that keep their normal meaning everywhere; they can never be a shortcut's key.
const NEVER_KEYS = new Set(["Tab", "Escape", "Enter", "NumpadEnter", "Space", "Backspace", "Delete", "ContextMenu"]);

const MAC_CODE_LABELS = { Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Backquote: "`", Minus: "-", Equal: "=", ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", PageUp: "Page Up", PageDown: "Page Down" };

/** Key part of a binding, readable: "KeyA" -> "A", "Digit5" -> "5", "PageDown" -> "Page Down". */
export function codeLabel(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return `Num ${code.slice(6)}`;
  return MAC_CODE_LABELS[code] ?? code.replace(/([a-z])([A-Z])/g, "$1 $2");
}

/** { mod, alt, shift, code } from a binding string, or null when it isn't one. */
export function parseBinding(binding) {
  if (typeof binding !== "string" || binding.length > 40) return null;
  const parts = binding.split("+");
  const code = parts.pop();
  if (!code || !/^[A-Za-z][A-Za-z0-9]*$/.test(code) || MODIFIER_CODES.has(code)) return null;
  const order = ["Mod", "Alt", "Shift"];
  let last = -1;
  const seen = {};
  for (const p of parts) {
    const i = order.indexOf(p);
    if (i < 0 || i <= last) return null;                 // unknown, duplicated, or not in canonical order
    seen[p] = true; last = i;
  }
  return { mod: !!seen.Mod, alt: !!seen.Alt, shift: !!seen.Shift, code };
}

export const formatBinding = (p) => `${p.mod ? "Mod+" : ""}${p.alt ? "Alt+" : ""}${p.shift ? "Shift+" : ""}${p.code}`;

/** Human label: "Ctrl + Alt + A" on Windows/Linux, "⌘⌥ A" on macOS. */
export function labelFor(binding, mac = isMacPlatform()) {
  const p = parseBinding(binding);
  if (!p) return "";
  const key = codeLabel(p.code);
  if (mac) return `${p.mod ? "⌘" : ""}${p.alt ? "⌥" : ""}${p.shift ? "⇧" : ""} ${key}`.trim();
  return [p.mod && "Ctrl", p.alt && "Alt", p.shift && "Shift", key].filter(Boolean).join(" + ");
}

const ARIA_KEYS = { Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Backquote: "`", Minus: "-", Equal: "=" };

/** The aria-keyshortcuts spelling of a binding: "Control+K", "Meta+Alt+A", "Alt+Shift+W". */
export function ariaShortcut(binding, mac = isMacPlatform()) {
  const p = parseBinding(binding);
  if (!p) return "";
  const key = /^Key[A-Z]$/.test(p.code) ? p.code.slice(3) : /^Digit\d$/.test(p.code) ? p.code.slice(5) : (ARIA_KEYS[p.code] ?? p.code);
  return [p.mod && (mac ? "Meta" : "Control"), p.alt && "Alt", p.shift && "Shift", key].filter(Boolean).join("+");
}

/**
 * Turns a keydown event into { binding } | { error } | null (null: only a modifier is down, keep waiting).
 * `Mod` is Meta on macOS and Ctrl elsewhere; the other one of the pair is refused rather than guessed at.
 */
export function eventToBinding(e, mac = isMacPlatform()) {
  const code = e.code;
  if (!code || code === "Unidentified" || MODIFIER_CODES.has(code)) return null;
  const mod = mac ? e.metaKey : e.ctrlKey;
  const wrong = mac ? e.ctrlKey : e.metaKey;
  if (wrong) return { error: mac ? "Use ⌘ (Command) rather than Control." : "Use Ctrl rather than the Windows/Meta key." };
  return { binding: formatBinding({ mod, alt: e.altKey, shift: e.shiftKey, code }) };
}

// Browser / OS / text-editing combinations Wedger refuses to take over. `Mod` stands for Ctrl or Command.
const RESERVED_MOD_CODES = new Set([
  "KeyA", "KeyC", "KeyV", "KeyX", "KeyZ", "KeyY",                           // text editing
  "KeyW", "KeyT", "KeyN", "KeyL", "KeyR", "KeyP", "KeyQ",                    // close / new tab / new window / address bar / reload / print / quit
  "KeyD", "KeyF", "KeyG", "KeyH", "KeyJ", "KeyO", "KeyU", "KeyE", "KeyM",    // bookmark, find, history, downloads, open, source, search, minimise
  "Minus", "Equal", "Digit0", "NumpadAdd", "NumpadSubtract", "Numpad0",      // zoom
  "F4", "F5", "F11", "F12", "PageUp", "PageDown",                            // browser tab / reload / fullscreen / devtools / switch tab
  "Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8", "Digit9",   // jump to browser tab
]);
const RESERVED_MOD_SHIFT_CODES = new Set(["KeyN", "KeyT", "KeyW", "KeyP", "KeyR", "KeyI", "KeyJ", "KeyC", "KeyB", "KeyQ", "KeyO", "Delete", "Tab", "F5"]);
const RESERVED_MOD_ALT_CODES = new Set(["KeyI", "KeyJ", "KeyC", "KeyU", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Escape", "F4"]);   // devtools, view source, browser tab switching
const RESERVED_ALT_SHIFT_CODES = new Set(["F4", "Tab"]);                    // window switching / closing

/** null when the binding is acceptable, otherwise a short message for the person. */
export function validateBinding(binding, mac = isMacPlatform()) {
  const p = parseBinding(binding);
  if (!p) return "That isn't a valid key combination.";
  if (NEVER_KEYS.has(p.code)) return `${codeLabel(p.code)} keeps its usual meaning and can't be a shortcut.`;
  if (!p.mod && !(p.alt && p.shift)) return `Shortcuts must include ${mac ? "⌘" : "Ctrl"}, or Alt and Shift together. Plain keys would interfere with typing.`;
  if (p.mod && !p.alt && !p.shift && RESERVED_MOD_CODES.has(p.code)) return "Your browser or the text editor already uses that combination.";
  if (p.mod && p.shift && !p.alt && RESERVED_MOD_SHIFT_CODES.has(p.code)) return "Your browser already uses that combination.";
  if (p.mod && p.alt && !p.shift && RESERVED_MOD_ALT_CODES.has(p.code)) return "Your browser already uses that combination.";
  if (!p.mod && p.alt && p.shift && RESERVED_ALT_SHIFT_CODES.has(p.code)) return "Your system already uses that combination.";
  if (p.mod && p.alt && p.shift && (p.code === "KeyI" || p.code === "KeyJ" || p.code === "KeyC")) return "Your browser already uses that combination.";
  return null;
}

export const defaults = () => Object.fromEntries(COMMANDS.map((c) => [c.id, c.default]));

/**
 * Turns whatever was in storage into a safe { commandId: binding | null } map.
 * Unknown ids are ignored; invalid values, non-clearable nulls and duplicates fall back to the default
 * (or to unassigned if even the default is taken). Processed in registry order so the result is deterministic.
 */
export function sanitizeStored(raw, mac = isMacPlatform()) {
  const out = {};
  const used = new Set();
  const stored = raw && typeof raw === "object" && raw.v === 1 && raw.bindings && typeof raw.bindings === "object" ? raw.bindings : {};
  for (const cmd of COMMANDS) {
    let value = Object.hasOwn(stored, cmd.id) ? stored[cmd.id] : cmd.default;
    if (value === null) { if (!cmd.clearable) value = cmd.default; }
    else if (typeof value !== "string" || validateBinding(value, mac) || parseBinding(value) == null) value = cmd.default;
    if (typeof value === "string") {
      value = formatBinding(parseBinding(value));
      if (used.has(value)) value = used.has(cmd.default) ? null : cmd.default;
      if (value === null && !cmd.clearable) value = cmd.default;     // can't happen with the built-in defaults; keeps the invariant anyway
    }
    out[cmd.id] = value;
    if (value) used.add(value);
  }
  return out;
}

/** Inputs, textareas, selects, contenteditable and CodeMirror: places where keys mean text. */
export function isEditableTarget(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") return !["button", "checkbox", "radio", "range", "submit", "reset", "image", "file", "color"].includes((el.type || "text").toLowerCase());
  if (el.isContentEditable) return true;
  return !!el.closest?.(".cm-editor, [contenteditable=''], [contenteditable='true']");
}

/* ---------------------------------------------------------------- the service */
export class KeyboardShortcuts extends Emitter {
  #bindings = defaults();
  #byBinding = new Map();
  #handlers = new Map();
  #storage;
  #mac;
  #capture = null;
  #initialised = false;
  #onKey = (e) => this.#handleKey(e);

  constructor({ storage = globalThis.localStorage, mac = isMacPlatform() } = {}) {
    super();
    this.#storage = storage;
    this.#mac = mac;
    this.#load();
  }

  get mac() { return this.#mac; }

  /** handlers: { commandId: { run(), isEnabled?() } }. Can be called more than once; later calls replace earlier ones. */
  attach(handlers) {
    for (const [id, h] of Object.entries(handlers)) if (BY_ID.has(id)) this.#handlers.set(id, h);
  }

  /** Installs the single global listener. Safe to call twice. */
  init(target = document) {
    if (this.#initialised) return;
    this.#initialised = true;
    this.#target = target;
    target.addEventListener("keydown", this.#onKey, true);
  }
  #target = null;
  dispose() { this.#target?.removeEventListener("keydown", this.#onKey, true); this.#initialised = false; this.#capture = null; }

  /* ---- configuration ---- */
  get(id) { return this.#bindings[id] ?? null; }
  all() { return COMMANDS.map((c) => ({ ...c, binding: this.#bindings[c.id], display: this.#bindings[c.id] ? labelFor(this.#bindings[c.id], this.#mac) : "", isDefault: this.#bindings[c.id] === c.default })); }
  label(binding) { return labelFor(binding, this.#mac); }
  ownerOf(binding, exceptId = null) { return COMMANDS.find((c) => c.id !== exceptId && this.#bindings[c.id] === binding) ?? null; }

  /** { ok: true } or { ok: false, error }. Rejects invalid, reserved and duplicate bindings. */
  set(id, binding) {
    const cmd = BY_ID.get(id);
    if (!cmd) return { ok: false, error: "Unknown command." };
    const p = parseBinding(binding);
    if (!p) return { ok: false, error: "That isn't a valid key combination." };
    binding = formatBinding(p);
    const problem = validateBinding(binding, this.#mac);
    if (problem) return { ok: false, error: problem };
    const owner = this.ownerOf(binding, id);
    if (owner) return { ok: false, error: `${this.label(binding)} is already used by “${owner.label}”. Change or clear that one first.` };
    this.#bindings[id] = binding;
    this.#commit();
    return { ok: true };
  }

  clear(id) {
    const cmd = BY_ID.get(id);
    if (!cmd) return { ok: false, error: "Unknown command." };
    if (!cmd.clearable) return { ok: false, error: `“${cmd.label}” can't be unassigned.` };
    this.#bindings[id] = null;
    this.#commit();
    return { ok: true };
  }

  reset() { this.#bindings = defaults(); this.#commit(); }

  /* ---- capture: Settings asks the service to hand over the next key combination ---- */
  /** cb({ kind: "binding", binding } | { kind: "error", message } | { kind: "cancel" }). Returns end(). */
  beginCapture(cb) {
    const session = { cb };
    this.#capture = session;
    return () => { if (this.#capture === session) this.#capture = null; };
  }
  get capturing() { return !!this.#capture; }

  /* ---- internals ---- */
  #load() {
    let raw = null;
    try { raw = JSON.parse(this.#storage?.getItem(STORAGE_KEY) ?? "null"); } catch { raw = null; }
    this.#bindings = sanitizeStored(raw, this.#mac);
    this.#index();
  }
  #index() {
    this.#byBinding = new Map();
    for (const c of COMMANDS) { const b = this.#bindings[c.id]; if (b) this.#byBinding.set(b, c); }
  }
  #commit() {
    this.#index();
    try { this.#storage?.setItem(STORAGE_KEY, JSON.stringify({ v: 1, bindings: this.#bindings })); } catch { /* storage blocked: still works for this visit */ }
    this.emit("changed", this.all());
  }

  #handleKey(e) {
    if (e.isComposing || e.keyCode === 229) return;                      // IME composition

    if (this.#capture) {
      const session = this.#capture;
      if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) { this.#capture = null; session.cb({ kind: "cancel", reason: "tab" }); return; }   // let focus move on
      e.preventDefault(); e.stopPropagation();
      if (e.repeat) return;
      if (e.key === "Escape" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) { this.#capture = null; session.cb({ kind: "cancel", reason: "escape" }); return; }
      const res = eventToBinding(e, this.#mac);
      if (!res) return;                                                  // just a modifier so far
      if (res.error) { session.cb({ kind: "error", message: res.error }); return; }
      session.cb({ kind: "binding", binding: res.binding });
      return;
    }

    if (e.defaultPrevented) return;
    const res = eventToBinding(e, this.#mac);
    if (!res?.binding) return;
    const cmd = this.#byBinding.get(res.binding);
    if (!cmd) return;
    const handler = this.#handlers.get(cmd.id);
    if (!handler) return;
    if (!cmd.inEditable && isEditableTarget(e.target)) return;           // typing wins
    if (document.querySelector("dialog[open], .popup-menu")) return;     // a dialog or menu has the floor
    if (handler.isEnabled && !handler.isEnabled()) return;               // nothing sensible to do here: leave the browser alone
    e.preventDefault();
    if (e.repeat) return;                                                // held key: swallow it, run once
    try {
      const r = handler.run();
      if (r?.catch) r.catch((err) => console.error(`Shortcut "${cmd.id}" failed`, err));
    } catch (err) { console.error(`Shortcut "${cmd.id}" failed`, err); }
  }
}

export const shortcuts = new KeyboardShortcuts();

/** { title, "aria-keyshortcuts" } for an icon-only control: the tooltip carries the CURRENT binding. */
export function shortcutAttrs(id, base, svc = shortcuts) {
  const b = svc.get(id);
  return { title: b ? `${base} (${svc.label(b)})` : base, "aria-keyshortcuts": b ? ariaShortcut(b, svc.mac) : null };
}

/**
 * Fills `[data-shortcut="commandId"]` hints (menu rows, menubar triggers) and sets title + aria-keyshortcuts on
 * `[data-shortcut-title="commandId"]` icon buttons, from the live bindings. Repaints when they change.
 * Returns the unsubscribe function.
 */
export function bindShortcutHints(root, svc = shortcuts) {
  const paint = () => {
    for (const el of root.querySelectorAll("[data-shortcut]")) {
      const b = svc.get(el.dataset.shortcut);
      el.textContent = b ? svc.label(b) : "";
      el.hidden = !b;
    }
    for (const el of root.querySelectorAll("[data-shortcut-title]")) {
      el.dataset.titleBase ??= el.getAttribute("title") ?? "";
      const a = shortcutAttrs(el.dataset.shortcutTitle, el.dataset.titleBase, svc);
      el.title = a.title;
      if (a["aria-keyshortcuts"]) el.setAttribute("aria-keyshortcuts", a["aria-keyshortcuts"]); else el.removeAttribute("aria-keyshortcuts");
    }
  };
  paint();
  return svc.on("changed", paint);
}
