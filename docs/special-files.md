# Special files

In Wedger almost everything is a file. Settings, "Create file", "Import file",
Google settings, Timeline and Reports output all open as **tabs in the file
viewer**, exactly like a journal does. None of them is written in `index.html`.

## The one code path

```
host.open(uri)
   -> registry.resolve(uri)        (assets/special/manifest.json)
   -> renderer.mount(view, ctx)    (special | journal)
   -> tab in the viewer
```

Sidebar buttons, welcome-page buttons and the Settings gear all do the same
thing: `host.open("wedger:settings")`.

## URIs

| URI                         | Opens                         |
|-----------------------------|-------------------------------|
| `file:finance.journal`      | a real file (journal viewer)  |
| `wedger:welcome`            | Welcome                       |
| `wedger:create-file`        | Create file wizard            |
| `wedger:import-file`        | Import file wizard            |
| `wedger:google-settings`    | Google account + Drive sync   |
| `wedger:settings`           | Settings                      |
| `wedger:timeline`           | Timeline                      |
| `wedger:reports-output`     | Reports output                |

Opening a URI that is already open just focuses its tab.

## Anatomy of a special file

```
assets/special/<name>.html   template  (markup + a scoped <style>)
assets/special/<name>.js     controller (optional)
assets/special/manifest.json one entry declaring both
```

Controller contract:

```js
export function mount({ root, view, host, assets, params }) {
  // wire up `root`, talk to `host`
  return { dispose() {} };   // optional: save(), onShow(), onHide()
}
```

`view` gives `setTitle()`, `setDirty()`, `close()`. The wizards open the file
they created and then call `view.close()`, so the wizard tab never lingers.

Templates can skip the controller for simple things:

* `data-open="wedger:create-file"` — open another file
* `data-action="sign-in" | "sign-out" | "close"`
* `data-show="signed-in" | "signed-out"` — show only in that auth state

## Adding a new special file

1. `assets/special/about.html` (+ `about.js` if it needs logic)
2. Add one object to `manifest.json`:
   ```json
   { "viewType": "wedger.about", "id": "about", "renderer": "special",
     "title": "About", "selector": { "uri": "wedger:about" },
     "priority": 10, "template": "special/about.html" }
   ```
3. Open it with `host.open("wedger:about")` from anywhere.

No change to the shell, tab bar or sidebar.

## The Host API (`assets/js/shell/host.js`)

Special files may only use `host`: `files`, `settings`, `auth`, `sync`,
`reports`, `actions`, `dialogs`, `notify`, `engine`, `open`, `close`. In the UI
phase it is backed by mock state; the integration phase re-backs the same
shape with `state.js` / `storage.js` / hledger.

## Trying the states

Add `?mock=` to the URL (comma-separated):

* `empty` — no journals
* `signedin` — Google signed in
* `sync-error` — one file fails to sync
* `slow` — slows template loading to show loading skeletons

The page must be served over http (`./start-server.sh`), not opened as `file://`,
because special files are fetched.
