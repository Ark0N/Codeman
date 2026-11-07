import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { REMOTE_CODEX_RESUME_PROBE } from '../src/discord-remote-conversation.js';
const exec = promisify(execFile);
const id = '01a1a603-1c4a-7f12-b20d-117d6b4da904';
async function probe(rows: string, panes = '100') {
  const script =
    `import subprocess\nsubprocess.check_output=lambda cmd,**kwargs: ${JSON.stringify(panes)} if cmd[0]=='tmux' else ${JSON.stringify(rows)}\n` +
    REMOTE_CODEX_RESUME_PROBE;
  const r = await exec('python3', [
    '-c',
    script,
    JSON.stringify({ location: { socket: 'test-only', sessionName: 'test-only' } }),
  ]);
  return JSON.parse(r.stdout).id;
}
describe('exact remote pane resume identity', () => {
  it('reads the native resume ID of the exact pane process', async () => {
    expect(await probe(`100 1 /usr/bin/codex resume ${id}`)).toBe(id);
  });
  it('follows a wrapper to its sole native child, ignoring unrelated same-workspace processes', async () => {
    expect(
      await probe(
        `100 1 /bin/zsh\n101 100 /opt/codex resume ${id}\n200 1 /opt/codex resume aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`
      )
    ).toBe(id);
  });
  it('does not extract a resume ID from a shell command string', async () => {
    expect(await probe(`100 1 /bin/sh -c 'codex resume ${id}'`)).toBeNull();
  });
  it('refuses multiple native agents even when they share an ID', async () => {
    expect(await probe(`100 1 /bin/sh\n101 100 codex resume ${id}\n102 100 codex resume ${id}`)).toBeNull();
  });
  it('does not adopt non-interactive exec subprocesses', async () => {
    expect(await probe(`100 1 /bin/sh\n101 100 codex exec resume ${id}`)).toBeNull();
  });
  it.each(['codex resume --last', 'codex', 'codex resume invalid', 'other resume ' + id])(
    'refuses an unproven invocation: %s',
    async (command) => {
      expect(await probe('100 1 ' + command)).toBeNull();
    }
  );
  it('requires exactly one pane and refuses a vanished pane process', async () => {
    await expect(probe(`100 1 codex resume ${id}`, '100\n101')).rejects.toThrow();
    await expect(probe(`200 1 codex resume ${id}`)).rejects.toThrow();
  });
});

it.each(['app-server', 'mcp-server', 'exec-server', 'exec', 'e', 'review'])(
  'ignores owned auxiliary %s without losing the real interactive identity',
  async (command) => {
    expect(await probe(`100 1 /bin/sh\n101 100 codex resume ${id}\n102 101 codex -c model=helper ${command}`)).toBe(id);
  }
);
it.each([`--config resume resume ${id}`, `--model app-server resume ${id}`, `--config=x=y resume ${id}`])(
  'parses global option values before the command: %s',
  async (args) => {
    expect(await probe(`100 1 codex ${args}`)).toBe(id);
  }
);
it.each([
  '-- app-server',
  '--unknown app-server',
  '--config app-server',
  '"write an exec summary"',
  '-- "resume ' + id + '"',
])('does not exclude interactive processes because of prompt or option text: %s', async (args) => {
  expect(await probe(`100 1 /bin/sh\n101 100 codex resume ${id}\n102 100 codex ${args}`)).toBeNull();
});
