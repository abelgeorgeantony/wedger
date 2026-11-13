/* assets/js/ui/helpers.js
 * Left-sidebar drag-to-resize.
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

  const root = document.documentElement;
  const resizer = document.getElementById('resizer');
  const body = document.body;

  if (!resizer) {
    console.error("resizer element not found!");
    return;
  }

  const clamp = (v) => Math.min(CONFIG.max, Math.max(CONFIG.min, v));

  let current = CONFIG.initial;

  function apply(percent) {
    current = clamp(percent);
    console.log(current);
    root.style.setProperty('--sidebar-width', current + '%');
    resizer.setAttribute('aria-valuenow', current.toFixed(1));
  }

  // --- init ---
  apply(CONFIG.initial);
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
    const percent = (e.clientX / window.innerWidth) * 100;
    apply(percent);
  });

  function stopDrag(e) {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    body.classList.remove('resizing');
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
        apply(current - step);
        e.preventDefault();
        break;
      case 'ArrowRight':
      case 'ArrowUp':
        apply(current + step);
        e.preventDefault();
        break;
      case 'Home':
        apply(CONFIG.min);
        e.preventDefault();
        break;
      case 'End':
        apply(CONFIG.max);
        e.preventDefault();
        break;
    }
  });

  // double-click resets to the initial width
  resizer.addEventListener('dblclick', () => apply(CONFIG.initial));

  // keep percentages sane if the window gets very narrow
  window.addEventListener('resize', () => apply(current));
})();