/**
 * Session Options structural guard.
 *
 * The modal shares the `set-*` settings surface with App Settings, but its rail
 * is a real switcher: switchOptionsTab shows one `.set-section` and hides the
 * rest. Like App Settings, its load/save path is `getElementById` by a fixed set
 * of ids, so dropping or renaming an element in the markup fails silently — the
 * option just stops loading, or stops being written back.
 *
 * These tests read the REAL session-ui.js and index.html and pin that contract.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const html = readFileSync(resolve(publicDir, 'index.html'), 'utf8');
const sessionUi = readFileSync(resolve(publicDir, 'session-ui.js'), 'utf8');
const styles = readFileSync(resolve(publicDir, 'styles.css'), 'utf8');

/** The Session Options markup, so assertions can't be satisfied elsewhere. */
function optionsModal(): string {
  const start = html.indexOf('<div class="modal" id="sessionOptionsModal">');
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf('<!-- Close Session Confirmation Modal -->', start);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

/** Body of a session-ui.js method, by name. */
function methodBody(signature: string): string {
  const start = sessionUi.indexOf(`\n  ${signature} {`);
  expect(start, `${signature} not found in session-ui.js`).toBeGreaterThan(-1);
  return sessionUi.slice(start, sessionUi.indexOf('\n  },', start));
}

const TABS = ['respawn', 'context', 'ralph', 'summary'];

describe('Session Options modal structure', () => {
  it('keeps every element openSessionOptions and switchOptionsTab touch by id', () => {
    const modal = optionsModal();
    const ids = new Set<string>();
    for (const sig of ['openSessionOptions(sessionId)', 'switchOptionsTab(tabName)', 'getRalphConfig()']) {
      for (const m of methodBody(sig).matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)) ids.add(m[1]);
    }
    // openSessionOptions also drives elements outside this modal (tabs, toasts);
    // only the ones it expects to find in here are this file's contract.
    const outside = new Set(['sessionOptionsDoc']);
    const missing = [...ids].filter((id) => !outside.has(id) && !modal.includes(`id="${id}"`));
    expect(missing).toEqual([]);
    expect(modal).toContain('id="sessionOptionsDoc"');
  });

  it('pairs each rail entry with exactly one section, in the same order', () => {
    const modal = optionsModal();
    const rail = [...modal.matchAll(/class="set-rail-item[^"]*" data-tab="([a-z]+)"/g)].map((m) => m[1]);
    expect(rail).toEqual(TABS);
    for (const tab of TABS) {
      const hits = modal.split(`id="${tab}-tab"`).length - 1;
      expect(hits, `section ${tab}-tab should exist exactly once`).toBe(1);
    }
    // switchOptionsTab queries the rail by THIS class; `.modal-tab-btn` here
    // would silently stop the active marker from moving.
    expect(methodBody('switchOptionsTab(tabName)')).toContain("'#sessionOptionsModal .set-rail-item'");
    expect(methodBody('openSessionOptions(sessionId)')).toContain('.set-rail-item[data-tab="ralph"]');
  });

  it('opens with exactly one section visible, the rest hidden', () => {
    const modal = optionsModal();
    const visible = TABS.filter((t) => modal.includes(`<section class="set-section" id="${t}-tab"`));
    expect(visible).toEqual(['respawn']);
    for (const t of TABS.filter((t) => t !== 'respawn')) {
      expect(modal).toContain(`<section class="set-section hidden" id="${t}-tab"`);
    }
  });

  it('keeps the Claude-only rail entries marked, so external CLIs lose them', () => {
    const modal = optionsModal();
    for (const tab of ['respawn', 'ralph']) {
      const entry = modal.match(new RegExp(`<button[^>]*data-tab="${tab}"[^>]*>`))?.[0] ?? '';
      expect(entry, `${tab} rail entry`).toContain('data-claude-only');
    }
    expect(modal.match(/<button[^>]*data-tab="context"[^>]*>/)?.[0]).not.toContain('data-claude-only');
  });

  it('uses the shared settings surface rather than the modal-tab chrome', () => {
    const modal = optionsModal();
    expect(modal).toContain('class="modal-content modal-lg set-shell"');
    expect(modal).toContain('class="set-body"');
    expect(modal).not.toContain('class="modal-tabs"');
    expect(modal).not.toContain('modal-tab-btn');
    expect(modal).not.toContain('modal-tab-content');
    // The `set-*` rules are shared by both modals through one :is() scope.
    const css = readFileSync(resolve(publicDir, 'styles.css'), 'utf8');
    expect(css).toContain(':is(#appSettingsModal, #sessionOptionsModal, #createCaseModal) .set-row {');
    expect(css).toContain(':is(#sessionOptionsModal, #createCaseModal) .set-section.hidden {');
  });

  it('uses document-safe context columns and widens only at the desktop breakpoint', () => {
    expect(styles).toMatch(/#sessionOptionsModal #context-tab\s*\{[^}]*minmax\(0, 1fr\)/s);
    expect(styles).toMatch(
      /@media \(min-width: 1200px\)[\s\S]*#sessionOptionsModal #context-tab[^}]*repeat\(2, minmax\(0, 1fr\)\)/
    );
    expect(styles).not.toMatch(/@media \(min-width: 680px\)[\s\S]{0,1200}#sessionOptionsModal #context-tab/);
  });

  it('shows the session working folder with a copy button', () => {
    const modal = optionsModal();
    expect(modal).toContain('id="modalSessionPath"');
    expect(modal).toContain('app.copySessionPath()');
    const open = methodBody('openSessionOptions(sessionId)');
    expect(open).toContain("getElementById('modalSessionPath')");
    expect(open).toContain('session.workingDir');
    expect(methodBody('async copySessionPath()')).toContain('_copyText(session.workingDir)');
  });
});
