/* special/settings.js — binds every [data-setting] control to host.settings. */
export function mount({ root, host }) {
  const controls = [...root.querySelectorAll("[data-setting]")];

  function paint(name) {
    const value = host.settings.get(name);
    for (const el of controls.filter((c) => c.dataset.setting === name)) {
      if (el.type === "checkbox") el.checked = !!value;
      else el.value = value;
    }
    const out = root.querySelector(`[data-setting-display="${name}"]`);
    if (out) out.textContent = name === "fontSize" ? `${value}px` : String(value);
  }

  for (const el of controls) {
    const name = el.dataset.setting;
    paint(name);
    el.addEventListener(el.type === "range" ? "input" : "change", () => {
      host.settings.set(name, el.type === "checkbox" ? el.checked : el.type === "range" ? Number(el.value) : el.value);
    });
  }
  root.querySelector('[data-act="reset"]').addEventListener("click", () => {
    host.settings.reset();
    host.notify("Settings reset to defaults", "ok");
  });

  const off = host.settings.on("*", ({ name }) => paint(name));
  return { dispose: off };
}
