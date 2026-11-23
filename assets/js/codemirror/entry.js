// assets/js/codemirror/entry.js
//
// Wedger CodeMirror 6 bridge.
//
// This creates CodeMirror editors for Wedger textareas while keeping the
// original textarea elements as hidden value bridges. Existing Wedger code
// can continue reading/writing textarea.value and textarea.disabled.
//
// Application code imports the BUILT bundle (assets/js/codemirror/bundle.js,
// produced by `npm run build:codemirror`), never this file: the browser cannot
// resolve the bare "@codemirror/..." specifiers below.

import {
  EditorView,
  keymap,
  placeholder,
  drawSelection,
  lineNumbers,
  highlightActiveLineGutter,
} from "@codemirror/view";
import { EditorState, EditorSelection, Compartment } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { search, searchKeymap } from "@codemirror/search";

const valueDescriptor = Object.getOwnPropertyDescriptor(
  HTMLTextAreaElement.prototype,
  "value"
);

const disabledDescriptor = Object.getOwnPropertyDescriptor(
  HTMLTextAreaElement.prototype,
  "disabled"
);

function getNativeValue(textarea) {
  return valueDescriptor.get.call(textarea);
}

function setNativeValue(textarea, value) {
  valueDescriptor.set.call(textarea, value);
}

function getNativeDisabled(textarea) {
  return disabledDescriptor.get.call(textarea);
}

function setNativeDisabled(textarea, disabled) {
  disabledDescriptor.set.call(textarea, disabled);
}

// Colours come from Wedger's design tokens, so light and dark mode just work (no second palette here).
const wedgerTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--text)",
    backgroundColor: "var(--surface)",
    fontFamily: "var(--font-raw)",
    fontSize: ".92rem",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-raw)", lineHeight: "1.55", overflow: "auto", height: "100%" },
  ".cm-content": { caretColor: "var(--accent)", padding: ".75rem 0", fontVariantNumeric: "tabular-nums" },
  ".cm-line": { padding: "0 .75rem" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "var(--accent-soft)",
  },
  ".cm-gutters": {
    backgroundColor: "var(--surface-2)",
    color: "var(--text-faint)",
    border: "none",
    borderRight: "1px solid var(--border)",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 .65rem 0 .5rem", minWidth: "2.6rem" },
  ".cm-activeLineGutter": { backgroundColor: "var(--hover)", color: "var(--text)" },
  ".cm-placeholder": { color: "var(--text-faint)" },
  ".cm-panels": { backgroundColor: "var(--surface-2)", color: "var(--text)", borderColor: "var(--border)" },
  ".cm-panel input, .cm-panel button": { fontFamily: "var(--font-ui)", color: "var(--text)" },
  ".cm-searchMatch": { backgroundColor: "var(--warn-soft)", outline: "1px solid var(--warn)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--accent-soft)" },
});

const gutterExtensions = (on) => (on ? [lineNumbers(), highlightActiveLineGutter()] : []);

export function createBoundEditor(textarea, options = {}) {
  if (!textarea) {
    throw new Error("createBoundEditor requires a textarea element");
  }

  const dispatchInput = options.dispatchInput ?? false;
  const resetHistoryOnSet = options.resetHistoryOnSet ?? false;
  const lineWrapping = options.lineWrapping ?? false;            // hledger text is columnar: wrapping lies about columns
  const forcedEditable = options.editable;
  let showLineNumbers = options.lineNumbers ?? true;
  const onSelection = options.onSelection;                       // (update) => void, on cursor moves and edits

  function computeEditable() {
    if (typeof forcedEditable === "boolean") {
      return forcedEditable && !textarea.disabled;
    }
    return !textarea.disabled && !textarea.readOnly;
  }

  let currentEditable = computeEditable();

  const editableCompartment = new Compartment();
  const readOnlyCompartment = new Compartment();
  const lineNumbersCompartment = new Compartment();

  let programmaticChange = false;

  // The wrapper makes it easier to style CodeMirror as a flex child and to
  // mirror visibility changes from the original textarea.
  const wrapper = document.createElement("div");
  wrapper.className = "cm-wrapper";

  if (textarea.disabled) {
    wrapper.classList.add("cm-disabled");
  }

  textarea.insertAdjacentElement("beforebegin", wrapper);

  // Hide the textarea visually but keep it in the DOM for JS compatibility.
  textarea.classList.add("cm-textarea-proxy");
  textarea.setAttribute("aria-hidden", "true");
  textarea.tabIndex = -1;

  function buildExtensions() {
    return [
      lineNumbersCompartment.of(gutterExtensions(showLineNumbers)),
      wedgerTheme,
      drawSelection(),                      // the selection stays visible while focus is in the search field
      EditorState.tabSize.of(4),

      history(),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
      search(),
      lineWrapping ? EditorView.lineWrapping : [],
      textarea.placeholder ? placeholder(textarea.placeholder) : [],
      EditorView.contentAttributes.of({
        spellcheck: textarea.spellcheck ? "true" : "false",
      }),
      editableCompartment.of(EditorView.editable.of(currentEditable)),
      readOnlyCompartment.of(EditorState.readOnly.of(!currentEditable)),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !programmaticChange) {
          const value = update.state.doc.toString();
          setNativeValue(textarea, value);

          if (dispatchInput) {
            textarea.dispatchEvent(new Event("input", { bubbles: true }));
          }
        }
        if ((update.selectionSet || update.docChanged) && onSelection) onSelection(update);
      }),
    ];
  }

  function createState(doc) {
    return EditorState.create({
      doc,
      extensions: buildExtensions(),
    });
  }

  const view = new EditorView({
    state: createState(getNativeValue(textarea) || ""),
    parent: wrapper,
  });

  if (textarea.getAttribute("aria-label")) {
    view.contentDOM.setAttribute("aria-label", textarea.getAttribute("aria-label"));
  }

  // If a visible <label for="..."> points at the hidden textarea, make it
  // focus the CodeMirror editor instead.
  if (textarea.id) {
    const label = document.querySelector(
      `label[for="${CSS.escape(textarea.id)}"]`
    );

    if (label) {
      view.contentDOM.setAttribute("aria-label", label.textContent.trim());
      label.addEventListener("click", (event) => {
        event.preventDefault();
        view.focus();
      });
    }
  } else if (textarea.placeholder) {
    view.contentDOM.setAttribute("aria-label", textarea.placeholder);
  }

  function syncWrapperVisibility() {
    const hidden =
      textarea.hidden ||
      textarea.style.display === "none" ||
      getNativeDisabled(textarea) === true && false; // disabled should not hide the editor

    wrapper.style.display = hidden ? "none" : "";
  }

  const displayObserver = new MutationObserver(syncWrapperVisibility);

  displayObserver.observe(textarea, {
    attributes: true,
    attributeFilter: ["style", "hidden"],
  });

  syncWrapperVisibility();

  const controller = {
    view,
    textarea,
    wrapper,

    get value() {
      return view.state.doc.toString();
    },

    setValue(value, opts = {}) {
      const nextValue = String(value ?? "");
      const shouldResetHistory = opts.resetHistory ?? resetHistoryOnSet;

      if (nextValue === controller.value) {
        setNativeValue(textarea, nextValue);
        return;
      }

      programmaticChange = true;

      try {
        if (shouldResetHistory) {
          view.setState(createState(nextValue));
        } else {
          view.dispatch({
            changes: {
              from: 0,
              to: view.state.doc.length,
              insert: nextValue,
            },
          });
        }

        setNativeValue(textarea, nextValue);
      } finally {
        programmaticChange = false;
      }
    },

    setEditable(nextEditable) {
      currentEditable = Boolean(nextEditable);

      view.dispatch({
        effects: [
          editableCompartment.reconfigure(
            EditorView.editable.of(currentEditable)
          ),
          readOnlyCompartment.reconfigure(
            EditorState.readOnly.of(!currentEditable)
          ),
        ],
      });
    },

    setLineNumbers(on) {
      showLineNumbers = Boolean(on);
      view.dispatch({ effects: lineNumbersCompartment.reconfigure(gutterExtensions(showLineNumbers)) });
    },

    /** Document offsets of the main selection: { from, to } (from <= to). */
    getSelection() {
      const { from, to } = view.state.selection.main;
      return { from, to };
    },

    /** 1-based { line, col } of the cursor (the selection head). */
    getCursor() {
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      return { line: line.number, col: head - line.from + 1 };
    },

    /** Selects [from, to] (document offsets) and scrolls it into view. Does not move focus. */
    setSelection(from, to = from, { scroll = true } = {}) {
      const len = view.state.doc.length;
      const clamp = (n) => Math.max(0, Math.min(len, Number.isFinite(n) ? n : 0));
      const a = clamp(from), b = clamp(to);
      view.dispatch({
        selection: EditorSelection.range(a, b),
        effects: scroll ? EditorView.scrollIntoView(EditorSelection.range(a, b), { y: "center" }) : [],
      });
    },

    refresh() {
      view.requestMeasure();
    },

    focus() {
      view.focus();
    },

    destroy() {
      displayObserver.disconnect();
      const last = view.state.doc.toString();
      view.destroy();
      wrapper.remove();

      // Give the textarea back its native behaviour (value, disabled, focus) and its last text.
      delete textarea.value;
      delete textarea.disabled;
      delete textarea.focus;
      setNativeValue(textarea, last);
      textarea.classList.remove("cm-textarea-proxy");
      textarea.removeAttribute("aria-hidden");
      textarea.tabIndex = 0;
    },
  };

  // textarea.focus() moves focus into the editor.
  textarea.focus = () => view.focus();

  // Preserve textarea.value semantics for existing Wedger code.
  Object.defineProperty(textarea, "value", {
    get() {
      return controller.value;
    },
    set(value) {
      controller.setValue(value, {
        resetHistory: resetHistoryOnSet,
      });
    },
    configurable: true,
  });

  // Preserve textarea.disabled semantics for existing Wedger code.
  Object.defineProperty(textarea, "disabled", {
    get() {
      return getNativeDisabled(textarea);
    },
    set(value) {
      const disabled = Boolean(value);

      setNativeDisabled(textarea, disabled);
      wrapper.classList.toggle("cm-disabled", disabled);
      controller.setEditable(computeEditable());
    },
    configurable: true,
  });

  return controller;
}

/**
 * Kept so old imports don't break. It used to look up element ids that no longer exist in the shell and did nothing.
 * Views mount their own editors with createBoundEditor() and destroy() them when they close.
 */
export function initWedgerEditors() {
  return {};
}