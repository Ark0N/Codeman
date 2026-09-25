/**
 * Covers `buildPasteTextCommands()` and `pasteText()`: the text half of a text+Enter
 * submit (`sendInput`) goes in as ONE bracketed paste.
 *
 * Why: `send-keys -l` typed the text as an unmarked burst, and Codex's paste-burst
 * heuristic folded the Enter that followed 50 ms later into the paste as a newline,
 * so the prompt sat in the composer unsubmitted (always at 1500 chars, sometimes for
 * a one-line prompt). With `paste-buffer -p` the paste is marked and the separate
 * Enter submits.
 *
 * Strategy: pure command shape, plus a round trip through a real shell with a fake
 * `tmux` that prints its argv, so quoting and tmux's trailing-`;` rule are checked
 * on the bytes a shell actually hands over. `pasteText` runs against a recording
 * runner. No real tmux.
 *
 * Port: N/A (no server / no real tmux)
 */
import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { buildPasteTextCommands, pasteText } from '../src/tmux-manager.js';

const FAKE_TMUX = `${JSON.stringify(process.execPath)} -e 'console.log(JSON.stringify(process.argv.slice(1)))' --`;

function argvOf(cmd: string): string[] {
  return JSON.parse(execSync(cmd, { encoding: 'utf-8' })) as string[];
}

describe('buildPasteTextCommands', () => {
  it('fills a buffer, pastes it bracketed into the target and deletes it', () => {
    const { set, paste, discard } = buildPasteTextCommands('tmux -L codeman', 'codeman-abc12345', 'hello');
    const buffer = /set-buffer -b (\S+) -- /.exec(set)?.[1];
    expect(buffer).toMatch(/^codeman-submit-\d+-\d+$/);
    expect(set).toBe(`tmux -L codeman set-buffer -b ${buffer} -- 'hello'`);
    expect(paste).toBe(`tmux -L codeman paste-buffer -p -d -b ${buffer} -t 'codeman-abc12345'`);
    expect(discard).toBe(`tmux -L codeman delete-buffer -b ${buffer}`);
  });

  it('never types the text with send-keys (the unmarked burst Codex misreads)', () => {
    for (const cmd of Object.values(buildPasteTextCommands('tmux', 'codeman-abc12345', 'read your inbox'))) {
      expect(cmd).not.toContain('send-keys');
    }
  });

  it('uses a fresh buffer per call, so concurrent sends cannot paste each other', () => {
    const a = buildPasteTextCommands('tmux', 't', 'a').set;
    const b = buildPasteTextCommands('tmux', 't', 'b').set;
    expect(/-b (\S+)/.exec(a)?.[1]).not.toBe(/-b (\S+)/.exec(b)?.[1]);
  });

  it.each([
    ['quotes and shell syntax', `it's "quoted" $HOME \`id\` $(id) & | > <`],
    ['tmux format syntax', '#{session_name} #S'],
    ['leading dash', '-t other --help'],
    ['non-ASCII', 'Mailbox lesen — äöü “x”'],
    ['a long prompt', 'x'.repeat(1500)],
  ])('hands the text to tmux unchanged through the shell: %s', (_label, text) => {
    const { set } = buildPasteTextCommands(FAKE_TMUX, 't', text);
    expect(argvOf(set).at(-1)).toBe(text);
  });

  it.each([
    ['x;', 'x\\;'],
    [';', '\\;'],
    ['x;;', 'x;\\;'],
    ['x\\;', 'x\\\\;'],
  ])('escapes a trailing ";" (tmux command separator): %s', (text, expected) => {
    const { set } = buildPasteTextCommands(FAKE_TMUX, 't', text);
    expect(argvOf(set).at(-1)).toBe(expected);
  });

  it('leaves a ";" inside the text alone', () => {
    const { set } = buildPasteTextCommands(FAKE_TMUX, 't', 'a; b');
    expect(argvOf(set).at(-1)).toBe('a; b');
  });
});

describe('pasteText', () => {
  const cmds = { set: 'SET', paste: 'PASTE', discard: 'DISCARD' };

  function recorder(failOn: string[] = []) {
    const ran: string[] = [];
    const run = async (cmd: string) => {
      ran.push(cmd);
      if (failOn.includes(cmd)) throw new Error(`${cmd} failed`);
    };
    return { ran, run };
  }

  it('fills the buffer, then pastes it; the paste deletes it, so nothing else runs', async () => {
    const { ran, run } = recorder();
    await pasteText(run, cmds);
    expect(ran).toEqual(['SET', 'PASTE']);
  });

  it('deletes the buffer when the paste fails, and reports the paste error', async () => {
    const { ran, run } = recorder(['PASTE']);
    await expect(pasteText(run, cmds)).rejects.toThrow('PASTE failed');
    expect(ran).toEqual(['SET', 'PASTE', 'DISCARD']);
  });

  it('still reports the paste error when the delete fails too', async () => {
    const { ran, run } = recorder(['PASTE', 'DISCARD']);
    await expect(pasteText(run, cmds)).rejects.toThrow('PASTE failed');
    expect(ran).toEqual(['SET', 'PASTE', 'DISCARD']);
  });

  it('does not paste when filling the buffer failed', async () => {
    const { ran, run } = recorder(['SET']);
    await expect(pasteText(run, cmds)).rejects.toThrow('SET failed');
    expect(ran).toEqual(['SET']);
  });
});

describe('sendInput wiring', () => {
  // sendInput() returns before touching tmux under vitest (IS_TEST_MODE), so the
  // branch that submits text is pinned on the source instead.
  it('submits text through pasteText, not send-keys -l', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/tmux-manager.ts', import.meta.url), 'utf-8');
    const body = src.slice(src.indexOf('async sendInput('), src.indexOf('// ========== Pane Methods'));
    const submitBranch = body.slice(
      body.indexOf('if (textPart && hasCarriageReturn)'),
      body.indexOf('} else if (textPart)')
    );
    expect(submitBranch).toContain('pasteText(');
    expect(submitBranch).toContain('buildPasteTextCommands(');
    expect(submitBranch).not.toMatch(/send-keys[^`]*-l/);
  });
});
