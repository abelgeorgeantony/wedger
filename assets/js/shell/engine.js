/* engine.js — the hledger-lib-wasm engine, behind one small async API.
 *
 * The WASM session holds exactly ONE loaded journal at a time, and loading a
 * different one (or converting a CSV) replaces it. This wrapper therefore:
 *   - runs every call through a queue so two views never race each other,
 *   - remembers which text is currently loaded and only re-parses when it changed,
 *   - mirrors the file store into the engine's virtual filesystem so that
 *     `include` directives resolve,
 *   - caches parsed transactions per file.
 *
 * Every method resolves to a plain object; failures are { ok:false, error }.
 * Only init() / whenReady() reject (when the WASM itself can't be loaded).
 */
import { Emitter } from "./core.js";

const isLocalDev = location.protocol === "file:" || location.hostname === "localhost" || location.hostname === "127.0.0.1";
const LIB_BASE = isLocalDev ? "http://localhost:5001/" : "https://cdn.jsdelivr.net/gh/abelgeorgeantony/hledger-lib-wasm@main/";

const REPORT_METHODS = {
  accounts: "accounts", balance: "balance", check: "check", checkstrict: "checkStrict", register: "register",
  print: "print", printtext: "printText", prices: "prices", payees: "payees", commodities: "commodities",
  tags: "tags", balancesheet: "balancesheet", incomestatement: "incomestatement", cashflow: "cashflow", budget: "budget",
};

const failure = (err) => ({ ok: false, error: err?.message ?? String(err) });

/** Mutations report errors as { error } (sometimes with ok:false). */
const mutationError = (res) => (!res ? "The engine returned nothing." : res.error ?? (res.ok === false ? "The engine rejected the change." : null));

class Engine extends Emitter {
  /** "idle" | "loading" | "ready" | "error" */
  status = "idle";
  error = null;
  progress = "";

  #session = null;
  #initPromise = null;
  #chain = Promise.resolve();
  #loaded = null;             // { text, forecast, fsVersion }
  #fsVersion = 0;
  #files = new Map();         // mirror of the file store (name -> content)
  #txCache = new Map();       // name -> { text, forecast, fsVersion, result }

  get ready() { return this.status === "ready"; }

  /* ------------------------------------------------------------ lifecycle */
  init() {
    if (this.#initPromise) return this.#initPromise;
    this.#setStatus("loading");
    this.#initPromise = (async () => {
      const restoreFetch = this.#watchDownloads();
      try {
        const { HledgerSession } = await import(`${LIB_BASE}js/hledger.js`);
        this.#session = await HledgerSession.init();
        for (const [name, content] of this.#files) this.#session.fs.setFile(name, content);
        this.error = null;
        this.#setStatus("ready");
      } catch (err) {
        console.error("hledger engine failed to start", err);
        this.error = new Error(`The accounting engine couldn't be loaded (${err?.message ?? err}). Check your connection.`);
        this.#setStatus("error");
        throw this.error;
      } finally { restoreFetch(); }
    })();
    return this.#initPromise;
  }

  /** Starts over after a failed init (used by the Retry buttons). */
  retry() {
    if (this.status !== "error") return this.#initPromise ?? this.init();
    this.#initPromise = null;
    return this.init();
  }

  async whenReady() {
    if (this.ready) return;
    await this.init();
  }

  #setStatus(status) { this.status = status; this.emit("status", status); }

  /** Reports "Fetching hledger-wasm-final.wasm.gz: 3.2 MB / 9.8 MB" while the engine downloads. */
  #watchDownloads() {
    const original = window.fetch;
    window.fetch = async (...args) => {
      const response = await original(...args);
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url ?? String(args[0] ?? "");
      if (!response.body || response.type === "opaque" || !/wasm|hledger/i.test(url)) return response;
      const total = parseInt(response.headers.get("content-length") ?? "0", 10);
      const reader = response.body.getReader();
      let loaded = 0;
      const mb = (n) => (n / 1048576).toFixed(1);
      const stream = new ReadableStream({
        start: async (controller) => {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) { controller.close(); break; }
            loaded += value.length;
            this.progress = `Downloading ${url.split("/").pop()} · ${mb(loaded)}${total ? ` / ${mb(total)}` : ""} MB`;
            this.emit("progress", this.progress);
            controller.enqueue(value);
          }
        },
      });
      return new Response(stream, { headers: response.headers, status: response.status, statusText: response.statusText });
    };
    return () => { window.fetch = original; this.progress = ""; };
  }

  /* ------------------------------------------------ virtual filesystem mirror */
  setFile(name, content) {
    this.#files.set(name, content);
    this.#fsVersion++;
    this.#session?.fs.setFile(name, content);
  }
  removeFile(name) {
    this.#files.delete(name);
    this.#txCache.delete(name);
    this.#fsVersion++;
    this.#session?.fs.deleteFile(name);
  }
  replaceAllFiles(map) {
    for (const name of [...this.#files.keys()]) if (!map.has(name)) this.removeFile(name);
    for (const [name, content] of map) this.setFile(name, content);
  }

  /* ------------------------------------------------------------- plumbing */
  #run(fn) {
    const p = this.#chain.then(async () => {
      if (!this.#session) await this.whenReady();
      return fn(this.#session);
    });
    this.#chain = p.catch(() => {});
    return p;
  }

  async #use(session, text, forecast) {
    const loaded = this.#loaded;
    if (loaded && loaded.text === text && loaded.forecast === forecast && loaded.fsVersion === this.#fsVersion) return { ok: true };
    this.#loaded = null;
    const res = await session.loadJournal(text, forecast);
    if (res?.ok) this.#loaded = { text, forecast, fsVersion: this.#fsVersion };
    return res ?? { ok: false, error: "The engine returned nothing." };
  }

  /* ------------------------------------------------------------ operations */
  /** Parsed transactions of `text`: { ok, data:[{id,date,description,postings:[{account,amount}],rawText}] } */
  transactions(name, text, { forecast = false } = {}) {
    const hit = this.#txCache.get(name);
    if (hit && hit.text === text && hit.forecast === forecast && hit.fsVersion === this.#fsVersion) return Promise.resolve(hit.result);
    return this.#run(async (s) => {
      const loaded = await this.#use(s, text, forecast);
      if (!loaded.ok) return { ok: false, error: loaded.error };
      const result = await s.getJournalJSON();
      const out = result?.ok ? { ok: true, data: result.data ?? [] } : { ok: false, error: result?.error ?? "Couldn't read the journal." };
      if (out.ok) this.#txCache.set(name, { text, forecast, fsVersion: this.#fsVersion, result: out });
      return out;
    }).catch(failure);
  }

  /** Account names (declared + used) for autocomplete. */
  accounts(text, { forecast = false } = {}) {
    return this.#run(async (s) => {
      const loaded = await this.#use(s, text, forecast);
      if (!loaded.ok) return [];
      const res = await s.accounts("");
      return res?.ok && Array.isArray(res.data) ? res.data.map(String) : [];
    }).catch(() => []);
  }

  /** Runs a report on `text`. Resolves { ok, data } or { ok:false, error }. */
  report(type, text, { query = "", forecast = false } = {}) {
    const method = REPORT_METHODS[type];
    if (!method) return Promise.resolve({ ok: false, error: `Unknown report "${type}".` });
    return this.#run(async (s) => {
      const loaded = await this.#use(s, text, forecast);
      if (!loaded.ok) return { ok: false, error: loaded.error };
      return (await s[method](query)) ?? { ok: false, error: "The engine returned nothing." };
    }).catch(failure);
  }

  /** Appends a transaction. Resolves { ok:true, text } (the new journal text) or { ok:false, error }. */
  addTransaction(text, txnText, { forecast = false } = {}) {
    return this.#mutate(text, forecast, (s) => s.balanceTransaction(txnText));
  }
  updateTransaction(text, id, txnText, { forecast = false } = {}) {
    return this.#mutate(text, forecast, (s) => s.updateTransaction(id, txnText));
  }
  deleteTransaction(text, id, { forecast = false } = {}) {
    return this.#mutate(text, forecast, (s) => s.deleteTransaction(id));
  }
  #mutate(text, forecast, op) {
    return this.#run(async (s) => {
      const loaded = await this.#use(s, text, forecast);
      if (!loaded.ok) return { ok: false, error: loaded.error };
      const res = await op(s);
      this.#loaded = null;              // the handle no longer matches any saved text
      const err = mutationError(res);
      if (err) return { ok: false, error: err };
      if (typeof res.rawText !== "string") return { ok: false, error: "The engine didn't return the updated journal." };
      return { ok: true, text: res.rawText };
    }).catch(failure);
  }

  /** CSV + rules -> journal text. Resolves { ok, text, count } or { ok:false, error }. */
  convertCsv(csv, rules, { forecast = false } = {}) {
    return this.#run(async (s) => {
      this.#loaded = null;              // parseCsv replaces whatever was loaded
      const parsed = await s.parseCsv(csv, rules, forecast);
      if (!parsed?.ok) return { ok: false, error: parsed?.error ?? "hledger couldn't read this CSV with those rules." };
      const printed = await s.printText("");
      const text = typeof printed?.data === "string" ? printed.data : "";
      const json = await s.getJournalJSON();
      return { ok: true, text, count: json?.ok ? (json.data?.length ?? 0) : null };
    }).catch(failure);
  }

  /** Validates journal text without keeping it. Resolves { ok, count } or { ok:false, error }. */
  inspectJournal(text) {
    return this.#run(async (s) => {
      this.#loaded = null;
      const loaded = await s.loadJournal(text, false);
      if (!loaded?.ok) return { ok: false, error: loaded?.error ?? "hledger couldn't read this journal." };
      const json = await s.getJournalJSON();
      return { ok: true, count: json?.ok ? (json.data?.length ?? 0) : null };
    }).catch(failure);
  }
}

export const engine = new Engine();
