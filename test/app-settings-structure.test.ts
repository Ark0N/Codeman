/**
 * App Settings structural guard.
 *
 * The settings modal is a rail (table of contents) over ONE scrolling document.
 * Its load/save path is pure `getElementById` by a fixed set of ids
 * (openAppSettings / saveAppSettings in settings-ui.js), so a restructure of the
 * markup that drops or renames an element does not fail loudly: the setting just
 * silently stops loading, or stops being saved and falls back to its default.
 *
 * These tests read the REAL settings-ui.js and index.html and pin that contract.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const html = readFileSync(resolve(publicDir, 'index.html'), 'utf8');
const settingsUi = readFileSync(resolve(publicDir, 'settings-ui.js'), 'utf8');

/** The App Settings modal markup, so assertions can't be satisfied elsewhere. */
function settingsModal(): string {
  const start = html.indexOf('<div class="modal" id="appSettingsModal">');
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf('<!-- Shortcut Overlay Modal -->', start);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

/**
 * Every id the load and save paths touch. Scoped to those two functions on
 * purpose: settings-ui.js also drives elements that live OUTSIDE the modal
 * (toasts, header chips), and those are not this file's contract.
 */
function referencedIds(): string[] {
  const ids = new Set<string>();
  for (const fn of ['openAppSettings()', 'async saveAppSettings()']) {
    const start = settingsUi.indexOf(`\n  ${fn} {`);
    expect(start, `${fn} not found in settings-ui.js`).toBeGreaterThan(-1);
    const body = settingsUi.slice(start, settingsUi.indexOf('\n  },', start));
    for (const m of body.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)) ids.add(m[1]);
  }
  return [...ids];
}

describe('App Settings modal structure', () => {
  it('keeps every element settings-ui.js loads or saves by id', () => {
    const modal = settingsModal();
    const missing = referencedIds().filter((id) => !modal.includes(`id="${id}"`));
    expect(missing).toEqual([]);
  });

  it('carries every section the rail points at, exactly once', () => {
    const modal = settingsModal();
    const sections = [...modal.matchAll(/data-section="([a-z-]+)"/g)].map((m) => m[1]);
    expect(sections.length).toBeGreaterThanOrEqual(9);
    for (const id of new Set(sections)) {
      const hits = modal.split(`<section class="set-section" id="${id}"`).length - 1;
      expect(hits, `section ${id} should exist exactly once`).toBe(1);
    }
  });

  it('opens on Updates: the version and the updater above everything else', () => {
    expect(settingsUi).toContain("this.switchSettingsTab('settings-updates')");
    const modal = settingsModal();
    const order = [...modal.matchAll(/<section class="set-section" id="([a-z-]+)"/g)].map((m) => m[1]);
    // Rail and document must agree, or scroll-spy paints the wrong entry.
    const rail = [...modal.matchAll(/data-section="([a-z-]+)"/g)].map((m) => m[1]);
    expect(rail.slice(0, 3)).toEqual(['settings-updates', 'settings-terminal', 'settings-layout']);
    expect(order.slice(0, 3)).toEqual(['settings-updates', 'settings-terminal', 'settings-layout']);
    // Updates carries ONLY the version and the update action; the rest of the
    // system settings tail the document under System, out of the way.
    const updates = modal.match(/id="settings-updates"([\s\S]*?)<\/section>/)?.[1] ?? '';
    expect(updates).toContain('id="updateCurrentVersion"');
    expect(updates).toContain('id="updateCheckBtn"');
    expect(updates).not.toContain('id="appSettingsClaudeMdPath"');
    expect(rail[rail.length - 1]).toBe('settings-system');
    expect(order[order.length - 1]).toBe('settings-system');
    const system = modal.match(/id="settings-system"([\s\S]*?)<\/section>/)?.[1] ?? '';
    expect(system).toContain('id="appSettingsClaudeMdPath"');
    expect(system).toContain('id="appSettingsTunnelEnabled"');
  });

  it('keeps Local Echo the first row of the second section', () => {
    const terminal = settingsModal().match(/id="settings-terminal"([\s\S]*?)<\/section>/);
    const localEcho = terminal?.[1].indexOf('appSettingsLocalEcho') ?? -1;
    const cjk = terminal?.[1].indexOf('appSettingsCjkInput') ?? -1;
    expect(localEcho).toBeGreaterThan(-1);
    expect(localEcho).toBeLessThan(cjk);
  });

  it('gives every previewed chip an icon to clone, and a slot that exists', () => {
    // _syncLayoutPreview clones `.set-chip-ico` out of the chip, so a chip that
    // opts into the preview without an icon renders as an empty button, and one
    // pointing at a slot id that does not exist renders as nothing at all.
    const layout = settingsModal().match(/id="settings-layout"([\s\S]*?)<\/section>/)?.[1] ?? '';
    const chips = [...layout.matchAll(/<label class="set-chip"([^>]*)>([\s\S]*?)<\/label>/g)];
    const previewed = chips.filter(([, attrs]) => attrs.includes('data-preview='));
    expect(previewed.length).toBeGreaterThanOrEqual(15);
    for (const [, attrs, body] of previewed) {
      const kind = attrs.match(/data-preview="([a-z]+)"/)?.[1];
      expect(['header', 'panel', 'toolbar', 'float']).toContain(kind);
      // A decimal (e.g. "11.5") is allowed — Split sits between Multi-monitor
      // (11) and Ultracode Agents (12) in the real header, and Number()
      // parses it fine for the preview's own sort.
      expect(attrs, `chip ${body} needs a preview order`).toMatch(/data-preview-order="\d+(\.\d+)?"/);
      // A text token replaces the icon for readouts (plan usage, CPU, font size).
      const hasIcon = body.includes('class="set-chip-ico') || attrs.includes('data-preview-text=');
      expect(hasIcon, `chip ${body} has nothing to render in the preview`).toBe(true);
    }
    for (const id of [
      'appSettingsPreviewHeader',
      'appSettingsPreviewPanels',
      'appSettingsPreviewToolbar',
      'appSettingsPreviewFloats',
    ]) {
      expect(layout).toContain(`id="${id}"`);
      expect(settingsUi).toContain(`'${id}'`);
    }
  });

  it('models: keeps the 1M variants as select options behind the context switch', () => {
    const modal = settingsModal();
    const select = modal.match(/id="appSettingsClaudeModel"([\s\S]*?)<\/select>/)?.[1] ?? '';
    // The cards render the base models; the [1m] rows exist so that base + the
    // context switch can compose back into a real claudeModel value.
    for (const value of [
      'opus[1m]',
      'claude-fable-5[1m]',
      'claude-fable-5-1[1m]',
      'claude-opus-5-5[1m]',
      'claude-opus-4-6[1m]',
    ]) {
      expect(select).toContain(`value="${value}"`);
    }
    expect(select).toContain('data-ctx="1"');
    expect(modal).toContain('id="appSettingsOpusContext1m"');
  });

  it('models: offers Fable 5.1 as a card and to task routing', () => {
    const modal = settingsModal();
    const select = modal.match(/id="appSettingsClaudeModel"([\s\S]*?)<\/select>/)?.[1] ?? '';
    // The cards are built from these options, so data-ctx is what keeps the 1M
    // switch live for the model rather than greying the row out.
    expect(select).toMatch(/value="claude-fable-5-1"[^>]*data-ctx="1"/);
    for (const id of [
      'appSettingsDefaultModel',
      'appSettingsModelExplore',
      'appSettingsModelImplement',
      'appSettingsModelTest',
      'appSettingsModelReview',
    ]) {
      const routing = modal.match(new RegExp(`id="${id}"([\\s\\S]*?)</select>`))?.[1] ?? '';
      expect(routing, `${id} does not offer Fable 5.1`).toContain('value="claude-fable-5-1"');
    }
  });

  it('models: offers Opus 5.5 as a card and to task routing', () => {
    const modal = settingsModal();
    const select = modal.match(/id="appSettingsClaudeModel"([\s\S]*?)<\/select>/)?.[1] ?? '';
    expect(select).toMatch(/value="claude-opus-5-5"[^>]*data-ctx="1"/);
    for (const id of [
      'appSettingsDefaultModel',
      'appSettingsModelExplore',
      'appSettingsModelImplement',
      'appSettingsModelTest',
      'appSettingsModelReview',
    ]) {
      const routing = modal.match(new RegExp(`id="${id}"([\\s\\S]*?)</select>`))?.[1] ?? '';
      expect(routing, `${id} does not offer Opus 5.5`).toContain('value="claude-opus-5-5"');
    }
  });

  it('has retired the modal-tab chrome everywhere, not just here', () => {
    // Session Options and Add Case moved onto this same `set-*` surface, so the
    // old tab classes have no users left. A reappearance means a modal drifted
    // back off the shared surface (or the dead CSS was resurrected).
    expect(settingsModal()).not.toContain('modal-tab-content');
    expect(html).not.toContain('class="modal-tabs"');
    expect(html).not.toContain('modal-tab-btn');
    const css = readFileSync(resolve(publicDir, 'styles.css'), 'utf8');
    expect(css).not.toContain('.modal-tab-btn {');
  });

  it('exposes the rail hooks admin-ui.js injects the Users section into', () => {
    const modal = settingsModal();
    expect(modal).toContain('class="set-rail-items"');
    expect(modal).toContain('id="appSettingsDoc"');
    const adminUi = readFileSync(resolve(publicDir, 'admin-ui.js'), 'utf8');
    expect(adminUi).toContain('.set-rail-items');
    expect(adminUi).toContain('.set-doc');
  });
});
