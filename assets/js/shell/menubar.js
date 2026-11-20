/* menubar.js — behaviour shared by every file's menu bar (journals, Reports output, ...).
 *
 * Markup contract (see assets/views/journal-menu.html):
 *   <nav class="menubar">
 *     <div class="menubar__item">
 *       <button class="menubar__btn" aria-expanded="false">Reports</button>
 *       <div class="menubar__panel" hidden>...</div>
 *     </div>
 *   </nav>
 *
 * Opening a menu never changes the size of anything: the button keeps its
 * weight and width, and the panel floats above the page.
 */
export function initMenubar(bar, { onOpen } = {}) {
  const items = () => [...bar.querySelectorAll(".menubar__item")];
  const btnOf = (item) => item.querySelector(".menubar__btn");
  const panelOf = (item) => item.querySelector(".menubar__panel");
  let current = null;

  function place(panel) {
    panel.style.left = "";
    if (getComputedStyle(panel).position === "fixed") return;       // phones: full-width sheet
    const r = panel.getBoundingClientRect();
    const overflow = r.right - (window.innerWidth - 8);
    if (overflow > 0) panel.style.left = `${-overflow}px`;
  }

  function close({ restoreFocus = false } = {}) {
    if (!current) return;
    const item = current;
    current = null;
    btnOf(item).setAttribute("aria-expanded", "false");
    panelOf(item).hidden = true;
    if (restoreFocus) btnOf(item).focus();
  }

  function open(item, { focusFirst = false } = {}) {
    if (current === item) return;
    close();
    const btn = btnOf(item), panel = panelOf(item);
    if (btn.disabled) return;
    current = item;
    btn.setAttribute("aria-expanded", "true");
    panel.hidden = false;
    place(panel);
    onOpen?.(item.dataset.menu, panel);
    if (focusFirst) panel.querySelector("input:not([type=radio]):not([type=checkbox]):not([disabled]), button:not([disabled]), input:not([disabled])")?.focus();
  }

  bar.addEventListener("click", (e) => {
    const btn = e.target.closest(".menubar__btn");
    if (!btn || !bar.contains(btn)) return;
    const item = btn.closest(".menubar__item");
    if (current === item) close();
    else open(item, { focusFirst: e.detail === 0 });                 // keyboard activation moves focus into the panel
  });

  // While one menu is open, hovering another top-level item switches to it (like a desktop menu bar).
  bar.addEventListener("pointerover", (e) => {
    if (!current || e.pointerType !== "mouse") return;
    const item = e.target.closest(".menubar__item");
    if (item && item !== current && !btnOf(item).disabled) open(item);
  });

  bar.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && current) { e.preventDefault(); close({ restoreFocus: true }); return; }
    if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && e.target.classList.contains("menubar__btn")) {
      const list = items().filter((i) => !btnOf(i).disabled);
      const idx = list.indexOf(e.target.closest(".menubar__item"));
      const next = list[(idx + (e.key === "ArrowRight" ? 1 : -1) + list.length) % list.length];
      e.preventDefault();
      btnOf(next).focus();
      if (current) open(next);
    }
  });

  const onOutside = (e) => { if (current && !bar.contains(e.target)) close(); };
  document.addEventListener("pointerdown", onOutside);
  const onResize = () => { if (current) place(panelOf(current)); };
  window.addEventListener("resize", onResize);

  return {
    close,
    /** Opens a top-level menu by its data-menu name (used by keyboard shortcuts). */
    open(name, opts) { const item = items().find((i) => i.dataset.menu === name); if (item) open(item, opts); },
    get isOpen() { return !!current; },
    dispose() { document.removeEventListener("pointerdown", onOutside); window.removeEventListener("resize", onResize); },
  };
}

