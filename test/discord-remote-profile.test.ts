/** Exact process metadata fixtures: no SSH, credentials or model execution. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { REMOTE_CODEX_ENV_READER, REMOTE_CODEX_RUNTIME_PROBE } from '../src/discord-remote-conversation.js';
const exec = promisify(execFile);
const id = '01a197ca-f81d-7cf1-82b0-7dbdd241eb22';
async function probe(env: string, rows = `100 1 /bin/zsh\n101 100 /opt/codex resume ${id}`, changed = false) {
  const prelude = `import subprocess,io,builtins,os,sys
sys.platform='linux'
rows=${JSON.stringify(rows)}
env=${JSON.stringify(env)}.encode()
count=0
def output(cmd,**kwargs):
 global count
 if cmd[0]=='tmux':return '100'
 if '-axo' in cmd:return rows
 count+=1
 return 'start native' if not ${changed ? 'True' : 'False'} or count==1 else 'different process'
subprocess.check_output=output
builtin_open=builtins.open
def read(path,*args,**kwargs):
 if path!='/proc/101/environ':raise Exception('wrong process environment')
 return io.BytesIO(env)
builtins.open=read
os.readlink=lambda p:'/work'
`;
  const result = await exec('python3', [
    '-c',
    prelude + REMOTE_CODEX_RUNTIME_PROBE,
    JSON.stringify({ location: { socket: 'fixture', sessionName: 'fixture' } }),
  ]);
  return result.stdout;
}
it('resolves an owned custom profile while ignoring unrelated processes and secret environment values', async () => {
  const output = await probe(
    'HOME=/home/test\0CODEX_HOME=/home/test/.codex-personal\0API_KEY=SECRET\0',
    `100 1 /bin/sh\n101 100 /opt/codex resume ${id}\n200 1 codex resume aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`
  );
  expect(JSON.parse(output)).toMatchObject({
    id,
    configHome: '/home/test/.codex-personal',
    fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(output).not.toContain('SECRET');
  expect(output).not.toContain('API_KEY');
});
it('uses the owned HOME default and does not mistake environment-like text inside a secret for a variable', async () => {
  expect(JSON.parse(await probe('HOME=/home/test\0API_KEY=SECRET CODEX_HOME=/wrong\0')).configHome).toBe(
    '/home/test/.codex'
  );
});
it.each([
  ['~/account', '/home/test/account'],
  ['profiles/personal', '/work/profiles/personal'],
  ['/home/test/account with spaces', '/home/test/account with spaces'],
])('resolves runtime home %s', async (home, expected) => {
  expect(JSON.parse(await probe(`HOME=/home/test\0CODEX_HOME=${home}\0`)).configHome).toBe(expected);
});
it('can resolve a new native pane home without inventing its conversation ID', async () => {
  expect(
    JSON.parse(await probe('HOME=/home/test\0CODEX_HOME=/account\0', '100 1 /bin/sh\n101 100 /opt/codex'))
  ).toMatchObject({ id: null, configHome: '/account' });
});
it('refuses ambiguous native ownership and process replacement', async () => {
  expect(
    JSON.parse(
      await probe('HOME=/home/test\0', `100 1 /bin/sh\n101 100 codex resume ${id}\n102 100 codex resume ${id}`)
    )
  ).toEqual({ id: null });
  await expect(probe('HOME=/home/test\0', undefined, true)).rejects.toThrow(/process changed/);
});
it.each(['HOME=/a\0HOME=/b\0', 'CODEX_HOME=/a\nother\0', 'OTHER=no-home\0'])(
  'refuses ambiguous or unverifiable profile metadata',
  async (env) => {
    await expect(probe(env)).rejects.toThrow();
  }
);
it('decodes macOS process-argument padding, spaces and NUL-separated variables without exporting secrets', async () => {
  const fixture =
    `import sys,json,struct
` +
    REMOTE_CODEX_ENV_READER +
    `
data=struct.pack('i',3)+b'/opt/codex\\0\\0\\0'+b'\\0'.join([b'codex',b'resume',b'${id}'])+b'\\0'+b'HOME=/Users/test\\0CODEX_HOME=/Users/test/personal account\\0API_KEY=SECRET CODEX_HOME=/wrong\\0\\0'
print(json.dumps(darwin_environment(data)))
`;
  const output = (await exec('python3', ['-c', fixture])).stdout;
  expect(JSON.parse(output)).toEqual({ HOME: '/Users/test', CODEX_HOME: '/Users/test/personal account' });
  expect(output).not.toContain('SECRET');
});

it('reads only the main interactive profile with nested app-server helpers present', async () => {
  const rows = `100 1 /bin/sh\n101 100 codex resume ${id}\n102 101 /bin/sh\n103 102 codex app-server`;
  expect(JSON.parse(await probe('HOME=/home/test\0CODEX_HOME=/account\0', rows))).toMatchObject({
    id,
    configHome: '/account',
    fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
});
