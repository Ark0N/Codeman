// Port: none (pure helpers from constants.js in a vm context).
//
// Issue #258: terminal history is split across browser scrollback, the server
// byte buffer and tmux, and the only signal the user got was a grey line written
// INTO the terminal saying "earlier output truncated for performance". That line
// scrolls away with the output it describes, cannot be acted on, and says the
// same thing whether the rest is one click away or gone forever.
//
// computeHistoryTruncationNotice() is the pure core of the replacement banner.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');

function loadHelpers() {
  const context = vm.createContext({ console, window: {}, document: {}, navigator: { userAgent: 'test' } });
  vm.runInContext(
    `${readFileSync(resolve(PUBLIC, 'constants.js'), 'utf8')}
     ;globalThis.__helpers = { formatHistoryBytes, computeHistoryTruncationNotice };`,
    context,
    { filename: 'constants.js' }
  );
  return (context as any).__helpers as {
    formatHistoryBytes: (n: number) => string;
    computeHistoryTruncationNotice: (s: Record<string, unknown>) => {
      visible: boolean;
      message: string;
      canLoadMore: boolean;
    };
  };
}

describe('formatHistoryBytes', () => {
  const { formatHistoryBytes } = loadHelpers();

  it('reports sub-KB amounts as a range, not a byte count', () => {
    expect(formatHistoryBytes(400)).toBe('less than 1 KB');
    expect(formatHistoryBytes(0)).toBe('less than 1 KB');
  });

  it('scales to KB and MB', () => {
    expect(formatHistoryBytes(2048)).toBe('2 KB');
    expect(formatHistoryBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });

  it('survives junk input rather than printing NaN into the UI', () => {
    expect(formatHistoryBytes(-5)).toBe('less than 1 KB');
    expect(formatHistoryBytes(NaN as unknown as number)).toBe('less than 1 KB');
    expect(formatHistoryBytes(undefined as unknown as number)).toBe('less than 1 KB');
  });
});

describe('computeHistoryTruncationNotice (issue #258)', () => {
  const { computeHistoryTruncationNotice } = loadHelpers();

  it('stays hidden when the replay was complete', () => {
    const notice = computeHistoryTruncationNotice({ truncated: false, fullSize: 100, retainedBytes: 100 });
    expect(notice.visible).toBe(false);
    expect(notice.canLoadMore).toBe(false);
  });

  it('offers to load more after an intentional tail replay', () => {
    const notice = computeHistoryTruncationNotice({
      truncated: true,
      reason: 'tail',
      source: 'history',
      fullSize: 5 * 1024 * 1024,
      retainedBytes: 1024 * 1024,
    });
    expect(notice.visible).toBe(true);
    expect(notice.canLoadMore).toBe(true);
    expect(notice.message).toContain('1.0 MB');
    expect(notice.message).toContain('more may still be retained');
  });

  it('promises nothing more once the FULL capture itself hit the ceiling', () => {
    // This is the case the old boolean could not express: a full-history pull
    // that was still capped means tmux has already given everything it has.
    const notice = computeHistoryTruncationNotice({
      truncated: true,
      reason: 'capped',
      source: 'mux-full-history',
      fullSize: 40 * 1024 * 1024,
      retainedBytes: 2 * 1024 * 1024,
    });
    expect(notice.visible).toBe(true);
    expect(notice.canLoadMore).toBe(false);
    expect(notice.message).toContain('cannot be recovered');
  });

  it('reports exhaustion when a full pull was refused as a downgrade', () => {
    // _replayWouldShrinkBuffer refused: the browser holds MORE than tmux can
    // return (a repaint-mode pane keeps no history), so offering "load more"
    // would be offering to destroy history.
    const notice = computeHistoryTruncationNotice({
      truncated: true,
      reason: 'tail',
      source: 'history',
      fullSize: 900000,
      retainedBytes: 500000,
      exhausted: true,
    });
    expect(notice.visible).toBe(true);
    expect(notice.canLoadMore).toBe(false);
    expect(notice.message).toContain('no longer kept');
  });

  it('lets exhaustion outrank a would-be recoverable state', () => {
    const recoverable = { truncated: true, reason: 'tail', source: 'history', fullSize: 900, retainedBytes: 100 };
    expect(computeHistoryTruncationNotice(recoverable).canLoadMore).toBe(true);
    expect(computeHistoryTruncationNotice({ ...recoverable, exhausted: true }).canLoadMore).toBe(false);
  });
});

describe('the in-terminal truncation line is gone (static guard)', () => {
  it('no longer writes the notice into terminal output', () => {
    const app = readFileSync(resolve(PUBLIC, 'app.js'), 'utf8');
    // The whole point of #258 is that this notice is no longer part of the
    // scrollback it describes.
    expect(app).not.toContain('earlier output truncated for performance');
  });

  it('loads a bounded shell tail first and keeps unbounded full history user-triggered', () => {
    const app = readFileSync(resolve(PUBLIC, 'app.js'), 'utf8');
    expect(app).toContain("session?.mode !== 'shell' && !this._fullHistoryLoaded.has(sessionId)");
    expect(app).toContain("!restoredSnapshot && session?.mode !== 'shell'");
    expect(app).toContain('`/api/sessions/${sessionId}/terminal?tail=${TERMINAL_TAIL_SIZE}`');
    // Every terminal capture now goes through _fetchTerminalCapture, which adds
    // an abort deadline (a `?full=1` body can be megabytes and used to hang
    // indefinitely on a stalled mobile link). The URL and the full-vs-tail
    // decision this guard exists to pin are unchanged.
    expect(app).toContain(': `/api/sessions/${sessionId}/terminal?full=1`,\n        { full: true }');
    expect(app).toContain("if (this.sessions.get(sessionId)?.mode !== 'shell')");
    expect(app).toContain("if (session?.mode === 'shell')");
    // A shell scroll gesture pulls a BOUNDED window of full history; only the
    // button pulls all of it (behaviour pinned in shell-scroll-history-pull.test.ts).
    expect(app).toContain("const boundedShellPull = !force && session?.mode === 'shell';");
    expect(app).toContain('`/api/sessions/${sessionId}/terminal?full=1&tail=${TERMINAL_TAIL_SIZE}`');
    expect(app).toContain("trigger: force ? 'full-history-button' : 'full-history-scroll'");
  });

  it('renders the banner through textContent, never innerHTML', () => {
    const app = readFileSync(resolve(PUBLIC, 'app.js'), 'utf8');
    const start = app.indexOf('_renderHistoryTruncationBanner() {');
    expect(start).toBeGreaterThan(-1);
    const body = app.slice(start, app.indexOf('\n  _shouldFocusTerminalForTabSwitch', start));
    expect(body).not.toContain('innerHTML');
  });
});
