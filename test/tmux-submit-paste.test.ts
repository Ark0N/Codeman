/**
 * Covers `buildPasteTextCommands()` and `pasteText()`: the text half of a text+Enter
 * submit (`sendInput`) goes in as ONE bracketed paste. Also `submitsAsKeys()`: a
 * single character is typed instead, since a selection dialog ignores a pasted `3`
 * and the Enter then confirms the highlighted option. And
 * `escapeTmuxTrailingSemicolon()`, which every literal text path runs through.
 *
 * Why: `send-keys -l` typed the text as an unmarked burst, and Codex's paste-burst
 * heuristic folded the Enter that followed 50 ms later into the paste as a newline,
 * so the prompt sat in the composer unsubmitted (always at 1500 chars, sometimes for
 * a one-line prompt). With `paste-buffer -p` the paste is marked and the separate
 * Enter submits.
 *
 * Also the line breaks of a multi-line `sendInput`: kept, and pasted as ONE block
 * with or without the Enter, where they used to be stripped and the lines joined.
 *
 * Strategy: pure command shape, plus a round trip through a real shell with a fake
 * `tmux` that prints its argv, so quoting and tmux's trailing-`;` rule are checked
 * on the bytes a shell actually hands over. `pasteText` runs against a recording
 * runner, and `sendInput` against a subclass whose `inputRunner()` records the
 * commands instead of running them. No real tmux.
 *
 * Port: N/A (no server / no real tmux)
 */
import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { MuxSession } from '../src/mux-interface.js';
import {
  TmuxManager,
  buildPasteTextCommands,
  escapeTmuxTrailingSemicolon,
  pasteText,
  submitsAsKeys,
} from '../src/tmux-manager.js';

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

describe('submitsAsKeys', () => {
  it.each(['3', '9', 'y', 'n', ';', 'ä', '👍'])('types a single character: %s', (text) => {
    expect(submitsAsKeys(text)).toBe(true);
  });

  it.each(['10', 'yes', '/cost', 'read your inbox', 'x'.repeat(1500)])('pastes anything longer: %s', (text) => {
    expect(submitsAsKeys(text)).toBe(false);
  });
});

describe('escapeTmuxTrailingSemicolon', () => {
  it.each([
    ['x;', 'x\\;'],
    [';', '\\;'],
    ['a; b', 'a; b'],
    ['plain', 'plain'],
  ])('%s -> %s', (text, expected) => {
    expect(escapeTmuxTrailingSemicolon(text)).toBe(expected);
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
  // These pin the branch shapes on the source; the commands sendInput actually runs
  // are recorded in 'sendInput line breaks' below.
  async function source(): Promise<string> {
    const { readFileSync } = await import('node:fs');
    return readFileSync(new URL('../src/tmux-manager.ts', import.meta.url), 'utf-8');
  }

  async function sendInputBody(): Promise<string> {
    const src = await source();
    return src.slice(src.indexOf('async sendInput('), src.indexOf('// ========== Pane Methods'));
  }

  it('submits text through pasteText, not send-keys -l', async () => {
    const body = await sendInputBody();
    const submitBranch = body.slice(
      body.indexOf('if (textPart && hasCarriageReturn)'),
      body.indexOf('} else if (textPart)')
    );
    const pasteBranch = submitBranch.slice(submitBranch.indexOf('} else {'));
    expect(pasteBranch).toContain('pasteText(');
    expect(pasteBranch).toContain('buildPasteTextCommands(');
    expect(pasteBranch).not.toMatch(/send-keys[^`]*-l/);
  });

  it('types a single-character submit with send-keys -l, so a dialog answer selects', async () => {
    const body = await sendInputBody();
    const keysBranch = body.slice(body.indexOf('if (submitsAsKeys(textPart))'), body.indexOf('} else {'));
    expect(keysBranch).toMatch(/send-keys[^`]*-l \$\{shellescape\(escapeTmuxTrailingSemicolon\(textPart\)\)\}/);
    expect(keysBranch).not.toContain('pasteText(');
  });

  it('escapes a trailing ";" on every send-keys -l in sendInput and sendInputToPane', async () => {
    const src = await source();
    const typed = src.match(/send-keys[^`\n]*-l \$\{[^`\n]*\}/g) ?? [];
    const inSend = [await sendInputBody(), src.slice(src.indexOf('sendInputToPane(muxName'))]
      .map((b) => b.slice(0, b.indexOf('\n  }\n')))
      .join('\n');
    const typedHere = typed.filter((cmd) => inSend.includes(cmd));
    expect(typedHere.length).toBe(4);
    for (const cmd of typedHere) expect(cmd).toContain('escapeTmuxTrailingSemicolon(textPart)');
  });
});

describe('sendInput line breaks', () => {
  class RecordingManager extends TmuxManager {
    ran: string[] = [];
    protected override inputRunner(): (cmd: string) => Promise<unknown> {
      return async (cmd: string) => {
        this.ran.push(cmd);
      };
    }
  }

  function managerWithSession(): RecordingManager {
    const manager = new RecordingManager();
    manager.registerSession({
      sessionId: 's1',
      muxName: 'codeman-abc12345',
      pid: 100,
      createdAt: 0,
      workingDir: '/tmp',
      mode: 'claude',
      attached: true,
    } as MuxSession);
    return manager;
  }

  /** The text a recorded `set-buffer` command hands to tmux, as a shell delivers it. */
  function bufferText(setBufferCmd: string): string {
    return argvOf(setBufferCmd.replace(/^.*? set-buffer /, `${FAKE_TMUX} set-buffer `)).at(-1) as string;
  }

  it('submits a multi-line prompt as one paste with its line breaks, then Enter', async () => {
    const manager = managerWithSession();
    expect(await manager.sendInput('s1', 'line one\nline two\n\nparagraph three\r')).toBe(true);

    expect(manager.ran).toHaveLength(3);
    const [set, paste, enter] = manager.ran;
    expect(bufferText(set)).toBe('line one\nline two\n\nparagraph three');
    expect(paste).toMatch(/ paste-buffer -p -d -b \S+ -t 'codeman-abc12345'$/);
    expect(enter).toMatch(/ send-keys -t "codeman-abc12345" Enter$/);
  });

  it('turns CRLF line endings into plain line breaks', async () => {
    const manager = managerWithSession();
    await manager.sendInput('s1', 'one\r\ntwo\r');
    expect(bufferText(manager.ran[0])).toBe('one\ntwo');
  });

  it('pastes multi-line text without Enter too, and never types it as keys', async () => {
    const manager = managerWithSession();
    await manager.sendInput('s1', 'one\ntwo');

    expect(manager.ran).toHaveLength(2);
    expect(bufferText(manager.ran[0])).toBe('one\ntwo');
    expect(manager.ran[1]).toContain(' paste-buffer -p ');
    for (const cmd of manager.ran) expect(cmd).not.toContain('send-keys');
  });

  it('drops trailing line breaks instead of pasting an empty last line', async () => {
    const manager = managerWithSession();
    await manager.sendInput('s1', 'one\ntwo\n\n\r');
    expect(bufferText(manager.ran[0])).toBe('one\ntwo');
  });

  it('drops leading line breaks instead of pasting an empty first line', async () => {
    const single = managerWithSession();
    await single.sendInput('s1', '\nfix it\r');
    expect(bufferText(single.ran[0])).toBe('fix it');

    const multi = managerWithSession();
    await multi.sendInput('s1', '\r\n\r\none\ntwo\r');
    expect(bufferText(multi.ran[0])).toBe('one\ntwo');

    // A blank first line made of spaces is dropped too; the first real line keeps its indentation.
    const spaced = managerWithSession();
    await spaced.sendInput('s1', '  \n\t\n  fix it\nnow\r');
    expect(bufferText(spaced.ran[0])).toBe('  fix it\nnow');

    // Without an Enter, what is left is one line, so it is typed like any other.
    const typed = managerWithSession();
    await typed.sendInput('s1', '\n\njust type');
    expect(typed.ran).toEqual([expect.stringMatching(/ send-keys -t "codeman-abc12345" -l 'just type'$/)]);
  });

  it('leaves single-line input as it was: pasted with Enter, typed without', async () => {
    const submitted = managerWithSession();
    await submitted.sendInput('s1', 'read your inbox\r');
    expect(bufferText(submitted.ran[0])).toBe('read your inbox');
    expect(submitted.ran.at(-1)).toMatch(/ send-keys -t "codeman-abc12345" Enter$/);

    const typed = managerWithSession();
    await typed.sendInput('s1', 'just type');
    expect(typed.ran).toHaveLength(1);
    expect(typed.ran[0]).toMatch(/ send-keys -t "codeman-abc12345" -l 'just type'$/);
  });
});
