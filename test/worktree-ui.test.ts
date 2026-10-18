/**
 * @fileoverview The git worktree launch wiring in session-ui.js, in a vm sandbox (no real DOM),
 * the way test/run-mode-ui.test.ts drives the run*() methods:
 *
 * - `managedWorktreeOfDir()` names only `<local case path>/.claude/worktrees/<valid-name>`;
 * - a worktree launch goes through the EXISTING create paths with the worktree's folder:
 *   POST /api/sessions with `workingDir` for claude and shell, quick-start with `worktree` for
 *   every other CLI; never a case lookup or scaffold, and tabs named after the worktree;
 * - `_launchInWorktree()` swaps the run mode for the one launch and puts it back.
 *
 * Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

const SESSION_UI = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');

const WT = { caseName: 'myrepo', name: 'fix-login', path: '/cases/myrepo/.claude/worktrees/fix-login' };

function load(fetchImpl: (url: string, init?: { method?: string; body?: string }) => Promise<unknown>) {
  const elements: Record<string, any> = {
    // The toolbar still points at ANOTHER case: a worktree launch must not read it.
    quickStartCase: { value: 'other-case' },
    tabCount: { value: '3' },
  };
  const requests: Array<{ url: string; method?: string; body?: any }> = [];
  const CodemanApp = function CodemanApp(this: any) {};
  const context = vm.createContext({
    CodemanApp,
    localStorage: { getItem: () => null, setItem: () => {} },
    document: { getElementById: (id: string) => elements[id] ?? null },
    fetch: async (url: string, init?: { method?: string; body?: string }) => {
      requests.push({ url, method: init?.method, body: init?.body ? JSON.parse(init.body) : undefined });
      return fetchImpl(url, init);
    },
    console,
    setTimeout,
  });
  vm.runInContext(SESSION_UI, context, { filename: 'session-ui.js' });
  const app = new (CodemanApp as any)();
  app.terminal = { clear: () => {}, writeln: () => {}, focus: () => {} };
  app.sessions = new Map();
  app.cases = [
    { name: 'myrepo', path: '/cases/myrepo', location: 'local' },
    { name: 'dock', path: '/cases/dock', location: 'docker' },
  ];
  app.getCaseSettings = () => ({});
  app.loadAppSettingsFromStorage = () => ({});
  app.buildEnvOverrides = () => ({});
  app.getEffortSetting = () => undefined;
  app.getAdvisorSetting = () => undefined;
  app.isRalphTrackerEnabledByDefault = () => false;
  app.getTerminalDimensions = () => null;
  app.loadQuickStartCases = () => {};
  app.isCliAvailable = () => true;
  app._ensureCreatedSessionVisible = async () => {};
  app.selectSession = vi.fn(async () => {});
  return { app, context, requests };
}

const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data });

describe('managedWorktreeOfDir', () => {
  const { context } = load(async () => json({}));
  const fn = (context as unknown as { managedWorktreeOfDir: (d: unknown, c: unknown) => unknown }).managedWorktreeOfDir;
  const cases = [
    { name: 'myrepo', path: '/cases/myrepo', location: 'local' },
    { name: 'linked', path: '/srv/linked', location: 'linked-local' },
    { name: 'dock', path: '/cases/dock', location: 'docker' },
  ];

  it('names a worktree folder of a local or linked case', () => {
    expect(fn('/cases/myrepo/.claude/worktrees/fix-login', cases)).toEqual(WT);
    expect(fn('/srv/linked/.claude/worktrees/a.b_c/', cases)).toEqual({
      caseName: 'linked',
      name: 'a.b_c',
      path: '/srv/linked/.claude/worktrees/a.b_c',
    });
  });

  it('ignores the case folder, a subfolder, unknown or Docker cases and invalid names', () => {
    expect(fn('/cases/myrepo', cases)).toBeNull();
    expect(fn('/cases/myrepo/.claude/worktrees/fix-login/src', cases)).toBeNull();
    expect(fn('/elsewhere/.claude/worktrees/x', cases)).toBeNull();
    expect(fn('/cases/dock/.claude/worktrees/x', cases)).toBeNull();
    expect(fn('/cases/myrepo/.claude/worktrees/-x', cases)).toBeNull();
    expect(fn('/cases/myrepo/.claude/worktrees/a..b', cases)).toBeNull();
    expect(fn(undefined, cases)).toBeNull();
  });
});

describe('launching in a worktree', () => {
  it('claude: POST /api/sessions in the worktree folder, one tab named after the worktree', async () => {
    const { app, requests } = load(async (url) => {
      if (url === '/api/sessions') return json({ success: true, data: { session: { id: 's-1' } } });
      return json({ success: true });
    });
    await app.runClaude({ count: 1, worktree: WT });
    const create = requests.filter((r) => r.url === '/api/sessions');
    expect(create).toHaveLength(1);
    expect(create[0].body).toMatchObject({ workingDir: WT.path, name: 'w1-fix-login' });
    expect(requests.some((r) => r.url.startsWith('/api/cases'))).toBe(false);
    expect(requests.some((r) => r.url === '/api/sessions/s-1/interactive')).toBe(true);
    expect(app.selectSession).toHaveBeenCalledWith('s-1');
  });

  it('shell: POST /api/sessions in the worktree folder, no case lookup', async () => {
    const { app, requests } = load(async (url) => {
      if (url === '/api/sessions') return json({ success: true, data: { session: { id: 's-2' } } });
      return json({ success: true });
    });
    await app.runShell({ count: 1, worktree: WT });
    expect(requests.find((r) => r.url === '/api/sessions')?.body).toMatchObject({
      workingDir: WT.path,
      mode: 'shell',
      name: 's1-fix-login',
    });
    expect(requests.some((r) => r.url.startsWith('/api/cases'))).toBe(false);
  });

  it('other CLIs: quick-start with the case and the worktree name', async () => {
    const { app, requests } = load(async (url) => {
      if (url === '/api/codex/status') return json({ success: true, data: { available: true } });
      if (url === '/api/quick-start') return json({ success: true, data: { sessionId: 's-3' } });
      return json({ success: true });
    });
    await app._runCliMode('codex', { count: 1, worktree: WT });
    const qs = requests.filter((r) => r.url === '/api/quick-start');
    expect(qs).toHaveLength(1);
    expect(qs[0].body).toMatchObject({
      caseName: 'myrepo',
      mode: 'codex',
      worktree: 'fix-login',
      sessionName: 'w1-fix-login',
    });
  });

  it('_launchInWorktree runs ONE session of the chosen mode and restores the Run button mode', async () => {
    const { app } = load(async () => json({}));
    app._runMode = 'claude';
    const seen: Array<{ mode: string; options: unknown }> = [];
    app.run = vi.fn(async (options: unknown) => {
      seen.push({ mode: app._runMode, options });
    });
    await app._launchInWorktree(WT, 'codex');
    expect(seen).toEqual([{ mode: 'codex', options: { count: 1, worktree: WT } }]);
    expect(app._runMode).toBe('claude');
  });

  it('a worktree whose folder is gone offers Remove but not Open, with a note saying what Remove does', () => {
    const dom = new JSDOM('<!doctype html><body></body>');
    const CodemanApp = function CodemanApp(this: any) {};
    const context = vm.createContext({
      CodemanApp,
      localStorage: { getItem: () => null, setItem: () => {} },
      document: dom.window.document,
      console,
      setTimeout,
    });
    vm.runInContext(SESSION_UI, context, { filename: 'session-ui.js' });
    const app = new (CodemanApp as any)();
    app._shortenHomePath = (p: string) => p;
    const row = (wt: Record<string, unknown>) =>
      app._buildWorktreeRow({ branch: 'worktree-x', path: '/r/.claude/worktrees/x', name: 'x', ...wt });
    const buttons = (el: HTMLElement) => [...el.querySelectorAll('button')].map((b) => b.textContent);

    expect(buttons(row({ managed: true, prunable: false }))).toEqual(['Open', 'Remove…']);
    expect(buttons(row({ managed: true, prunable: true }))).toEqual(['Remove…']);
    expect(buttons(row({ managed: false, prunable: true }))).toEqual([]);

    app._worktreeRemoveConfirm = 'x';
    const missingNote = row({ managed: true, prunable: true }).querySelector('.worktree-remove-note')!.textContent;
    expect(missingNote).toContain('folder is gone');
    const liveNote = row({ managed: true, prunable: false }).querySelector('.worktree-remove-note')!.textContent;
    expect(liveNote).toContain('never forces');
    dom.window.close();
  });

  it('closing offers worktree removal only for a session in a managed worktree', () => {
    const { app } = load(async () => json({}));
    expect(app._managedWorktreeOfSession({ workingDir: WT.path })).toEqual(WT);
    expect(app._managedWorktreeOfSession({ workingDir: '/cases/myrepo' })).toBeNull();
    expect(app._managedWorktreeOfSession({ workingDir: WT.path, remote: { hostId: 'x' } })).toBeNull();
  });
});
