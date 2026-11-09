/**
 * @fileoverview Opt-in case sync, client side: the schema accepts the setting and a per-case map, and the
 * session-ui helpers only touch the server when the setting is on, send one case at a time, report a failed
 * save, and obey the server's answer about whether sync is on. Evaluates the real session-ui.js.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { SettingsUpdateSchema } from '../src/web/schemas.js';

const SRC = readFileSync(new URL('../src/web/public/session-ui.js', import.meta.url), 'utf-8');
// The real write-result handling the case sync reuses (a toast for a failed save, read-only after a 403).
const SETTINGS_SRC = readFileSync(new URL('../src/web/public/settings-ui.js', import.meta.url), 'utf-8');

type Reply = { status?: number; body?: unknown } | 'throw';
type Handler = (url: string, init?: { method?: string; body?: string }) => Reply | Promise<Reply>;

function makeApp(settings: Record<string, unknown>, onFetch: Handler = () => ({ body: { success: true, data: {} } })) {
  const store = new Map<string, string>();
  const calls: { method: string; body: unknown }[] = [];
  const toasts: string[] = [];
  const select = { value: 'alpha' };
  const hidden = new Set<string>();
  const popover = (id: string) => ({ classList: { add: (c: string) => c === 'hidden' && void hidden.add(id) } });
  function CodemanApp(this: unknown) {}
  const ctx = vm.createContext({
    CodemanApp,
    window: {},
    document: {
      getElementById: (id: string) => (id.startsWith('caseSettingsPopover') ? popover(id) : select),
      addEventListener: () => {},
    },
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
    fetch: async (url: string, init?: { method?: string; body?: string }) => {
      calls.push({ method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined });
      const r = await onFetch(url, init);
      if (r === 'throw') throw new Error('offline');
      const status = r.status ?? 200;
      const res = { ok: status < 400, status, json: async () => r.body ?? {}, clone: () => res };
      return res;
    },
    console,
  });
  vm.runInContext(SRC, ctx);
  vm.runInContext(SETTINGS_SRC, ctx);
  const app = Object.create((CodemanApp as unknown as { prototype: object }).prototype) as Record<string, any>;
  app.loadAppSettingsFromStorage = () => settings;
  app.saveAppSettingsToStorage = (s: Record<string, unknown>) => Object.assign(settings, s);
  app.showToast = (m: string) => void toasts.push(m);
  app.cases = [{ name: 'alpha' }, { name: 'beta' }];
  app.updateDirDisplayForCase = () => {};
  app.updateMobileCaseLabel = () => {};
  app.updateCasePickerInput = () => {};
  app.closeCasePicker = () => {};
  return { app, store, calls, toasts, select, settings, hidden };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const entry = { agentTeams: true, opusContext1m: false };

describe('syncCaseState schema', () => {
  it('accepts the setting with a per-case map, and rejects junk', () => {
    expect(SettingsUpdateSchema.safeParse({ syncCaseState: true, caseSettings: { demo: entry } }).success).toBe(true);
    expect(SettingsUpdateSchema.safeParse({ caseSettings: { demo: { agentTeams: 'yes' } } }).success).toBe(false);
    expect(
      SettingsUpdateSchema.safeParse({ caseSettings: { demo: { agentTeams: true, opusContext1m: true, x: 1 } } })
        .success
    ).toBe(false);
  });
});

describe('saving a case', () => {
  it('stays on this browser while the setting is off', async () => {
    const { app, store, calls } = makeApp({});
    app.saveCaseSettings('demo', entry);
    await settle();
    expect(store.get('caseSettings_demo')).toContain('agentTeams');
    expect(calls).toEqual([]);
  });

  it('sends only that case (no read of the server map first), and nothing when read-only', async () => {
    const on = makeApp({ syncCaseState: true });
    on.app.saveCaseSettings('demo', entry);
    await settle();
    expect(on.calls).toEqual([{ method: 'PUT', body: { caseSettings: { demo: entry } } }]);
    const ro = makeApp({ syncCaseState: true });
    ro.app._settingsReadOnly = () => true;
    ro.app.saveCaseSettings('demo', entry);
    await settle();
    expect(ro.calls).toEqual([]);
  });

  it('sends rapid saves one after another, in the order they were made', async () => {
    let release!: () => void;
    const first = new Promise<void>((r) => (release = r));
    let n = 0;
    const { app, calls } = makeApp({ syncCaseState: true }, async () => {
      if (++n === 1) await first;
      return { body: { success: true, data: {} } };
    });
    app.saveCaseSettings('demo', { agentTeams: true, opusContext1m: true });
    app.saveCaseSettings('demo', { agentTeams: false, opusContext1m: false });
    await settle();
    expect(calls).toHaveLength(1); // the second waits for the first
    release();
    await app._caseSyncChain;
    expect(calls.map((c) => (c.body as any).caseSettings.demo.agentTeams)).toEqual([true, false]);
  });

  it.each([
    ['an HTTP 500', { status: 500, body: { success: false, error: 'boom' } }],
    ['a dropped connection', 'throw' as const],
  ])('keeps the local choice and says it was not synced after %s', async (_label, reply) => {
    const { app, store, toasts } = makeApp({ syncCaseState: true }, () => reply as Reply);
    app.saveCaseSettings('demo', entry);
    await app._caseSyncChain;
    expect(JSON.parse(store.get('caseSettings_demo')!)).toEqual(entry);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toContain('not on the server');
    expect(toasts[0]).toContain('until the next sync');
  });

  it('hands an admin-only refusal to the read-only handling, without a toast', async () => {
    const forbidden = { status: 403, body: { success: false, errorCode: 'FORBIDDEN' } };
    const { app, toasts } = makeApp({ syncCaseState: true }, () => forbidden);
    app._noteSettingsWriteRefusal = async (res: { status: number }) => {
      if (res.status !== 403) return false;
      app._settingsWriteForbidden = true;
      return true;
    };
    app._settingsReadOnly = () => app._settingsWriteForbidden === true;
    app.saveCaseSettings('demo', entry);
    await app._caseSyncChain;
    expect(toasts).toEqual([]);
    expect(app._caseStateSyncOn()).toBe(false); // nothing more is sent from this page
  });
});

describe('recording the picked case', () => {
  it('writes lastPickedCase with lastUsedCase only while sync is on', async () => {
    const on = makeApp({ syncCaseState: true });
    await on.app.saveLastUsedCase('beta');
    expect(on.calls[0].body).toEqual({ lastUsedCase: 'beta', lastPickedCase: 'beta' });
    const off = makeApp({});
    await off.app.saveLastUsedCase('beta');
    expect(off.calls[0].body).toEqual({ lastUsedCase: 'beta' });
  });
});

describe('a pick that did not reach the server', () => {
  it('is not undone by the next tab return, and following resumes once a pick is stored', async () => {
    let putOk = false;
    const { app, select } = makeApp({ syncCaseState: true }, (_url, init) =>
      init?.method === 'PUT'
        ? putOk
          ? { body: { success: true } }
          : { status: 500, body: { error: 'x' } }
        : { body: { success: true, data: { syncCaseState: true, lastPickedCase: 'alpha' } } }
    );
    select.value = 'beta';
    await app.saveLastUsedCase('beta'); // the pick fails
    await app._syncCaseStateFromServer(); // the server still says alpha
    expect(select.value).toBe('beta');
    putOk = true;
    await app.saveLastUsedCase('beta');
    await app._syncCaseStateFromServer();
    expect(select.value).toBe('alpha');
  });

  it('lands before the copy a tab return reads', async () => {
    const order: string[] = [];
    const { app } = makeApp({ syncCaseState: true }, async (_url, init) => {
      order.push(init?.method ?? 'GET');
      return { body: { success: true, data: { syncCaseState: true } } };
    });
    void app.saveLastUsedCase('beta');
    await app._syncCaseStateFromServer();
    expect(order).toEqual(['PUT', 'GET']);
  });
});

describe('taking the server copy', () => {
  const server = { syncCaseState: true, caseSettings: { demo: entry } };

  it('writes the options into the local keys only while the server says sync is on', () => {
    const a = makeApp({});
    a.app._applyServerCaseSettings(server);
    expect(JSON.parse(a.store.get('caseSettings_demo')!)).toEqual(entry);
    const b = makeApp({});
    b.app._applyServerCaseSettings({ ...server, syncCaseState: false });
    expect(b.store.size).toBe(0);
  });

  it('never applies a map to a read-only identity, even one the server handed over', () => {
    const { app, store } = makeApp({ syncCaseState: true });
    app._settingsReadOnly = () => true;
    app._applyServerCaseSettings(server);
    expect(store.size).toBe(0);
  });

  it('leaves a case alone while this device is still saving it', async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const { app, store } = makeApp({ syncCaseState: true }, async () => {
      await hold;
      return { body: { success: true, data: {} } };
    });
    app.saveCaseSettings('demo', { agentTeams: false, opusContext1m: false });
    app._applyServerCaseSettings({ syncCaseState: true, caseSettings: { demo: entry, other: entry } });
    expect(JSON.parse(store.get('caseSettings_demo')!)).toEqual({ agentTeams: false, opusContext1m: false });
    expect(JSON.parse(store.get('caseSettings_other')!)).toEqual(entry);
    release();
    await app._caseSyncChain;
  });
});

describe('returning to the tab', () => {
  const env = (data: Record<string, unknown>) => ({ body: { success: true, data } });

  it('follows the selected case and the options while sync is on', async () => {
    const { app, select, store } = makeApp({ syncCaseState: true }, () =>
      env({ syncCaseState: true, lastPickedCase: 'beta', caseSettings: { beta: entry } })
    );
    await app._syncCaseStateFromServer();
    expect(select.value).toBe('beta');
    expect(JSON.parse(store.get('caseSettings_beta')!)).toEqual(entry);
  });

  it('stops following when another device turned sync off, and the cached switch follows the server', async () => {
    const { app, select, store, settings } = makeApp({ syncCaseState: true }, () =>
      env({ syncCaseState: false, lastPickedCase: 'beta', caseSettings: { beta: entry } })
    );
    await app._syncCaseStateFromServer();
    expect(select.value).toBe('alpha');
    expect(store.size).toBe(0);
    expect(settings.syncCaseState).toBe(false);
    expect(app._caseStateSyncOn()).toBe(false);
  });

  it('does not follow a case a quick-start or an agent started, only one picked in a picker', async () => {
    const { app, select } = makeApp({ syncCaseState: true }, () =>
      env({ syncCaseState: true, lastUsedCase: 'beta', lastPickedCase: 'alpha' })
    );
    await app._syncCaseStateFromServer();
    expect(select.value).toBe('alpha');
  });

  it('closes an open case-options popover when the follow or an import changes what it shows', async () => {
    const followed = makeApp({ syncCaseState: true }, () => env({ syncCaseState: true, lastPickedCase: 'beta' }));
    await followed.app._syncCaseStateFromServer();
    expect([...followed.hidden].sort()).toEqual(['caseSettingsPopover', 'caseSettingsPopoverMobile']);
    const imported = makeApp({ syncCaseState: true }, () =>
      env({ syncCaseState: true, caseSettings: { alpha: entry } })
    );
    await imported.app._syncCaseStateFromServer();
    expect(imported.hidden.size).toBe(2);
    const unchanged = makeApp({ syncCaseState: true }, () => env({ syncCaseState: true, lastPickedCase: 'alpha' }));
    await unchanged.app._syncCaseStateFromServer();
    expect(unchanged.hidden.size).toBe(0);
  });

  it('does not undo a pick or a case save made while its read was out', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { app, select, store } = makeApp({ syncCaseState: true }, async (_url, init) => {
      if (init?.method === 'PUT') return { body: { success: true, data: {} } };
      await gate; // the server read this copy before the pick and the save below reached it
      return env({
        syncCaseState: true,
        lastPickedCase: 'alpha',
        caseSettings: { beta: { agentTeams: false, opusContext1m: true } },
      });
    });
    const refresh = app._syncCaseStateFromServer();
    await settle();
    select.value = 'beta';
    await app.saveLastUsedCase('beta');
    app.saveCaseSettings('beta', entry);
    await app._caseSyncChain;
    release();
    await refresh;
    expect(select.value).toBe('beta');
    expect(JSON.parse(store.get('caseSettings_beta')!)).toEqual(entry);
  });

  it('asks for nothing on a tab return while this device has sync off', async () => {
    const { app, select, calls } = makeApp({}, () => env({ syncCaseState: true, lastUsedCase: 'beta' }));
    await app._syncCaseStateFromServer();
    expect(calls).toEqual([]);
    expect(select.value).toBe('alpha');
  });

  it('does nothing for a read-only identity', async () => {
    const { app, calls } = makeApp({ syncCaseState: true });
    app._settingsReadOnly = () => true;
    await app._syncCaseStateFromServer();
    expect(calls).toEqual([]);
  });

  it('keeps what it has when the request fails', async () => {
    const { app, select } = makeApp({ syncCaseState: true }, () => ({ status: 500, body: { error: 'x' } }));
    await app._syncCaseStateFromServer();
    expect(select.value).toBe('alpha');
  });

  it('discards an older refresh that answers after a newer one', async () => {
    const releases: (() => void)[] = [];
    const answers = [
      env({ syncCaseState: true, lastPickedCase: 'beta' }), // the older request
      env({ syncCaseState: true, lastPickedCase: 'alpha' }), // the newer request
    ];
    let i = 0;
    const { app, select } = makeApp({ syncCaseState: true }, async () => {
      const mine = answers[i++];
      await new Promise<void>((r) => releases.push(r));
      return mine;
    });
    const older = app._syncCaseStateFromServer();
    await settle();
    const newer = app._syncCaseStateFromServer();
    await settle();
    releases[1](); // the newer answers first
    await newer;
    releases[0](); // then the older one arrives late
    await older;
    expect(select.value).toBe('alpha');
  });
});
