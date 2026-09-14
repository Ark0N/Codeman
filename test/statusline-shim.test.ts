/**
 * The generated plan-usage statusLine shim and the command that launches it.
 *
 * Like the DeepSeek status shim, the shim is emitted as a STRING and executed
 * by someone else, Claude Code, before every render, so tsc never sees it. The
 * assertions therefore run the real file in a real `node` process, with a real
 * temp HOME and a real listener, rather than inspecting the source text. The
 * injected command is exercised the same way, through `sh -c`, because its
 * fallback half is the only thing that renders inside a Docker case's
 * container and a typo there is invisible to every other check.
 *
 * The load-bearing property is the pair: the shim must keep forwarding plan
 * usage to Codeman AND give the user back the statusline it shadows. Losing
 * either half silently defeats the feature, in one direction by blanking the
 * header chip and in the other by stealing the terminal footer.
 */
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ensureStatusLineShim,
  LEGACY_STATUSLINE_MARKER,
  resetStatusLineShimForTest,
  statusLineShimGuard,
  statusLineShimPath,
  STATUSLINE_SHIM_TOKEN,
} from '../src/statusline-shim.js';
import { generateStatusLineCommand, isCodemanStatusLine } from '../src/hooks-config.js';

const PORT = 3252;
/** A port nothing listens on, for the unreachable-Codeman case. Claimed here so
 *  the repo-wide `const PORT =` search a contributor runs finds it too. */
const PORT_DEAD = 3253;

/** Point a settings file's statusLine at a shell command. */
function writeStatusLine(file: string, command: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ statusLine: { type: 'command', command } }, null, 2));
}

describe('statusLine shim: provisioning', () => {
  beforeEach(() => {
    resetStatusLineShimForTest();
  });

  it('writes an executable shim that node can actually parse', () => {
    const path = ensureStatusLineShim();
    expect(path).toBeTruthy();
    expect(existsSync(path!)).toBe(true);
    expect(statSync(path!).mode & 0o777).toBe(0o700);
    // `node --check` on the real file: a template-literal typo in SHIM_SOURCE is
    // invisible to tsc, because the shim is a string as far as it is concerned.
    expect(() => execFileSync(process.execPath, ['--check', path!], { stdio: 'pipe' })).not.toThrow();
  });

  it('refreshes a shim written by an older Codeman, and leaves no temp file behind', () => {
    const path = statusLineShimPath();
    ensureStatusLineShim();
    const current = readFileSync(path, 'utf-8');

    writeFileSync(path, `#!/usr/bin/env node\n// ${STATUSLINE_SHIM_TOKEN} v0\nprocess.exit(0)\n`, { mode: 0o700 });
    resetStatusLineShimForTest();
    ensureStatusLineShim();

    expect(readFileSync(path, 'utf-8')).toBe(current);
    const strays = readdirSync(dirname(path)).filter((f) => f.startsWith(STATUSLINE_SHIM_TOKEN) && f.endsWith('.tmp'));
    expect(strays).toEqual([]);
  });

  it('re-asserts the exec bit even when the content already matches', () => {
    const path = ensureStatusLineShim()!;
    chmodSync(path, 0o600); // a restored backup / copied data dir
    resetStatusLineShimForTest();
    ensureStatusLineShim();
    expect(statSync(path).mode & 0o777).toBe(0o700);
  });

  it('names the shim so the guard carries the ownership token', () => {
    // isCodemanStatusLine decides ownership on this substring. If the file is
    // ever renamed out from under it, Codeman stops recognising its own entries
    // and starts treating them as hand-authored.
    const guard = statusLineShimGuard();
    expect(guard).toBeTruthy();
    expect(guard).toContain(STATUSLINE_SHIM_TOKEN);
    // Absolute node, not a bare `node`: a managed session's PATH need not have one.
    expect(guard).toContain(process.execPath);
  });

  it('tests both paths before exec-ing, and quotes them, so a data dir with a space still runs', () => {
    const node = `'${process.execPath}'`;
    const shim = `'${statusLineShimPath()}'`;
    expect(statusLineShimGuard()).toBe(`if [ -x ${node} ] && [ -f ${shim} ]; then exec ${node} ${shim}; fi;`);
  });
});

describe('statusLine shim: rendering', () => {
  let shim: string;
  let server: Server;
  let received: Array<{ url: string; body: string }> = [];
  let footer = 'CODEMAN-FOOTER';
  let workspace: string;
  let fakeHome: string;

  /** Run the shim the way Claude Code does: a subprocess, JSON on stdin. */
  function render(
    payload: object,
    env: Record<string, string> = {},
    cwd: string = workspace
  ): Promise<{ stdout: string; code: number | null }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [shim], {
        cwd,
        env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, ...env },
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      let stdout = '';
      child.stdout.on('data', (c) => (stdout += c));
      child.on('close', (code) => resolve({ stdout, code }));
      child.stdin.end(JSON.stringify(payload));
    });
  }

  const managed = () => ({ CODEMAN_SESSION_ID: 'sess-1', CODEMAN_API_URL: `http://127.0.0.1:${PORT}` });

  beforeAll(async () => {
    resetStatusLineShimForTest();
    shim = ensureStatusLineShim()!;

    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ url: req.url ?? '', body });
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(footer);
      });
    });
    await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', r));
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  beforeEach(() => {
    received = [];
    footer = 'CODEMAN-FOOTER';
    const root = mkdtempSync(join(tmpdir(), 'codeman-statusline-'));
    fakeHome = join(root, 'home');
    workspace = join(root, 'repo');
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    mkdirSync(join(workspace, '.claude'), { recursive: true });
    // The entry Codeman injects into the managed repo. Every case below has it,
    // because the shim must always skip its own entry while hunting a delegate.
    writeStatusLine(join(workspace, '.claude', 'settings.local.json'), `'${process.execPath}' '${shim}'`);
  });

  it('prints the global statusline it shadows', async () => {
    writeStatusLine(join(fakeHome, '.claude', 'settings.json'), 'echo THE-USERS-LINE');
    const { stdout } = await render({ cwd: workspace });
    expect(stdout).toBe('THE-USERS-LINE');
  });

  it('hands the delegate the same JSON Claude Code sent', async () => {
    // The delegate is only useful if it sees the payload: every statusline
    // script reads the model, the cwd or the rate limits off this blob.
    writeStatusLine(join(fakeHome, '.claude', 'settings.json'), `bash -c 'read -r j; echo "GOT:$j"'`);
    const { stdout } = await render({ cwd: workspace, model: { display_name: 'Opus 5' } });
    expect(stdout).toContain('"display_name":"Opus 5"');
  });

  it('never delegates to its own entry, and prints nothing rather than a brand word', async () => {
    // No other statusLine exists, so the only candidate is the shim's own. If
    // the loop guard failed this would fork until something ran out. And with
    // nothing to shadow and no Codeman to ask, the line stays blank: the bare
    // word `codeman` is the symptom discussion #405 opened with.
    const { stdout, code } = await render({ cwd: workspace });
    expect(code).toBe(0);
    expect(stdout).toBe('');
  });

  it('never delegates to the pre-shim inline exporter', async () => {
    // An upgraded install can still have the old command in a parent settings
    // file. Running it would double-report and print Codeman's footer anyway.
    writeStatusLine(
      join(fakeHome, '.claude', 'settings.json'),
      `curl -sk -X POST "$CODEMAN_API_URL${LEGACY_STATUSLINE_MARKER}" || echo codeman`
    );
    const { stdout } = await render({ cwd: workspace });
    expect(stdout).toBe('');
  });

  it('prefers a project statusline to the global one', async () => {
    writeStatusLine(join(fakeHome, '.claude', 'settings.json'), 'echo GLOBAL');
    writeStatusLine(join(workspace, '.claude', 'settings.json'), 'echo PROJECT');
    const { stdout } = await render({ cwd: workspace });
    expect(stdout).toBe('PROJECT');
  });

  it('reads project settings from the launch directory, not the current one', async () => {
    // Claude Code applies a project's settings from the directory it was
    // launched in (workspace.project_dir), which the blob keeps reporting after
    // the working directory changes mid-session.
    writeStatusLine(join(workspace, '.claude', 'settings.json'), 'echo PROJECT');
    const elsewhere = join(dirname(workspace), 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    const { stdout } = await render(
      { cwd: elsewhere, workspace: { current_dir: elsewhere, project_dir: workspace } },
      {},
      elsewhere
    );
    expect(stdout).toBe('PROJECT');
  });

  it('does not walk up from the launch directory', async () => {
    // Claude Code reads project settings from the launch directory alone, so a
    // .claude in an ancestor is one it would have ignored. Delegating to it
    // would run a statusline the user never sees otherwise.
    writeStatusLine(join(workspace, '.claude', 'settings.json'), 'echo ANCESTOR');
    const sub = join(workspace, 'packages', 'inner');
    mkdirSync(sub, { recursive: true });
    writeStatusLine(join(fakeHome, '.claude', 'settings.json'), 'echo GLOBAL');
    const { stdout } = await render({ cwd: sub, workspace: { current_dir: sub, project_dir: sub } }, {}, sub);
    expect(stdout).toBe('GLOBAL');
  });

  it('ignores a user-level settings.local.json, which Claude Code does not read', async () => {
    writeStatusLine(join(fakeHome, '.claude', 'settings.local.json'), 'echo NOT-A-REAL-FILE');
    writeStatusLine(join(fakeHome, '.claude', 'settings.json'), 'echo GLOBAL');
    const { stdout } = await render({ cwd: workspace });
    expect(stdout).toBe('GLOBAL');
  });

  it('forwards telemetry to Codeman WHILE delegating', async () => {
    // The whole point: taking the user's line back must not cost the header chip.
    writeStatusLine(join(fakeHome, '.claude', 'settings.json'), 'echo THE-USERS-LINE');
    const { stdout } = await render(
      { cwd: workspace, rate_limits: { five_hour: { used_percentage: 12, resets_at: 99 } } },
      managed()
    );

    expect(stdout).toBe('THE-USERS-LINE');
    expect(received).toHaveLength(1);
    expect(received[0].url).toBe(LEGACY_STATUSLINE_MARKER);
    const posted = JSON.parse(received[0].body);
    expect(posted.sessionId).toBe('sess-1');
    expect(posted.data.rate_limits.five_hour.used_percentage).toBe(12);
  });

  it("prints Codeman's own footer when there is no line to shadow", async () => {
    const { stdout } = await render({ cwd: workspace }, managed());
    expect(stdout).toBe('CODEMAN-FOOTER');
    expect(received).toHaveLength(1);
  });

  it('treats the bare brand word from an older server as no telemetry', async () => {
    // A pre-1.28 route answers `codeman` for a session it does not know. That
    // word on the statusline is what cost discussion #405 seven repositories
    // of debugging, so it must never be printed, whichever server answers.
    footer = 'codeman';
    const { stdout } = await render({ cwd: workspace }, managed());
    expect(stdout).toBe('');
    expect(received).toHaveLength(1);
  });

  it('skips the POST entirely outside a managed session', async () => {
    // Running `claude` by hand in a managed repo must cost nothing extra.
    writeStatusLine(join(fakeHome, '.claude', 'settings.json'), 'echo THE-USERS-LINE');
    const { stdout } = await render({ cwd: workspace });
    expect(stdout).toBe('THE-USERS-LINE');
    expect(received).toEqual([]);
  });

  it('falls back to the footer when the delegate fails silently', async () => {
    // A delegate that exits non-zero with no output must not win over a footer
    // Codeman can supply.
    writeStatusLine(join(fakeHome, '.claude', 'settings.json'), 'exit 3');
    const { stdout } = await render({ cwd: workspace }, managed());
    expect(stdout).toBe('CODEMAN-FOOTER');
  });

  it('still prints a failing delegate that produced output', async () => {
    // Plenty of statusline scripts end on the exit code of their last command.
    writeStatusLine(join(fakeHome, '.claude', 'settings.json'), 'echo PARTIAL; exit 1');
    const { stdout } = await render({ cwd: workspace });
    expect(stdout).toBe('PARTIAL');
  });

  it('survives an unreachable Codeman and a malformed payload', async () => {
    writeStatusLine(join(fakeHome, '.claude', 'settings.json'), 'echo THE-USERS-LINE');
    const child = spawn(process.execPath, [shim], {
      cwd: workspace,
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        CODEMAN_SESSION_ID: 'sess-1',
        // Nothing listens here.
        CODEMAN_API_URL: `http://127.0.0.1:${PORT_DEAD}`,
      },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let stdout = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stdin.end('not json at all');
    const code = await new Promise<number | null>((r) => child.on('close', r));
    expect(code).toBe(0);
    expect(stdout).toBe('THE-USERS-LINE');
  });

  it('ignores a malformed settings file instead of dying on it', async () => {
    writeFileSync(join(workspace, '.claude', 'settings.json'), '{ broken');
    writeStatusLine(join(fakeHome, '.claude', 'settings.json'), 'echo THE-USERS-LINE');
    const { stdout, code } = await render({ cwd: workspace });
    expect(code).toBe(0);
    expect(stdout).toBe('THE-USERS-LINE');
  });

  it('ignores a statusLine that is not a command', async () => {
    writeFileSync(
      join(fakeHome, '.claude', 'settings.json'),
      JSON.stringify({ statusLine: { type: 'something-else', command: 'echo NOPE' } })
    );
    const { stdout } = await render({ cwd: workspace }, managed());
    expect(stdout).toBe('CODEMAN-FOOTER');
  });
});

describe('the injected statusLine command', () => {
  let server: Server;
  let received: string[] = [];
  let fakeHome: string;

  /** Run the command the way Claude Code does: through a shell, JSON on stdin. */
  function run(command: string, env: Record<string, string>, stdin = '{"model":{"display_name":"Opus"}}') {
    return new Promise<{ stdout: string; code: number | null }>((resolve) => {
      const child = spawn('/bin/sh', ['-c', command], {
        cwd: fakeHome,
        env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, ...env },
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      let stdout = '';
      child.stdout.on('data', (c) => (stdout += c));
      child.on('close', (code) => resolve({ stdout, code }));
      child.stdin.end(stdin);
    });
  }

  const managed = () => ({ CODEMAN_SESSION_ID: 'sess-2', CODEMAN_API_URL: `http://127.0.0.1:${PORT}` });

  beforeAll(async () => {
    resetStatusLineShimForTest();
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push(body);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('CODEMAN-FOOTER');
      });
    });
    await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', r));
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  beforeEach(() => {
    received = [];
    fakeHome = mkdtempSync(join(tmpdir(), 'codeman-statusline-cmd-'));
  });

  it('is recognised as ours by both of its halves', () => {
    const command = generateStatusLineCommand();
    expect(command.startsWith('if [ -x ')).toBe(true);
    expect(command).toContain(STATUSLINE_SHIM_TOKEN);
    expect(command).toContain(LEGACY_STATUSLINE_MARKER);
    expect(isCodemanStatusLine(command)).toBe(true);
    // The word the whole change exists to remove.
    expect(command).not.toContain('echo codeman');
  });

  it('runs the shim where the shim exists', async () => {
    writeStatusLine(join(fakeHome, '.claude', 'settings.json'), 'echo THE-USERS-LINE');
    const { stdout } = await run(generateStatusLineCommand(), managed());
    expect(stdout).toBe('THE-USERS-LINE');
    expect(JSON.parse(received[0]).sessionId).toBe('sess-2');
  });

  it('falls through to the inline curl exporter where the shim does not exist', async () => {
    // Inside a Docker case's container the workspace's settings.local.json is
    // bind-mounted at the same absolute path, but neither the host's node nor
    // its data dir is. The same command must still report telemetry there.
    const command = generateStatusLineCommand().split(statusLineShimPath()).join(join(fakeHome, 'no-such-shim.mjs'));
    writeStatusLine(join(fakeHome, '.claude', 'settings.json'), 'echo THE-USERS-LINE');
    const { stdout } = await run(command, managed());
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0])).toMatchObject({ sessionId: 'sess-2', data: { model: { display_name: 'Opus' } } });
    // The inline half cannot delegate, so it prints the footer through.
    expect(stdout).toBe('CODEMAN-FOOTER');
  });

  it('prints nothing, not a brand word, when the inline half has no Codeman to reach', async () => {
    const command = generateStatusLineCommand().split(statusLineShimPath()).join(join(fakeHome, 'no-such-shim.mjs'));
    const { stdout, code } = await run(command, { CODEMAN_API_URL: '', CODEMAN_SESSION_ID: '' });
    expect(code).toBe(0);
    expect(stdout).toBe('');
  });
});
