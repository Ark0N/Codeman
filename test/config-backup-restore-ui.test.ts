/**
 * @fileoverview Restoring settings.json from inside App Settings must refill the form, or Save
 * would PUT the pre-restore values back over the restored file. Evaluates the real settings-ui.js
 * against a stub app.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../src/web/public/settings-ui.js', import.meta.url), 'utf-8');

function makeApp(
  restored: string[],
  confirmed = true,
  reply: { ok: boolean; body: unknown } = { ok: true, body: { success: true, data: { restored, restartRequired: [] } } }
) {
  const calls: string[] = [];
  const confirms: string[] = [];
  const toasts: Array<[string, string]> = [];
  function CodemanApp(this: unknown) {}
  const ctx = vm.createContext({
    CodemanApp,
    window: {},
    document: {},
    confirm: (m: string) => (confirms.push(m), confirmed),
    escapeHtml: (s: string) => s,
  });
  vm.runInContext(SRC, ctx);
  const app = Object.create((CodemanApp as unknown as { prototype: object }).prototype) as Record<string, unknown>;
  Object.assign(app, {
    _configBackups: [
      {
        id: 'cfg-1',
        files: [{ name: 'settings.json' }, { name: 'users.json' }, { name: '.env' }, { name: 'clis.json' }],
      },
    ],
    _apiPost: async () => ({ ok: reply.ok, json: async () => reply.body }),
    loadAppSettingsFromServer: async () => void calls.push('reload-settings'),
    openAppSettings: () => void calls.push('refill-form'),
    loadConfigBackups: () => void calls.push('reload-list'),
    showToast: (m: string, type: string) => void toasts.push([m, type]),
  });
  return { app, calls, confirms, toasts };
}

describe('restoreConfigBackup (Settings UI)', () => {
  it('re-reads settings into the form when settings.json was restored', async () => {
    const { app, calls } = makeApp(['settings.json', 'clis.json']);
    await (app.restoreConfigBackup as (id: string) => Promise<void>)('cfg-1');
    expect(calls).toEqual(['reload-settings', 'refill-form', 'reload-list']);
  });

  it('leaves the form alone when settings.json was not part of the restore', async () => {
    const { app, calls } = makeApp(['clis.json']);
    await (app.restoreConfigBackup as (id: string) => Promise<void>)('cfg-1');
    expect(calls).toEqual(['reload-list']);
  });

  it('a restore that failed partway still refills the form when settings.json was among the files written', async () => {
    const { app, calls, toasts } = makeApp([], true, {
      ok: false,
      body: {
        success: false,
        errorCode: 'OPERATION_FAILED',
        error: 'Restore incomplete: could not write clis.json (EISDIR); settings.json restored',
        data: {
          restored: ['settings.json'],
          failed: [{ name: 'clis.json', error: 'EISDIR' }],
          safetySnapshot: 'cfg-2',
          restartRequired: ['settings.json'],
        },
      },
    });
    await (app.restoreConfigBackup as (id: string) => Promise<void>)('cfg-1');
    expect(calls).toEqual(['reload-settings', 'refill-form', 'reload-list']);
    expect(toasts).toHaveLength(1);
    expect(toasts[0][1]).toBe('error');
    expect(toasts[0][0]).toContain('clis.json');
  });

  it('a refused restore (nothing written) only reports the error', async () => {
    const { app, calls, toasts } = makeApp([], true, {
      ok: false,
      body: { success: false, errorCode: 'CONFLICT', error: 'settings.json does not match its checksum' },
    });
    await (app.restoreConfigBackup as (id: string) => Promise<void>)('cfg-1');
    expect(calls).toEqual([]);
    expect(toasts).toEqual([['settings.json does not match its checksum', 'error']]);
  });

  it('names the files being replaced and calls out the credential ones', async () => {
    const { app, confirms } = makeApp(['settings.json'], false);
    await (app.restoreConfigBackup as (id: string) => Promise<void>)('cfg-1');
    expect(confirms[0]).toContain('settings.json, users.json, .env, clis.json');
    expect(confirms[0]).toContain('credentials');
    expect(confirms[0]).toMatch(/users\.json, \.env\)/);
  });
});

describe('loadConfigBackups (retention fields)', () => {
  function load(saved: Record<string, unknown>) {
    const inputs: Record<string, { value: string; placeholder: string }> = {
      appSettingsConfigBackupKeepCount: { value: '20', placeholder: '' },
      appSettingsConfigBackupKeepDays: { value: '30', placeholder: '' },
      appSettingsConfigBackupDir: { value: '', placeholder: '' },
    };
    function CodemanApp(this: unknown) {}
    const ctx = vm.createContext({
      CodemanApp,
      window: {},
      document: { getElementById: (id: string) => inputs[id] ?? null },
      escapeHtml: (s: string) => s,
    });
    vm.runInContext(SRC, ctx);
    const app = Object.create((CodemanApp as unknown as { prototype: object }).prototype) as Record<string, unknown>;
    Object.assign(app, {
      $: () => ({ textContent: '', innerHTML: '' }),
      loadAppSettingsFromStorage: () => saved,
      _api: async () => ({
        ok: true,
        json: async () => ({
          success: true,
          data: { settings: { keepCount: 100, keepDays: 0 }, dir: '/d', defaultDir: '/d', backups: [] },
        }),
      }),
    });
    return { app, inputs };
  }

  it('shows the retention the passes use when settings.json has none of the keys (a reset file)', async () => {
    const { app, inputs } = load({});
    await (app.loadConfigBackups as () => Promise<void>)();
    expect(inputs.appSettingsConfigBackupKeepCount.value).toBe(100);
    expect(inputs.appSettingsConfigBackupKeepDays.value).toBe(0);
  });

  it('leaves the form alone when the saved settings state the retention', async () => {
    const { app, inputs } = load({ configBackupKeepCount: 7, configBackupKeepDays: 9 });
    await (app.loadConfigBackups as () => Promise<void>)();
    expect(inputs.appSettingsConfigBackupKeepCount.value).toBe('20'); // the open-settings code owns it
  });
});

describe('Save and the displayed retention', () => {
  function payload(
    prev: Record<string, unknown>,
    touched: { count?: boolean; days?: boolean },
    count = '100',
    days = '0'
  ) {
    const inputs: Record<string, { value: string; dataset: Record<string, string> }> = {
      appSettingsConfigBackupKeepCount: { value: count, dataset: touched.count ? { touched: '1' } : {} },
      appSettingsConfigBackupKeepDays: { value: days, dataset: touched.days ? { touched: '1' } : {} },
    };
    function CodemanApp(this: unknown) {}
    const ctx = vm.createContext({
      CodemanApp,
      window: {},
      document: { getElementById: (id: string) => inputs[id] },
    });
    vm.runInContext(SRC, ctx);
    const app = Object.create((CodemanApp as unknown as { prototype: object }).prototype) as Record<string, unknown>;
    return (app._configBackupRetentionPayload as (p: Record<string, unknown>) => Record<string, unknown>).call(
      app,
      prev
    );
  }

  it('leaves out a retention value that was only displayed (a reset settings.json)', () => {
    expect(payload({}, {})).toEqual({});
  });

  it('sends a value that was saved before, or edited here, and only that one', () => {
    expect(payload({ configBackupKeepCount: 100 }, {})).toEqual({ configBackupKeepCount: 100 });
    expect(payload({}, { days: true })).toEqual({ configBackupKeepDays: 0 });
    expect(payload({}, { count: true, days: true }, '5', '7')).toEqual({
      configBackupKeepCount: 5,
      configBackupKeepDays: 7,
    });
  });

  it('clamps like the form always did', () => {
    expect(payload({}, { count: true, days: true }, '1', '99999')).toEqual({
      configBackupKeepCount: 2,
      configBackupKeepDays: 3650,
    });
  });
});
