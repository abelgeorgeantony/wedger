import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { FILE_ICON_PATHS, fileIconPath, fileIconForName, configuredIconPaths } from "../assets/js/shell/file-icons.js";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const root = new URL("../", import.meta.url);

/* -------------------------------------------------------------------- icons */
test("each known extension maps to its own icon, whatever the case of the name", () => {
  const paths = new Set();
  for (const ext of [".journal", ".timeclock", ".timedot", ".csv", ".rules"]) {
    const p = fileIconPath(`my file${ext}`);
    assert.ok(p, `${ext} has an icon`);
    assert.equal(fileIconPath(`MY FILE${ext.toUpperCase()}`), p, `${ext} is case-insensitive`);
    assert.equal(fileIconForName(`a${ext}`).known, true);
    paths.add(p);
  }
  assert.equal(paths.size, 5, "five different icons");
});

test("unknown extensions, no extension and odd names fall back to the generic file icon", () => {
  for (const name of ["notes.txt", "README", "", ".hidden", "archive.journal.bak", "x.constructor", "x.__proto__", undefined, null]) {
    const r = fileIconForName(name);
    assert.equal(r.known, false, String(name));
    assert.equal(r.url, null);
    assert.equal(fileIconPath(name), null);
  }
});

test("icon URLs are resolved against the assets URL, so a Jekyll baseurl cannot break them", () => {
  const { url } = fileIconForName("a.timeclock");
  assert.ok(/\/assets\/icons\/[^/]+\.svg$/.test(url), url);
  assert.ok(!url.includes("/assets/assets/"));
});

test("the mapping lives in ONE place: no other source file hard-codes a mapped icon path", () => {
  const others = ["assets/js/shell/sidebar.js", "assets/js/shell/editor-service.js", "index.html", "assets/css/base.css", "assets/css/components.css", "assets/css/time.css"];
  for (const path of configuredIconPaths()) {
    for (const file of others) assert.equal(read(file).includes(path), false, `${file} must not mention ${path}`);
  }
  assert.match(read("assets/js/shell/sidebar.js"), /fileIconEl\(/);
  assert.match(read("assets/js/shell/editor-service.js"), /fileIconEl\(/);
});

test("the configuration module is clearly marked and documented for customisation", () => {
  const src = read("assets/js/shell/file-icons.js");
  assert.match(src, /CUSTOMISE FILE ICON PATHS HERE/);
  assert.match(src, /relative to the \/assets\/ directory/);
  assert.match(src, /export const FILE_ICON_PATHS = \{/);
  assert.match(src, /export function fileIconForName/);
});

test("every configured icon file exists in assets/ (this fails with the real file names if a path is wrong)", (t) => {
  const dir = new URL("assets/icons/", root);
  const svgs = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".svg")) : [];
  if (!svgs.length) { t.skip("assets/icons is empty or absent in this checkout"); return; }
  const missing = Object.entries(FILE_ICON_PATHS).filter(([, p]) => !existsSync(new URL(`assets/${p}`, root)));
  assert.deepEqual(missing, [], `FILE_ICON_PATHS in assets/js/shell/file-icons.js points at files that don't exist: ${missing.map(([e, p]) => `${e} → ${p}`).join(", ")}. Files in assets/icons: ${svgs.join(", ")}`);
});

/* --------------------------------------------------------------- navigation */
test("the sidebar section is called Files, and every aria reference in index.html is valid", () => {
  const html = read("index.html");
  assert.match(html, /id="files-dropdown-btn"[\s\S]*?Files\s*<\/span>|id="files-dropdown-btn"[\s\S]{0,400}?Files/);
  assert.equal(/Journals\s*\n/.test(html.replace(/<!--[\s\S]*?-->/g, "")), false, "no 'Journals' heading is left");
  assert.equal(html.includes("journals-list") || html.includes("journals-dropdown-btn"), false);
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  for (const m of html.matchAll(/aria-(?:controls|labelledby|describedby)="([^"]+)"/g)) {
    for (const id of m[1].split(/\s+/)) assert.ok(ids.has(id), `aria reference to missing id "${id}"`);
  }
  const js = read("assets/js/shell/sidebar.js");
  assert.match(js, /\$\("files-list"\)/);
  assert.match(js, /\$\("files-dropdown-btn"\)/);
  assert.equal(js.includes("journals-"), false);
  assert.ok(ids.has("files-list") && ids.has("files-dropdown-btn"));
});

test("the empty state talks about files, not only journals", () => {
  const js = read("assets/js/shell/sidebar.js");
  assert.match(js, /No files yet\. Create a file, or import one/);
});

test("the JavaScript only looks up element ids that index.html defines (no stale ids after the rename)", () => {
  const html = read("index.html");
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const js = read("assets/js/shell/sidebar.js");
  for (const m of js.matchAll(/\$\("([a-z0-9-]+)"\)/g)) assert.ok(ids.has(m[1]), `sidebar.js asks for #${m[1]}, which index.html doesn't define`);
});
