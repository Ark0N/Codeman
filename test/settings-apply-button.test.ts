/**
 * @fileoverview Settings "Apply": saves like Save but keeps the modal open and refreshes the
 * groups that depend on a saved value (MCP sync, custom model endpoints, CLI management).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const html = readFileSync(resolve(publicDir, 'index.html'), 'utf8');
const settingsUi = readFileSync(resolve(publicDir, 'settings-ui.js'), 'utf8');

function loadApp() {
  const CodemanApp = function CodemanApp() {} as unknown as { prototype: Record<string, unknown> };
  const context = vm.createContext({
    CodemanApp,
    localStorage: { getItem: () => null, setItem: () => {} },
    document: { getElementById: () => null, querySelectorAll: () => [], addEventListener: () => {} },
    window: {},
    console,
  });
  vm.runInContext(settingsUi, context, { filename: 'settings-ui.js' });
  return new (CodemanApp as unknown as new () => Record<string, any>)();
}

describe('Settings Apply button', () => {
  it('sits next to Save in the footer and the phone header, wired to applyAppSettings', () => {
    const start = html.indexOf('<div class="modal" id="appSettingsModal">');
    const modal = html.slice(start, html.indexOf('<!-- Shortcut Overlay Modal -->', start));
    expect(modal.match(/onclick="app\.applyAppSettings\(\)"/g)).toHaveLength(2);
    expect(modal.match(/onclick="app\.saveAppSettings\(\)"/g)).toHaveLength(2);
  });

  it('flags the save as keep-open while it runs and clears the flag afterwards', async () => {
    const app = loadApp();
    const seen: boolean[] = [];
    app.saveAppSettings = vi.fn(async () => {
      seen.push(app._applyingSettings);
    });
    await app.applyAppSettings();
    expect(seen).toEqual([true]);
    expect(app._applyingSettings).toBe(false);
  });

  it('clears the flag even when the save throws, and ignores a second click mid-save', async () => {
    const app = loadApp();
    let release!: () => void;
    app.saveAppSettings = vi.fn(() => new Promise<void>((r) => (release = r)));
    const first = app.applyAppSettings();
    await app.applyAppSettings();
    expect(app.saveAppSettings).toHaveBeenCalledTimes(1);
    release();
    await first;

    app.saveAppSettings = vi.fn(async () => {
      throw new Error('boom');
    });
    await expect(app.applyAppSettings()).rejects.toThrow('boom');
    expect(app._applyingSettings).toBe(false);
  });

  it('refreshes the dependent groups from the saved values', () => {
    const app = loadApp();
    const out = {
      textContent: 'Apply or Save settings to turn MCP sync on first',
      style: { display: 'block' },
      innerHTML: 'x',
    };
    app.$ = (id: string) => (id === 'mcpSyncResult' ? out : null);
    app.applyMcpSyncVisibility = vi.fn();
    app.applyCustomModelEndpointsVisibility = vi.fn();
    app.applyCliManagementVisibility = vi.fn();
    app._applyDoctorAdminGate = vi.fn();
    app._mcpSyncSavedOn = false;

    app._refreshSettingsAfterApply({ mcpSyncEnabled: true });

    expect(app._mcpSyncSavedOn).toBe(true);
    expect(out.style.display).toBe('none');
    expect(app.applyMcpSyncVisibility).toHaveBeenCalled();
    expect(app.applyCustomModelEndpointsVisibility).toHaveBeenCalled();
    expect(app.applyCliManagementVisibility).toHaveBeenCalled();
  });

  it('only closes the modal on a plain Save', () => {
    const body = settingsUi.slice(settingsUi.indexOf('\n  async saveAppSettings() {'));
    expect(body).toContain('const keepOpen = this._applyingSettings === true;');
    expect(body).toMatch(
      /else if \(keepOpen\) \{\s*this\._refreshSettingsAfterApply\(settings\);\s*\} else \{\s*this\.closeAppSettings\(\);/
    );
  });
});
