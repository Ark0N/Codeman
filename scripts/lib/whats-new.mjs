/**
 * Pulls the headline of each change out of one version's section of CHANGELOG.md.
 *
 * Release notes here lead each change with a bold phrase ("**Tab layouts (#538, optional).** ..."),
 * so a highlight is that phrase. The Thanks block is credit, not a feature.
 */

const MAX_HIGHLIGHTS = 8;

/** The text between `## <version>` and the next `## ` heading, or '' when absent. */
export function versionSection(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `## ${version}`);
  if (start === -1) return '';
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end === -1) end = lines.length;
  return lines.slice(start + 1, end).join('\n');
}

/** Bold lead-ins at the start of a paragraph or bullet, cleaned for display. */
export function extractHighlights(section) {
  const out = [];
  for (const line of section.split('\n')) {
    const m = /^\s*(?:[-*]\s+)?\*\*([^*]{3,120})\*\*/.exec(line);
    if (!m) continue;
    const text = m[1].replace(/[\s.:]+$/, '').trim();
    if (!text || /^thanks\b/i.test(text)) continue;
    if (!out.includes(text)) out.push(text);
  }
  return out.slice(0, MAX_HIGHLIGHTS);
}

export function buildWhatsNew(changelog, version) {
  return { version, highlights: extractHighlights(versionSection(changelog, version)) };
}
