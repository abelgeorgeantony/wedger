/* overlays.js — toasts, popup menus and dialogs.
 * Dialogs are NOT files (they interrupt rather than open in the viewer),
 * but dialog bodies that are more than a sentence long are still loaded
 * from external templates (see openTemplate).
 */
import { h } from "./core.js";
import { assets } from "./registry.js";

function overlayRoot() {
  let el = document.getElementById("overlay-root");
  if (!el) { el = h("div", { id: "overlay-root" }); document.body.append(el); }
  return el;
}

/* ---------- toasts ---------- */
export function toast(message, type = "info", ms = 3500) {
  const root = overlayRoot();
  let stack = root.querySelector(".toast-stack");
  if (!stack) { stack = h("div", { class: "toast-stack", role: "status" }); root.append(stack); }
  const el = h("div", { class: `toast toast--${type}` }, message);
  stack.append(el);
  setTimeout(() => el.remove(), ms);
}

/* ---------- popup menu ---------- */
/** items: [{label, onSelect, danger, disabled}] | {separator:true}.  anchor: Element or {x, y}. */
export function menu(anchor, items) {
  const root = overlayRoot();
  const el = h("div", { class: "popup-menu", role: "menu" });
  const opener = document.activeElement;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    el.remove();
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
    opener?.focus?.();
  };
  const onOutside = (e) => { if (!el.contains(e.target)) close(); };
  const buttons = [];
  for (const item of items) {
    if (item.separator) { el.append(h("div", { class: "popup-menu__sep", role: "separator" })); continue; }
    const b = h("button", {
      class: `popup-menu__item${item.danger ? " popup-menu__item--danger" : ""}`,
      role: "menuitem", type: "button", disabled: item.disabled,
      onclick: () => { close(); item.onSelect?.(); },
    }, item.label);
    buttons.push(b);
    el.append(b);
  }
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const enabled = buttons.filter((b) => !b.disabled);
      const i = enabled.indexOf(document.activeElement);
      const next = e.key === "ArrowDown" ? (i + 1) % enabled.length : (i <= 0 ? enabled.length - 1 : i - 1);
      enabled[next]?.focus();
    }
  };

  root.append(el);
  const rect = anchor instanceof Element ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
  const w = el.offsetWidth, hgt = el.offsetHeight;
  el.style.left = `${Math.max(4, Math.min(rect.left, window.innerWidth - w - 4))}px`;
  el.style.top = `${Math.max(4, Math.min(rect.bottom + 2, window.innerHeight - hgt - 4))}px`;

  document.addEventListener("pointerdown", onOutside, true);
  document.addEventListener("keydown", onKey, true);
  buttons.find((b) => !b.disabled)?.focus();
  return close;
}

/* ---------- dialogs ---------- */
/** Shows `content` in a modal <dialog>. Resolves `done` with whatever was passed to close(). */
export function showDialog(content, { label = "Dialog", wide = false } = {}) {
  const dialog = h("dialog", { class: `dialog${wide ? " dialog--wide" : ""}`, "aria-label": label });
  dialog.append(content);
  document.body.append(dialog);
  let result = null;
  const done = new Promise((resolve) =>
    dialog.addEventListener("close", () => { dialog.remove(); resolve(result); }));
  dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });
  dialog.showModal();
  return { dialog, close: (value = null) => { result = value; dialog.close(); }, done };
}

export async function confirm({ title, message = "", confirmLabel = "Confirm", danger = false }) {
  const body = h("div", { class: "dialog__body" },
    h("h2", { class: "dialog__title" }, title),
    message && h("p", { class: "dialog__message" }, message));
  let d;
  const actions = h("div", { class: "dialog__actions" },
    h("button", { class: "btn", type: "button", onclick: () => d.close(false) }, "Cancel"),
    h("button", { class: `btn ${danger ? "btn--danger-solid" : "btn--primary"}`, type: "button", onclick: () => d.close(true) }, confirmLabel));
  d = showDialog(h("div", {}, body, actions), { label: title });
  return (await d.done) === true;
}

/** Resolves with the entered string, or null if cancelled. validate(value) returns an error message or null. */
export async function prompt({ title, label, value = "", confirmLabel = "OK", validate }) {
  const input = h("input", { class: "input", type: "text", value, autocomplete: "off", spellcheck: "false", "aria-label": label });
  const error = h("p", { class: "field__error", role: "alert", hidden: true });
  const submit = () => {
    const msg = validate?.(input.value) ?? null;
    if (msg) { error.textContent = msg; error.hidden = false; input.setAttribute("aria-invalid", "true"); return; }
    d.close(input.value);
  };
  const form = h("form", { onsubmit: (e) => { e.preventDefault(); submit(); } },
    h("div", { class: "dialog__body" },
      h("h2", { class: "dialog__title" }, title),
      h("label", { class: "field" }, h("span", { class: "field__label" }, label), input, error)),
    h("div", { class: "dialog__actions" },
      h("button", { class: "btn", type: "button", onclick: () => d.close(null) }, "Cancel"),
      h("button", { class: "btn btn--primary", type: "submit" }, confirmLabel)));
  const d = showDialog(form, { label: title });
  input.focus(); input.select();
  return d.done;
}

/**
 * Opens a dialog whose body lives in an external template (assets/<template>),
 * optionally driven by a controller module exporting mount({ root, params, close, assets }).
 */
export async function openTemplate(template, { controller, params = {}, label = "Dialog", wide = false } = {}) {
  const html = await assets.text(template);
  const root = h("div", { class: "dialog__surface" });
  root.innerHTML = html;
  const d = showDialog(root, { label, wide });
  let api;
  if (controller) {
    const mod = await assets.module(controller);
    api = await mod.mount?.({ root, params, close: d.close, assets });
  }
  const result = await d.done;
  api?.dispose?.();
  return result;
}
