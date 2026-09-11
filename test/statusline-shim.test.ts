/**
 * The generated plan-usage statusLine shim.
 *
 * Like the DeepSeek status shim, this file is emitted as a STRING and executed
 * by someone else — Claude Code, before every render — so tsc never sees it.
 * The assertions therefore run the real file in a real `node` process, with a
 * real temp HOME and a real listener, rather than inspecting the source text.
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
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ensureStatusLineShim,
  generateShimStatusLineCommand,
  LEGACY_STATUSLINE_MARKER,
  resetStatusLineShimForTest,
  statusLineShimPath,
  STATUSLINE_SHIM_TOKEN,
} from '../src/statusline-shim.js';

const PORT = 3252;
/** A port nothing listens on, for the unreachable-Codeman case. Claimed here so
 *  the repo-wide `const PORT =` search a contributor runs finds it too. */
const PORT_DEAD = 3253;

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

  it('names the shim so the injected command carries the ownership token', () => {
    // applyStatusLineConfig decides ownership on this substring. If the file is
    // ever renamed out from under it, Codeman stops recognising its own entries
    // and starts treating them as hand-authored.
    const command = generateShimStatusLineCommand();
    expect(command).toBeTruthy();
    expect(command).toContain(STATUSLINE_SHIM_TOKEN);
    // Absolute node, not a bare `node`: a managed session's PATH need not have one.
    expect(command).toContain(process.execPath);
  });

  it('quotes both paths, so a data dir with a space still runs', () => {
    const command = generateShimStatusLineCommand()!;
    expect(command).toBe(`'${process.execPath}' '${statusLineShimPath()}'`);
  });
});

describe('statusLine shim: rendering', () => {
  let shim: string;
  let server: Server;
  let received: Array<{ url: string; body: string }> = [];
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

  /** Point a settings file's statusLine at a shell command. */
  function writeStatusLine(file: string, command: string): void {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ statusLine: { type: 'command', command } }, null, 2));
  }

  beforeAll(async () => {
    resetStatusLineShimForTest();
    shim = ensureStatusLineShim()!;

    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ url: req.url ?? '', body });
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

  it('never delegates to its own entry', async () => {
    // No other statusLine exists, so the only candidate is the shim's own. If
    // the loop guard failed this would fork until something ran out.
    const { stdout, code } = await render({ cwd: workspace });
    expect(code).toBe(0);
    expect(stdout).toBe('codeman');
  });

  it('never delegates to the pre-shim inline exporter', async () => {
    // An upgraded install can still have the old command in a parent settings
    // file. Running it would double-report and print Codeman's footer anyway.
    writeStatusLine(
      join(fakeHome, '.claude', 'settings.json'),
      `curl -sk -X POST "$CODEMAN_API_URL${LEGACY_STATUSLINE_MARKER}" || echo codeman`
    );
    const { stdout } = await render({ cwd: workspace });
    expect(stdout).toBe('codeman');
  });

  it('prefers a project statusline to the global one', async () => {
    writeStatusLine(join(fakeHome, '.claude', 'settings.json'), 'echo GLOBAL');
    writeStatusLine(join(workspace, '.claude', 'settings.json'), 'echo PROJECT');
    const { stdout } = await render({ cwd: workspace });
    expect(stdout).toBe('PROJECT');
  });

  it('finds the workspace statusline from a subdirectory', async () => {
    // Claude Code applies a project's settings from the workspace root, which is
    // routinely an ancestor of the directory the session sits in.
    writeStatusLine(join(workspace, '.claude', 'settings.json'), 'echo PROJECT');
    const deep = join(workspace, 'src', 'nested');
    mkdirSync(deep, { recursive: true });
    const { stdout } = await render({ cwd: deep }, {}, deep);
    expect(stdout).toBe('PROJECT');
  });

  it('forwards telemetry to Codeman WHILE delegating', async () => {
    // The whole point: taking the user's line back must not cost the header chip.
    writeStatusLine(join(fakeHome, '.claude', 'settings.json'), 'echo THE-USERS-LINE');
    const { stdout } = await render(
      { cwd: workspace, rate_limits: { five_hour: { used_percentage: 12, resets_at: 99 } } },
      { CODEMAN_SESSION_ID: 'sess-1', CODEMAN_API_URL: `http://127.0.0.1:${PORT}` }
    );

    expect(stdout).toBe('THE-USERS-LINE');
    expect(received).toHaveLength(1);
    expect(received[0].url).toBe(LEGACY_STATUSLINE_MARKER);
    const posted = JSON.parse(received[0].body);
    expect(posted.sessionId).toBe('sess-1');
    expect(posted.data.rate_limits.five_hour.used_percentage).toBe(12);
  });

  it("prints Codeman's own footer when there is no line to shadow", async () => {
    const { stdout } = await render(
      { cwd: workspace },
      { CODEMAN_SESSION_ID: 'sess-1', CODEMAN_API_URL: `http://127.0.0.1:${PORT}` }
    );
    expect(stdout).toBe('CODEMAN-FOOTER');
    expect(received).toHaveLength(1);
  });

  it('skips the POST entirely outside a managed session', async () => {
    // Running `claude` by hand in a managed repo must cost nothing extra, and
    // must not render the old bare-word `codeman` the server returns for an
    // unknown session id.
    writeStatusLine(join(fakeHome, '.claude', 'settings.json'), 'echo THE-USERS-LINE');
    const { stdout } = await render({ cwd: workspace });
    expect(stdout).toBe('THE-USERS-LINE');
    expect(received).toEqual([]);
  });

  it('falls back rather than blanking when the delegate fails silently', async () => {
    // A blank statusline reads as a broken terminal, so a delegate that exits
    // non-zero with no output must not win.
    writeStatusLine(join(fakeHome, '.claude', 'settings.json'), 'exit 3');
    const { stdout } = await render(
      { cwd: workspace },
      { CODEMAN_SESSION_ID: 'sess-1', CODEMAN_API_URL: `http://127.0.0.1:${PORT}` }
    );
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
    const { stdout } = await render({ cwd: workspace });
    expect(stdout).toBe('codeman');
  });
});
