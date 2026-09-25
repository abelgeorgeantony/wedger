// assets/js/cm/entry.js
//
// Wedger CodeMirror 6 bridge.
//
// This creates CodeMirror editors for Wedger textareas while keeping the
// original textarea elements as hidden value bridges. Existing Wedger code
// can continue reading/writing textarea.value and textarea.disabled.

import {
  EditorView,
  keymap,
  placeholder,
  lineNumbers,
  highlightActiveLineGutter,
} from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
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

export function createBoundEditor(textarea, options = {}) {
  if (!textarea) {
    throw new Error("createBoundEditor requires a textarea element");
  }

  const dispatchInput = options.dispatchInput ?? false;
  const resetHistoryOnSet = options.resetHistoryOnSet ?? false;
  const lineWrapping = options.lineWrapping ?? true;
  const forcedEditable = options.editable;
  const showLineNumbers = options.lineNumbers ?? true;

  function computeEditable() {
    if (typeof forcedEditable === "boolean") {
      return forcedEditable && !textarea.disabled;
    }
    return !textarea.disabled && !textarea.readOnly;
  }

  let currentEditable = computeEditable();

  const editableCompartment = new Compartment();
  const readOnlyCompartment = new Compartment();

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
      showLineNumbers ? lineNumbers() : [],
      showLineNumbers ? highlightActiveLineGutter() : [],

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
        if (!update.docChanged || programmaticChange) return;

        const value = update.state.doc.toString();
        setNativeValue(textarea, value);

        if (dispatchInput) {
          textarea.dispatchEvent(new Event("input", { bubbles: true }));
        }
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

    refresh() {
      view.requestMeasure();
    },

    focus() {
      view.focus();
    },

    destroy() {
      displayObserver.disconnect();
      view.destroy();
      wrapper.remove();

      textarea.classList.remove("cm-textarea-proxy");
      textarea.removeAttribute("aria-hidden");
      textarea.tabIndex = 0;
    },
  };

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

export function initWedgerEditors() {
  if (window.wedgerEditors) {
    return window.wedgerEditors;
  }

  const editors = {};

  function bind(id, options) {
    const el = document.getElementById(id);

    if (!el || el.dataset.cmBound === "true") {
      return null;
    }

    el.dataset.cmBound = "true";
    return createBoundEditor(el, options);
  }

  // Main journal editor.
  //
  // dispatchInput: true allows the existing journalText input listener in
  // app.js to continue working.
  //
  // resetHistoryOnSet: true avoids undo history leaking across journal files
  // when Wedger programmatically replaces the whole document.
  editors.journal = bind("journal-text", {
    dispatchInput: true,
    resetHistoryOnSet: true,
  });

  // Output/report viewer.
  editors.output = bind("output", {
    editable: false,
    dispatchInput: false,
    resetHistoryOnSet: false,
  });

  // CSV import textareas.
  editors.csvData = bind("csv-import-text", {
    dispatchInput: false,
    resetHistoryOnSet: false,
  });

  editors.csvRules = bind("csv-import-rules", {
    dispatchInput: false,
    resetHistoryOnSet: false,
  });

  // Raw transaction preview.
  //
  // The current HTML uses readonly. If you want raw transaction text to be
  // user-editable, remove readonly from the textarea and change this to:
  //
  // editable: true
  editors.rawTxn = bind("raw-txn-input", {
    dispatchInput: false,
    resetHistoryOnSet: false,
  });

  // Refresh editors when dialogs open.
  //
  // CodeMirror can measure incorrectly if it is initialized while inside a
  // closed <dialog> element. Refreshing on open avoids layout glitches.
  function refreshEditorsWithin(root) {
    for (const editor of Object.values(editors)) {
      if (editor && root.contains(editor.view.dom)) {
        editor.refresh();
      }
    }
  }

  document.querySelectorAll("dialog").forEach((dialog) => {
    const observer = new MutationObserver(() => {
      if (dialog.open) {
        requestAnimationFrame(() => {
          refreshEditorsWithin(dialog);
        });
      }
    });

    observer.observe(dialog, {
      attributes: true,
      attributeFilter: ["open"],
    });
  });

  window.wedgerEditors = editors;

  return editors;
}