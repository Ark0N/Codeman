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

  it('raises the keep-open intent for the save it wraps and clears it afterwards', async () => {
    const app = loadApp();
    const seen: boolean[] = [];
    app.saveAppSettings = vi.fn(async () => {
      seen.push(app._keepSettingsOpenOnce);
    });
    await app.applyAppSettings();
    expect(seen).toEqual([true]);
    expect(app._keepSettingsOpenOnce).toBe(false);
    expect(app._applyInFlight).toBe(false);
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
    expect(app._applyInFlight).toBe(false);
    expect(app._keepSettingsOpenOnce).toBe(false);
  });

  it('refreshes the dependent groups from the saved values', () => {
    const app = loadApp();
    const out = {
      textContent: 'Anything: the hint is found by its marker, not its (translatable) text',
      dataset: { hint: 'save-first' },
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

  describe('the real saveAppSettings()', () => {
    /** An element that answers any property read, call or write: enough for a DOM-heavy function to run. */
    function genericElement(): any {
      const el: any = new Proxy(function () {}, {
        get: (_t, prop) => {
          if (prop === 'value') return '';
          if (prop === 'checked') return false;
          if (prop === Symbol.toPrimitive) return () => '';
          if (prop === 'then') return undefined;
          return el;
        },
        set: () => true,
        apply: () => el,
      });
      return el;
    }

    function loadRealApp(put: () => Promise<unknown>) {
      const CodemanApp = function CodemanApp() {} as unknown as { prototype: Record<string, unknown> };
      const el = genericElement();
      const context = vm.createContext({
        CodemanApp,
        localStorage: { getItem: () => null, setItem: () => {} },
        document: new Proxy(
          {
            getElementById: () => el,
            querySelectorAll: () => [],
            querySelector: () => el,
            addEventListener: () => {},
            body: el,
            documentElement: el,
          },
          { get: (t: any, prop: string) => (prop in t ? t[prop] : el) }
        ),
        window: {},
        location: { reload: vi.fn() },
        VoiceInput: new Proxy({}, { get: () => vi.fn(() => ({})) }),
        KeyboardAccessoryBar: new Proxy({}, { get: () => vi.fn(() => ({})) }),
        MobileDetection: new Proxy({}, { get: () => vi.fn(() => false) }),
        setTimeout,
        console,
      });
      vm.runInContext(settingsUi, context, { filename: 'settings-ui.js' });
      const target = new (CodemanApp as unknown as new () => Record<string, any>)();
      // saveAppSettings() leans on helpers from the other settings mixins; anything it asks for
      // that is not defined is a harmless stub, while the state the Apply logic owns stays real.
      const state = new Set(['_keepSettingsOpenOnce', '_applyInFlight', '_mcpSyncSavedOn']);
      const app: Record<string, any> = new Proxy(target, {
        get: (t, prop) =>
          prop in t || typeof prop !== 'string' || state.has(prop) || prop === 'then'
            ? t[prop as string]
            : vi.fn(() => 14),
      });
      app.loadAppSettingsFromStorage = () => ({});
      app.saveAppSettingsToStorage = vi.fn();
      app.notificationManager = new Proxy(
        { preferences: {}, normalizePreferences: (p: unknown) => p, getToastDurationMs: () => 3000 },
        { get: (t: any, prop: string) => (prop in t ? t[prop] : vi.fn()) }
      );
      app._apiPut = vi.fn(put);
      app._handleTunnelEnableRefusal = vi.fn(async () => false);
      app.saveModelConfigFromSettings = vi.fn(async () => {});
      app._webhookPending = () => false;
      app.showToast = vi.fn();
      app.closeAppSettings = vi.fn();
      app._refreshSettingsAfterApply = vi.fn();
      // The apply*() helpers re-skin and re-lay-out the page from real DOM geometry; that is not what
      // these tests are about, so they are stubbed. applyAppSettings() itself stays real.
      for (const name of Object.keys(CodemanApp.prototype)) {
        if (/^apply[A-Z]/.test(name) && name !== 'applyAppSettings') app[name] = vi.fn();
      }
      return app;
    }

    it('a Save clicked while an Apply is in flight closes the modal, and the Apply keeps it open', async () => {
      let resolvePut!: (v: unknown) => void;
      const first = new Promise((r) => (resolvePut = r));
      const app = loadRealApp(() => first);
      const apply = app.applyAppSettings();
      // The Apply's PUT is still pending; the user clicks Save now.
      const save = app.saveAppSettings();
      resolvePut({ ok: true });
      await Promise.all([apply, save]);
      expect(app.closeAppSettings).toHaveBeenCalledTimes(1);
      expect(app._refreshSettingsAfterApply).toHaveBeenCalledTimes(1);
      const toasts = app.showToast.mock.calls.map((c: unknown[]) => c[0]);
      expect(toasts).toContain('Settings applied');
      expect(toasts).toContain('Settings saved');
    });

    it('does not refresh the dependent groups when the settings PUT failed', async () => {
      for (const failure of [{ ok: false }, null]) {
        const app = loadRealApp(async () => failure);
        await app.applyAppSettings();
        expect(app._refreshSettingsAfterApply, JSON.stringify(failure)).not.toHaveBeenCalled();
        expect(app.closeAppSettings).not.toHaveBeenCalled();
      }
    });

    it('still refreshes when only the webhook failed (the rest was saved)', async () => {
      const app = loadRealApp(async () => ({ ok: true }));
      app._webhookPending = () => true;
      app.saveWebhook = vi.fn(async () => 'bad URL');
      await app.applyAppSettings();
      expect(app._refreshSettingsAfterApply).toHaveBeenCalledTimes(1);
      expect(app.closeAppSettings).not.toHaveBeenCalled();
    });

    it('a plain Save closes the modal and never refreshes in place', async () => {
      const app = loadRealApp(async () => ({ ok: true }));
      await app.saveAppSettings();
      expect(app.closeAppSettings).toHaveBeenCalledTimes(1);
      expect(app._refreshSettingsAfterApply).not.toHaveBeenCalled();
    });
  });
});
