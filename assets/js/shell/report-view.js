/* report-view.js — draws a report model (see report-model.js) as DOM.
 * Styles for these classes live in components.css (.rv-*). */
import { h } from "./core.js";
import { isNegativeText } from "./format.js";
import { formatAmounts, treeToRows } from "./report-model.js";

const isNeg = isNegativeText;

export function renderModel(model, { grouping = "auto" } = {}) {
  switch (model.kind) {
    case "tree": return renderTree(model, grouping);
    case "table": return renderTable(model);
    case "text": return h("pre", { class: "rv-text", tabindex: "0" }, model.text);
    default: return h("p", { class: "rv-empty" }, model.message ?? "Nothing to show.");
  }
}

/* ---------------------------------------------------------------- table */
function renderTable(model) {
  const head = h("tr", {}, ...model.columns.map((c, i) => h("th", { scope: "col", class: model.align[i] === "right" ? "is-num" : "" }, c)));
  const body = model.rows.map((row) => h("tr", {}, ...row.map((cell, i) => {
    const num = model.align[i] === "right";
    return h("td", { class: `${num ? "is-num" : ""}${num && isNeg(cell) ? " is-neg" : ""}` }, cell);
  })));
  return h("div", { class: "rv-table-wrap", tabindex: "0" }, h("table", { class: "rv-table" }, h("thead", {}, head), h("tbody", {}, ...body)));
}

/* ----------------------------------------------------------------- tree */
function treeRows(nodes, grouping, depth = 0) {
  return nodes.map((node) => {
    const amount = h("span", { class: `rv-tree__amount${isNeg(formatAmounts(node.amounts, grouping)) ? " is-neg" : ""}` }, formatAmounts(node.amounts, grouping));
    const label = h("span", { class: "rv-tree__name", title: node.full }, node.name);
    if (!node.children.length) return h("div", { class: "rv-tree__row rv-tree__leaf", style: `--depth:${depth}` }, label, amount);
    const summary = h("summary", { class: "rv-tree__row", style: `--depth:${depth}` }, h("span", { class: "rv-tree__caret", "aria-hidden": "true" }), label, amount);
    return h("details", { class: "rv-tree__branch", open: true }, summary, h("div", {}, ...treeRows(node.children, grouping, depth + 1)));
  });
}

function renderTree(model, grouping) {
  const wrap = h("div", { class: "rv-tree" });
  for (const section of model.sections) {
    const block = h("section", { class: "rv-tree__section" });
    if (section.title) block.append(h("h3", { class: "rv-tree__title" }, section.title));
    block.append(...treeRows(section.nodes, grouping));
    if (section.total) {
      block.append(h("div", { class: "rv-tree__row rv-tree__total" }, h("span", { class: "rv-tree__name" }, "Total"), h("span", { class: "rv-tree__amount" }, formatAmounts(section.total, grouping))));
    }
    wrap.append(block);
  }
  if (model.total) {
    wrap.append(h("div", { class: "rv-tree__row rv-tree__total rv-tree__grand" }, h("span", { class: "rv-tree__name" }, model.totalLabel ?? "Total"), h("span", { class: "rv-tree__amount" }, formatAmounts(model.total, grouping))));
  }
  return wrap;
}

/** Expands or collapses every branch below `root`. */
export function setAllOpen(root, open) {
  root.querySelectorAll("details.rv-tree__branch").forEach((d) => { d.open = open; });
}

export { treeToRows };
