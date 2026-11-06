/**
 * Turns one version's section of CHANGELOG.md into the body of its GitHub release.
 *
 * changesets writes a changeset as one list item, `- <hash>: <first line>`, with the rest
 * indented under it, and changesets/action copies that section into the release as it stands.
 * So a whole release rendered as a single bullet, and the `### Thanks` that opens a changeset
 * sat behind the hash as literal text. The shape below cannot be written into CHANGELOG.md
 * instead: `### <Type> Changes` is hardcoded upstream, and a `## ` line would end the section
 * for both changesets/action and versionSection(). So the changelog keeps changesets' format,
 * and the Release workflow applies this to what comes out of it.
 *
 * Only the commit prefix and the `### <Type> Changes` lines are removed. A block this does not
 * recognise stays as text; test/release-notes.test.ts checks that over every past release.
 */
import { SECTION_LABELS, cleanLead, versionSection } from './whats-new.mjs';

const REPO_URL = 'https://github.com/Ark0N/Codeman';

const TYPE_HEADING = /^### (?:Major|Minor|Patch) Changes\s*$/;
const ITEM_START = /^- (?:[0-9a-f]{7,40}: )?(.*)$/;
const HEADING = /^#{1,6}\s+(.+?)\s*$/;
const BOLD_START = /^\*\*(.+?)\*\*(?:\s+(.*))?$/;
const LIST_ITEM = /^\s*[-*] /;
const VERSION_HEADING = /^## (\d+\.\d+\.\d+\S*)\s*$/;
const BEHAVIOUR_CHANGE = /(?<![*\w])(Behaviou?r changes?|Breaking):/g;

/** The section's changesets, each as its own lines with the prefix and indent removed. */
function changesets(section) {
  const items = [];
  for (const line of section.split('\n')) {
    if (TYPE_HEADING.test(line)) continue;
    const start = ITEM_START.exec(line);
    if (start) items.push([start[1]]);
    else if (items.length > 0) items[items.length - 1].push(line.replace(/^ {2}/, ''));
    else if (line.trim()) items.push([line]);
  }
  return items;
}

/** Splits lines on blank ones, keeping a fenced code block whole. */
function splitBlocks(lines) {
  const blocks = [];
  let current = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(?:```|~~~)/.test(line)) inFence = !inFence;
    if (inFence || line.trim()) {
      current.push(line);
    } else if (current.length > 0) {
      blocks.push(current);
      current = [];
    }
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
}

/**
 * The title a block opens with, or null. Bold counts only as a lead-in when it ends in
 * punctuation or stands alone: "**Allow network access** is a new setting" is a sentence.
 */
function blockTitle(firstLine) {
  const heading = HEADING.exec(firstLine);
  if (heading) return { title: heading[1], text: '', isHeading: true };
  const bold = BOLD_START.exec(firstLine);
  if (bold && (!bold[2] || /[.:?!]$/.test(bold[1]))) return { title: bold[1], text: bold[2] ?? '', isHeading: false };
  return null;
}

/** Which part of the page a group label heads, or null for a change's own headline. */
function groupFor(label) {
  if (!SECTION_LABELS.test(label)) return null;
  if (/^thanks\b/i.test(label)) return 'thanks';
  if (/^fixes$/i.test(label)) return 'fixes';
  return /^new features$/i.test(label) ? null : 'also';
}

/** Sorts every block of the section into the part of the page it belongs to. */
function sortBlocks(section) {
  const parts = { thanks: [], intro: [], news: [], fixes: [], also: [] };
  const items = changesets(section);
  for (const item of items) {
    const blocks = splitBlocks(item);
    // Text with no headline leads What's new, or it would read as part of the last feature.
    let target = 'intro';
    let thanksIsEmpty = false;
    for (const block of blocks) {
      const [first, ...rest] = block;
      const opened = blockTitle(first);
      if (opened) {
        const label = cleanLead(opened.title);
        const group = groupFor(label);
        const body = [opened.text, ...rest].filter(Boolean).join('\n');
        target = group ?? 'news';
        thanksIsEmpty = group === 'thanks' && !body;
        if (group === 'also') {
          // These two are a sentence or two each, so they keep their bold lead-in: a heading
          // over every one of them weighs more than the text under it.
          parts.also.push(opened.isHeading ? [`**${label}.**`, ...rest].join('\n') : block.join('\n'));
        } else if (group) {
          if (body) parts[group].push(body);
        } else {
          parts.news.push(`### ${label}`);
          if (body) parts.news.push(body);
        }
        continue;
      }
      // Only credit stays under Thanks: what opens it, its list, and a line ending in a colon
      // that leads into one. A paragraph after that is the release talking again.
      if (target === 'thanks' && !thanksIsEmpty && !LIST_ITEM.test(first) && !first.endsWith(':')) target = 'intro';
      thanksIsEmpty = false;
      const text = block.join('\n');
      // A one-line changeset was a bullet in the changelog; beside others it stays one.
      parts[target].push(blocks.length === 1 && items.length > 1 ? `- ${text}` : text);
    }
  }
  return parts;
}

/** The release before `version`, or null for the first one or a version not in the changelog. */
export function previousVersion(changelog, version) {
  const versions = changelog.split(/\r?\n/).flatMap((line) => VERSION_HEADING.exec(line)?.[1] ?? []);
  const index = versions.indexOf(version);
  return index === -1 ? null : (versions[index + 1] ?? null);
}

/** The markdown for the release page, or '' when the changelog has nothing for `version`. */
export function buildReleaseNotes(changelog, version) {
  const { thanks, intro, news, fixes, also } = sortBlocks(versionSection(changelog, version));
  const page = [];
  // Thanks stays first on purpose: contributors are the first thing a visitor to Latest sees.
  if (thanks.length > 0) page.push('## Thanks', ...thanks);
  if (intro.length + news.length > 0) page.push("## What's new", ...intro, ...news);
  if (fixes.length > 0) page.push('## Fixes', ...fixes);
  if (also.length > 0) page.push('## Also in this release', ...also);
  if (page.length === 0) return '';

  const blocks = page.map((block) => (block.startsWith('#') ? block : block.replace(BEHAVIOUR_CHANGE, '**$1:**')));
  const previous = previousVersion(changelog, version);
  if (previous) {
    blocks.push('---', `**Full Changelog**: ${REPO_URL}/compare/codeman@${previous}...codeman@${version}`);
  }
  return `${blocks.join('\n\n')}\n`;
}
