import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const INDEX_HTML = readFileSync(join(process.cwd(), 'src/web/public/index.html'), 'utf-8');

function normalizedHtml(value: string): string {
  return value.replace(/\s+/g, ' ');
}

function extractElementById(html: string, id: string): string {
  const idIndex = html.indexOf(`id="${id}"`);
  expect(idIndex, `expected #${id} to exist`).toBeGreaterThanOrEqual(0);

  const start = html.lastIndexOf('<', idIndex);
  expect(start, `expected #${id} start tag`).toBeGreaterThanOrEqual(0);

  // Bound at the next HTML comment (every following section is comment-labeled) so
  // sections inserted between this element and any fixed marker don't leak into the
  // slice — the cron modal's "Run At" text false-positived the stale-shortcut check.
  const nextSection = html.indexOf('<!--', idIndex);
  expect(nextSection, `expected section marker after #${id}`).toBeGreaterThanOrEqual(0);

  const end = nextSection;
  return html.slice(start, end);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function expectShortcut(html: string, keys: string[], label: string): void {
  const keyPattern = keys.map((key) => `<kbd>${escapeRegExp(key)}</kbd>`).join('\\s*\\+\\s*');
  expect(html).toMatch(new RegExp(`${keyPattern}.*?${escapeRegExp(label)}`, 'i'));
}

describe('help modal shortcuts', () => {
  const helpModal = normalizedHtml(extractElementById(INDEX_HTML, 'helpModal'));

  it('documents implemented global and tab shortcuts', () => {
    // Ctrl+W is NOT an app shortcut: it is delete-word in the terminal, and as
    // Close Session it killed sessions with no confirm (ctrl-w-never-closes.test.ts).
    expect(helpModal).not.toMatch(/<kbd>Ctrl<\/kbd>\s*\+\s*<kbd>W<\/kbd>/i);
    expectShortcut(helpModal, ['Ctrl', 'Tab'], 'Next Session');
    expectShortcut(helpModal, ['Alt/Option', '['], 'Previous / Next Session');
    expectShortcut(helpModal, ['Alt/Option', ']'], 'Previous / Next Session');
    expectShortcut(helpModal, ['Alt/Option', '1-9'], 'Switch to Tab N');
    expectShortcut(helpModal, ['Ctrl', '{'], 'Move Active Tab Left');
    expectShortcut(helpModal, ['Ctrl', '}'], 'Move Active Tab Right');
    expectShortcut(helpModal, ['Ctrl', '?'], 'Show Shortcuts');
    expect(helpModal).not.toMatch(/Ctrl<\/kbd>\s*\+\s*<kbd>\/<\/kbd>.*?Show Shortcuts/i);
    expectShortcut(helpModal, ['Ctrl', 'Shift', 'V'], 'Voice Input');
    expectShortcut(helpModal, ['Escape'], 'Close Panels');
  });

  it('documents the tile grid chords', () => {
    expectShortcut(helpModal, ['Ctrl', 'Shift', 'G'], 'Toggle Tile Grid');
    expectShortcut(helpModal, ['Alt/Option', 'Shift', 'Arrows'], 'Focus Tile Left / Right / Up / Down');
    expectShortcut(helpModal, ['Alt/Option', 'Shift', 'Enter'], 'Zoom Focused Tile');
    expectShortcut(helpModal, ['Ctrl/Cmd', 'Click'], 'Add the Session to the Tile Grid');
    expectShortcut(helpModal, ['Right-click'], 'Choose How Many Tiles (2, 4 or 6)');
  });

  it('documents terminal input shortcuts without advertising stale run shortcuts', () => {
    expectShortcut(helpModal, ['Ctrl', 'C'], 'Copy Selection');
    expectShortcut(helpModal, ['Ctrl', 'Shift', 'C'], 'Copy Selection');
    expectShortcut(helpModal, ['Ctrl', 'L'], 'Clear Terminal');
    expectShortcut(helpModal, ['Ctrl', '+'], 'Increase Font');
    expectShortcut(helpModal, ['Ctrl', '-'], 'Decrease Font');
    expectShortcut(helpModal, ['Shift', 'Enter'], 'Insert Newline');
    expectShortcut(helpModal, ['Ctrl', 'Enter'], 'Insert Newline');
    // Ctrl+Shift+R (restore terminal size) is still dispatched — keep it documented.
    expectShortcut(helpModal, ['Ctrl', 'Shift', 'R'], 'Restore Terminal Size');

    expect(helpModal).not.toMatch(/Ctrl<\/kbd>\s*\+\s*<kbd>K<\/kbd>/i);
    expect(helpModal).not.toMatch(/Ctrl<\/kbd>\s*\+\s*<kbd>Enter<\/kbd>.*?(Run|Start)/i);
  });

  it('does not advertise the removed Ctrl+Enter run binding in launch UI hints', () => {
    expect(INDEX_HTML).not.toContain('Or press <kbd>Ctrl</kbd>+<kbd>Enter</kbd> to start');
    expect(INDEX_HTML).not.toContain('title="Run (Ctrl+Enter)"');
  });
});
