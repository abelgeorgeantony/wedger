/* time-session.js — ONE source of truth for an open .timeclock / .timedot file.
 *
 * The Raw editor and the rendered view never hold separate copies: both read and write `session.text`. Raw typing
 * calls setText(); a rendered action calls apply(mutation) with a pure mutation from timeclock.js / timedot.js, which
 * either returns new text (adopted atomically) or an error (nothing changes). The parsed model is cached per text, so
 * a view asking for it after every keystroke only parses when the text really changed.
 *
 * Saving goes through host.files.write(). With auto-save on, writes are debounced and flushed on dispose, on tab
 * hide and on page hide; with it off the tab shows the dirty dot until save() is called.
 *
 * No DOM here. `files` and `settings` are Wedger's host.files / host.settings (or fakes with the same shape).
 */
import { Emitter, debounce } from "./core.js";
import { timeKindOf } from "./time-format.js";
import { parseTimeclock } from "./timeclock.js";
import { parseTimedot } from "./timedot.js";

const PARSERS = { timeclock: parseTimeclock, timedot: parseTimedot };

export class TimeSession extends Emitter {
  #files; #settings; #getName; #setDirty; #notify;
  #text; #saved; #parsed = null; #disposed = false;
  #offs = [];

  /**
   * @param {{ files, settings, name: () => string, setDirty?: (b: boolean) => void, notify?: (msg: string, type?: string) => void, autosaveMs?: number }} o
   * events: "text" ({ text, source: "raw"|"mutation"|"external" }), "saved", "error" (message)
   */
  constructor({ files, settings, name, setDirty = () => {}, notify = () => {}, autosaveMs = 700 }) {
    super();
    this.#files = files; this.#settings = settings; this.#getName = name; this.#setDirty = setDirty; this.#notify = notify;
    this.kind = timeKindOf(name());
    if (!PARSERS[this.kind]) throw new Error(`“${name()}” is not a time-tracking file.`);
    this.#text = this.#saved = files.get(name())?.content ?? "";
    this.autosave = debounce(() => { this.save(); }, autosaveMs);

    this.#offs.push(
      files.on("changed", (ev) => this.#onFileChanged(ev)),
      settings.on("autoSave", () => { this.#syncDirty(); if (settings.get("autoSave")) this.autosave(); }),
    );
  }

  get name() { return this.#getName(); }
  get text() { return this.#text; }
  get isDirty() { return this.#text !== this.#saved; }

  /** The parsed model of the current text (cached). */
  get model() {
    if (!this.#parsed || this.#parsed.text !== this.#text) this.#parsed = PARSERS[this.kind](this.#text);
    return this.#parsed;
  }

  /** Raw editor typing (or any whole-text replacement from the editor). */
  setText(text, source = "raw") {
    if (text === this.#text) return;
    this.#text = text;
    this.#afterChange(source);
  }

  /**
   * Applies a pure mutation: `fn(text)` returns { ok: true, text } or { ok: false, error }.
   * On success the new text becomes the session text atomically; on failure nothing changes and the error is returned.
   */
  apply(fn) {
    const res = fn(this.#text);
    if (res?.ok && !res.unchanged && res.text !== this.#text) { this.#text = res.text; this.#afterChange("mutation"); }
    return res;
  }

  #afterChange(source) {
    this.#syncDirty();
    this.emit("text", { text: this.#text, source });
    if (this.#settings.get("autoSave")) this.autosave();
  }
  #syncDirty() {
    // With auto-save on, "unsaved" lasts under a second, so the tab doesn't flash a dot (or nag on close).
    this.#setDirty(this.isDirty && !this.#settings.get("autoSave"));
  }

  /** Writes the text to the file store. Returns false (and reports) when it could not be saved. */
  save() {
    this.autosave.cancel();
    if (!this.isDirty) return true;
    const name = this.#getName();
    if (!this.#files.exists(name)) return false;
    try { this.#files.write(name, this.#text); }
    catch (err) { this.#notify(err.message, "error"); this.emit("error", err.message); return false; }
    this.#saved = this.#text;
    this.#syncDirty();
    this.emit("saved");
    return true;
  }

  /** Flush on the way out (tab hidden, page hidden, closing): only when auto-save is on, as in the journal viewer. */
  flush() {
    if (this.#settings.get("autoSave") && this.#files.exists(this.#getName())) this.save(); else this.autosave.cancel();
  }

  /** The file changed elsewhere (Drive sync, another tab): adopt it unless there are unsaved edits here. */
  #onFileChanged(ev) {
    if (this.#disposed) return;
    if (!(ev.kind === "reload" || ev.kind === "meta" || ev.name === this.#getName())) return;
    const f = this.#files.get(this.#getName());
    if (f && f.content !== this.#saved && !this.isDirty) {
      this.#text = this.#saved = f.content;
      this.#syncDirty();
      this.emit("text", { text: this.#text, source: "external" });
    }
  }

  dispose() {
    if (this.#disposed) return;
    this.flush();
    this.#disposed = true;
    this.autosave.cancel();
    this.#offs.forEach((off) => off());
    this.#offs = [];
  }
}
