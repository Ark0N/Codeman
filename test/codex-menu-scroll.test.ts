/**
 * Codex's selection menus (the "Implement this plan?" prompt, the /model, /permissions and /review pickers,
 * approvals, questions, the trust prompt) take PageUp and PageDown as "move the selection". Codeman turns
 * the wheel into those keys for a Codex pane that does not track the mouse (codex-cli 0.162 and 0.164 never
 * do), so a wheel notch walked the cursor through the options: one notch down landed on "No, stay in Plan
 * mode", one up on "Yes, implement this plan". The pane must consume the wheel there and send nothing.
 *
 * The screens are the live `tmux capture-pane` frames in test/fixtures/codex-dialogs/.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { STOCK_CLIS } from '../src/config/cli-registry/stock.js';

const PAGE_KEY_MODES = STOCK_CLIS.filter((e) => e.capabilities.transcriptPageKeys === true).map((e) => e.id);
const publicDir = resolve(import.meta.dirname, '../src/web/public');
const fixture = (name: string) => readFileSync(resolve(import.meta.dirname, 'fixtures/codex-dialogs', name), 'utf8');

/** A terminal whose screen shows `text`, padded to `rows` rows (what xterm holds for a hollow pane). */
function terminalShowing(text: string, rows = 40) {
  const lines = text.replace(/\n+$/, '').split('\n');
  // A capture taller than the pane keeps its bottom rows (the menu), a shorter one sits at the top.
  const shown = lines.length > rows ? lines.slice(-rows) : lines;
  const screen = Array.from({ length: rows }, (_, i) => shown[i] ?? '');
  return {
    cols: 100,
    rows,
    modes: { mouseTrackingMode: 'none' },
    buffer: {
      active: {
        type: 'normal',
        baseY: 0,
        viewportY: 0,
        length: rows,
        getLine: (y: number) => (screen[y] === undefined ? undefined : { translateToString: () => screen[y] }),
      },
    },
  };
}

function load() {
  const CodemanApp = function CodemanApp(this: any) {};
  const windowRef: Record<string, any> = { __codemanTranscriptPageKeys: PAGE_KEY_MODES };
  const context = vm.createContext({
    window: windowRef,
    CodemanApp,
    console: { warn: vi.fn(), log: vi.fn() },
    _crashDiag: { log: vi.fn() },
    performance: { now: () => 1_000 },
    requestAnimationFrame: () => 1,
    setTimeout: () => 1,
    clearTimeout: () => undefined,
    Blob: function Blob() {},
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
    Worker: function Worker(this: any) {
      this.postMessage = () => {};
    },
    MobileDetection: { isTouchDevice: () => true },
    DEC_SYNC_STRIP_RE: /\x1b\[\?2026[hl]/g,
    OSC52_STRIP_RE: /\x1b\]52;[^\x07\x1b]*(?:\x07|\x1b\\)/g,
    TERMINAL_CHUNK_SIZE: 32 * 1024,
  });
  vm.runInContext(readFileSync(resolve(publicDir, 'terminal-ui.js'), 'utf8'), context, { filename: 'terminal-ui.js' });
  return { app: new (CodemanApp as any)(), windowRef };
}

/** Every dialog or menu a Codex pane can be sitting in, and the screens where PageUp must still page. */
const MENUS = [
  'implement-plan.txt',
  'model-popup.txt',
  'permissions-popup.txt',
  'review-popup.txt',
  'exec-approval.txt',
  'exec-approval-w36.txt',
  'edit-approval.txt',
  'question.txt',
  'question-1of2.txt',
  'question-notes.txt',
  'trust-dialog.txt',
  'trust-dialog-back.txt',
  'trust-dialog-w40.txt',
  'exec-approval-w44.txt',
  'exec-approval-60x14.txt',
  'exec-approval-long-command.txt',
  'network-escalation-approval.txt',
  'question-option2-selected.txt',
  'question-2of2-submit-all.txt',
  'question-notes-typed.txt',
  'question-w36.txt', // the key hint one segment per row
  'question-w60.txt',
];
const NOT_MENUS = [
  'idle-start.txt',
  'composer-typed.txt',
  'working.txt',
  'after-approve.txt',
  'after-deny.txt',
  'after-question.txt',
  'slash-popup.txt',
  'transcript-quotes-dialog.txt',
  'composer-typed-dialog-text.txt',
  'composer-typed-dialog-text-w60.txt',
];

describe('isCodexSelectionMenu on live captures', () => {
  const { windowRef } = load();
  const isMenu = (name: string) => windowRef.CodemanTerminalInput.isCodexSelectionMenu(terminalShowing(fixture(name)));

  it.each(MENUS)('reads %s as a menu', (name) => {
    expect(isMenu(name), name).toBe(true);
  });

  it.each(NOT_MENUS)('does not read %s as a menu', (name) => {
    expect(isMenu(name), name).toBe(false);
  });

  it('still reads a narrow question whose option descriptions wrap over many rows', () => {
    // The selected option sat 16 rows up from the bottom at 36 columns; sentence-length descriptions on
    // a phone-width pane push it further, and an earlier row cap lost it (the menu was missed and the
    // wheel moved the selection again).
    const rows = fixture('question-w36.txt').split('\n');
    const at = rows.findIndex((row) => /^\s{0,2}› 1\./.test(row));
    expect(at).toBeGreaterThan(-1);
    rows.splice(at + 1, 0, ...Array.from({ length: 12 }, (_, i) => `      wrapped description row ${i + 1}`));
    const terminal = terminalShowing(rows.join('\n'), 60);
    expect(windowRef.CodemanTerminalInput.isCodexSelectionMenu(terminal)).toBe(true);
  });

  it('is false for a terminal it cannot read', () => {
    expect(windowRef.CodemanTerminalInput.isCodexSelectionMenu(undefined)).toBe(false);
    expect(windowRef.CodemanTerminalInput.isCodexSelectionMenu({ rows: 10, buffer: { active: { baseY: 0 } } })).toBe(
      false
    );
  });
});

describe('the wheel over a Codex pane', () => {
  function codexPane(screen: string) {
    const { app } = load();
    const sent: string[] = [];
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'codex', cliMouseTracking: false }]]);
    app._sendInputEphemeral = (_id: string, data: string) => sent.push(data);
    app.terminal = terminalShowing(screen);
    return { app, sent };
  }

  it('sends no page key while the "Implement this plan?" menu is open, and consumes the wheel', () => {
    const { app, sent } = codexPane(fixture('implement-plan.txt'));
    for (const lines of [-30, 30, -30, 30]) expect(app._maybePageCliTranscript({ shiftKey: false }, lines)).toBe(true);
    app._flushWheelSgrQueue();
    expect(sent).toEqual([]);
  });

  it('still pages the transcript from the composer', () => {
    const { app, sent } = codexPane(fixture('composer-typed.txt'));
    expect(app._maybePageCliTranscript({ shiftKey: false }, -30)).toBe(true);
    app._flushWheelSgrQueue();
    expect(sent).toEqual(['\x1b[5~']);
  });

  it('only looks at Codex: another page-key CLI showing the same text is paged as before', () => {
    const { app, sent } = codexPane(fixture('implement-plan.txt'));
    app.sessions.set('sess-1', { mode: 'opencode' });
    app._maybePageCliTranscript({ shiftKey: false }, -30);
    app._flushWheelSgrQueue();
    expect(sent).toEqual(['\x1b[5~']);
  });
});

describe('a tile asks the same question', () => {
  it('consumes the wheel for an open Codex menu in its own terminal and session', () => {
    const tile = readFileSync(resolve(publicDir, 'terminal-tile.js'), 'utf8');
    expect(tile).toContain('app._codexMenuOpen?.({ terminal: this.terminal, sessionId: this.sessionId })');
    const { app } = load();
    app.sessions = new Map([
      ['active', { mode: 'claude' }],
      ['tile', { mode: 'codex' }],
    ]);
    app.terminal = terminalShowing(fixture('composer-typed.txt'));
    const tileTerminal = terminalShowing(fixture('implement-plan.txt'));
    // the tile's own terminal and session decide, not the active pane's
    expect(app._codexMenuOpen({ terminal: tileTerminal, sessionId: 'tile' })).toBe(true);
    expect(app._codexMenuOpen({ terminal: tileTerminal, sessionId: 'active' })).toBe(false);
    expect(app._codexMenuOpen()).toBe(false);
  });
});
