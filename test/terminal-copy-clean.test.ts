/**
 * What a copy actually puts on the clipboard.
 *
 * xterm returns whole screen rows and trims only the cells that were never
 * written to, so a full-screen TUI's padding spaces reach the clipboard. These
 * tests drive the SHIPPED transform (`CodemanCopySelection.clean` in
 * constants.js), the SHIPPED wiring that decides column mode, and both SHIPPED
 * copy paths, because the interesting failures live in the paths rather than in
 * the string handling: a padding-only selection must not silently keep the
 * user's Ctrl+C, and must not put a bare newline on the clipboard.
 *
 * A shared LEADING indent is stripped only when a caller has measured a MARGIN
 * off the pane and passed it in. The transform called with text alone still
 * touches trailing padding and nothing else, and the block below pins that,
 * because measuring the indent off the SELECTION was built and dropped before
 * #451 merged: see the rule in docs/architecture-invariants.md.
 *
 * Strategy: constants.js and terminal-ui.js in one vm with a stub CodemanApp,
 * the harness shape test/terminal-auto-copy.test.ts uses. No DOM, no xterm.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const read = (name: string) => readFileSync(resolve(publicDir, name), 'utf8');

/**
 * The map the server derives from the `transcriptGutter` CAPABILITY and injects
 * at render, keyed by run mode. Claude is the only stock entry that declares one.
 */
const STOCK_GUTTERS = { claude: 2, codex: 2 };

function loadHarness(
  settingsOverride?: Record<string, unknown>,
  gutters: Record<string, number> | null = STOCK_GUTTERS
) {
  const CodemanApp = function CodemanApp(this: unknown) {};
  const windowRef: Record<string, any> = {};
  if (gutters) windowRef.__codemanTranscriptGutter = gutters;
  const context = vm.createContext({
    window: windowRef,
    document: {
      body: { classList: { contains: () => false } },
      getElementById: () => null,
      querySelector: () => null,
      addEventListener: () => {},
    },
    CodemanApp,
    console: { warn: vi.fn(), log: vi.fn(), debug: vi.fn() },
    _crashDiag: { log: vi.fn() },
    requestAnimationFrame: () => 1,
    setTimeout: () => 1,
    Blob: function Blob() {},
    URL: { createObjectURL: () => 'blob:yield', revokeObjectURL: () => {} },
    Worker: function Worker(this: any) {
      this.postMessage = () => {};
    },
    MobileDetection: { isTouchDevice: () => false, getDeviceType: () => 'desktop' },
    KeyboardHandler: { keyboardVisible: false },
    DEC_SYNC_STRIP_RE: /\x1b\[\?2026[hl]/g,
    TERMINAL_CHUNK_SIZE: 32 * 1024,
  });

  vm.runInContext(read('constants.js'), context, { filename: 'constants.js' });
  vm.runInContext(read('terminal-ui.js'), context, { filename: 'terminal-ui.js' });

  const app = new (CodemanApp as unknown as new () => Record<string, any>)();
  const toasts: { message: string; type: string }[] = [];
  app.showToast = (message: string, type: string) => toasts.push({ message, type });
  app._copyText = vi.fn(async () => true);
  app.loadAppSettingsFromStorage = () => ({ autoCopySelection: true, ...(settingsOverride ?? {}) });

  // `mode` is what decides the strip: the session's run mode is looked up in the
  // injected gutter map. No buffer is involved, because the width is declared
  // rather than measured off the pane. The default is a mode that declares NO
  // gutter, so a test about the trailing trim keeps its exact meaning, and only a
  // test asking for `mode: 'claude'` gets a leading strip at all.
  const setSelection = (
    selection: string,
    { startX = 0, columnMode = false, mode = 'shell', from = 0, to = 1 } = {}
  ) => {
    app.activeSessionId = 'S1';
    app.sessions = new Map([['S1', { id: 'S1', mode }]]);
    app.terminal = {
      hasSelection: () => !!selection,
      getSelection: vi.fn(() => selection),
      getSelectionPosition: vi.fn(() => ({ start: { x: startX, y: from }, end: { x: 0, y: to } })),
      clearSelection: vi.fn(),
      focus: vi.fn(),
      _core: { _selectionService: { _activeSelectionMode: columnMode ? 3 : 0 } },
    };
    return app.terminal;
  };

  return { app, windowRef, toasts, setSelection };
}

const clean = (text: unknown) => loadHarness().windowRef.CodemanCopySelection.clean(text);

describe('CodemanCopySelection.clean — trailing padding', () => {
  it('drops the padding a full-screen TUI writes across the rest of each row', () => {
    expect(clean('hello     \nworld       ')).toBe('hello\nworld');
  });

  it('drops it from a single-row selection too', () => {
    expect(clean('hello     ')).toBe('hello');
  });

  it('keeps the line endings xterm chose, including the Windows \\r\\n', () => {
    expect(clean('hello   \r\nworld  \r\n')).toBe('hello\r\nworld\r\n');
  });

  it('drops trailing tabs as well as trailing spaces', () => {
    expect(clean('hello \t \nworld')).toBe('hello\nworld');
  });

  it('leaves a line that has no padding untouched', () => {
    expect(clean('hello\nworld')).toBe('hello\nworld');
  });
});

describe('CodemanCopySelection.clean — a shared leading indent is kept without a margin', () => {
  // Measured over 401,445 three-row windows across 1,010 tracked files, stripping
  // the run every row shares fired on 73% of them, and the transform cannot tell
  // a TUI margin from content by looking at the selection. These are the cases
  // that settled it, and each one still loses information if the transform ever
  // strips an indent nobody measured off the pane.
  it('keeps the indent every selected row shares', () => {
    expect(clean('  first line\n  second line')).toBe('  first line\n  second line');
  });

  it('keeps a git log body at its four-space indent', () => {
    expect(clean('    fix(terminal): trim the padding   \n    xterm hands back whole rows      ')).toBe(
      '    fix(terminal): trim the padding\n    xterm hands back whole rows'
    );
  });

  it('keeps indented Python, where the indent is semantic', () => {
    expect(clean('        for item in items:\n            if item.ready:')).toBe(
      '        for item in items:\n            if item.ready:'
    );
  });

  it('keeps the leading space on git diff context rows, where it is the marker', () => {
    expect(clean(' const x = 1;\n }')).toBe(' const x = 1;\n }');
  });

  it('is a no-op on shell output, which shares no indent anyway', () => {
    expect(clean('$ ls\n  indented output\ndone')).toBe('$ ls\n  indented output\ndone');
  });

  it('still drops trailing padding on every one of those rows', () => {
    expect(clean('  first  \n   \n  second  ')).toBe('  first\n\n  second');
  });

  it('does not eat a \\r on a blank row', () => {
    expect(clean('    first\r\n\r\n    second\r\n')).toBe('    first\r\n\r\n    second\r\n');
  });
});

describe('CodemanCopySelection.clean — one row is treated like any other', () => {
  it('leaves the indent on a single-row selection', () => {
    expect(clean('    hello world   ')).toBe('    hello world');
  });

  it('leaves it on a single row followed by a blank row', () => {
    expect(clean('    hello world\n   ')).toBe('    hello world\n');
  });

  it('leaves it when a second row carries content, exactly as for one row', () => {
    expect(clean('    hello\n    world')).toBe('    hello\n    world');
  });
});

describe('CodemanCopySelection.clean — nothing to clean', () => {
  it('returns an empty string for an empty selection', () => {
    expect(clean('')).toBe('');
  });

  it('returns an empty string rather than throwing on a non-string', () => {
    expect(clean(undefined)).toBe('');
    expect(clean(null)).toBe('');
  });

  it('reduces an all-padding selection to its line breaks alone', () => {
    // The copy paths reject this with trim(); the transform itself only removes
    // whitespace, so the row structure survives here by design.
    expect(clean('    \n      \n  ')).toBe('\n\n');
  });
});

describe('cleanedTerminalSelection — wiring', () => {
  it('trims each row and leaves the shared indent alone', () => {
    const { app, setSelection } = loadHarness();
    setSelection('  first   \n  second  ');
    expect(app.cleanedTerminalSelection()).toBe('  first\n  second');
  });

  it('strips nothing for a run mode that declares no gutter', () => {
    const { app, setSelection } = loadHarness();
    setSelection('  first\n  second');
    expect(app.cleanedTerminalSelection()).toBe('  first\n  second');
  });

  it('uses the text it is given without reading the selection again', () => {
    const { app, setSelection } = loadHarness();
    // The contract is that `text` IS the live selection, so the stub agrees with
    // it; the assertion that carries weight is that getSelection went unread.
    const terminal = setSelection('  given text  \n  second row  ');
    expect(app.cleanedTerminalSelection('  given text  \n  second row  ')).toBe('  given text\n  second row');
    expect(terminal.getSelection).not.toHaveBeenCalled();
  });

  it('returns an empty string when there is no selection at all', () => {
    const { app, setSelection } = loadHarness();
    setSelection('');
    expect(app.cleanedTerminalSelection()).toBe('');
  });

  it('leaves a column selection completely untouched', () => {
    // Alt+drag makes a rectangle, and its rows lining up is the whole point:
    // both halves of the clean would destroy that alignment.
    const { app, setSelection } = loadHarness();
    const rect = '  alpha   \n  beta    \n  gamma   ';
    setSelection(rect, { startX: 40, columnMode: true });
    expect(app.cleanedTerminalSelection()).toBe(rect);
  });
});

describe('CodemanCopySelection.clean — the margin is a ceiling, never the answer', () => {
  const clean2 = (text: string, options: Record<string, unknown>) =>
    loadHarness().windowRef.CodemanCopySelection.clean(text, options);

  it('strips a measured margin', () => {
    expect(clean2('  first\n  second', { margin: 2 })).toBe('first\nsecond');
  });

  it('strips the margin and no more from a block indented past it', () => {
    // Four of these six columns are the git log body's own, and they stay.
    expect(clean2('      fix(terminal): trim it\n      xterm hands back rows', { margin: 2 })).toBe(
      '    fix(terminal): trim it\n    xterm hands back rows'
    );
  });

  it('strips nothing when any selected line sits at column 0', () => {
    // Selecting a marker row along with the prose under it means the block's
    // own shared indent is zero, and the block shifts as a unit or not at all.
    expect(clean2('● Creating a job\n  Intent. A daily check.', { margin: 2 })).toBe(
      '● Creating a job\n  Intent. A daily check.'
    );
  });

  it("keeps every line's indentation relative to every other", () => {
    const before = '  name: CI\n  on:\n    push:\n      branches: [master]';
    expect(clean2(before, { margin: 2 })).toBe('name: CI\non:\n  push:\n    branches: [master]');
  });

  it('leaves the first line alone when the selection began mid-row', () => {
    // That line never carried the margin: the mousedown cut it off.
    expect(clean2('rst line\n  second\n  third', { margin: 2, firstLinePartial: true })).toBe(
      'rst line\nsecond\nthird'
    );
  });

  it('still trims trailing padding while it dedents', () => {
    expect(clean2('  first   \n   \n  second  ', { margin: 2 })).toBe('first\n\nsecond');
  });

  it('keeps the Windows line join intact on both blank and content rows', () => {
    expect(clean2('  first\r\n\r\n  second\r\n', { margin: 2 })).toBe('first\r\n\r\nsecond\r\n');
  });

  it('treats a margin it cannot use as no margin at all', () => {
    expect(clean2('  first\n  second', { margin: 0 })).toBe('  first\n  second');
    expect(clean2('  first\n  second', { margin: -4 })).toBe('  first\n  second');
    expect(clean2('  first\n  second', { margin: 'two' as never })).toBe('  first\n  second');
  });
});

describe('cleanedTerminalSelection — the two bugs that kept this out of #451', () => {
  // Both were real, and both came from the mid-row flag reading the selection's
  // own geometry to decide how much every row lost. The width is declared by the
  // CLI now, so neither end of a drag can move it, and the flag governs one line.
  const ROWS = [
    '  Intent. A daily check tells you when it publishes.',
    '  Scope. One recurring routine and nothing else.',
    '  Risks. Three are worth naming here.',
  ];
  const body =
    '  Intent. A daily check tells you when it publishes.\n  Scope. One recurring routine and nothing else.\n  Risks. Three are worth naming here.';
  const dedented =
    'Intent. A daily check tells you when it publishes.\nScope. One recurring routine and nothing else.\nRisks. Three are worth naming here.';

  it('survives a reversed range, whatever end xterm reports first', () => {
    // xterm 6.0 orders the pair itself, verified by driving a real upward drag
    // through chromium, so this pins the guard rather than a live bug: an
    // unordered pair would put the mid-row flag on the wrong end of the drag.
    const from = 401;
    const down = loadHarness();
    down.setSelection(body, { mode: 'claude', from, to: from + 2 });
    const up = loadHarness();
    up.setSelection(body, { mode: 'claude', from, to: from + 2 });
    up.app.terminal.getSelectionPosition = () => ({ start: { x: 0, y: from + 2 }, end: { x: 0, y: from } });
    expect(down.app.cleanedTerminalSelection()).toBe(dedented);
    expect(up.app.cleanedTerminalSelection()).toBe(dedented);
  });

  it('reads the mid-row flag off the earlier end of the range, not the later one', () => {
    // A drag between column 9 on the first row and column 0 on the last leaves
    // the FIRST line partial. Read off the wrong end the flag says the block is
    // flush, and that partial line loses two characters of its own content.
    const { app, setSelection } = loadHarness();
    setSelection(`nt. A daily check tells you when it publishes.\n${ROWS[1]}`, { mode: 'claude', from: 1, to: 2 });
    app.terminal.getSelectionPosition = () => ({ start: { x: 0, y: 2 }, end: { x: 9, y: 1 } });
    expect(app.cleanedTerminalSelection()).toBe(
      'nt. A daily check tells you when it publishes.\nScope. One recurring routine and nothing else.'
    );
  });

  it('gives the rows below the first one the same result whatever column the mousedown hit', () => {
    // Three rows used to produce three different clipboards depending on where
    // the click landed, which the user never sees. Only the partial first line
    // may differ now, and it differs because it is different text.
    const tails = [0, 1, 2, 7].map((startX) => {
      const h = loadHarness();
      h.setSelection(`${ROWS[0].slice(startX)}\n${ROWS[1]}\n${ROWS[2]}`, { mode: 'claude', from: 1, to: 3, startX });
      return h.app.cleanedTerminalSelection().split('\n').slice(1).join('\n');
    });
    expect(new Set(tails).size).toBe(1);
    expect(tails[0]).toBe('Scope. One recurring routine and nothing else.\nRisks. Three are worth naming here.');
  });
});

describe('cleanedTerminalSelection — the cases the margin has to get right', () => {
  it('takes the gutter off Claude Code prose, which is what people copy', () => {
    const { app, setSelection } = loadHarness();
    setSelection(
      '  Intent. A daily check tells you when it publishes.\n  Scope. One recurring routine on your account.',
      { mode: 'claude', from: 1, to: 2 }
    );
    expect(app.cleanedTerminalSelection()).toBe(
      'Intent. A daily check tells you when it publishes.\nScope. One recurring routine on your account.'
    );
  });

  it('keeps a git log body at its four-space indent inside an agent gutter', () => {
    // This is the case that kept the painted-padding gate out on its own: the
    // pane is a TUI, so that gate says yes, and the body shares six columns.
    const { app, setSelection } = loadHarness();
    setSelection(
      '      fix(terminal): trim the padding a TUI paints\n      xterm hands back whole rows and trims only the\n      cells nothing ever wrote to.',
      { mode: 'claude', from: 4, to: 6 }
    );
    expect(app.cleanedTerminalSelection()).toBe(
      '    fix(terminal): trim the padding a TUI paints\n    xterm hands back whole rows and trims only the\n    cells nothing ever wrote to.'
    );
  });

  it('keeps YAML nesting inside an agent gutter', () => {
    const { app, setSelection } = loadHarness();
    setSelection('    build:\n      steps:\n        - run: npm ci', { mode: 'claude', from: 2, to: 4 });
    expect(app.cleanedTerminalSelection()).toBe('  build:\n    steps:\n      - run: npm ci');
  });

  it('leaves indented Python alone in a shell pane, where the indent is semantic', () => {
    const { app, setSelection } = loadHarness();
    setSelection('    if event.ready:\n        run(event)', { from: 2, to: 3 });
    expect(app.cleanedTerminalSelection()).toBe('    if event.ready:\n        run(event)');
  });

  it('leaves git diff context rows alone, where the leading space is the marker', () => {
    const { app, setSelection } = loadHarness();
    setSelection(' const x = 1;\n const y = 2;\n }', { from: 2, to: 4 });
    expect(app.cleanedTerminalSelection()).toBe(' const x = 1;\n const y = 2;\n }');
  });
});

describe('copyStripMargin — the per-device toggle', () => {
  const body = '  Intent. A daily check tells you when it publishes.\n  Scope. One recurring routine and nothing else.';
  const select = (h: ReturnType<typeof loadHarness>) => h.setSelection(body, { mode: 'claude', from: 1, to: 2 });

  it('strips the margin when the device has never stored a value, because it defaults ON', () => {
    const h = loadHarness({});
    select(h);
    expect(h.app.cleanedTerminalSelection()).toBe(
      'Intent. A daily check tells you when it publishes.\nScope. One recurring routine and nothing else.'
    );
  });

  it('leaves the margin alone when the device turned it off', () => {
    const h = loadHarness({ copyStripMargin: false });
    select(h);
    expect(h.app.cleanedTerminalSelection()).toBe(body);
  });

  it('still trims trailing padding while the strip is off', () => {
    const h = loadHarness({ copyStripMargin: false });
    h.setSelection('  first   \n  second  ', { mode: 'claude', from: 1, to: 2 });
    expect(h.app.cleanedTerminalSelection()).toBe('  first\n  second');
  });

  it('never consults the gutter map while it is off', () => {
    // The lookup is the whole cost now, and it runs on every Ctrl+C, so the
    // toggle is checked first. There is no buffer to read: the width is declared.
    const h = loadHarness({ copyStripMargin: false });
    select(h);
    expect(h.app._cliGutterColumns()).toBe(0);
    expect(h.app.cleanedTerminalSelection()).toBe(body);
  });

  it('treats an unreadable settings store as ON, matching the default', () => {
    const h = loadHarness();
    h.app.loadAppSettingsFromStorage = () => {
      throw new Error('localStorage unavailable');
    };
    select(h);
    expect(h.app.cleanedTerminalSelection()).toBe(
      'Intent. A daily check tells you when it publishes.\nScope. One recurring routine and nothing else.'
    );
  });

  it('keeps the toggle per-device: display key, stripped from the PUT, absent from the schema', () => {
    const settingsUi = read('settings-ui.js');
    const schemas = readFileSync(resolve(import.meta.dirname, '../src/web/schemas.ts'), 'utf8');
    const displayKeys = settingsUi.slice(
      settingsUi.indexOf('const displayKeys = new Set(['),
      settingsUi.indexOf('])', settingsUi.indexOf('const displayKeys = new Set(['))
    );
    expect(displayKeys).toContain("'copyStripMargin'");
    // SettingsUpdateSchema is .strict(), so a key it does not declare 400s the
    // whole settings PUT if the client sends it.
    expect(settingsUi).toContain('copyStripMargin: _csm,');
    expect(schemas).not.toContain('copyStripMargin');
  });

  it('keeps the control loadable and savable by id', () => {
    const settingsUi = read('settings-ui.js');
    expect(read('index.html')).toContain('id="appSettingsCopyStripMargin"');
    // `!== false`, because this one defaults ON and the desktop branch of
    // getDefaultSettings returns {}.
    expect(settingsUi).toContain(
      "document.getElementById('appSettingsCopyStripMargin').checked = settings.copyStripMargin !== false;"
    );
    expect(settingsUi).toContain("copyStripMargin: document.getElementById('appSettingsCopyStripMargin').checked,");
  });
});

describe('the gutter is DECLARED by the CLI, never measured off the pane', () => {
  const body = '  Intent. A daily check tells you when it publishes.\n  Scope. One recurring routine.';
  const flush = 'Intent. A daily check tells you when it publishes.\nScope. One recurring routine.';

  it('takes the declared width off a mode that declares one', () => {
    const { app, setSelection } = loadHarness();
    setSelection(body, { mode: 'claude', from: 1, to: 2 });
    expect(app._cliGutterColumns()).toBe(2);
    expect(app.cleanedTerminalSelection()).toBe(flush);
  });

  it('takes the two columns off Codex as well, and keeps the nesting under them', () => {
    // Measured on a live codex-cli 0.154.0 answer: its •/›/⚠ markers sit in the
    // gutter, prose continuations sit at 2, and a nested YAML block the model
    // wrote rendered at 2/4/6/8 for its own 0/2/4/6. Replayed at six widths the
    // indents were 0, 2, 4, 6 and 8 at every one, never 1.
    const { app, setSelection } = loadHarness();
    setSelection('  terminal:\n    pane:\n      gutter:\n        width: 1', { mode: 'codex', from: 1, to: 4 });
    expect(app._cliGutterColumns()).toBe(2);
    expect(app.cleanedTerminalSelection()).toBe('terminal:\n  pane:\n    gutter:\n      width: 1');
  });

  it('leaves a mode nobody has measured alone, because it declares none', () => {
    const { app, setSelection } = loadHarness();
    setSelection('    build:\n      steps:', { mode: 'opencode', from: 1, to: 2 });
    expect(app._cliGutterColumns()).toBe(0);
    expect(app.cleanedTerminalSelection()).toBe('    build:\n      steps:');
  });

  it('leaves a shell alone for the same reason', () => {
    const { app, setSelection } = loadHarness();
    setSelection('    if event.ready:\n        run(event)', { mode: 'shell', from: 1, to: 2 });
    expect(app.cleanedTerminalSelection()).toBe('    if event.ready:\n        run(event)');
  });

  it('strips nothing at all when the server injected no map', () => {
    // A page served before the capability existed, or a render path that skips
    // the injection: no session gets a strip rather than every session guessing.
    const { app, setSelection } = loadHarness(undefined, null);
    setSelection(body, { mode: 'claude', from: 1, to: 2 });
    expect(app._cliGutterColumns()).toBe(0);
    expect(app.cleanedTerminalSelection()).toBe(body);
  });

  it('ignores a width that is not a positive whole number', () => {
    for (const bad of [0, -2, 2.5, '2', null] as unknown[]) {
      const { app, setSelection } = loadHarness(undefined, { claude: bad } as Record<string, number>);
      setSelection(body, { mode: 'claude', from: 1, to: 2 });
      expect(app._cliGutterColumns()).toBe(0);
    }
  });

  it('reads no terminal buffer on the copy path at all', () => {
    // The old version scanned up to ~240 rows per Ctrl+C to measure a width that
    // the CLI can simply state. A buffer here would be a regression to that.
    const { app, setSelection } = loadHarness();
    const terminal = setSelection(body, { mode: 'claude', from: 1, to: 2 });
    const getLine = vi.fn(() => undefined);
    terminal.buffer = { active: { length: 0, getLine } };
    expect(app.cleanedTerminalSelection()).toBe(flush);
    expect(getLine).not.toHaveBeenCalled();
  });
});

describe('the transcriptGutter capability, as the registry and server carry it', () => {
  const registryDir = resolve(import.meta.dirname, '../src/config/cli-registry');
  const readSrc = (n: string) => readFileSync(resolve(registryDir, n), 'utf8');

  it('is a bounded integer in the schema, so a clis.json cannot declare a huge one', () => {
    expect(readSrc('schema.ts')).toContain('transcriptGutter: z.number().int().min(1).max(8).optional()');
  });

  it('is declared by claude and codex, and by nothing else in the stock registry', () => {
    const stock = readSrc('stock.ts');
    expect(stock.match(/transcriptGutter: 2,/g)).toHaveLength(2);
    // Exactly the two whose transcript layout has been measured on a live pane.
    expect(stock.match(/transcriptGutter:/g)).toHaveLength(2);
  });

  it('reaches the page off the capability rather than as an id list', () => {
    const server = readFileSync(resolve(import.meta.dirname, '../src/web/server.ts'), 'utf8');
    expect(server).toContain('entry.capabilities.transcriptGutter');
    expect(server).toContain('window.__codemanTranscriptGutter=');
    // The frontend looks the mode up in that map; the helper holds no id itself.
    const terminalUi = read('terminal-ui.js');
    const helper = terminalUi.slice(
      terminalUi.indexOf('_cliGutterColumns(sessionId) {'),
      terminalUi.indexOf('async copyTerminalSelection')
    );
    expect(helper).toContain('window.__codemanTranscriptGutter');
    expect(helper).not.toMatch(/'claude'/);
  });
});

describe('the xterm internals the column check depends on', () => {
  // The column check reads a private field and compares it to a literal, because
  // xterm publishes the selection mode nowhere. A rename or a renumber would make
  // every rectangular selection get cleaned with both rules and lose the column
  // alignment the rule exists to protect, and the fallback is silent by design.
  // So the assumption is pinned against the real library rather than only against
  // a stub that repeats it. lib/xterm.js is the esbuild input for the shipped
  // vendor bundle, so it is the file that decides what runs in the browser.
  const xtermLib = readFileSync(resolve(import.meta.dirname, '../node_modules/@xterm/xterm/lib/xterm.js'), 'utf8');

  it('still branches on _activeSelectionMode === 3 for a column selection', () => {
    expect(xtermLib).toContain('3===this._activeSelectionMode');
  });

  it('still reaches that field through _selectionService', () => {
    expect(xtermLib).toContain('_selectionService');
  });
});

describe('copyTerminalSelection — what reaches the clipboard', () => {
  it('copies the cleaned text, never the padded rows', () => {
    const { app, setSelection } = loadHarness();
    setSelection('  first line      \n  second line     ');
    return app.copyTerminalSelection().then((ok: boolean) => {
      expect(ok).toBe(true);
      expect(app._copyText).toHaveBeenCalledWith('  first line\n  second line');
    });
  });

  it('cleans a realistic TUI block, padding only', () => {
    const { app, setSelection } = loadHarness();
    const pane = ['  That last point is the important one.   ', '  Claude Code writes each paragraph.      '].join(
      '\n'
    );
    setSelection(pane);
    return app.copyTerminalSelection().then(() => {
      expect(app._copyText).toHaveBeenCalledWith(
        '  That last point is the important one.\n  Claude Code writes each paragraph.'
      );
    });
  });

  it('clears a padding-only selection rather than leaving a dead highlight', () => {
    // The clear is feedback, not protection: the Ctrl+C gate tests the CLEANED
    // selection, so a padding-only one falls through to the PTY either way.
    const { app, toasts, setSelection } = loadHarness();
    const terminal = setSelection('                 ');
    return app.copyTerminalSelection().then((ok: boolean) => {
      expect(ok).toBe(false);
      expect(app._copyText).not.toHaveBeenCalled();
      expect(terminal.clearSelection).toHaveBeenCalledTimes(1);
      expect(toasts).toEqual([{ message: 'Nothing to copy', type: 'warning' }]);
    });
  });

  it('rejects a multi-row padding selection instead of copying bare newlines', () => {
    const { app, setSelection } = loadHarness();
    const terminal = setSelection('      \n        \n   ');
    return app.copyTerminalSelection().then((ok: boolean) => {
      expect(ok).toBe(false);
      expect(app._copyText).not.toHaveBeenCalled();
      expect(terminal.clearSelection).toHaveBeenCalledTimes(1);
    });
  });

  // Every case above runs on the harness default mode, which declares no gutter,
  // so none of them can see a margin stripped twice. These two run on a mode that
  // declares one.
  it('takes the declared width off a claude pane exactly once', () => {
    const { app, setSelection } = loadHarness();
    setSelection('      fix(terminal): trim it', { mode: 'claude', from: 1, to: 2 });
    return app.copyTerminalSelection().then(() => {
      // 2 gutter columns off a body that carries 4 of its own.
      expect(app._copyText).toHaveBeenCalledWith('    fix(terminal): trim it');
    });
  });

  it("keeps a nested block's own indentation on a claude pane", () => {
    const { app, setSelection } = loadHarness();
    setSelection('    build:\n      steps:\n        - run: npm ci', { mode: 'claude', from: 1, to: 4 });
    return app.copyTerminalSelection().then(() => {
      expect(app._copyText).toHaveBeenCalledWith('  build:\n    steps:\n      - run: npm ci');
    });
  });
});

describe('the margin strip is not idempotent, so no caller may clean twice', () => {
  // The trailing trim is a fixed point, and copyTerminalSelection leaned on that
  // by re-cleaning whatever it was handed. The margin strip broke it: it takes
  // the narrower of the declared width and the run every line shares, so a
  // second pass takes up to `margin` columns more. Ctrl+C cleaned to decide
  // whether to copy and then passed the CLEANED string on, which dedented every
  // claude and codex copy twice on the most-used copy path of the four.
  it('takes more off a block that has already been stripped', () => {
    const h = loadHarness();
    const clean = h.windowRef.CodemanCopySelection.clean;
    const once = clean('      fix(terminal): trim it', { margin: 2 });
    expect(once).toBe('    fix(terminal): trim it');
    expect(clean(once, { margin: 2 })).toBe('  fix(terminal): trim it');
  });

  it('is pinned in the Ctrl+C branch, which gates on the clean and copies the raw', () => {
    // The branch lives inside initTerminal's attachCustomKeyEventHandler closure,
    // over a real xterm this harness cannot build, so the rule is pinned at the
    // source rather than driven by a keystroke.
    const terminalUi = read('terminal-ui.js');
    const branch = terminalUi.slice(
      terminalUi.indexOf('if (this.shouldCopyTerminalSelectionFromShortcut?.(ev)) {'),
      terminalUi.indexOf('// Session-sidebar toggle chord')
    );
    expect(branch).toContain('const selection = this.cleanedTerminalSelection(raw);');
    expect(branch).toContain('void this.copyTerminalSelection(raw);');
    expect(branch).not.toContain('this.copyTerminalSelection(selection)');
  });
});

describe('_flushAutoCopySelection — cleaned text is what Auto Copy handles', () => {
  it('copies the cleaned text and remembers it for the dedupe', () => {
    const { app, setSelection } = loadHarness();
    setSelection('  first line      \n  second line     ');
    app._autoCopyPending = true;
    return app._flushAutoCopySelection().then(() => {
      expect(app._copyText).toHaveBeenCalledWith('  first line\n  second line');
      expect(app._autoCopyLastText).toBe('  first line\n  second line');
    });
  });

  it('reads nothing at all while the toggle is off', () => {
    // Auto Copy defaults to OFF, and a selection can run to the scrollback
    // ceiling, so the flush must not read or clean before it checks.
    const { app, setSelection } = loadHarness();
    const terminal = setSelection('  first line      \n  second line     ');
    terminal.getSelection = vi.fn(() => '  first line      ');
    app.loadAppSettingsFromStorage = () => ({ autoCopySelection: false });
    app._autoCopyPending = true;
    return app._flushAutoCopySelection().then(() => {
      expect(terminal.getSelection).not.toHaveBeenCalled();
      expect(app._copyText).not.toHaveBeenCalled();
    });
  });
});
