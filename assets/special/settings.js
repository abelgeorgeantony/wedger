/* special/settings.js — binds the Settings page to host.settings.
 *
 * Text size gets special care: dragging the slider only updates the readout and a
 * small preview; the app is rescaled once, when the slider is released. Rescaling on
 * every pixel of the drag moved the slider itself under the pointer and made the page jump around.
 */
export function mount({ root, host }) {
  const S = host.settings;
  const $ = (sel) => root.querySelector(sel);
  const slot = (n) => root.querySelector(`[data-slot="${n}"]`);

  /* ---- generic controls ---- */
  const controls = [...root.querySelectorAll("[data-setting]")].filter((el) => el.dataset.setting !== "fontSize");
  const paint = (el) => {
    const v = S.get(el.dataset.setting);
    if (el.type === "checkbox") el.checked = !!v; else el.value = v;
  };
  controls.forEach((el) => {
    paint(el);
    el.addEventListener("change", () => S.set(el.dataset.setting, el.type === "checkbox" ? el.checked : el.value.trim()));
  });

  /* ---- text size ---- */
  const { min, max, default: def } = S.schema("fontSize");
  const slider = $('[data-setting="fontSize"]');
  Object.assign(slider, { min, max, step: 1 });
  slot("ticks").replaceChildren(...Array.from({ length: max - min + 1 }, (_, i) => {
    const tick = document.createElement("span");
    tick.style.setProperty("--f", String(i / (max - min)));
    if (min + i === def) tick.className = "is-default";
    return tick;
  }));

  const showSize = (px) => {
    slot("font-value").textContent = `${px} px${px === def ? " · default" : ""}`;
    slot("preview").style.fontSize = `${px}px`;
    slider.setAttribute("aria-valuetext", `${px} pixels`);
  };
  const paintSize = () => { const v = S.get("fontSize"); slider.value = v; showSize(v); };
  paintSize();

  slider.addEventListener("input", () => showSize(Number(slider.value)));          // preview only
  slider.addEventListener("change", () => S.set("fontSize", Number(slider.value))); // commit on release / key press
  root.addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "font-dec") S.set("fontSize", S.get("fontSize") - 1);
    else if (act === "font-inc") S.set("fontSize", S.get("fontSize") + 1);
    else if (act === "font-reset") S.set("fontSize", def);
    else if (act === "reset-all") {
      host.dialogs.confirm({ title: "Reset all settings?", message: "Every setting goes back to its default. Your files aren't touched.", confirmLabel: "Reset" })
        .then((ok) => { if (ok) { S.reset(); controls.forEach(paint); paintSize(); } });
    }
  });

  const off = S.on("*", () => { controls.forEach(paint); paintSize(); });
  return { dispose: off };
}
