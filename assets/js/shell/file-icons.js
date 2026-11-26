/* file-icons.js — which icon each kind of file gets in the sidebar and on its tab.
 *
 * This is the ONE place the mapping lives. Nothing else (sidebar.js, editor-service.js, CSS, HTML) hard-codes an icon
 * path: they all call fileIconEl(name) / fileIconForName(name).
 *
 * Icons are drawn as <img> (not as a CSS mask like the toolbar icons), so each SVG keeps its own colours.
 * A name with no entry below, or an icon file that fails to load, falls back to the generic file icon: there is
 * never a broken-image box.
 */
import { ASSETS, extOf, h } from "./core.js";

/*
 * CUSTOMISE FILE ICON PATHS HERE
 *
 * Keys are lower-case file extensions, with the dot. Values are paths relative to the /assets/ directory (so
 * "icons/journal.svg" is /assets/icons/journal.svg). To use a different icon, rename or replace the file in
 * assets/icons/ and/or change the value on its line. To give another extension an icon, add a line.
 * These resolve against the assets URL, so they work under any Jekyll baseurl.
 */
export const FILE_ICON_PATHS = {
  ".journal": "icons/journal.svg",
  ".timeclock": "icons/timeclock.svg",
  ".timedot": "icons/timedot.svg",
  ".csv": "icons/csv.svg",
  ".rules": "icons/rules.svg",
};

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** The configured path for a file name (relative to /assets/), or null for an unknown extension. */
export function fileIconPath(filename) {
  const ext = extOf(String(filename ?? ""));
  return ext && has(FILE_ICON_PATHS, ext) ? FILE_ICON_PATHS[ext] : null;
}

/** { ext, path, url, known } — `url` is absolute (baseurl-safe); `known` is false for the generic fallback. */
export function fileIconForName(filename) {
  const ext = extOf(String(filename ?? ""));
  const path = fileIconPath(filename);
  return { ext, path, url: path ? new URL(path, ASSETS).href : null, known: !!path };
}

/**
 * The icon element for a file name: a type icon <img>, or the generic file icon. Fresh element on every call.
 * If the image can't be loaded it turns itself into the generic icon.
 */
export function fileIconEl(filename, { className = "" } = {}) {
  const { url, ext } = fileIconForName(filename);
  const generic = () => h("span", { class: `icon icon--file file-icon-fallback ${className}`.trim(), "aria-hidden": "true" });
  if (!url) return generic();
  const img = h("img", {
    class: `file-icon file-icon--${ext.slice(1)} ${className}`.trim(), src: url, alt: "", width: "16", height: "16",
    decoding: "async", draggable: "false", "aria-hidden": "true",
  });
  img.addEventListener("error", () => img.replaceWith(generic()), { once: true });
  return img;
}

/** For tests and tooling: every distinct path the configuration refers to. */
export const configuredIconPaths = () => [...new Set(Object.values(FILE_ICON_PATHS))];
