/* templates.js — which starter templates a file type may use, and what they expand to. Pure (used by create-file.js).
 *
 * A template declares the extensions it is for in `types` ("*" = every type). Filtering is strict: a .timeclock or
 * .timedot file is only ever offered templates that name its extension (or "*"); journal templates never show up. */
export const usableFor = (template, ext) => (template.types ?? []).includes("*") || (template.types ?? []).includes(ext);

export const templatesFor = (templates, ext) => templates.filter((t) => usableFor(t, ext));

export const resolveTemplate = (template, year) => template.content.replaceAll("{{year}}", String(year));

/** The first few non-empty lines, for the card preview. */
export function previewOf(template, year, lines = 4) {
  const rows = resolveTemplate(template, year).split("\n").filter((l) => l.trim());
  return rows.length ? rows.slice(0, lines).join("\n") : "Empty file";
}
