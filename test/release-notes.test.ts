import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
// @ts-expect-error plain .mjs helper shared with scripts/generate-release-notes.mjs
import { buildReleaseNotes, previousVersion } from '../scripts/lib/release-notes.mjs';
// @ts-expect-error plain .mjs helper shared with scripts/generate-whats-new.mjs
import { versionSection, extractHighlights } from '../scripts/lib/whats-new.mjs';

const root = resolve(import.meta.dirname, '..');
const realChangelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');

/** A release the way changesets writes it: one hashed bullet, the rest nested under it. */
const CHANGELOG = `# aicodeman

## 2.1.0

### Minor Changes

- 12024cc: ### Thanks
  - @someone for the tile grid (#10).
  - @other for reporting the wheel bug (#11).

  **The tile grid (#10).** Six sessions side by side. Behaviour change: \`Ctrl+G\` opens it now.

  It remembers your layout.

  **Install without admin rights.** Nothing lands outside your home folder.

  **Fixes.**
  - **The wheel works (#11).** It survives a reload.
  - **A second fix.** Text.

  **Fixes applied while landing.** One review fix (#10).

  **Docs and tests.** A new guide.

## 2.0.0

### Patch Changes

- abcdef1: One line.
- A bullet with no hash.

## 1.9.0

- **The oldest entry.** Text.
`;

const notes = (version: string, changelog = CHANGELOG): string => buildReleaseNotes(changelog, version);

describe('release notes', () => {
  it('drops what only changesets needs: the commit prefix, the type heading and the nesting', () => {
    const body = notes('2.1.0');
    expect(body).not.toMatch(/12024cc/);
    expect(body).not.toMatch(/Minor Changes/);
    expect(body.split('\n').filter((line) => line.startsWith('  '))).toEqual([]);
  });

  it('lays the page out in order, with Thanks first', () => {
    const headings = notes('2.1.0')
      .split('\n')
      .filter((line) => line.startsWith('#'));
    expect(headings).toEqual([
      '## Thanks',
      "## What's new",
      '### The tile grid (#10)',
      '### Install without admin rights',
      '## Fixes',
      '## Also in this release',
    ]);
  });

  it('keeps a paragraph with the feature it follows', () => {
    const body = notes('2.1.0');
    expect(body.indexOf('It remembers your layout.')).toBeLessThan(body.indexOf('### Install without admin rights'));
    expect(body.indexOf('It remembers your layout.')).toBeGreaterThan(body.indexOf('### The tile grid'));
  });

  it('keeps the fixes as a list and the two short sections as run-ins', () => {
    const body = notes('2.1.0');
    expect(body).toContain('## Fixes\n\n- **The wheel works (#11).** It survives a reload.\n- **A second fix.** Text.');
    expect(body).toContain('**Fixes applied while landing.** One review fix (#10).');
    expect(body).toContain('**Docs and tests.** A new guide.');
  });

  it('makes a behaviour change stand out, without doubling bold that is already there', () => {
    expect(notes('2.1.0')).toContain('**Behaviour change:** `Ctrl+G` opens it now.');
    const bold = '## 1.0.0\n\n- **Fixes.**\n  - **Clone.** Text. Behaviour changes: a. **Breaking:** b.\n';
    const body = notes('1.0.0', bold);
    expect(body).toContain('**Behaviour changes:** a. **Breaking:** b.');
    expect(body).not.toContain('****');
  });

  it('links the comparison with the previous release, and only when there is one', () => {
    expect(previousVersion(CHANGELOG, '2.1.0')).toBe('2.0.0');
    expect(notes('2.1.0')).toContain('compare/codeman@2.0.0...codeman@2.1.0');
    expect(previousVersion(CHANGELOG, '1.9.0')).toBeNull();
    expect(notes('1.9.0')).not.toContain('Full Changelog');
  });

  it('keeps one-line changesets as a list, hashed or not', () => {
    expect(notes('2.0.0')).toContain("## What's new\n\n- One line.\n\n- A bullet with no hash.");
  });

  it('merges several changesets into one page instead of repeating sections', () => {
    const changelog = [
      '## 3.0.0',
      '### Minor Changes',
      '- aaaaaaa: ### Thanks\n  - @a for one.\n\n  **Feature A.** Text.\n\n  **Fixes.**\n  - **Fix A.** Text.',
      '### Patch Changes',
      '- bbbbbbb: ### Thanks\n  - @b for two.\n\n  **Feature B.** Text.\n\n  **Fixes.**\n  - **Fix B.** Text.',
    ].join('\n\n');
    const body = notes('3.0.0', changelog);
    expect(body.match(/^## Thanks$/gm)).toHaveLength(1);
    expect(body.match(/^## Fixes$/gm)).toHaveLength(1);
    expect(body).toContain('### Feature A');
    expect(body).toContain('### Feature B');
    expect(body).toContain('- @b for two.');
    expect(body).toContain('- **Fix B.** Text.');
  });

  it('does not take a sentence that opens in bold for a headline', () => {
    const changelog = '## 1.0.0\n\n- **Allow network access** is a new setting, off by default.\n';
    const body = notes('1.0.0', changelog);
    expect(body).toContain('**Allow network access** is a new setting, off by default.');
    expect(body).not.toContain('###');
  });

  it('keeps text after the Thanks list out of Thanks, and a lead-in line in it', () => {
    const changelog = [
      '## 1.0.0',
      '- ### Thanks',
      '  1.0.0 follows 0.9.0, so the thanks belong here too:',
      '',
      '  - @a for a fix.',
      '',
      '  ![a demo](https://example.com/demo.png)',
      '',
      '  **A feature.** Text.',
    ].join('\n');
    const body = notes('1.0.0', changelog);
    expect(body).toMatch(/## Thanks\n\n1\.0\.0 follows 0\.9\.0.*:\n\n- @a for a fix\.\n\n## What's new\n\n!\[a demo\]/);
  });

  it('keeps credit written as a paragraph under Thanks, where it opened (1.21.0 does this)', () => {
    const changelog =
      '## 1.0.0\n\n- ### Thanks\n\n  Seven rounds of beta testing by **@someone**.\n\n  **A feature.** Text.\n';
    expect(notes('1.0.0', changelog)).toMatch(
      /^## Thanks\n\nSeven rounds of beta testing by \*\*@someone\*\*\.\n\n## What's new/
    );
  });

  it('leaves a fenced code block alone', () => {
    const changelog = '## 1.0.0\n\n- **A feature.** Text.\n\n  ```md\n  ### Not a heading\n\n  **Fixes.**\n  ```\n';
    const body = notes('1.0.0', changelog);
    expect(body).toContain('```md\n### Not a heading\n\n**Fixes.**\n```');
    expect(body).not.toContain('## Fixes');
  });

  it('returns nothing for a version the changelog does not have', () => {
    expect(notes('9.9.9')).toBe('');
    expect(notes('1.0.0', '## 1.0.0\n\n### Patch Changes\n')).toBe('');
  });
});

describe('release notes over every release in CHANGELOG.md', () => {
  const versions: string[] = [...realChangelog.matchAll(/^## (\d+\.\d+\.\d+\S*)\s*$/gm)].map((m) => m[1]);

  /** The words of a text, ignoring only what the page legitimately changes around them. */
  const words = (text: string): string[] =>
    text
      .replace(/^### (?:Major|Minor|Patch) Changes\s*$/gm, '')
      .replace(/^- [0-9a-f]{7,40}: /gm, '')
      .replace(/[*#]/g, '')
      .split(/\s+/)
      .map((word) => word.replace(/[.:]+$/, ''))
      .filter((word) => word && word !== '-');

  it('reads the whole changelog', () => {
    expect(versions.length).toBeGreaterThan(200);
  });

  it('never loses a word', () => {
    const lost: string[] = [];
    for (const version of versions) {
      const available = new Map<string, number>();
      for (const word of words(buildReleaseNotes(realChangelog, version))) {
        available.set(word, (available.get(word) ?? 0) + 1);
      }
      for (const word of words(versionSection(realChangelog, version))) {
        const left = available.get(word) ?? 0;
        if (left === 0) lost.push(`${version}: ${word}`);
        available.set(word, left - 1);
      }
    }
    expect(lost).toEqual([]);
  });

  it('leaves no changesets scaffolding on any page, and opens with Thanks wherever there is one', () => {
    for (const version of versions) {
      const body: string = buildReleaseNotes(realChangelog, version);
      expect(body, version).not.toMatch(/^- [0-9a-f]{7,40}: /m);
      expect(body, version).not.toMatch(/^#+ (?:Major|Minor|Patch) Changes/m);
      if (/^ *### Thanks|: ### Thanks/m.test(versionSection(realChangelog, version))) {
        expect(body.startsWith('## Thanks'), version).toBe(true);
      }
    }
  });

  it('gives a page every headline the in-app toast announces for the same release', () => {
    const body: string = buildReleaseNotes(realChangelog, '1.49.0');
    const highlights: string[] = extractHighlights(versionSection(realChangelog, '1.49.0'));
    expect(highlights.length).toBeGreaterThan(0);
    for (const highlight of highlights) expect(body).toContain(highlight);
  });
});

describe('generate-release-notes.mjs', () => {
  const script = resolve(root, 'scripts/generate-release-notes.mjs');

  it('prints the page for a version', () => {
    const out = execFileSync(process.execPath, [script, '1.49.0'], { encoding: 'utf8' });
    expect(out).toBe(buildReleaseNotes(realChangelog, '1.49.0'));
  });

  it('prints nothing and fails for an unknown version, so the workflow keeps the changesets text', () => {
    const run = spawnSync(process.execPath, [script, '0.0.1-nope'], { encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
  });
});

describe('Release workflow', () => {
  const workflow = readFileSync(resolve(root, '.github/workflows/release.yml'), 'utf8');

  it('titles the release after the product and keeps the tag the updater parses', () => {
    expect(workflow).toContain('-f name="Codeman ${VERSION}"');
    expect(workflow).toContain('-f tag_name="$NEW_TAG"');
  });

  it('cannot lose the retag to a failed format: the script is guarded and the PATCH is not', () => {
    const guard = workflow.indexOf('if node scripts/generate-release-notes.mjs "$VERSION"');
    const patch = workflow.indexOf('gh api -X PATCH');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(patch);
    expect(workflow.slice(guard, patch)).toContain('fi\n');
    expect(workflow.slice(patch)).toContain('"${BODY_ARGS[@]}"');
  });
});
