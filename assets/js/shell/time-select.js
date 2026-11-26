/* time-select.js — the selection model of the .timeclock and .timedot viewers. Pure: no DOM.
 *
 * It mirrors the journal viewer's rules, once, for both formats:
 *   - Selection mode is a mode: rows only carry checkboxes while it is on, and leaving it forgets the selection.
 *   - "Select all visible" and "Delete selected" only ever touch what the list shows RIGHT NOW. Records that were
 *     selected and are then hidden by a filter or search stay selected (and are counted separately) but are never
 *     acted on.
 *   - Ids come from line numbers, so they belong to ONE text. bind(text) forgets the selection when the text changed.
 *   - Shift-click selects the range between the last toggled row and this one, within the shown order.
 *
 * Rows are anything with an `id`. `shown` is always the ordered rows the list currently displays.
 */
export function createSelection() {
  let mode = false;
  let anchor = null;
  let boundText = null;
  const ids = new Set();

  const api = {
    get mode() { return mode; },
    get size() { return ids.size; },
    get boundText() { return boundText; },
    has: (id) => ids.has(id),
    list: () => [...ids],

    /** Turns selection mode on or off. Turning it off forgets the selection. Returns true when the mode changed. */
    setMode(on) {
      on = !!on;
      if (on === mode) return false;
      mode = on;
      if (!on) api.clear();
      return true;
    },

    /** Ties the selection to `text`. A different text may mean different records behind the same ids, so it is dropped. */
    bind(text) {
      const stale = boundText !== null && boundText !== text;
      boundText = text;
      if (stale) api.clear();
      return stale;
    },

    /** Forgets every selected record (selection mode stays as it is). Returns true when something was selected. */
    clear() {
      const had = ids.size > 0;
      ids.clear();
      anchor = null;
      return had;
    },

    /**
     * Selects or deselects `row`; with `range`, everything between the previous anchor and `row` in the shown order.
     * Returns the ids that were touched (so the caller can repaint just those rows).
     */
    set(row, on, { range = false, shown = [], selectable = () => true } = {}) {
      let targets = [row];
      if (range && anchor != null) {
        const a = shown.findIndex((r) => r.id === anchor);
        const b = shown.findIndex((r) => r.id === row.id);
        if (a >= 0 && b >= 0) targets = shown.slice(Math.min(a, b), Math.max(a, b) + 1);
      }
      const touched = [];
      for (const r of targets) {
        if (!selectable(r)) continue;
        if (on) ids.add(r.id); else ids.delete(r.id);
        touched.push(r.id);
      }
      anchor = row.id;
      return touched;
    },

    /** Selects every selectable shown row. Returns how many are selected among the shown rows afterwards. */
    selectAll(shown, selectable = () => true) {
      for (const r of shown) if (selectable(r)) ids.add(r.id);
      return api.visible(shown).length;
    },

    /** The shown rows that are selected: the ONLY rows a bulk action may touch. */
    visible: (shown) => shown.filter((r) => ids.has(r.id)),

    /** Selected records the current filters or search hide: kept, counted, never acted on. */
    hiddenCount: (shown) => ids.size - shown.filter((r) => ids.has(r.id)).length,

    /** Drops ids that no longer exist (`valid` is a Set of ids). */
    prune(valid) {
      let dropped = 0;
      for (const id of [...ids]) if (!valid.has(id)) { ids.delete(id); dropped++; }
      if (anchor != null && !valid.has(anchor)) anchor = null;
      return dropped;
    },
  };
  return api;
}
