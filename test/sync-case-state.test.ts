/**
 * @fileoverview Opt-in case sync: the schema accepts the setting and a per-case map, and the
 * session-ui helpers only touch the server when the setting is on. Evaluates the real session-ui.js.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { SettingsUpdateSchema } from '../src/web/schemas.js';

const SRC = readFileSync(new URL('../src/web/public/session-ui.js', import.meta.url), 'utf-8');

function makeApp(settings: Record<string, unknown>, server: Record<string, unknown> = {}) {
  const store = new Map<string, string>();
  const puts: unknown[] = [];
  function CodemanApp(this: unknown) {}
  const ctx = vm.createContext({
    CodemanApp,
    window: {},
    document: { getElementById: () => null, addEventListener: () => {} },
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
    fetch: async (_url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'PUT') puts.push(JSON.parse(init.body!));
      return { ok: true, json: async () => ({ success: true, data: server }) };
    },
    console,
  });
  vm.runInContext(SRC, ctx);
  const app = Object.create((CodemanApp as unknown as { prototype: object }).prototype) as Record<string, any>;
  app.loadAppSettingsFromStorage = () => settings;
  return { app, store, puts };
}

describe('syncCaseState', () => {
  it('is accepted by the settings schema with a per-case map, and rejects junk', () => {
    expect(
      SettingsUpdateSchema.safeParse({
        syncCaseState: true,
        caseSettings: { demo: { agentTeams: true, opusContext1m: false } },
      }).success
    ).toBe(true);
    expect(SettingsUpdateSchema.safeParse({ caseSettings: { demo: { agentTeams: 'yes' } } }).success).toBe(false);
    expect(
      SettingsUpdateSchema.safeParse({ caseSettings: { demo: { agentTeams: true, opusContext1m: true, x: 1 } } })
        .success
    ).toBe(false);
  });

  it('saves only to this browser while the setting is off', async () => {
    const { app, store, puts } = makeApp({});
    app.saveCaseSettings('demo', { agentTeams: true, opusContext1m: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(store.get('caseSettings_demo')).toContain('agentTeams');
    expect(puts).toEqual([]);
  });

  it('pushes a merge into the server map while on, and never when settings are read-only', async () => {
    const server = { caseSettings: { other: { agentTeams: false, opusContext1m: true } } };
    const on = makeApp({ syncCaseState: true }, server);
    on.app.saveCaseSettings('demo', { agentTeams: true, opusContext1m: false });
    await new Promise((r) => setTimeout(r, 0));
    expect(on.puts).toEqual([
      {
        caseSettings: {
          other: { agentTeams: false, opusContext1m: true },
          demo: { agentTeams: true, opusContext1m: false },
        },
      },
    ]);
    const ro = makeApp({ syncCaseState: true });
    ro.app._settingsReadOnly = () => true;
    ro.app.saveCaseSettings('demo', { agentTeams: true, opusContext1m: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(ro.puts).toEqual([]);
  });

  it('takes the server copy into local keys only while the server says sync is on', () => {
    const a = makeApp({});
    a.app._applyServerCaseSettings({
      syncCaseState: true,
      caseSettings: { demo: { agentTeams: true, opusContext1m: false } },
    });
    expect(JSON.parse(a.store.get('caseSettings_demo')!)).toEqual({ agentTeams: true, opusContext1m: false });
    const b = makeApp({});
    b.app._applyServerCaseSettings({
      syncCaseState: false,
      caseSettings: { demo: { agentTeams: true, opusContext1m: false } },
    });
    expect(b.store.size).toBe(0);
  });
});
