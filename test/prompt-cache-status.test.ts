/**
 * The Session Options "Prompt cache" readout (`CodemanPromptCache.format`, constants.js):
 * the one sentence that tells the user whether the next turn reads the conversation
 * from cache or re-processes it cold. Loaded the way the other constants.js policies are.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

type Cache = {
  warm: boolean;
  ttl?: string;
  expiresAt?: number;
  recacheTokensIfCold?: number;
  hitRatio?: number;
  lastMissCauses?: string[];
  compactedAt?: number;
};
type KeepWarm = {
  enabled: boolean;
  idleCompactionOff?: boolean;
  state: string;
  nextCheckAt?: number;
  reason?: string;
  nudges: number;
  lastNudgeAt?: number;
  budgetEndsAt?: number;
};
type Api = {
  format: (c: Cache | null | undefined, now: number, statusLine?: string) => string;
  formatKeepWarm: (s: KeepWarm | null | undefined, now: number, statusLine?: string) => string;
  keepWarmUnavailable: (statusLine?: string) => boolean;
};

function loadApi(): Api {
  const context = vm.createContext({ window: {}, globalThis: {} });
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'constants.js' });
  return (context.window as { CodemanPromptCache: Api }).CodemanPromptCache;
}
const loadFormat = () => loadApi().format;

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const NOW = Date.UTC(2026, 9, 6, 22, 18, 0);

describe('Prompt cache readout', () => {
  it('says so when Claude has not reported the cache yet (older CLI or no response yet)', () => {
    const format = loadFormat();
    expect(format(null, NOW)).toMatch(/^Not reported yet/);
    expect(format(undefined, NOW)).toMatch(/^Not reported yet/);
  });

  it('says why when the launch carries no statusLine exporter, whatever report is stored', () => {
    const format = loadFormat();
    expect(format(null, NOW, 'collection-off')).toMatch(/^Not collected: Plan Usage was off when this session started/);
    // Collection is decided at launch, so the fix is a new session, and the readout says where the switch is.
    expect(format(null, NOW, 'collection-off')).toContain('App Settings → Header & Panels, then start a new session');
    expect(format({ warm: true, expiresAt: NOW + 60_000 }, NOW, 'collection-off')).toMatch(/^Not collected/);
    expect(format(null, NOW, 'workspace-statusline')).toMatch(/settings\.local\.json sets its own statusLine/);
    expect(format(null, NOW, 'remote')).toBe('Not collected for remote and Docker sessions.');
    expect(format(null, NOW, 'injected')).toMatch(/^Not reported yet/);
  });

  it('warm: a clock time, the lifetime and the tokens at stake', () => {
    const format = loadFormat();
    const expiresAt = NOW + 42 * 60_000;
    expect(format({ warm: true, ttl: '1h', expiresAt, recacheTokensIfCold: 109833 }, NOW)).toBe(
      `Warm until ${clock(expiresAt)} (1h cache). About 110k tokens would be re-cached if it goes cold.`
    );
    expect(format({ warm: true, expiresAt }, NOW)).toBe(`Warm until ${clock(expiresAt)}.`);
  });

  it('cold once reported cold, past the expiry, or warm with no expiry to promise', () => {
    const format = loadFormat();
    expect(format({ warm: false, recacheTokensIfCold: 89882 }, NOW)).toBe(
      'Cold. The next turn re-caches about 90k tokens.'
    );
    expect(format({ warm: true, expiresAt: NOW - 1, recacheTokensIfCold: 500 }, NOW)).toBe(
      'Cold. The next turn re-caches about 500 tokens.'
    );
    expect(format({ warm: true }, NOW)).toBe('Cold.');
    expect(format({ warm: false }, NOW)).toBe('Cold.');
  });

  it('appends the hit rate and the last miss cause when Claude reports them', () => {
    const format = loadFormat();
    const expiresAt = NOW + 42 * 60_000;
    expect(format({ warm: true, ttl: '1h', expiresAt, recacheTokensIfCold: 50000, hitRatio: 0.91 }, NOW)).toBe(
      `Warm until ${clock(expiresAt)} (1h cache). About 50k tokens would be re-cached if it goes cold. 91% cache hit rate.`
    );
    expect(
      format({ warm: false, recacheTokensIfCold: 90000, hitRatio: 0.6, lastMissCauses: ['ttl_expired_1h'] }, NOW)
    ).toBe('Cold. The next turn re-caches about 90k tokens. 60% cache hit rate. Last miss: ttl_expired_1h.');
  });

  it('names a compaction, with no re-cache stake while the prefix is still warm', () => {
    const format = loadFormat();
    const expiresAt = NOW + 42 * 60_000;
    const compactedAt = NOW - 6 * 60_000;
    // recacheTokensIfCold is null right after a compaction, so no "would be re-cached" clause.
    expect(format({ warm: true, ttl: '1h', expiresAt, compactedAt, hitRatio: 0.88 }, NOW)).toBe(
      `Warm until ${clock(expiresAt)} (1h cache). Context compacted at ${clock(compactedAt)}. 88% cache hit rate.`
    );
  });
});

describe('Keep-warm line on the Status row', () => {
  const T = NOW + 55 * 60_000;
  const END = NOW + 2 * 3_600_000;

  it('says nothing until the service has published, or while switched off', () => {
    const { formatKeepWarm } = loadApi();
    expect(formatKeepWarm(null, NOW, 'injected')).toBe('');
    expect(formatKeepWarm({ enabled: false, state: 'off', nudges: 0 }, NOW, 'injected')).toBe('');
    expect(formatKeepWarm({ enabled: false, state: 'off', reason: 'off', nudges: 0 }, NOW, 'injected')).toBe('');
  });

  it('armed: the due time and when the window closes', () => {
    const { formatKeepWarm } = loadApi();
    expect(formatKeepWarm({ enabled: true, state: 'armed', nextCheckAt: T, nudges: 0, budgetEndsAt: END }, NOW)).toBe(
      `Keep-alive: next ${clock(T)} · stops ${clock(END)}`
    );
    expect(
      formatKeepWarm({ enabled: true, state: 'armed', nextCheckAt: T, nudges: 3, budgetEndsAt: NOW - 1 }, NOW)
    ).toBe(`Keep-alive: next ${clock(T)} · window closed`);
  });

  it('waiting and sent carry the reason and the count', () => {
    const { formatKeepWarm } = loadApi();
    expect(
      formatKeepWarm(
        {
          enabled: true,
          state: 'waiting',
          reason: 'the composer holds text',
          nextCheckAt: T,
          nudges: 1,
          budgetEndsAt: END,
        },
        NOW
      )
    ).toBe(`Keep-alive: waiting · the composer holds text · retry ${clock(T)} · stops ${clock(END)}`);
    expect(formatKeepWarm({ enabled: true, state: 'nudged', lastNudgeAt: T, nudges: 2, budgetEndsAt: END }, NOW)).toBe(
      `Keep-alive: sent ${clock(T)} (2×) · stops ${clock(END)}`
    );
  });

  it('stopped, or off for a reason, names it', () => {
    const { formatKeepWarm } = loadApi();
    expect(formatKeepWarm({ enabled: true, state: 'stopped', reason: 'cache is cold', nudges: 0 }, NOW)).toBe(
      'Keep-alive: stopped · cache is cold'
    );
    expect(
      formatKeepWarm({ enabled: false, state: 'off', reason: 'an agent-spawned session ...', nudges: 0 }, NOW)
    ).toBe('Keep-alive: off · an agent-spawned session ...');
  });

  it("adds nothing on a launch without the exporter: the readout's Not collected sentence already says why", () => {
    const { formatKeepWarm } = loadApi();
    const stopped = { enabled: true, state: 'stopped', reason: 'no cache reports on this launch', nudges: 0 };
    for (const statusLine of ['collection-off', 'workspace-statusline', 'remote']) {
      expect(formatKeepWarm(stopped, NOW, statusLine)).toBe('');
    }
  });

  it('says idle compaction stays on when the opt-out was not on this launch', () => {
    const { formatKeepWarm } = loadApi();
    const armed = { enabled: true, state: 'armed', nextCheckAt: T, nudges: 0 };
    expect(formatKeepWarm({ ...armed, idleCompactionOff: true }, NOW, 'injected')).toBe(`Keep-alive: next ${clock(T)}`);
    expect(formatKeepWarm({ ...armed, idleCompactionOff: false }, NOW, 'injected')).toBe(
      `Keep-alive: next ${clock(T)} · idle compaction on until relaunch`
    );
  });

  it('says idle compaction stays off when keep-warm was switched off on a launch that carries the opt-out', () => {
    const { formatKeepWarm } = loadApi();
    const off = { enabled: false, state: 'off', reason: 'off', nudges: 0 };
    expect(formatKeepWarm({ ...off, idleCompactionOff: false }, NOW, 'injected')).toBe('');
    expect(formatKeepWarm({ ...off, idleCompactionOff: true }, NOW, 'injected')).toBe(
      'Keep-alive: off · idle compaction off until relaunch'
    );
  });
});

/**
 * session-ui.js `updateKeepWarmStatus`, run as shipped against a minimal DOM: the keep-warm line
 * on the Status row is hidden when it has nothing to say, and a launch without cache reports
 * greys the switch's row and refuses to switch it on, never to switch it off.
 */
describe('Keep-warm switch and its Status line', () => {
  /** One Session Options modal: the same elements across every session it is opened on. */
  function makeModal() {
    const ui = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
    const start = ui.indexOf('  updateKeepWarmStatus(sessionId) {');
    expect(start).toBeGreaterThan(-1);
    const update = new Function(
      'document',
      'window',
      'sessionId',
      ui.slice(ui.indexOf('{', start) + 1, ui.indexOf('\n  },\n', start))
    );
    const rowClasses = new Set<string>();
    const line = { textContent: '', hidden: true };
    const row = {
      classList: { toggle: (c: string, on: boolean) => void (on ? rowClasses.add(c) : rowClasses.delete(c)) },
    };
    const box = { checked: false, disabled: false, closest: () => row };
    const elements: Record<string, unknown> = { keepWarmStatus: line, modalKeepWarmEnabled: box };
    const document = { getElementById: (id: string) => elements[id] ?? null };
    const window = { CodemanPromptCache: loadApi() };
    return (statusLine: string, keepWarm: KeepWarm | undefined, checked: boolean) => {
      box.checked = checked;
      const self = {
        editingSessionId: 's1',
        sessions: new Map([['s1', { statusLineExporter: statusLine, keepWarm }]]),
      };
      update.call(self, document, window, 's1');
      return { line: { ...line }, greyed: rowClasses.has('set-row-disabled'), box: { ...box } };
    };
  }
  const render = (statusLine: string, keepWarm: KeepWarm | undefined, checked: boolean) =>
    makeModal()(statusLine, keepWarm, checked);

  it('shows the line whenever it has words, any state, and hides it otherwise', () => {
    const waiting = render(
      'injected',
      { enabled: true, state: 'waiting', reason: 'the composer holds text', nudges: 0 },
      true
    );
    expect(waiting.line.textContent).toContain('Keep-alive: waiting');
    expect(waiting.line.hidden).toBe(false);
    expect(waiting.greyed).toBe(false);
    expect(waiting.box.disabled).toBe(false);
    expect(render('injected', { enabled: false, state: 'off', nudges: 0 }, false).line.hidden).toBe(true);
  });

  it('greys a launch without cache reports, but lets a switch that is on be turned off', () => {
    const off = render('collection-off', { enabled: false, state: 'off', nudges: 0 }, false);
    expect(off.line.hidden).toBe(true);
    expect(off.greyed).toBe(true);
    expect(off.box.disabled).toBe(true);
    const on = render('collection-off', { enabled: true, state: 'stopped', nudges: 0 }, true);
    expect(on.greyed).toBe(true);
    expect(on.box.disabled).toBe(false);
  });

  it('undoes what the previous session left on the same modal', () => {
    const show = makeModal();
    expect(show('collection-off', { enabled: false, state: 'off', nudges: 0 }, false).box.disabled).toBe(true);
    const next = show('injected', { enabled: false, state: 'off', nudges: 0 }, false);
    expect(next.box.disabled).toBe(false);
    expect(next.greyed).toBe(false);
    expect(show('injected', { enabled: true, state: 'armed', nextCheckAt: NOW, nudges: 0 }, true).line.hidden).toBe(
      false
    );
    const off = show('injected', { enabled: false, state: 'off', nudges: 0 }, false);
    expect(off.line.hidden).toBe(true);
    expect(off.line.textContent).toBe('');
  });
});
