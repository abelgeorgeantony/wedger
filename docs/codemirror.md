# `doc.md`

# CodeMirror 6 Integration

Wedger uses CodeMirror 6 to replace plain textareas for journal input and text output.

This document explains:

- which textareas are replaced
- how CodeMirror is hosted and versioned
- how the integration works
- what to watch out for when updating CodeMirror
- common pitfalls and debugging notes

---

## 1. Scope

The following textareas are replaced with CodeMirror 6 editors:

| Textarea ID | Purpose | Mode | Notes |
|---|---|---|---|
| `#journal-text` | Main hledger journal editor | Editable | Dispatches normal `input` events so existing autosave/reparse logic continues to work |
| `#output` | Report/output viewer | Read-only | Can display text reports, JSON, or printed journal output |
| `#csv-import-text` | CSV data input | Editable | Used by the CSV import modal |
| `#csv-import-rules` | CSV rules input | Editable | Used by the CSV import modal |
| `#raw-txn-input` | Raw transaction preview | Read-only by default | Can be made editable later if raw transaction editing is desired |

The main integration target is `#journal-text`.

---

## 2. Hosting strategy

CodeMirror is self-hosted from this repository.

The generated bundle lives at:

```txt
assets/js/vendor/codemirror.bundle.js
```

This file is generated from:

```txt
assets/js/cm/entry.js
```

using npm and esbuild.

Do not edit `assets/js/vendor/codemirror.bundle.js` manually.

Do not load CodeMirror from a CDN in production. The purpose of this integration is to ensure availability from the Wedger repository itself.

---

## 3. Source of truth

The source of truth for CodeMirror versions is:

```txt
package.json
package-lock.json
assets/js/cm/entry.js
```

The committed bundle is a build artifact.

When updating CodeMirror:

1. Update npm dependencies.
2. Rebuild the bundle.
3. Test.
4. Commit all of the following:
   - `package.json`
   - `package-lock.json`
   - `assets/js/cm/entry.js`
   - `assets/js/vendor/codemirror.bundle.js`

---

## 4. Build commands

Install dependencies:

```bash
npm install
```

Build the CodeMirror bundle:

```bash
npm run build:codemirror
```

The build command uses esbuild:

```bash
esbuild assets/js/cm/entry.js \
  --bundle \
  --format=esm \
  --target=es2022 \
  --minify \
  --outfile=assets/js/vendor/codemirror.bundle.js
```

The output is an ES module bundle.

---

## 5. Versioning policy

Use CodeMirror 6.

Do not use CodeMirror 5. CodeMirror 5 is a different architecture and is not the recommended path for new integration work.

For Wedger:

- Prefer pinned versions in `package.json` using `--save-exact`.
- Always commit `package-lock.json`.
- Use `npm ci` in CI or reproducible builds.
- Do not import CodeMirror from a CDN using `@latest`.
- Do not upgrade CodeMirror implicitly by editing the vendor bundle.

CodeMirror 6 has many independently versioned packages:

```txt
codemirror
@codemirror/view
@codemirror/state
@codemirror/commands
@codemirror/search
```

The `codemirror` umbrella package helps keep a compatible set of packages together, but the lockfile is still the final source of truth.

---

## 6. Update process

When updating CodeMirror:

```bash
npm outdated
npm update
npm run build:codemirror
```

Or, for a controlled major/minor bump:

```bash
npm install --save-exact codemirror@x.y.z
npm install --save-exact @codemirror/view@x.y.z
npm install --save-exact @codemirror/state@x.y.z
npm install --save-exact @codemirror/commands@x.y.z
npm install --save-exact @codemirror/search@x.y.z
npm run build:codemirror
```

After rebuilding, run the test checklist in this document.

For major version upgrades, create a separate branch and review the CodeMirror changelog/migration notes before merging.

---

## 7. Runtime architecture

Wedger keeps the original textarea elements in the DOM.

For each replaced textarea, the CodeMirror bridge:

1. Creates a wrapper `<div class="cm-wrapper">`.
2. Inserts the wrapper before the original textarea.
3. Mounts a CodeMirror `EditorView` inside the wrapper.
4. Hides the original textarea using the class `cm-textarea-proxy`.
5. Overrides the textarea's `value` property.
6. Overrides the textarea's `disabled` property where needed.
7. Keeps the hidden textarea synchronized with the CodeMirror document.

This allows existing Wedger code such as:

```js
journalText.value = content;
const text = journalText.value;
journalText.disabled = true;
```

to keep working without large refactors.

---

## 8. Main journal editor

The main journal editor is bound to:

```html
<textarea id="journal-text" spellcheck="false" disabled></textarea>
```

It is initialized with:

```js
{
  dispatchInput: true,
  resetHistoryOnSet: true,
}
```

### Why `dispatchInput: true`?

Existing logic in `app.js` uses:

```js
journalText.addEventListener("input", () => {
  commitFileState(state.files.active, journalText.value, true);
  scheduleReparse();
});
```

The CodeMirror bridge dispatches a normal `input` event on the hidden textarea when the user edits the document. This allows the existing autosave and reparse behavior to continue working.

### Why `resetHistoryOnSet: true`?

Wedger often replaces the entire journal content programmatically:

- when switching files
- when loading from local storage
- when syncing from Google Drive
- after CSV import
- after transaction add/edit/delete

Resetting history avoids undo operations crossing journal file boundaries or undoing programmatic file loads.

This may mean the user cannot undo programmatic changes. That is acceptable for the current Wedger model, but it can be refined later if needed.

---

## 9. Output editor

The output textarea:

```html
<textarea id="output" readonly spellcheck="false"></textarea>
```

is replaced with a read-only CodeMirror editor.

It is initialized with:

```js
{
  editable: false,
  dispatchInput: false,
  resetHistoryOnSet: false,
}
```

The existing app writes to it using:

```js
output.value = ...;
```

The bridge intercepts that assignment and updates CodeMirror.

### Visibility synchronization

`state.ui.dataRendering` toggles the raw output textarea using:

```js
output.style.display = "none";
```

or:

```js
output.style.display = "";
```

Because CodeMirror is a sibling wrapper, the bridge observes the original textarea's `style` and `hidden` attributes and mirrors visibility onto the `.cm-wrapper`.

If you change how `#output` is hidden/shown, make sure the CodeMirror wrapper is also hidden/shown.

---

## 10. CSV import editors

The CSV modal textareas:

```html
<textarea id="csv-import-text"></textarea>
<textarea id="csv-import-rules"></textarea>
```

are editable CodeMirror editors.

They do not dispatch synthetic `input` events because Wedger does not currently need input listeners for them.

The file reader logic still works because it writes:

```js
document.getElementById(textareaId).value = e.target.result;
```

and the bridge intercepts the value assignment.

---

## 11. Raw transaction editor

The raw transaction textarea:

```html
<textarea id="raw-txn-input" readonly rows="8" spellcheck="false"></textarea>
```

is currently treated as read-only.

If you want users to edit raw transaction text directly, change the HTML by removing `readonly`, and initialize the editor with:

```js
{
  editable: true,
  dispatchInput: false,
}
```

If raw editing is enabled, make sure the transaction modal validation still works as expected.

---

## 12. Styling

CodeMirror styling is integrated with Wedger CSS variables.

Important variables:

```css
--ink
--ink-soft
--paper
--panel
--rule
--accent
--focus-ring
--mono
--base-font-size
```

The editor inherits:

- background from `--paper`
- text color from `--ink`
- font family from `--mono`
- font size from `--base-font-size`
- focus ring from `--focus-ring`

Dark mode should work automatically because the CodeMirror styles reference the same CSS variables.

If you change Wedger's design system, check the CodeMirror editor in both light and dark mode.

---

## 13. Dialog and modal behavior

CodeMirror can have measurement issues if it is initialized while hidden inside a closed dialog.

The bridge watches `<dialog>` elements for changes to the `open` attribute and calls:

```js
editor.refresh()
```

when a dialog opens.

This matters for:

- CSV import modal
- transaction modal
- any future modal containing a CodeMirror editor

If you add a new modal containing CodeMirror, make sure it is either refreshed on open or initialized after the modal becomes visible.

---

## 14. Things to watch out for

### Do not load CodeMirror from a CDN

The bundle in `assets/js/vendor/codemirror.bundle.js` is the supported source.

Do not add:

```html
<script src="https://cdn.jsdelivr.net/npm/codemirror..."></script>
```

or similar CDN imports.

---

### Do not edit the generated bundle manually

The bundle is generated by esbuild.

Manual edits will be lost on the next build and make version auditing unreliable.

---

### Do not assume the textarea is visible

The original textarea is hidden with:

```css
textarea.cm-textarea-proxy {
  display: none !important;
}
```

Use the CodeMirror editor for visible interaction.

However, keep using the textarea element for programmatic value access unless you intentionally refactor Wedger to use the editor controller directly.

---

### Programmatic value changes should not cause loops

The bridge uses an internal flag, `programmaticChange`, to prevent CodeMirror update listeners from reacting to programmatic value writes.

If you add new listeners that write back to the same textarea, be careful to avoid infinite update loops.

---

### File switching should reset editor history

The main journal editor currently resets history on programmatic value replacement.

If you change this behavior, make sure undo history does not leak between unrelated journal files.

---

### Disabled state

The main journal editor is disabled when no file is selected.

Existing code uses:

```js
journalText.disabled = !hasFile;
```

The bridge intercepts this and updates CodeMirror's editable/read-only state.

If you refactor state management, preserve this behavior.

---

### Output visibility

If you change the raw/report view toggle, ensure both of these stay synchronized:

```js
output.style.display
guiOutputPanel.style.display
```

and the CodeMirror wrapper for `#output`.

The current bridge observes `output.style.display`, but significant UI refactors may require adjusting this.

---

### Large journals

CodeMirror 6 handles large documents better than a plain textarea because it renders incrementally.

However, keep these in mind:

- avoid expensive full-document syntax highlighting without testing
- avoid running heavy work on every keystroke
- preserve the existing debounce around reparse
- test with realistic multi-year journal files

---

### Mobile behavior

CodeMirror 6 is touch-friendly, but Wedger has custom mobile behavior for transaction cards.

Test:

- scrolling
- selection
- keyboard appearance
- swipe gestures near editors
- modal editors on small screens

---

### Accessibility

CodeMirror 6 is more accessible than many custom editors, but you still need to check:

- focus visibility
- keyboard navigation
- screen reader labels
- label association
- read-only versus disabled semantics

The bridge attempts to preserve labels by reading labels associated with the original textarea and focusing CodeMirror when the label is clicked.

If you add new labeled textareas, verify label behavior after CodeMirror replacement.

---

## 15. Bundle size considerations

The current CodeMirror setup intentionally avoids heavy optional features.

Included:

- editor state
- editor view
- history
- default keymap
- search
- placeholder
- line wrapping

Not included yet:

- custom hledger syntax highlighting
- linting
- autocompletion
- advanced language parsing
- collaborative editing
- custom themes beyond CSS variables

If bundle size becomes a concern, you can reduce the bundle by removing features such as search or history, but those are useful for a text-editor-like experience.

---

## 16. Future hledger syntax highlighting

The current integration does not implement hledger-specific syntax highlighting.

If adding it later:

1. Start with a simple `StreamLanguage` tokenizer.
2. Avoid expensive whole-document parsing.
3. Test with large journals.
4. Keep highlighting separate from parsing/validation logic.
5. Do not use highlighting as a substitute for hledger's own error reporting.

Possible highlighting targets:

- dates
- comments
- account names
- amounts
- commodity symbols
- tags
- directives such as `account`, `commodity`, `include`, `alias`

---

## 17. Test checklist

After rebuilding or updating CodeMirror, test at least the following.

### Startup

- [ ] App loads without CodeMirror errors.
- [ ] Loading overlay disappears.
- [ ] Main journal editor appears when a file is selected.
- [ ] Disabled state appears when no file is selected.

### File management

- [ ] Create new journal file.
- [ ] Switch between files.
- [ ] Rename file.
- [ ] Delete file.
- [ ] Editor content updates correctly on file switch.
- [ ] Undo history does not leak across files.

### Journal editing

- [ ] Typing updates the editor.
- [ ] Local storage is updated.
- [ ] Reparse is triggered.
- [ ] Journal errors appear in the status banner.
- [ ] Google Drive sync queue still works if signed in.

### Transactions

- [ ] Add transaction works.
- [ ] Edit transaction works.
- [ ] Delete transaction works.
- [ ] Raw transaction preview updates.
- [ ] Transaction modal editor renders correctly after opening.

### CSV import

- [ ] CSV modal opens.
- [ ] CSV textarea renders correctly.
- [ ] Rules textarea renders correctly.
- [ ] File picker fills the correct editor.
- [ ] Append import works.
- [ ] Replace import works.

### Reports

- [ ] Report output appears in read-only CodeMirror editor.
- [ ] Clear output works.
- [ ] Switching between journal/report views works.
- [ ] Raw output visibility toggles correctly.
- [ ] Rendered GUI output toggle still works.

### Settings

- [ ] Dark mode updates editor colors.
- [ ] Font size setting updates editor font size.
- [ ] Hide status banner does not break editor layout.

### Mobile

- [ ] Editor is usable on small screens.
- [ ] Dialog editors render correctly.
- [ ] Keyboard does not break layout.
- [ ] Transaction card swipe gestures still work.

---

## 18. Debugging tips

### Check whether editors initialized

In the browser console:

```js
window.wedgerEditors
```

You should see editor controllers for:

```js
journal
output
csvData
csvRules
rawTxn
```

### Force a layout refresh

If an editor looks incorrectly sized inside a dialog:

```js
window.wedgerEditors.journal.refresh()
```

or for another editor:

```js
window.wedgerEditors.csvData.refresh()
```

### Inspect the hidden textarea

The hidden textarea still holds the synchronized value.

For example:

```js
document.getElementById("journal-text").value
```

This should match the visible CodeMirror content.

### Check the bundle version

The generated bundle should include a banner comment such as:

```js
/* Wedger CodeMirror 6 vendor bundle. Generated by npm run build:codemirror. Do not edit manually. */
```

For exact versions, inspect:

```txt
package-lock.json
```

or run:

```bash
npm ls codemirror @codemirror/view @codemirror/state @codemirror/commands @codemirror/search
```

---

## 19. Known limitations

- The current setup does not provide hledger syntax highlighting.
- The main journal editor resets undo history on programmatic replacement.
- The raw transaction editor is read-only unless explicitly changed.
- CodeMirror is self-hosted, but `hledger-lib-wasm` may still be loaded from a CDN depending on `assets/js/init.js`.

---

## 20. Related files

```txt
assets/js/cm/entry.js
assets/js/cm-init.js
assets/js/vendor/codemirror.bundle.js
assets/css/base.css
new_index.html
package.json
package-lock.json
```
```

---

# Important code changes outside CodeMirror

With the bridge approach above, you may need very few changes to `app.js` or `state.js`.

However, there are a few things to be aware of.

## `journalText.value`

Existing code such as:

```js
journalText.value = content;
```

will now update CodeMirror.

Existing code such as:

```js
const content = journalText.value;
```

will now read from CodeMirror.

That is intentional.

---

## `journalText.disabled`

Existing code such as:

```js
journalText.disabled = !hasFile;
```

will now update CodeMirror's editable state.

That is also intentional.

---

## `journalText.addEventListener("input", ...)`

The CodeMirror bridge dispatches a normal `input` event on the hidden textarea when the user edits the journal.

So this existing handler continues to work:

```js
journalText.addEventListener("input", () => {
  commitFileState(state.files.active, journalText.value, true);
  scheduleReparse();
});
```

---

## `output.value`

Existing code such as:

```js
output.value = result.data;
```

or:

```js
output.value = JSON.stringify(result, null, 2);
```

will update the read-only CodeMirror output editor.

---

## CSV file loading

Existing file reader code:

```js
document.getElementById(textareaId).value = e.target.result;
```

will update the appropriate CodeMirror editor.

---

# Optional future refactor

The bridge approach is good for a clean migration, but if you later want a more direct architecture, you can refactor Wedger to use editor controllers explicitly.

For example:

```js
const content = window.wedgerEditors.journal.value;
window.wedgerEditors.journal.setValue(content, { resetHistory: true });
```

That would be cleaner long-term, but it requires touching more parts of `app.js` and `state.js`.

For now, the hidden-textarea bridge is the lowest-risk way to migrate.

---

# Final recommendation

Use this approach:

1. Keep CodeMirror 6 self-hosted as a committed vendor bundle.
2. Use npm + esbuild to generate the bundle.
3. Keep the original textareas as hidden value bridges.
4. Replace:
   - `#journal-text`
   - `#output`
   - `#csv-import-text`
   - `#csv-import-rules`
   - `#raw-txn-input`
5. Start with a lean feature set.
6. Add hledger-specific highlighting later if desired.
7. Treat `package-lock.json` and the generated bundle as part of the update process.
8. Use the included `doc.md` as the maintenance reference.