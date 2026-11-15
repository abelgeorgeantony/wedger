/* renderers/special.js — renders "special files".
 *
 * A special file is an external HTML template (assets/special/*.html) plus an
 * optional controller module (assets/special/*.js) and an optional menu bar
 * template, all declared in manifest.json. Nothing about a special file
 * lives in index.html.
 *
 * Templates can wire simple behaviour declaratively:
 *   data-open="wedger:create-file"   open another file in the viewer
 *   data-action="sign-in|sign-out|close"
 *   data-show="signed-in|signed-out" show only in that auth state
 * Anything richer goes in the controller:
 *   export function mount({ root, view, host, assets, params, menubar })
 */
import { h } from "../core.js";

export default {
  async mount(view, { host, assets, contrib }) {
    const [html, menuHtml] = await Promise.all([
      assets.text(contrib.template),
      contrib.menuTemplate ? assets.text(contrib.menuTemplate) : Promise.resolve(""),
    ]);
    const root = h("div", { class: `sf sf-${contrib.id}`, dataset: { viewType: contrib.viewType } });
    root.innerHTML = html;
    view.container.append(root);
    if (menuHtml) view.menubar.innerHTML = menuHtml;

    const syncAuth = () => {
      const signedIn = !!host.auth.user;
      root.querySelectorAll("[data-show]").forEach((el) => {
        el.hidden = el.dataset.show === "signed-in" ? !signedIn : signedIn;
      });
    };
    syncAuth();
    const offAuth = host.auth.on("changed", syncAuth);

    root.addEventListener("click", (e) => {
      const t = e.target.closest("[data-open],[data-action]");
      if (!t || !root.contains(t)) return;
      if (t.dataset.open) { host.open(t.dataset.open); return; }
      if (t.dataset.action === "sign-in") host.auth.signIn();
      else if (t.dataset.action === "sign-out") host.auth.signOut();
      else if (t.dataset.action === "close") view.close();
    });

    let api;
    if (contrib.controller) {
      const mod = await assets.module(contrib.controller);
      api = await mod.mount?.({ root, view, host, assets, params: view.params, contrib, menubar: menuHtml ? view.menubar : null });
    }
    return { ...(api ?? {}), dispose() { offAuth(); api?.dispose?.(); } };
  },
};
