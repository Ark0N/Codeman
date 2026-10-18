/**
 * @fileoverview Restoring settings.json from inside App Settings must refill the form, or Save
 * would PUT the pre-restore values back over the restored file. Evaluates the real settings-ui.js
 * against a stub app.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../src/web/public/settings-ui.js', import.meta.url), 'utf-8');

function makeApp(restored: string[], confirmed = true) {
  const calls: string[] = [];
  const confirms: string[] = [];
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
    _apiPost: async () => ({
      ok: true,
      json: async () => ({ success: true, data: { restored, restartRequired: [] } }),
    }),
    loadAppSettingsFromServer: async () => void calls.push('reload-settings'),
    openAppSettings: () => void calls.push('refill-form'),
    loadConfigBackups: () => void calls.push('reload-list'),
    showToast: () => {},
  });
  return { app, calls, confirms };
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

  it('names the files being replaced and calls out the credential ones', async () => {
    const { app, confirms } = makeApp(['settings.json'], false);
    await (app.restoreConfigBackup as (id: string) => Promise<void>)('cfg-1');
    expect(confirms[0]).toContain('settings.json, users.json, .env, clis.json');
    expect(confirms[0]).toContain('credentials');
    expect(confirms[0]).toMatch(/users\.json, \.env\)/);
  });
});
