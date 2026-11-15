/* assets/js/ui/helpers.js
 * Left-sidebar drag-to-resize. The width is remembered between visits.
 * Change CONFIG to taste — everything else adapts.
 */
(function () {
  'use strict';

  const CONFIG = {
    min: 15,       // % of viewport width
    max: 35,       // % of viewport width
    initial: 20,   // % of viewport width
    step: 1,       // % per arrow key press
    bigStep: 5,    // % per shift+arrow key press
  };
  const STORAGE_KEY = 'wedger_sidebar_width';

  const root = document.documentElement;
  const resizer = document.getElementById('resizer');
  const body = document.body;

  if (!resizer) {
    console.error("resizer element not found!");
    return;
  }

  const clamp = (v) => Math.min(CONFIG.max, Math.max(CONFIG.min, v));

  let current = CONFIG.initial;
  try {
    const saved = parseFloat(localStorage.getItem(STORAGE_KEY));
    if (Number.isFinite(saved)) current = saved;
  } catch (_) { /* storage blocked */ }

  function apply(percent, { remember = false } = {}) {
    current = clamp(percent);
    root.style.setProperty('--sidebar-width', current + '%');
    resizer.setAttribute('aria-valuenow', current.toFixed(1));
    if (remember) { try { localStorage.setItem(STORAGE_KEY, String(current)); } catch (_) { } }
  }

  // --- init ---
  apply(current);
  resizer.setAttribute('aria-valuemin', CONFIG.min);
  resizer.setAttribute('aria-valuemax', CONFIG.max);

  // --- pointer dragging ---
  let dragging = false;

  resizer.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    resizer.setPointerCapture(e.pointerId);
    resizer.classList.add('dragging');
    body.classList.add('resizing');
    e.preventDefault();
  });

  resizer.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    // sidebar starts at x = 0, so clientX is directly its width
    apply((e.clientX / window.innerWidth) * 100);
  });

  function stopDrag(e) {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    body.classList.remove('resizing');
    apply(current, { remember: true });
    if (e && e.pointerId != null) {
      try { resizer.releasePointerCapture(e.pointerId); } catch (_) { }
    }
  }

  resizer.addEventListener('pointerup', stopDrag);
  resizer.addEventListener('pointercancel', stopDrag);
  resizer.addEventListener('lostpointercapture', stopDrag);

  // --- keyboard accessibility ---
  resizer.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? CONFIG.bigStep : CONFIG.step;
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        apply(current - step, { remember: true });
        e.preventDefault();
        break;
      case 'ArrowRight':
      case 'ArrowUp':
        apply(current + step, { remember: true });
        e.preventDefault();
        break;
      case 'Home':
        apply(CONFIG.min, { remember: true });
        e.preventDefault();
        break;
      case 'End':
        apply(CONFIG.max, { remember: true });
        e.preventDefault();
        break;
    }
  });

  // double-click resets to the initial width
  resizer.addEventListener('dblclick', () => apply(CONFIG.initial, { remember: true }));

  // keep percentages sane if the window gets very narrow
  window.addEventListener('resize', () => apply(current));
})();
