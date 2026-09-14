/**
 * @fileoverview Terminal font weight: live apply, and the plumbing around it.
 *
 * Bold text on the theme's default foreground carries exactly ONE cue, the
 * weight step. Claude Code marks its markdown bold with a bare `ESC[1m` and no
 * colour change, and xterm substitutes a bright colour for bold only when the
 * foreground is a palette index below 8, so nothing else distinguishes it. A
 * family that ships only a regular and a bold face keeps that step small, and
 * 400 stays 400 whatever family is picked — which is why the NORMAL slot is
 * settable at all.
 *
 * Three things are pinned here because each fails silently:
 *
 *  - A live save reaches the echo overlays and the Agent Teams panes. Both
 *    cache the weight (the overlays paint it into their spans, the panes read
 *    their options at construction), so without the propagation the characters
 *    being typed, or a pane left open across the save, keep the old weight
 *    beside a repainted terminal.
 *  - An unchanged save is a no-op, so opening and closing App Settings does not
 *    churn the terminal.
 *  - The bundled face is declared over its full axis. The `@font-face`
 *    descriptor, not the file, is what the browser synthesizes from: at
 *    `400 700` every weight below 400 renders identically to 400, so the
 *    setting would be inert for anyone without Fira Code or Cascadia Code
 *    installed.
 *
 * Loaded via `vm` with a stubbed context (no jsdom — jsdom is broken on this
 * box; see connection-indicator.test.ts), matching terminal-font-settle.test.ts.
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const publicDir = resolve(import.meta.dirname, '../src/web/public');

function loadTerminalMixin(): Record<string, unknown> {
  const FakeCodemanApp = function () {} as unknown as { prototype: Record<string, unknown> };
  const context = vm.createContext({
    console,
    performance,
    setTimeout,
    clearTimeout,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    requestAnimationFrame: vi.fn(),
    CodemanApp: FakeCodemanApp,
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    document: undefined,
  });
  const constants = readFileSync(resolve(publicDir, 'constants.js'), 'utf8');
  const source = readFileSync(resolve(publicDir, 'terminal-ui.js'), 'utf8');
  vm.runInContext(`${constants}\n${source}`, context);
  // constants.js publishes CodemanTerminalFont onto the context's window, which
  // is the one the mixin closes over.
  return FakeCodemanApp.prototype;
}

const mixin = loadTerminalMixin();

function fakeTerminal(options: Record<string, unknown> = {}) {
  return { options: { fontFamily: '"JetBrains Mono"', fontSize: 14, ...options } };
}

function makeApp(opts: { teammates?: number; terminal?: ReturnType<typeof fakeTerminal> | null } = {}) {
  const fit = vi.fn();
  const teammateFits: ReturnType<typeof vi.fn>[] = [];
  const teammateTerminals = new Map<string, { terminal: ReturnType<typeof fakeTerminal>; fitAddon: unknown }>();
  for (let i = 0; i < (opts.teammates ?? 0); i++) {
    const teammateFit = vi.fn();
    teammateFits.push(teammateFit);
    teammateTerminals.set(`agent-${i}`, { terminal: fakeTerminal(), fitAddon: { fit: teammateFit } });
  }
  const app = {
    applyTerminalFontWeights: mixin.applyTerminalFontWeights,
    _awaitTerminalFont: vi.fn(() => Promise.resolve()),
    terminal: opts.terminal === undefined ? fakeTerminal() : opts.terminal,
    fitAddon: { fit },
    teammateTerminals,
    _localEchoOverlay: { refreshFont: vi.fn() },
    _predictiveEcho: { refreshFont: vi.fn() },
    _terminalFontReady: null as unknown,
  };
  return { app, fit, teammateFits, teammateTerminals };
}

describe('applyTerminalFontWeights', () => {
  it('writes both slots to the live terminal', () => {
    const { app, fit } = makeApp();

    (app as unknown as { applyTerminalFontWeights: (s: unknown) => void }).applyTerminalFontWeights({
      terminalFontWeight: '300',
      terminalFontWeightBold: '800',
    });

    expect(app.terminal?.options.fontWeight).toBe(300);
    expect(app.terminal?.options.fontWeightBold).toBe(800);
    expect(fit).toHaveBeenCalled();
  });

  it('refreshes the echo overlays, which cache the weight and paint it', () => {
    // Without this the characters being typed keep the old weight while the
    // rest of the screen changes — most visible on a phone, where local echo
    // is on by default.
    const { app } = makeApp();

    (app as unknown as { applyTerminalFontWeights: (s: unknown) => void }).applyTerminalFontWeights({
      terminalFontWeight: '300',
    });

    expect(app._localEchoOverlay.refreshFont).toHaveBeenCalledTimes(1);
    expect(app._predictiveEcho.refreshFont).toHaveBeenCalledTimes(1);
  });

  it('reaches Agent Teams panes, which read their options at construction', () => {
    const { app, teammateTerminals, teammateFits } = makeApp({ teammates: 2 });

    (app as unknown as { applyTerminalFontWeights: (s: unknown) => void }).applyTerminalFontWeights({
      terminalFontWeight: '300',
      terminalFontWeightBold: '800',
    });

    for (const [, entry] of teammateTerminals) {
      expect(entry.terminal.options.fontWeight).toBe(300);
      expect(entry.terminal.options.fontWeightBold).toBe(800);
    }
    for (const teammateFit of teammateFits) expect(teammateFit).toHaveBeenCalled();
  });

  it('restores xterm’s own defaults when the setting is cleared', () => {
    const { app } = makeApp({ terminal: fakeTerminal({ fontWeight: 300, fontWeightBold: 800 }) });

    (app as unknown as { applyTerminalFontWeights: (s: unknown) => void }).applyTerminalFontWeights({});

    expect(app.terminal?.options.fontWeight).toBe('normal');
    expect(app.terminal?.options.fontWeightBold).toBe('bold');
  });

  it('does nothing when neither slot changed', () => {
    // saveAppSettings runs on every close of the modal.
    const { app, fit } = makeApp({ terminal: fakeTerminal({ fontWeight: 300, fontWeightBold: 'bold' }) });

    (app as unknown as { applyTerminalFontWeights: (s: unknown) => void }).applyTerminalFontWeights({
      terminalFontWeight: 300,
    });

    expect(fit).not.toHaveBeenCalled();
    expect(app._localEchoOverlay.refreshFont).not.toHaveBeenCalled();
    expect(app._awaitTerminalFont).not.toHaveBeenCalled();
  });

  it('re-arms the font wait, so a fit lands once the face is rasterized', () => {
    const { app } = makeApp();

    (app as unknown as { applyTerminalFontWeights: (s: unknown) => void }).applyTerminalFontWeights({
      terminalFontWeight: '300',
    });

    expect(app._awaitTerminalFont).toHaveBeenCalledTimes(1);
    expect(app._terminalFontReady).toBeInstanceOf(Promise);
  });

  it('survives a terminal that does not exist yet', () => {
    const { app } = makeApp({ terminal: null });

    expect(() =>
      (app as unknown as { applyTerminalFontWeights: (s: unknown) => void }).applyTerminalFontWeights({
        terminalFontWeight: '300',
      })
    ).not.toThrow();
  });
});

describe('bundled terminal face', () => {
  const styles = readFileSync(resolve(publicDir, 'styles.css'), 'utf8');

  it('is declared over its full weight axis, not xterm’s default span', () => {
    // The woff2 carries a `wght` axis of 100 to 800. A narrower @font-face
    // descriptor CLAMPS it: at `400 700`, 100/200/300 all render identically to
    // 400 and 800 identically to 700, so the settings above would be a no-op
    // for every install without Fira Code or Cascadia Code.
    const face = styles.slice(styles.indexOf("font-family: 'JetBrains Mono'"));
    const declared = /font-weight:\s*(\d+)\s+(\d+)/.exec(face.slice(0, face.indexOf('}')));
    expect(declared, 'the bundled mono face must declare a weight RANGE').not.toBeNull();
    expect(Number(declared![1])).toBeLessThanOrEqual(100);
    expect(Number(declared![2])).toBeGreaterThanOrEqual(800);
  });
});

describe('terminal font weight settings plumbing', () => {
  const settingsUi = readFileSync(resolve(publicDir, 'settings-ui.js'), 'utf8');
  const html = readFileSync(resolve(publicDir, 'index.html'), 'utf8');
  const keys = ['terminalFontWeight', 'terminalFontWeightBold'] as const;

  it('offers both selects with a Default entry and the 100-900 steps', () => {
    for (const id of ['appSettingsTerminalFontWeight', 'appSettingsTerminalFontWeightBold']) {
      const start = html.indexOf(`<select id="${id}"`);
      expect(start, `${id} missing from index.html`).toBeGreaterThan(-1);
      const select = html.slice(start, html.indexOf('</select>', start));
      expect(select).toContain('<option value="">');
      for (let w = 100; w <= 900; w += 100) expect(select).toContain(`<option value="${w}">`);
    }
  });

  it('treats both as per-device, which is TWO separate decisions', () => {
    // Membership in displayKeys keeps one device from overwriting another's
    // value; the strip before the PUT is what stops the .strict() schema from
    // 400-ing the whole settings save.
    const displayKeys = settingsUi.slice(settingsUi.indexOf('const displayKeys = new Set(['));
    const listed = displayKeys.slice(0, displayKeys.indexOf(']);'));
    const stripped = settingsUi.slice(settingsUi.indexOf('const {', settingsUi.indexOf('async saveAppSettings()')));
    for (const key of keys) {
      expect(listed, `${key} must be a display key`).toContain(`'${key}'`);
      expect(stripped.slice(0, stripped.indexOf('} = settings;')), `${key} must be stripped from the PUT`).toContain(
        `${key}: _`
      );
    }
  });

  it('drops a custom entry a previous open added', () => {
    // The modal is opened again and again, and a custom entry is only ever right for
    // the value it was added for. Without the cleanup a picker that visited 350, then
    // 200, then 400 ends up offering all three, none of them stored.
    const populate = settingsUi.slice(settingsUi.indexOf('populateTerminalFontWeight(select, value) {'));
    const body = populate.slice(0, populate.indexOf('\n  },'));
    expect(body).toContain('option[data-custom="1"]');
    expect(body).toContain('.remove()');
    // The marker has to be SET too, or the cleanup above matches nothing.
    expect(body).toContain("dataset.custom = '1'");
    // …and the removal must run before the add, or it takes out the entry it just made.
    expect(body.indexOf('.remove()')).toBeLessThan(body.indexOf('createElement'));
  });

  it('applies the save to the live terminal', () => {
    const save = settingsUi.slice(settingsUi.indexOf('async saveAppSettings()'));
    expect(save.slice(0, save.indexOf('\n  },'))).toContain('this.applyTerminalFontWeights?.(settings)');
  });
});
