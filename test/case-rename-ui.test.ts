/**
 * @fileoverview The Rename button's flow in session-ui.js (renameCase): the prompts, the second confirmation
 * before sessions are stopped, and the follow-up refresh. Evaluates the real file against a stub app.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../src/web/public/session-ui.js', import.meta.url), 'utf-8');

function makeApp(opts: { prompt: string | null; confirms: boolean[]; responses: unknown[]; cases: unknown[] }) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const confirmMessages: string[] = [];
  const toasts: string[] = [];
  const store = new Map<string, string>([['caseSettings_alpha', '{"agentTeams":true}']]);
  const queue = [...opts.responses];
  function CodemanApp(this: unknown) {}
  const ctx = vm.createContext({
    CodemanApp,
    window: {},
    document: { getElementById: () => ({ value: 'alpha' }) },
    prompt: () => opts.prompt,
    confirm: (m: string) => (confirmMessages.push(m), opts.confirms.shift() ?? false),
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    fetch: async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { json: async () => queue.shift() };
    },
    escapeHtml: (s: string) => s,
  });
  vm.runInContext(SRC, ctx);
  const app = Object.create((CodemanApp as unknown as { prototype: object }).prototype) as Record<string, any>;
  const refreshed: unknown[] = [];
  Object.assign(app, {
    cases: opts.cases,
    showToast: (m: string) => void toasts.push(m),
    loadQuickStartCases: async (n: unknown) => void refreshed.push(n),
    renderCaseManageList: () => void refreshed.push('render'),
  });
  return { app, calls, confirmMessages, toasts, store, refreshed };
}

const ok = { success: true, data: {} };

describe('renameCase (case manager)', () => {
  it('renames a local case, moves its run options and reselects it under the new name', async () => {
    const t = makeApp({
      prompt: ' beta ',
      confirms: [],
      responses: [ok],
      cases: [{ name: 'alpha', location: 'local' }],
    });
    await t.app.renameCase('alpha');
    expect(t.calls).toEqual([{ url: '/api/cases/alpha/rename', body: { newName: 'beta' } }]);
    expect(t.store.get('caseSettings_beta')).toBe('{"agentTeams":true}');
    expect(t.store.has('caseSettings_alpha')).toBe(false);
    expect(t.refreshed).toEqual(['beta', 'render']);
  });

  it('does nothing for a cancelled prompt, the same name, or a name that is not allowed', async () => {
    for (const entered of [null, '', 'alpha', 'a b', '../x']) {
      const t = makeApp({ prompt: entered, confirms: [], responses: [], cases: [{ name: 'alpha' }] });
      await t.app.renameCase('alpha');
      expect(t.calls, String(entered)).toEqual([]);
    }
  });

  it('asks a linked case whether to rename the real folder, and sends the answer', async () => {
    const t = makeApp({
      prompt: 'beta',
      confirms: [true],
      responses: [ok],
      cases: [{ name: 'alpha', linked: true, path: '/srv/app' }],
    });
    await t.app.renameCase('alpha');
    expect(t.confirmMessages[0]).toContain('/srv/app');
    expect(t.calls[0].body).toEqual({ newName: 'beta', renameFolder: true });
  });

  it('lists the live sessions and only stops them after a second confirmation', async () => {
    const refusal = {
      success: false,
      error: '1 live session has this folder open.',
      requiresStop: true,
      sessions: [{ id: 's', name: 'w1-alpha' }],
    };
    const t = makeApp({ prompt: 'beta', confirms: [true], responses: [refusal, ok], cases: [{ name: 'alpha' }] });
    await t.app.renameCase('alpha');
    expect(t.confirmMessages[0]).toContain('w1-alpha');
    expect(t.calls.map((c) => c.body)).toEqual([{ newName: 'beta' }, { newName: 'beta', stopSessions: true }]);

    const declined = makeApp({ prompt: 'beta', confirms: [false], responses: [refusal], cases: [{ name: 'alpha' }] });
    await declined.app.renameCase('alpha');
    expect(declined.calls).toHaveLength(1);
    expect(declined.refreshed).toEqual([]);
  });

  it('shows the server’s message when the folder is locked, and leaves the lists alone', async () => {
    const locked = { success: false, error: 'The folder is in use by another program (EBUSY).' };
    const t = makeApp({ prompt: 'beta', confirms: [], responses: [locked], cases: [{ name: 'alpha' }] });
    await t.app.renameCase('alpha');
    expect(t.toasts).toEqual(['The folder is in use by another program (EBUSY).']);
    expect(t.refreshed).toEqual([]);
    expect(t.store.has('caseSettings_alpha')).toBe(true);
  });
});
