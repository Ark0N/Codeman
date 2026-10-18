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

// Bold phrases the release notes use as group labels rather than as the headline of a change:
// "**Fixes.**" heads the list of fixes, "**Fixes applied while landing.**" the review fixes.
const SECTION_LABELS =
  /^(?:thanks\b.*|fixes|fixes applied while landing|docs|docs and tests|new features|also in this release)$/i;

/** Bold lead-ins at the start of a paragraph or bullet, cleaned for display. */
export function extractHighlights(section) {
  const out = [];
  for (const line of section.split('\n')) {
    // `changeset version` prefixes the first line of a committed changeset with its commit
    // ("- d18deed: **Lead.** text"), which is the shape every changesets-bot release has.
    const m = /^\s*(?:[-*]\s+)?(?:[0-9a-f]{7,40}:\s+)?\*\*([^*]{3,120})\*\*/.exec(line);
    if (!m) continue;
    const text = m[1].replace(/[\s.:]+$/, '').trim();
    if (!text || SECTION_LABELS.test(text)) continue;
    if (!out.includes(text)) out.push(text);
  }
  return out.slice(0, MAX_HIGHLIGHTS);
}

export function buildWhatsNew(changelog, version) {
  return { version, highlights: extractHighlights(versionSection(changelog, version)) };
}
