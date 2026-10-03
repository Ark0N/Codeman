/**
 * @fileoverview Launching a session INTO a tab group (the group menu's "New
 * session"): session-ui.js run paths with `{ count, tabGroupId }`.
 *
 * Pins that the group id rides the create request of every launch path (local
 * /api/sessions, remote/docker and external-CLI /api/quick-start), that the
 * one-session count overrides the toolbar steppers without touching them, that
 * the layout returned by the create response is adopted BEFORE the new tab is
 * drawn (so it is drawn inside its group), and that an ordinary Run sends no
 * group at all.
 *
 * Port: none (vm sandbox, stubbed fetch).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const LAYOUT = { version: 9, updatedAt: '', groups: [{ id: 'g1', name: 'Core', refs: [] }], ungrouped: [] };

function harness(caseData: Record<string, unknown>, extra: { mode?: string } = {}) {
  const elements: Record<string, any> = {
    quickStartCase: { value: 'proj' },
    tabCount: { value: '4' },
    shellCount: { value: '3' },
  };
  const requests: Array<{ url: string; body?: any }> = [];
  const events: string[] = [];
  let counter = 0;
  const CodemanApp = function CodemanApp(this: any) {};
  const context = vm.createContext({
    CodemanApp,
    localStorage: { getItem: () => null, setItem: () => {} },
    document: { getElementById: (id: string) => elements[id] ?? null },
    fetch: async (url: string, init?: { body?: string }) => {
      const body = init?.body ? JSON.parse(init.body) : undefined;
      requests.push({ url, body });
      const json = (value: unknown) => ({ json: async () => value });
      if (url === '/api/cases/proj') return json({ success: true, data: caseData });
      if (url.endsWith('/status')) return json({ success: true, data: { available: true, runnable: true } });
      if (url === '/api/sessions') {
        const id = `sess-${++counter}`;
        return json({
          success: true,
          data: { session: { id, name: body.name }, ...(body.tabGroupId ? { tabLayout: LAYOUT } : {}) },
        });
      }
      if (url === '/api/quick-start') {
        const id = `sess-${++counter}`;
        return json({
          success: true,
          data: { sessionId: id, session: { id }, ...(body.tabGroupId ? { tabLayout: LAYOUT } : {}) },
        });
      }
      return json({ success: true, data: {} });
    },
    console,
  });
  for (const file of ['settings-ui.js', 'session-ui.js']) {
    vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public', file), 'utf8'), context, {
      filename: file,
    });
  }
  const app = new (CodemanApp as any)();
  app._runMinLockMs = 0;
  app._runMode = extra.mode ?? 'claude';
  app.terminal = { clear: () => {}, writeln: () => {}, focus: () => {}, cols: 80, rows: 24 };
  app.sessions = new Map();
  app.cases = [{ name: 'proj', location: caseData.location }];
  app.loadAppSettingsFromStorage = () => ({});
  app.getCaseSettings = () => ({});
  app.buildEnvOverrides = () => ({});
  app.getEffortSetting = () => undefined;
  app.isRalphTrackerEnabledByDefault = () => false;
  app.getTerminalDimensions = () => null;
  app.isCliAvailable = () => true;
  app.loadQuickStartCases = () => {};
  app.selectSession = vi.fn(async () => {});
  app._applyTabLayout = vi.fn(() => events.push('layout'));
  app._onSessionCreated = (session: any) => {
    events.push(`created:${session.id}`);
    app.sessions.set(session.id, session);
  };
  app._renderSessionTabsImmediate = () => events.push('render');
  return { app, elements, requests, events };
}

const creates = (requests: Array<{ url: string; body?: any }>) =>
  requests.filter((req) => req.url === '/api/sessions' || req.url === '/api/quick-start');

describe('launching into a tab group', () => {
  it('local Claude: one session with the group id, and the returned layout adopted before the tab renders', async () => {
    const { app, elements, requests, events } = harness({ name: 'proj', path: '/tmp/proj' });
    await app.run({ count: 1, tabGroupId: 'g1' });
    const made = creates(requests);
    expect(made).toHaveLength(1);
    expect(made[0].url).toBe('/api/sessions');
    expect(made[0].body.tabGroupId).toBe('g1');
    expect(elements.tabCount.value).toBe('4');
    expect(app._applyTabLayout).toHaveBeenCalledWith(LAYOUT);
    expect(events.slice(0, 3)).toEqual(['layout', 'created:sess-1', 'render']);
  });

  it('local Shell honours the same one-session override', async () => {
    const { app, elements, requests } = harness({ name: 'proj', path: '/tmp/proj' }, { mode: 'shell' });
    await app.run({ count: 1, tabGroupId: 'g1' });
    const made = creates(requests);
    expect(made).toHaveLength(1);
    expect(made[0].body).toMatchObject({ mode: 'shell', tabGroupId: 'g1' });
    expect(elements.shellCount.value).toBe('3');
  });

  it.each([
    ['remote Claude', { name: 'proj', path: 'u@h:/w', location: 'remote' }, 'claude'],
    ['remote Shell', { name: 'proj', path: 'u@h:/w', location: 'remote' }, 'shell'],
    ['an external CLI', { name: 'proj', path: '/tmp/proj' }, 'gemini'],
  ])('%s carries the group on its quick-start request', async (_label, caseData, mode) => {
    const { app, requests } = harness(caseData, { mode });
    await app.run({ count: 1, tabGroupId: 'g1' });
    const made = creates(requests);
    expect(made).toHaveLength(1);
    expect(made[0].url).toBe('/api/quick-start');
    expect(made[0].body.tabGroupId).toBe('g1');
    expect(app._applyTabLayout).toHaveBeenCalledWith(LAYOUT);
  });

  it('an ordinary Run sends no group and keeps the stepper count', async () => {
    const { app, requests } = harness({ name: 'proj', path: '/tmp/proj' });
    await app.run();
    const made = creates(requests);
    expect(made).toHaveLength(4);
    expect(made.every((req) => !('tabGroupId' in req.body))).toBe(true);
    expect(app._applyTabLayout).not.toHaveBeenCalled();
  });
});
