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
import { SettingsUpdateSchema } from '../src/web/schemas.js';

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

  /**
   * Owner decision (2026-10-09): every animation setting has its own
   * Animations section, right after Appearance, so it is easy to find. The
   * selects are wired by id in entrance-animations.js, not by the load/save
   * path above, so they get their own check here.
   */
  it('keeps every animation setting in its own Animations section, after Appearance', () => {
    const modal = settingsModal();
    const rail = [...modal.matchAll(/data-section="([a-z-]+)"/g)].map((m) => m[1]);
    const order = [...modal.matchAll(/<section class="set-section" id="([a-z-]+)"/g)].map((m) => m[1]);
    for (const list of [rail, order]) {
      expect(list[list.indexOf('settings-appearance') + 1]).toBe('settings-animations');
    }
    const animations = modal.match(/id="settings-animations"([\s\S]*?)<\/section>/)?.[1] ?? '';
    for (const id of ['appSettingsEntranceAnim', 'appSettingsTileAnim', 'appSettingsOpenAnimLab']) {
      expect(animations, `${id} belongs in the Animations section`).toContain(`id="${id}"`);
    }
    const appearance = modal.match(/id="settings-appearance"([\s\S]*?)<\/section>/)?.[1] ?? '';
    expect(appearance).not.toMatch(/id="appSettings[A-Za-z]*Anim"/);
    const anim = readFileSync(resolve(publicDir, 'entrance-animations.js'), 'utf8');
    for (const id of ['appSettingsEntranceAnim', 'appSettingsTileAnim', 'appSettingsOpenAnimLab']) {
      expect(anim).toContain(`document.getElementById('${id}')`);
    }
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

  /**
   * Git fetch on an interval (src/git-fetch-scheduler.ts). Both keys are SYNCED, not display keys, because
   * the server's scheduler is what acts on them: kept per-device, the scheduler would read nobody's number.
   * Off by default, and the interval clamped on save to the same bounds the schema accepts.
   */
  it('keeps the Git fetch rows synced, off by default, and inside the bounds the scheduler acts on', () => {
    const modal = settingsModal();
    const bar = modal.match(/<h4>Bottom bar<\/h4>([\s\S]*?)(?=<div class="set-group-head">)/)?.[1];
    expect(bar, 'the Git fetch rows are not in the Bottom bar group').toBeTruthy();
    for (const id of ['appSettingsGitFetchEnabled', 'appSettingsGitFetchIntervalSeconds']) {
      const at = modal.indexOf(`id="${id}"`);
      expect(at, `no element ${id}`).toBeGreaterThan(-1);
      const row = modal.slice(modal.lastIndexOf('<div class="set-row"', at), modal.indexOf('</div>', at));
      expect(row).toContain('<span class="set-scope">synced</span>');
    }
    // The number row's own bounds must agree with the schema's, or the browser sends a value the PUT rejects.
    expect(modal).toContain('id="appSettingsGitFetchIntervalSeconds" class="set-num" value="300" min="30" max="3600"');

    // Display keys are the half of the per-device split that keeps a value off the server.
    const displayStart = settingsUi.indexOf('const displayKeys = new Set([');
    const displayBlock = settingsUi.slice(displayStart, settingsUi.indexOf(']);', displayStart));
    expect(displayBlock).not.toContain('gitFetchEnabled');
    expect(displayBlock).not.toContain('gitFetchIntervalSeconds');
    // The strip destructure is the other half: an aliased key here never reaches the settings PUT.
    expect(settingsUi).not.toMatch(/gitFetch(?:Enabled|IntervalSeconds):\s*_\w+/);

    // Declared in the .strict() schema: an undeclared key 400s the whole settings PUT.
    expect(SettingsUpdateSchema.safeParse({ gitFetchEnabled: true, gitFetchIntervalSeconds: 300 }).success).toBe(true);

    // Off by default (only an explicit true loads as on), and an empty box falls back to the default interval.
    expect(settingsUi).toContain(
      "document.getElementById('appSettingsGitFetchEnabled').checked = settings.gitFetchEnabled === true;"
    );
    expect(settingsUi).toContain(
      "document.getElementById('appSettingsGitFetchIntervalSeconds').value = settings.gitFetchIntervalSeconds ?? 300;"
    );
    expect(settingsUi).toMatch(
      /gitFetchIntervalSeconds: Math\.min\(\s*3600,\s*Math\.max\(30, parseInt\(document\.getElementById\('appSettingsGitFetchIntervalSeconds'\)\.value, 10\) \|\| 300\)\s*\),/
    );
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
