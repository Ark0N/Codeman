/**
 * @fileoverview Upstream review fix (Ark0N/Codeman#353, PR #3): resumeHistorySession()
 * threads the row's own mode through session creation via a `modeConfigKey` map
 * (opencode/pi/grok/omp → `continueSession: true`), then retires the old row via
 * DELETE. codex/gemini/antigravity were missing from that map, so resuming one of
 * their rows created a session with NO continuation while still deleting the row
 * it came from — data loss dressed as a fix. The correction: only retire the row
 * when the new session actually continues something.
 *
 * Loaded via `vm` against a stub CodemanApp, same harness as resume-name.test.ts.
 * `fetch` is a shared mutable stub so each test can inspect exactly which requests
 * fired without a real network/server.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi, beforeEach } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The fetch the vm's shipping code calls; swapped per test (see beforeEach). */
let currentFetch: (...args: unknown[]) => unknown = () => {
  throw new Error('fetch not stubbed for this test');
};

function loadTerminalUiPrototype(): Record<string, (...args: unknown[]) => unknown> {
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');
  const context = vm.createContext({
    console,
    CodemanApp: class CodemanApp {},
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    setTimeout,
    clearTimeout,
    requestAnimationFrame: vi.fn(),
    document: { addEventListener: vi.fn(), getElementById: vi.fn(() => null) },
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    fetch: (...args: unknown[]) => currentFetch(...args),
  });
  vm.runInContext(`${source}\nglobalThis.__proto = CodemanApp.prototype;`, context);
  return (context as { __proto: Record<string, (...args: unknown[]) => unknown> }).__proto;
}

const proto = loadTerminalUiPrototype();

function makeApp() {
  return {
    terminal: { clear: vi.fn(), writeln: vi.fn(), focus: vi.fn() },
    cases: [],
    resumeHistorySession: proto.resumeHistorySession as (...args: unknown[]) => Promise<void>,
    _closeFolderHistoryModal: vi.fn(),
    _resolveResumeName: () => 'w1-case',
    loadAppSettingsFromStorage: () => ({}),
    getCaseSettings: () => ({}),
    buildEnvOverrides: () => ({}),
    getEffortSetting: () => undefined,
    selectSession: vi.fn(async () => {}),
  };
}

/** DELETE calls the fetch mock recorded. */
function deleteCalls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls
    .filter(([, opts]: [string, { method?: string }]) => opts?.method === 'DELETE')
    .map(([url]: [string]) => url);
}

/** POST /api/sessions body the fetch mock recorded. */
function createBody(fetchMock: ReturnType<typeof vi.fn>): any {
  const call = fetchMock.mock.calls.find(([url]: [string]) => url === '/api/sessions');
  return call ? JSON.parse((call[1] as { body: string }).body) : undefined;
}

function stubFetch(newSessionId: string): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/sessions') {
      return { json: async () => ({ success: true, data: { session: { id: newSessionId } } }) };
    }
    return { json: async () => ({ success: true }) };
  });
  currentFetch = fetchMock;
  return fetchMock;
}

describe('resumeHistorySession: row retirement is gated on actual continuation', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = stubFetch('new-session-id');
  });

  it.each(['gemini', 'antigravity'])(
    'does NOT retire the old row for %s (no continuation is wired for it)',
    async (mode) => {
      const app = makeApp();
      await app.resumeHistorySession.call(app, 'old-id', '/repo', 'w1-repo', mode);

      expect(createBody(fetchMock)).toMatchObject({ mode });
      expect(createBody(fetchMock).codexConfig).toBeUndefined();
      expect(createBody(fetchMock).geminiConfig).toBeUndefined();
      expect(createBody(fetchMock).antigravityConfig).toBeUndefined();
      expect(deleteCalls(fetchMock)).toEqual([]);
    }
  );

  // codex continues only when the row carried its thread id. A row without one
  // is a live session's row, whose sessionId is Codeman's own uuid — sending
  // THAT to `codex resume` asks for a thread that does not exist, so it must
  // stay a fresh session and must not retire the row it came from.
  it('does NOT continue or retire a codex row that carries no resumeId', async () => {
    const app = makeApp();
    await app.resumeHistorySession.call(app, 'codeman-uuid', '/repo', 'w1-repo', 'codex');

    expect(createBody(fetchMock)).toMatchObject({ mode: 'codex' });
    expect(createBody(fetchMock).codexConfig).toBeUndefined();
    expect(deleteCalls(fetchMock)).toEqual([]);
  });

  it('resumes a codex row by the thread id the row carried', async () => {
    const app = makeApp();
    await app.resumeHistorySession.call(
      app,
      '01a060f0-0361-7f91-abde-b283020db0d7',
      '/repo',
      'w1-repo',
      'codex',
      '01a060f0-0361-7f91-abde-b283020db0d7'
    );

    expect(createBody(fetchMock)).toMatchObject({
      mode: 'codex',
      codexConfig: { resumeSessionId: '01a060f0-0361-7f91-abde-b283020db0d7' },
    });
  });

  it('ignores a resumeId on a row that is not codex', async () => {
    const app = makeApp();
    await app.resumeHistorySession.call(app, 'old-id', '/repo', 'w1-repo', 'gemini', 'some-thread-id');

    expect(createBody(fetchMock).codexConfig).toBeUndefined();
    expect(deleteCalls(fetchMock)).toEqual([]);
  });

  it.each([
    ['opencode', 'openCodeConfig'],
    ['pi', 'piConfig'],
    ['grok', 'grokConfig'],
    ['omp', 'ompConfig'],
  ])('retires the old row for %s (continueSession is wired via %s)', async (mode, configKey) => {
    const app = makeApp();
    await app.resumeHistorySession.call(app, 'old-id', '/repo', 'w1-repo', mode);

    expect(createBody(fetchMock)[configKey]).toEqual({ continueSession: true });
    expect(deleteCalls(fetchMock)).toEqual(['/api/sessions/old-id?killMux=true']);
  });

  it('retires the old row for deepseek (resumeSession is wired)', async () => {
    const app = makeApp();
    await app.resumeHistorySession.call(app, 'old-id', '/repo', 'w1-repo', 'deepseek');

    expect(createBody(fetchMock).deepSeekConfig).toEqual({ resumeSession: true });
    expect(deleteCalls(fetchMock)).toEqual(['/api/sessions/old-id?killMux=true']);
  });

  it('never retires a claude row (resumeSessionId is a claudeSessionId, not a Codeman row id)', async () => {
    const app = makeApp();
    await app.resumeHistorySession.call(app, 'claude-uuid', '/repo', 'w1-repo', 'claude');

    expect(createBody(fetchMock)).toMatchObject({ mode: 'claude', resumeSessionId: 'claude-uuid' });
    expect(deleteCalls(fetchMock)).toEqual([]);
  });

  it('never retires when the new session id equals the old one (no-op resume)', async () => {
    fetchMock = stubFetch('same-id');
    const app = makeApp();
    await app.resumeHistorySession.call(app, 'same-id', '/repo', 'w1-repo', 'omp');

    expect(deleteCalls(fetchMock)).toEqual([]);
  });
});
