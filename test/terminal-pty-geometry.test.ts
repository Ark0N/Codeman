// Port: none (pure helpers + a real headless xterm + source guards).
//
// Issue #464, "text gets muffled sometimes". The report is a phone screenshot
// where lines of Claude Code's output are rendered twice and short tool
// summaries sit inside longer prose rows with the prose's tail still showing.
//
// That is not a dropped frame or a frozen renderer; it is arithmetic. Ink wraps
// its frame at the width the PTY reported and erases the previous frame by
// walking the cursor up the number of rows it BELIEVES that frame occupied. A
// browser terminal narrower than the PTY makes each logical line occupy more
// physical rows than Ink counted, so `eraseLines(n)` clears too few of them and
// the new frame paints over rows that were never erased.
//
// `renders each wrapped line twice when the PTY is wider` below reproduces it
// against the repo's own xterm, and is written as a CONTRAST: the same stream at
// a matching width must come out clean. An implementation that stopped fixing
// anything would fail the second half, not quietly satisfy the first.
//
// The rest pins the invariant the fix rests on: there is exactly ONE function
// that changes the terminal's size, it applies the same floor it reports, and
// the server reports back the geometry the PTY actually holds so a client whose
// resize was declined can adopt it instead of rendering against a screen that
// does not exist.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import xtermHeadless from '@xterm/headless';

const { Terminal } = xtermHeadless as unknown as {
  Terminal: new (opts: Record<string, unknown>) => {
    write(data: string, cb?: () => void): void;
    buffer: {
      active: { length: number; getLine(y: number): { translateToString(trim?: boolean): string } | undefined };
    };
  };
};

const read = (rel: string) => readFileSync(resolve(import.meta.dirname, '..', rel), 'utf8');

type Dims = { cols: number; rows: number };

function loadGeometry() {
  const context = vm.createContext({ window: {}, globalThis: {} });
  vm.runInContext(read('src/web/public/constants.js'), context, { filename: 'constants.js' });
  return (
    context.window as {
      CodemanTerminalGeometry: {
        clampTerminalDimensions: (p: Partial<Dims> | null | undefined) => Dims | null;
        reconcilePtyGeometry: (local: Dims | null, pty: Partial<Dims> | null) => { adopt: boolean; oversized: boolean };
        TERMINAL_MIN_COLS: number;
        TERMINAL_MIN_ROWS: number;
      };
    }
  ).CodemanTerminalGeometry;
}

// ───────────────────────────────────────────────────────────────────────────
// The failure itself, against the real terminal.
// ───────────────────────────────────────────────────────────────────────────

/** ansi-escapes `eraseLines(n)`: \x1b[2K per row walking up, then column 1. */
function eraseLines(n: number): string {
  let out = '';
  for (let i = 0; i < n; i++) out += '\x1b[2K' + (i < n - 1 ? '\x1b[1A' : '');
  return n ? out + '\x1b[G' : '';
}

/** How many physical rows Ink thinks its frame took, wrapping at `cols`. */
const rowsAt = (frame: string[], cols: number) =>
  frame.reduce((n, line) => n + Math.max(1, Math.ceil(line.length / cols)), 0);

/**
 * Ink's repaint loop: erase the previous frame, write the new one. The erase
 * count is computed at `ptyCols` — the width the PTY told the CLI about —
 * while the terminal is `xtermCols` wide.
 */
function inkStream(frames: string[][], ptyCols: number): string {
  let out = '';
  let previousRows = 0;
  for (const frame of frames) {
    out += eraseLines(previousRows) + frame.join('\r\n');
    previousRows = rowsAt(frame, ptyCols);
  }
  return out;
}

async function render(data: string, cols: number, rows = 24): Promise<string[]> {
  const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 500 });
  await new Promise<void>((done) => term.write(data, () => done()));
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < buf.length; y++) lines.push(buf.getLine(y)?.translateToString(true) ?? '');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

describe('a terminal that disagrees with the PTY about width', () => {
  const XTERM_COLS = 62;
  // Prose long enough to wrap, then a live region that shrinks as tool calls
  // collapse into one-line summaries — ordinary Claude Code output.
  const PROSE = [
    "• Password store entries exist, but GPG can't decrypt — that's the locked keyring after a pod restart. Let me get the browsers sorted.",
  ];
  const FRAMES = [
    [...PROSE, '  Reading settings, scanning the pass store and checking whether the agent can reach AWS'],
    [...PROSE, '  Ran 1 shell command'],
  ];

  it('renders each wrapped line twice when the PTY is wider', async () => {
    const lines = await render(inkStream(FRAMES, 120), XTERM_COLS);
    const duplicated = lines.filter((line, i) => line !== '' && lines.indexOf(line) !== i);
    expect(
      duplicated.length,
      `a 120-column PTY against a ${XTERM_COLS}-column terminal must leave ghost rows:\n${lines.join('\n')}`
    ).toBeGreaterThan(0);
  });

  // The contrast. Without this half, an implementation that fixed nothing —
  // or a stream that never ghosted in the first place — would still pass above.
  it('renders each line exactly once when the two agree', async () => {
    const lines = await render(inkStream(FRAMES, XTERM_COLS), XTERM_COLS);
    const duplicated = lines.filter((line, i) => line !== '' && lines.indexOf(line) !== i);
    expect(duplicated, `matched widths must render cleanly:\n${lines.join('\n')}`).toEqual([]);
    // And the frame that actually won is the last one.
    expect(lines[lines.length - 1]).toBe('  Ran 1 shell command');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The decisions, pure.
// ───────────────────────────────────────────────────────────────────────────

describe('clampTerminalDimensions', () => {
  const { clampTerminalDimensions, TERMINAL_MIN_COLS, TERMINAL_MIN_ROWS } = loadGeometry();

  it('floors a proposal too small to be a usable PTY', () => {
    expect(clampTerminalDimensions({ cols: 12, rows: 4 })).toEqual({
      cols: TERMINAL_MIN_COLS,
      rows: TERMINAL_MIN_ROWS,
    });
  });

  it('leaves a proposal that already clears the floor alone', () => {
    expect(clampTerminalDimensions({ cols: 62, rows: 40 })).toEqual({ cols: 62, rows: 40 });
  });

  it('floors each axis independently — a short phone is not a narrow one', () => {
    // The everyday case behind #464: keyboard up, plenty of columns, under ten rows.
    expect(clampTerminalDimensions({ cols: 62, rows: 6 })).toEqual({ cols: 62, rows: TERMINAL_MIN_ROWS });
  });

  it('reports nothing rather than a guess when the terminal cannot be measured', () => {
    for (const bad of [null, undefined, {}, { cols: NaN, rows: 10 }, { cols: 40, rows: Infinity }]) {
      expect(clampTerminalDimensions(bad as Partial<Dims>)).toBeNull();
    }
  });
});

describe('reconcilePtyGeometry', () => {
  const { reconcilePtyGeometry } = loadGeometry();

  it('does nothing when the terminal already has the PTY\u2019s width', () => {
    expect(reconcilePtyGeometry({ cols: 62, rows: 40 }, { cols: 62, rows: 40 })).toEqual({ adopt: false, cols: null });
  });

  it('adopts a width the client never asked for \u2014 a declined resize is still the truth', () => {
    // Session.resize ignores a small viewport while a desktop claim is live.
    expect(reconcilePtyGeometry({ cols: 62, rows: 40 }, { cols: 120, rows: 40 })).toEqual({ adopt: true, cols: 120 });
  });

  // \u26a0\ufe0f The regression this pins: adopting the PTY's ROWS put a phone that took
  // a desktop's 43 into a viewport with room for 18, which painted the CLI's
  // input line below the container with nothing able to scroll to it. Width is
  // the axis the wrap arithmetic needs; rows only decide how much is on screen.
  it('never asks for the PTY\u2019s rows, however far off they are', () => {
    for (const ptyRows of [43, 4, 400]) {
      const out = reconcilePtyGeometry({ cols: 62, rows: 18 }, { cols: 120, rows: ptyRows });
      expect(out).toEqual({ adopt: true, cols: 120 });
      expect(out).not.toHaveProperty('rows');
    }
  });

  it('does nothing when only the rows differ', () => {
    expect(reconcilePtyGeometry({ cols: 62, rows: 40 }, { cols: 62, rows: 12 })).toEqual({ adopt: false, cols: null });
  });

  it('adopts a narrower PTY too \u2014 the width it was told is the width it draws for', () => {
    expect(reconcilePtyGeometry({ cols: 120, rows: 40 }, { cols: 80, rows: 40 })).toEqual({ adopt: true, cols: 80 });
  });

  it('keeps its own geometry when the server reported none', () => {
    // A session with no pane answers `{}` (Session.ptyGeometry is null), and an
    // older server answers `{}` too. Neither is evidence about any PTY.
    for (const bad of [null, {}, { rows: 40 }, { cols: 'wide', rows: 40 }]) {
      expect(reconcilePtyGeometry({ cols: 62, rows: 40 }, bad as Partial<Dims>)).toEqual({ adopt: false, cols: null });
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// One owner of the terminal's size. These are source guards because the code
// they cover needs a real DOM (FitAddon measures a rendered element), which
// the CI gate has no way to give it.
// ───────────────────────────────────────────────────────────────────────────

describe('exactly one function may change the terminal size', () => {
  const terminalUi = read('src/web/public/terminal-ui.js');
  const mobileHandlers = read('src/web/public/mobile-handlers.js');

  function bodyOf(source: string, signature: string): string {
    const start = source.indexOf(signature);
    expect(start, `${signature} not found — renamed?`).toBeGreaterThan(-1);
    const end = source.indexOf('\n  },', start);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  it('syncTerminalGeometry applies the floor it reports, not the raw proposal', () => {
    const body = bodyOf(terminalUi, 'syncTerminalGeometry() {');
    expect(body).toContain('this.fitAddon.fit()');
    // fit() resizes to proposeDimensions() RAW; the floored value is what goes
    // to the server, so the floored value is what xterm must end up holding.
    expect(body).toContain('this.getTerminalDimensions()');
    expect(body).toContain('this._resizeTerminalTo(dims)');
  });

  // A sweep of every module that touches the main terminal rather than a spot
  // check, so a NEW call site there trips it rather than quietly reopening
  // #464. A module outside the list below is not covered. Scoped to the MAIN
  // terminal: the split
  // pane, the teammate windows and the log viewer are separate xterm instances
  // with their own PTYs (or none), and each owns its own sizing.
  it('no other call site fits the main terminal behind its back', () => {
    // `fit(` optionally called through `?.`, so `fitAddon?.fit?.()` counts too.
    const MAIN_TERMINAL_FIT = /^(?!.*(?:_splitPane|entry\.fitAddon)).*fitAddon[?.]*\.fit(?:\?\.)?\(\)/;
    const offenders: string[] = [];
    for (const rel of [
      'src/web/public/terminal-ui.js',
      'src/web/public/mobile-handlers.js',
      'src/web/public/app.js',
      'src/web/public/ralph-panel.js',
      'src/web/public/settings-ui.js',
      'src/web/public/tab-rail-resize.js',
      'src/web/public/notification-manager.js',
    ]) {
      read(rel)
        .split('\n')
        .forEach((line, i) => {
          const code = line.trim();
          if (code.startsWith('*') || code.startsWith('//')) return; // prose about fit(), not a call
          if (MAIN_TERMINAL_FIT.test(line)) offenders.push(`${rel}:${i + 1} ${code}`);
        });
    }
    // Exactly one: the owner's own fit.
    expect(
      offenders,
      'every fit of the main terminal must go through syncTerminalGeometry(), which applies ' +
        'the same floor it reports — a bare fit() leaves xterm at the RAW proposal while the ' +
        'server is told the floored one (issue #464)'
    ).toHaveLength(1);
    expect(offenders[0]).toContain('terminal-ui.js');
    expect(bodyOf(terminalUi, 'syncTerminalGeometry() {')).toContain('this.fitAddon.fit()');
    expect(mobileHandlers).toContain('app.syncTerminalGeometry?.()');
  });

  it('a font change tells the server, because it moves the cell size', () => {
    // Bigger glyphs mean fewer columns in the same box. These three refitted
    // and sent nothing, so the CLI kept wrapping at the old column count.
    for (const setter of [
      'setFontSize(size) {',
      'this.terminal.options.fontFamily === resolved',
      'this.terminal.options.fontWeight === fontWeight',
    ]) {
      expect(terminalUi, `${setter} no longer present`).toContain(setter);
    }
    expect(bodyOf(terminalUi, 'setFontSize(size) {')).toContain('this._refitAfterCellSizeChange()');
    const helper = bodyOf(terminalUi, '_refitAfterCellSizeChange() {');
    expect(helper).toContain('this.sendResize(this.activeSessionId)');
    expect(helper).toContain('this.syncTerminalGeometry()');
    // Three call sites in the font setters (size, family, weight) plus the two
    // font-settle re-fits.
    expect((terminalUi.match(/_refitAfterCellSizeChange\(\)/g) ?? []).length).toBeGreaterThanOrEqual(6);
  });

  it('the keyboard one-shot delegates rather than computing its own numbers', () => {
    const body = bodyOf(mobileHandlers, '_sendTerminalResize() {');
    expect(body).toContain('app.sendResize');
    // The hand-rolled POST floored what it sent and nothing else.
    expect(body).not.toContain('proposeDimensions');
    expect(body).not.toContain('Math.max');
    expect(body).not.toContain('fetch(');
  });

  it('sendResize yields a detached session BEFORE touching geometry, not after', () => {
    const body = bodyOf(terminalUi, 'async sendResize(sessionId, options = {}) {');
    const yieldAt = body.indexOf('detachedSessions?.has(sessionId)) return false');
    const fitAt = body.indexOf('this._geometryForResizeRequest()');
    expect(yieldAt, 'the detached-session yield is gone').toBeGreaterThan(-1);
    expect(fitAt, 'sendResize no longer syncs geometry').toBeGreaterThan(-1);
    expect(
      yieldAt,
      'withholding the server resize but reflowing anyway leaves this xterm at a shape ' +
        'the PTY was never told about — withhold both or neither'
    ).toBeLessThan(fitAt);
  });

  it('throttledResize withholds the fit wherever it withholds the SIGWINCH', () => {
    const start = terminalUi.indexOf('const throttledResize = () => {');
    expect(start).toBeGreaterThan(-1);
    const block = terminalUi.slice(start, terminalUi.indexOf("window.addEventListener('resize', throttledResize)"));
    const guardAt = block.indexOf('!keyboardUp && !detachedElsewhere');
    const syncAt = block.indexOf('this._geometryForResizeRequest()');
    expect(guardAt).toBeGreaterThan(-1);
    expect(syncAt, 'the geometry sync must sit INSIDE the guard').toBeGreaterThan(guardAt);
  });
});

describe('the failed-load notice fits the narrowest terminal this app will render', () => {
  // ⚠️ `e587d845`'s commit message claimed a test asserted this against the
  // BUILT asset. It did not: that assertion lived in a throwaway probe that was
  // deleted with the rest of the scratch scripts, so the claim was wrong when it
  // was written. This is the real one, and it reads the source rather than
  // `dist/`, because `dist/` is not committed and a test that skips when it is
  // absent would pass for the wrong reason in CI.
  const app = read('src/web/public/app.js');
  const { TERMINAL_MIN_COLS } = loadGeometry();

  /** The literal the catch writes, escapes resolved, SGR stripped. */
  function noticeLines(): string[] {
    const at = app.indexOf('if (clearedBeforeFresh && this.terminal)');
    expect(at, 'the failed-load branch is gone — renamed?').toBeGreaterThan(-1);
    // Anchored past the comments: one of them quotes a lone '.', which a
    // first-quote match happily returns instead of the notice.
    const writeAt = app.indexOf('this.terminal.write(', at);
    expect(writeAt, 'the failed-load branch no longer writes to the terminal').toBeGreaterThan(-1);
    const call = app.slice(writeAt, app.indexOf('\n      }', writeAt));
    const literal = call.match(/'((?:[^'\\]|\\.)*)'/);
    expect(literal, 'no string literal in the failed-load branch').not.toBeNull();
    return literal![1]
      .replace(/\\x1b\[[0-9;]*m/g, '')
      .split('\\r\\n')
      .filter((line) => line.trim().length > 0);
  }

  it('says what failed, that the session lives, and what to do', () => {
    const lines = noticeLines();
    expect(lines.length).toBe(3);
    expect(lines[0]).toMatch(/did not load/i);
    expect(lines[1]).toMatch(/live output/i);
    // A dead end is the most expensive defect here: the pane is blank and the
    // reader has no idea whether the session is recoverable.
    expect(lines[2], 'the notice must name the next step').toMatch(/reload/i);
  });

  it('never wraps, down to the 40-column floor', () => {
    // A 52-character sentence measured at 320px wrapped and left a lone '.' on
    // a line of its own. The floor is the narrowest this app renders, and it is
    // two taps away on a small phone via increaseFontSize.
    for (const line of noticeLines()) {
      expect(
        line.length,
        `"${line}" is ${line.length} columns, over the ${TERMINAL_MIN_COLS} floor`
      ).toBeLessThanOrEqual(TERMINAL_MIN_COLS);
    }
  });

  it('does not tell the reader to reopen the tab, which retries nothing', () => {
    // selectSession early-returns when the session is already active, so
    // clicking the tab you are already on does not re-fetch.
    expect(app).toContain('if (this.activeSessionId === sessionId && !forceReload)');
    expect(noticeLines().join(' ')).not.toMatch(/reopen|switch tab/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Resize stopped being write-only.
// ───────────────────────────────────────────────────────────────────────────

describe('the server reports the geometry the PTY actually holds', () => {
  it('Session reports its geometry only while a pane is actually drawing', () => {
    const session = read('src/session.ts');
    // ⚠️ `resize()` writes _ptyCols/_ptyRows only when ptyProcess is set and
    // nothing seeds them from the spawn geometry, so a dead-pane session still
    // holds the constructor defaults of 120x40. Reporting those made a client
    // adopt a size no process was ever told, and claim another device owned the
    // pane when none existed.
    expect(session).toMatch(/get ptyGeometry\(\): \{ cols: number; rows: number \} \| null \{/);
    expect(session).toContain('return this.ptyProcess ? { cols: this._ptyCols, rows: this._ptyRows } : null;');
    expect(session, 'the raw getters would report the defaults again').not.toMatch(/get ptyCols\(\)/);
  });

  it('the WebSocket answers a resize with what took', () => {
    const ws = read('src/web/routes/ws-routes.ts');
    const at = ws.indexOf('session.resize(msg.c, msg.r,');
    expect(at).toBeGreaterThan(-1);
    const after = ws.slice(at, at + 1400);
    expect(after).toContain('"t":"zc"');
    expect(after).toContain('const applied = session.ptyGeometry;');
    // No pane, no frame at all.
    expect(after).toContain('if (applied && socket.readyState === 1)');
    // Documented in the protocol block at the top of the file, like every other frame.
    expect(ws).toContain('{"t":"zc","c":N,"r":N}');
  });

  it('the HTTP resize answers with what took, not an empty object', () => {
    const routes = read('src/web/routes/session-routes.ts');
    const at = routes.indexOf("app.post('/api/sessions/:id/resize'");
    expect(at).toBeGreaterThan(-1);
    const handler = routes.slice(at, at + 1600);
    expect(handler).toContain('return session.ptyGeometry ?? {};');
  });

  it('the client adopts the report and re-bases its dedupe on it', () => {
    const terminalUi = read('src/web/public/terminal-ui.js');
    const start = terminalUi.indexOf('_onPtyGeometryReport(sessionId, cols, rows) {');
    expect(start).toBeGreaterThan(-1);
    const body = terminalUi.slice(start, terminalUi.indexOf('\n  },', start));
    expect(body).toContain('reconcilePtyGeometry');
    // Columns only: the local row count is carried through untouched.
    expect(body).toContain('this._resizeTerminalTo({ cols, rows: local.rows })');
    // Without this the next resize is deduped against a request that was
    // REFUSED, which suppresses the retry that recovers the pane.
    expect(body).toContain('this._lastResizeDims = { cols, rows: local.rows }');
    // And the WS frame is wired up at all.
    expect(read('src/web/public/app.js')).toContain("msg.t === 'zc'");
  });

  it('a pane wider than the screen gets horizontal reach for as long as that lasts', () => {
    const css = read('src/web/public/styles.css');
    // .terminal-container is overflow:hidden, so adopting a wider PTY without
    // this puts the right-hand columns somewhere no gesture can reach them.
    // Read the rule's DECLARATIONS, comments stripped: the comments in this block
    // quote CSS with braces in it, which a `[^}]*` window cannot survive.
    const declarationsOf = (selector: string) => {
      const at = css.indexOf(`${selector} {`);
      expect(at, `${selector} not found`).toBeGreaterThan(-1);
      const body = css.slice(at + selector.length, css.indexOf('\n}', at));
      return body.replace(/\/\*[\s\S]*?\*\//g, '');
    };
    const oversized = declarationsOf('.terminal-container.term-overflows-x');
    expect(oversized).toContain('overflow-x: auto;');
    // Both axes, explicitly: mobile.css sets `overflow: visible` on the bare
    // selector, and a lone overflow-x would leave overflow-y computing to auto.
    expect(oversized).toContain('overflow-y: hidden;');
    // ⚠️ NO touch-action here, deliberately. `touch-action: pan-x` does nothing
    // for the sessions this targets — `touchstart` preventDefault()s every
    // 'content' tap, which cancels the browser's pan before it starts — and
    // granting it as well as the JS pan would move the pane twice for one
    // finger on the taps where that preventDefault does not run. The terminal's
    // own touchmove handler owns both axes; mobile.css's unscoped
    // `touch-action: none` is what keeps it the only owner.
    expect(css.slice(css.indexOf('.terminal-container.term-overflows-x'))).not.toMatch(
      /\.terminal-container\.term-overflows-x[^{]*\{[^}]*touch-action/
    );
    expect(read('src/web/public/terminal-ui.js')).toContain('const canPanHorizontally = () =>');
    expect(read('src/web/public/terminal-ui.js')).toContain("if (panAxis === 'x') {");
    // The class is only ever on while the terminal really is too wide, and it
    // is MEASURED rather than derived: the floor widens the terminal past a
    // narrow container with the PTY agreeing throughout, so a mismatch test
    // would never fire for it (360px, font 24: 218px unreachable).
    expect(read('src/web/public/terminal-ui.js')).toContain("classList.toggle('term-overflows-x', overflows)");
    expect(read('src/web/public/terminal-ui.js')).toContain(
      'screen.getBoundingClientRect().width - container.clientWidth > 1'
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// A refused width must not be re-applied locally on every ask. The real mixin
// methods, run against a fake terminal whose FitAddon behaves like xterm's.
// ───────────────────────────────────────────────────────────────────────────

describe('while another device holds the width', () => {
  const SESSION = 'session-A';

  function makeApp() {
    const FakeCodemanApp = function () {} as unknown as { prototype: Record<string, unknown> };
    const context = vm.createContext({
      console,
      setTimeout,
      clearTimeout,
      setInterval: vi.fn(),
      clearInterval: vi.fn(),
      CodemanApp: FakeCodemanApp,
      window: { addEventListener: vi.fn(), removeEventListener: vi.fn(), innerWidth: 400 },
      document: { addEventListener: vi.fn(), getElementById: () => null },
    });
    vm.runInContext(read('src/web/public/constants.js'), context, { filename: 'constants.js' });
    vm.runInContext(read('src/web/public/terminal-ui.js'), context, { filename: 'terminal-ui.js' });
    const mixin = FakeCodemanApp.prototype as Record<string, (...a: unknown[]) => unknown>;
    // The phone's container: 57x13. Every resize xterm performs is recorded,
    // because a resize is a re-wrap of the whole buffer.
    const resizes: Array<[number, number]> = [];
    const terminal = {
      cols: 80,
      rows: 24,
      resize(cols: number, rows: number) {
        resizes.push([cols, rows]);
        this.cols = cols;
        this.rows = rows;
      },
    };
    const proposal = { cols: 57, rows: 13 };
    const sent: Array<{ c: number; r: number }> = [];
    const app = Object.assign(Object.create(mixin), {
      terminal,
      fitAddon: {
        proposeDimensions: () => ({ ...proposal }),
        // xterm's FitAddon resizes to the raw proposal.
        fit: () => terminal.resize(proposal.cols, proposal.rows),
      },
      activeSessionId: SESSION,
      detachedSessions: new Set<string>(),
      isSoloWindow: false,
      _lastResizeDims: null,
      _wsReady: true,
      _wsSessionId: SESSION,
      _ws: { send: (frame: string) => sent.push(JSON.parse(frame)) },
      _notePaneOwnedElsewhere: vi.fn(),
    }) as Record<string, unknown> & {
      sendResize: (id: string) => Promise<boolean>;
      _onPtyGeometryReport: (id: string, cols: number, rows: number) => void;
      _paneWidthRefused?: boolean;
    };
    return { app, terminal, resizes, sent, proposal };
  }

  it('asks for its own width again without re-wrapping to it until the PTY follows', async () => {
    const { app, terminal, resizes, sent } = makeApp();
    await app.sendResize(SESSION);
    expect(sent.at(-1)).toMatchObject({ c: 57, r: 13 });
    // Refused: the desktop keeps the pane at 198 columns.
    app._onPtyGeometryReport(SESSION, 198, 43);
    expect(terminal.cols).toBe(198);
    expect(app._paneWidthRefused).toBe(true);

    // The retry timer asks again. Nothing about the screen changed, so xterm
    // must not be re-wrapped to 57 and back (it used to be, every 30 seconds).
    resizes.length = 0;
    await app.sendResize(SESSION);
    app._onPtyGeometryReport(SESSION, 198, 43);
    expect(resizes).toEqual([]);
    expect(terminal.cols).toBe(198);
    // It still ASKS for this screen's width, which is how it recovers.
    expect(sent.at(-1)).toMatchObject({ c: 57, r: 13 });

    // The desktop went idle and the request took: the report is adopted.
    await app.sendResize(SESSION);
    app._onPtyGeometryReport(SESSION, 57, 13);
    expect(terminal.cols).toBe(57);
    expect(app._paneWidthRefused).toBe(false);
  });

  it('still follows the container\u2019s rows while the width is held elsewhere', async () => {
    const { app, terminal, resizes, proposal } = makeApp();
    await app.sendResize(SESSION);
    app._onPtyGeometryReport(SESSION, 198, 43);
    resizes.length = 0;
    proposal.rows = 20; // keyboard dismissed
    await app.sendResize(SESSION);
    // Rows only: the columns stay at the width the PTY has.
    expect(resizes).toEqual([[198, 20]]);
    expect(terminal.cols).toBe(198);
  });
});
