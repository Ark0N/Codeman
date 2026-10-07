/**
 * Which model a session runs (`SessionState.displayModel`), for the tile grid's and the
 * split pane's headers: the pure resolver, the screen read with each CLI's registry
 * pattern, and the session that feeds them.
 *
 * The pane fixtures are verbatim `capture-pane -p` rows (trailing blanks trimmed) from
 * live panes on 2026-10-07: dsh-TUI 0.10.0-beta.1 on the owner's qwen route, and codex
 * 0.147.0. The codex 0.154.0 footer is the one `session-watching.test.ts` pins.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import { getCli } from '../src/config/cli-registry/index.js';
import { compileVersionRegex, countCaptureGroups } from '../src/config/cli-registry/patterns.js';
import { CliEntrySchema } from '../src/config/cli-registry/schema.js';
import {
  MAX_DISPLAY_MODEL_CHARS,
  launchModelFor,
  readScreenModel,
  resolveDisplayModel,
  restoredReportedModel,
  sanitizeModelName,
} from '../src/session-display-model.js';
import { IDLE_SILENCE_MS } from '../src/session-activity.js';

const detectOf = (mode: string) => getCli(mode)!.capabilities.modelDetect!;
const DSH = compileVersionRegex(detectOf('deepseek').screenLine)!;
const DSH_ROWS = detectOf('deepseek').screenLines;
const CODEX = compileVersionRegex(detectOf('codex').screenLine)!;
const CODEX_ROWS = detectOf('codex').screenLines;

const DSH_BORDER_TOP = '╭' + '─'.repeat(95) + '╮';
const DSH_BORDER_BOTTOM = '╰' + '─'.repeat(95) + '╯';
const DSH_COMPOSER = '❯' + ' '.repeat(95) + '⛶';
/** The foot of a dsh-TUI pane: transcript, the composer's rounded box, the status line. */
function dshPane(statusLine: string | null, transcript: string[] = []): string {
  return [
    '                                          Tip: Footer compact on = one merged line; off = metric…',
    '        Explore the uncharted!',
    ' ▶ （Ctrl+P to expand） Context loaded · System prompt 16 sections · Runtime context 2 items · …',
    ...transcript,
    DSH_BORDER_TOP,
    DSH_COMPOSER,
    DSH_BORDER_BOTTOM,
    ...(statusLine === null ? [] : [statusLine]),
    '',
  ].join('\n');
}
const DSH_LIVE = dshPane(' qwen3.8-27b · medium · th-scratch');

/** The foot of a codex pane: transcript, composer, then the status line on the last row. */
function codexPane(statusLine: string | null, transcript: string[] = []): string {
  return [
    '│ directory:   ~/codeman-cases/th-scratch       │',
    '│ permissions: YOLO mode                        │',
    '╰───────────────────────────────────────────────╯',
    '  Tip: New For a limited time, Codex is included in your',
    '  plan for free – let’s build together.',
    ...transcript,
    '› Explain this codebase',
    ...(statusLine === null ? [] : [statusLine]),
    '',
  ].join('\n');
}
const CODEX_LIVE = codexPane('  gpt-5.6-terra default · ~/codeman-cases/th-scratch');
const CODEX_154 = codexPane(
  '  gpt-5.6-sol medium · Context 98% left · ~/codeman-cases/codex-probe · 5h 99% left · weekly 94% left'
);

describe('the registry patterns', () => {
  it('compile through compileVersionRegex() with exactly one capture group', () => {
    for (const mode of ['deepseek', 'codex']) {
      const { screenLine } = detectOf(mode);
      expect(compileVersionRegex(screenLine), mode).not.toBeNull();
      expect(countCaptureGroups(screenLine), mode).toBe(1);
    }
  });

  it('are declared only where a footer was measured (claude reports through its statusline)', () => {
    expect(getCli('claude')!.capabilities.modelDetect).toBeUndefined();
    expect(getCli('shell')!.capabilities.modelDetect).toBeUndefined();
  });

  it('the schema refuses a pattern with no capture group, two of them, or one it will not run', () => {
    const codex = getCli('codex')!;
    const withDetect = (modelDetect: unknown) =>
      CliEntrySchema.safeParse({ ...codex, capabilities: { ...codex.capabilities, modelDetect } }).success;
    expect(withDetect({ screenLine: '^ {2}([a-z]+) · ' })).toBe(true);
    expect(withDetect({ screenLine: '^ {2}[a-z]+ · ' })).toBe(false);
    expect(withDetect({ screenLine: '^ {2}([a-z]+) (high) · ' })).toBe(false);
    expect(withDetect({ screenLine: '(a+)+$' })).toBe(false);
    expect(withDetect({ screenLine: '^(x)', screenLines: 9 })).toBe(false);
  });

  it('dsh also names a config reader for while its screen names no model', () => {
    expect(detectOf('deepseek').configResolver).toBe('deepseek-route');
    expect(detectOf('codex').configResolver).toBeUndefined();
  });

  it('the schema takes a known config reader alone, and refuses an empty or unknown one', () => {
    const codex = getCli('codex')!;
    const withDetect = (modelDetect: unknown) =>
      CliEntrySchema.safeParse({ ...codex, capabilities: { ...codex.capabilities, modelDetect } }).success;
    expect(withDetect({ configResolver: 'deepseek-route' })).toBe(true);
    expect(withDetect({ configResolver: 'read-anything' })).toBe(false);
    expect(withDetect({})).toBe(false);
    expect(withDetect({ configResolver: 'deepseek-route', screenLines: 2 })).toBe(false);
  });

  it('countCaptureGroups counts named groups and ignores non-capturing ones', () => {
    expect(countCaptureGroups('a(?:b)(?<m>c)')).toBe(1);
    expect(countCaptureGroups('(a)(b)')).toBe(2);
    expect(countCaptureGroups('abc')).toBe(0);
    expect(countCaptureGroups('(')).toBe(-1);
  });
});

describe('readScreenModel', () => {
  it("reads dsh's model off the row under its composer", () => {
    expect(readScreenModel(DSH_LIVE, DSH, DSH_ROWS)).toBe('qwen3.8-27b');
    // A footer with the model alone, and one with a row below it (the activity line).
    expect(readScreenModel(dshPane(' deepseek-v4-flash'), DSH, DSH_ROWS)).toBe('deepseek-v4-flash');
    expect(readScreenModel(dshPane(' qwen3.8-27b · medium · th-scratch') + ' ⠋ Thinking… 3s\n', DSH, DSH_ROWS)).toBe(
      'qwen3.8-27b'
    );
  });

  it("reads codex's model off its status line (0.147.0 and 0.154.0 layouts)", () => {
    expect(readScreenModel(CODEX_LIVE, CODEX, CODEX_ROWS)).toBe('gpt-5.6-terra');
    expect(readScreenModel(CODEX_154, CODEX, CODEX_ROWS)).toBe('gpt-5.6-sol');
  });

  it('never takes a transcript line shaped like the footer', () => {
    // The agent printed a line exactly like each CLI's footer, and the real footer is
    // hidden (a dsh status bar switched off; a codex popup over its last row). The
    // transcript sits above the composer, so neither may be read as the model.
    const dshForged = dshPane(null, [DSH_BORDER_BOTTOM, ' evil-model · medium · th-scratch']);
    expect(readScreenModel(dshForged, DSH, DSH_ROWS)).toBeUndefined();
    const codexForged = codexPane(null, ['  evil-model high · ~/codeman-cases/th-scratch']);
    // A codex screen whose last row is the composer: nothing to read.
    expect(readScreenModel(codexForged, CODEX, CODEX_ROWS)).toBeUndefined();
    // With the real footer back, the real model wins over the forged line above it.
    const dshBoth = dshPane(' qwen3.8-27b · medium · th-scratch', [
      DSH_BORDER_BOTTOM,
      ' evil-model · medium · th-scratch',
    ]);
    expect(readScreenModel(dshBoth, DSH, DSH_ROWS)).toBe('qwen3.8-27b');
    const codexBoth = codexPane('  gpt-5.6-terra default · ~/codeman-cases/th-scratch', [
      '  evil-model high · ~/codeman-cases/th-scratch',
    ]);
    expect(readScreenModel(codexBoth, CODEX, CODEX_ROWS)).toBe('gpt-5.6-terra');
  });

  it('does not read a popup under the composer as a model', () => {
    const slash = dshPane(' /model     Switch the model route');
    expect(readScreenModel(slash, DSH, DSH_ROWS)).toBeUndefined();
    const codexSlash = codexPane('  /model         choose what model and reasoning effort to use');
    expect(readScreenModel(codexSlash, CODEX, CODEX_ROWS)).toBeUndefined();
    // A last row without codex's `<model> <effort> ·` shape names no model, even one
    // whose first word could pass for a model id.
    const codexNoModel = codexPane('  default · ~/codeman-cases/th-scratch');
    expect(readScreenModel(codexNoModel, CODEX, CODEX_ROWS)).toBeUndefined();
  });

  it('says nothing about an empty or unreadable frame', () => {
    expect(readScreenModel('', DSH, DSH_ROWS)).toBeUndefined();
    expect(readScreenModel(null, CODEX, CODEX_ROWS)).toBeUndefined();
  });
});

describe('sanitizeModelName', () => {
  it('keeps markup as text: sanitizing is not escaping, the browser renders text', () => {
    expect(sanitizeModelName('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>');
  });

  it('drops escape sequences and control characters, and collapses whitespace', () => {
    expect(sanitizeModelName('\x1b[31mOpus\x1b[0m\t 4.8‮\n')).toBe('Opus 4.8');
    expect(sanitizeModelName('\x00\x07')).toBeUndefined();
    expect(sanitizeModelName('   ')).toBeUndefined();
    expect(sanitizeModelName(42)).toBeUndefined();
  });

  it(`caps the name at ${MAX_DISPLAY_MODEL_CHARS} characters`, () => {
    expect(sanitizeModelName('m'.repeat(500))).toHaveLength(MAX_DISPLAY_MODEL_CHARS);
  });
});

describe('resolveDisplayModel', () => {
  const reported = { model: 'Sonnet 4.6', source: 'statusline' as const };

  it('the custom endpoint wins, then the newest report, then the launch model', () => {
    expect(resolveDisplayModel({ customModelId: 'qwen3.8-27b', reported, launchModel: 'opus' })).toEqual({
      model: 'qwen3.8-27b',
      source: 'custom-endpoint',
    });
    expect(resolveDisplayModel({ reported, launchModel: 'opus' })).toEqual(reported);
    expect(resolveDisplayModel({ launchModel: 'opus' })).toEqual({ model: 'opus', source: 'launch' });
  });

  it("the config ranks below the CLI's own report and above the launch model", () => {
    expect(resolveDisplayModel({ reported, configModel: 'qwen3.8-27b', launchModel: 'opus' })).toEqual(reported);
    expect(resolveDisplayModel({ configModel: 'qwen3.8-27b', launchModel: 'opus' })).toEqual({
      model: 'qwen3.8-27b',
      source: 'config',
    });
    expect(resolveDisplayModel({ customModelId: 'm', configModel: 'qwen3.8-27b' })?.source).toBe('custom-endpoint');
    expect(resolveDisplayModel({ configModel: null, launchModel: 'opus' })?.source).toBe('launch');
  });

  it('knows nothing when nothing is known: no placeholder', () => {
    expect(resolveDisplayModel({})).toBeUndefined();
    expect(resolveDisplayModel({ customModelId: ' ', reported: null, launchModel: '' })).toBeUndefined();
  });
});

describe('restoredReportedModel', () => {
  it('restores what the CLI reported, never a derived answer', () => {
    expect(restoredReportedModel({ model: 'qwen3.8-27b', source: 'screen' })).toEqual({
      model: 'qwen3.8-27b',
      source: 'screen',
    });
    expect(restoredReportedModel({ model: 'Opus 4.8', source: 'statusline' })?.source).toBe('statusline');
    expect(restoredReportedModel({ model: 'opus', source: 'launch' })).toBeUndefined();
    expect(restoredReportedModel({ model: 'qwen3.8-27b', source: 'config' })).toBeUndefined();
    expect(restoredReportedModel({ model: 'x', source: 'custom-endpoint' })).toBeUndefined();
    expect(restoredReportedModel({ model: '', source: 'screen' })).toBeUndefined();
    expect(restoredReportedModel('screen')).toBeUndefined();
    expect(restoredReportedModel(undefined)).toBeUndefined();
  });
});

describe('launchModelFor', () => {
  it("reads the model param where each CLI's registry entry keeps it", () => {
    expect(launchModelFor('claude', { model: 'haiku' })).toBe('haiku');
    expect(launchModelFor('codex', { codexConfig: { model: 'gpt-5.5' } })).toBe('gpt-5.5');
    expect(launchModelFor('grok', { grokConfig: { model: 'grok-code-fast' } })).toBe('grok-code-fast');
    // Another CLI's config, or a top-level model, is not this CLI's launch model.
    expect(launchModelFor('codex', { model: 'opus', grokConfig: { model: 'x' } })).toBeUndefined();
  });

  it('has none for a CLI whose model is not a launch param', () => {
    expect(launchModelFor('deepseek', { model: 'opus', deepSeekConfig: { profile: 'dsh-tui' } })).toBeUndefined();
    expect(launchModelFor('shell', { model: 'opus' })).toBeUndefined();
    expect(launchModelFor('no-such-cli', { model: 'opus' })).toBeUndefined();
  });
});

describe('a session', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  type Internals = {
    _handleTerminalOutput(data: string): void;
    _detectInteractiveActivity(data: string): void;
    _customModel?: { endpointId: string; modelId: string; envKeys: string[] };
  };

  function withFakePane(mode: string, screen: () => string | null, extra: Record<string, unknown> = {}): Session {
    const mux = { isAvailable: () => true, capturePaneText: () => screen() } as unknown as NonNullable<
      ConstructorParameters<typeof Session>[0]
    >['mux'];
    return new Session({
      workingDir: '/tmp',
      mode,
      mux,
      muxSession: { muxName: 'codeman-test', sessionId: 'test', createdAt: Date.now() },
      ...extra,
    } as ConstructorParameters<typeof Session>[0]);
  }

  /** A composer repaint (arms the idle confirmation), then quiet: the probe reads the screen. */
  function settle(session: Session, glyph: string): void {
    const internals = session as unknown as Internals;
    for (let i = 0; i < 3; i++) {
      const frame = `\x1b[31;1H${glyph}\xa0`;
      internals._handleTerminalOutput(frame);
      internals._detectInteractiveActivity(frame);
      vi.advanceTimersByTime(1000);
    }
    vi.advanceTimersByTime(IDLE_SILENCE_MS + 2000);
  }

  it('publishes the model its footer names, and follows the footer when it changes', () => {
    vi.useFakeTimers();
    let screen = DSH_LIVE;
    const session = withFakePane('deepseek', () => screen);
    const changed = vi.fn();
    session.on('displayModelChanged', changed);
    expect(session.toState().displayModel).toBeUndefined();
    settle(session, '❯');
    expect(session.toState().displayModel).toEqual({ model: 'qwen3.8-27b', source: 'screen' });
    expect(changed).toHaveBeenCalledTimes(1);
    // The same footer again: nothing new to say.
    settle(session, '❯');
    expect(changed).toHaveBeenCalledTimes(1);
    // An in-session switch redraws the footer.
    screen = dshPane(' deepseek-v4-flash · high · th-scratch');
    settle(session, '❯');
    expect(session.toState().displayModel).toEqual({ model: 'deepseek-v4-flash', source: 'screen' });
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('keeps the last model when the footer cannot be read', () => {
    vi.useFakeTimers();
    let screen: string | null = CODEX_LIVE;
    const session = withFakePane('codex', () => screen);
    settle(session, '›');
    expect(session.toState().displayModel?.model).toBe('gpt-5.6-terra');
    screen = codexPane('  /model         choose what model and reasoning effort to use');
    settle(session, '›');
    screen = null;
    settle(session, '›');
    expect(session.toState().displayModel).toEqual({ model: 'gpt-5.6-terra', source: 'screen' });
  });

  it('a CLI without a footer pattern never reads one (a claude pane says nothing)', () => {
    vi.useFakeTimers();
    const session = withFakePane('claude', () => '❯ \n  Haiku 4.5  in:0 out:0\n');
    settle(session, '❯');
    expect(session.toState().displayModel).toBeUndefined();
  });

  it('shows the launch model until the CLI reports, and a custom endpoint over both', () => {
    const session = withFakePane('claude', () => null, { model: 'haiku' });
    expect(session.toState().displayModel).toEqual({ model: 'haiku', source: 'launch' });
    expect(session.noteReportedModel('statusline', 'Haiku 4.5')).toBe(true);
    expect(session.toState().displayModel).toEqual({ model: 'Haiku 4.5', source: 'statusline' });
    expect(session.noteReportedModel('statusline', 'Haiku 4.5')).toBe(false);
    expect(session.noteReportedModel('statusline', '')).toBe(false);
    (session as unknown as Internals)._customModel = { endpointId: 'e', modelId: 'qwen3.8-27b', envKeys: [] };
    expect(session.toState().displayModel).toEqual({ model: 'qwen3.8-27b', source: 'custom-endpoint' });
    (session as unknown as Internals)._customModel = undefined;
    expect(session.toState().displayModel?.model).toBe('Haiku 4.5');
  });

  it("an external CLI's launch model is its own config's, never the inert top-level one", () => {
    const codex = withFakePane('codex', () => null, { model: 'opus', codexConfig: { model: 'gpt-5.5' } });
    expect(codex.toState().displayModel).toEqual({ model: 'gpt-5.5', source: 'launch' });
    const dsh = withFakePane('deepseek', () => null, { model: 'opus', deepSeekConfig: { profile: 'dsh-tui' } });
    expect(dsh.toState().displayModel).toBeUndefined();
  });

  it('restores a reported model after a restart, until the next report replaces it', () => {
    const session = withFakePane('deepseek', () => null, {
      displayModel: { model: 'qwen3.8-27b', source: 'screen' },
    });
    expect(session.toState().displayModel).toEqual({ model: 'qwen3.8-27b', source: 'screen' });
    session.noteReportedModel('screen', 'deepseek-v4-flash');
    expect(session.toState().displayModel?.model).toBe('deepseek-v4-flash');
    // A launch answer from the previous run is derived again, not restored.
    const claude = withFakePane('claude', () => null, { displayModel: { model: 'opus', source: 'launch' } });
    expect(claude.toState().displayModel).toBeUndefined();
  });
});

describe('a dsh session over a fixture dsh home (end to end, no mocks)', () => {
  it('names the route its profile pins until the screen names one, then the screen', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-e2e-'));
    try {
      const home = join(root, 'dsh');
      mkdirSync(join(home, 'profiles', 'dsh-tui'), { recursive: true });
      writeFileSync(
        join(home, 'profiles', 'dsh-tui', 'package.json'),
        JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-harness-tui/dsh-tui'] } } })
      );
      writeFileSync(
        join(home, 'profiles', 'dsh-tui', 'cordis.patch.yml'),
        '- id: dsh-tui\n  config:\n    provider: qwen5090\n    model: qwen3.8-27b\n'
      );
      const session = new Session({
        workingDir: '/tmp',
        mode: 'deepseek',
        deepSeekConfig: { profile: 'dsh-tui' },
        envOverrides: { DSH_HOME: home },
      } as ConstructorParameters<typeof Session>[0]);
      await (session as unknown as { _withPaneLifecycle(op: () => Promise<void>): Promise<void> })._withPaneLifecycle(
        async () => {}
      );
      await vi.waitFor(() =>
        expect(session.toState().displayModel).toEqual({ model: 'qwen3.8-27b', source: 'config' })
      );
      session.noteReportedModel('screen', 'deepseek-v4-flash');
      expect(session.toState().displayModel).toEqual({ model: 'deepseek-v4-flash', source: 'screen' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
