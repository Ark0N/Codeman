/**
 * The generated DeepSeek Harness status shim.
 *
 * This file is the one piece of DeepSeek's wiring that is neither TypeScript we
 * typecheck nor a route we can `inject()` into: it is a script emitted as a
 * string, dropped in the data dir, and executed by a third-party TUI as a
 * SUBPROCESS. So the assertions here run it the way the harness does — a real
 * `node` process, real argv, real env, against a real listener — rather than
 * inspecting the source text.
 *
 * The exit codes are the contract's load-bearing half: the caller retries with
 * backoff on any non-zero, so "cannot ever succeed" (unknown verb, unmapped
 * state) must exit 0 or one typo becomes four HTTP requests per state change,
 * forever.
 */
import { describe, expect, it, beforeEach, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  ensureDeepSeekStatusShim,
  deepSeekStatusShimPath,
  resetDeepSeekStatusShimForTest,
  DEEPSEEK_STATE_TO_HOOK_EVENT,
} from '../src/deepseek-status-shim.js';

describe('DeepSeek status shim: provisioning', () => {
  beforeEach(() => {
    resetDeepSeekStatusShimForTest();
  });

  it('writes an executable shim that node can actually parse', () => {
    const path = ensureDeepSeekStatusShim();
    expect(path).toBeTruthy();
    expect(existsSync(path!)).toBe(true);
    // 0700: the TUI execs it directly, so a lost exec bit means every report
    // fails and is retried four times per state change.
    expect(statSync(path!).mode & 0o777).toBe(0o700);
    // `node --check` on the real file, because a template-literal typo in
    // SHIM_SOURCE is invisible to tsc — the shim is a STRING as far as the
    // compiler is concerned.
    expect(() => execFileSync(process.execPath, ['--check', path!], { stdio: 'pipe' })).not.toThrow();
  });

  it('refreshes a shim written by an older Codeman, and leaves no temp file behind', () => {
    const path = deepSeekStatusShimPath();
    ensureDeepSeekStatusShim();
    const current = readFileSync(path, 'utf-8');

    // A v1 shim from an older install: right path, stale content.
    writeFileSync(path, '#!/usr/bin/env node\n// codeman-dsh-status-shim v1\nprocess.exit(0)\n', { mode: 0o700 });
    resetDeepSeekStatusShimForTest();
    ensureDeepSeekStatusShim();

    expect(readFileSync(path, 'utf-8')).toBe(current);
    // The rewrite goes through a temp + rename so a TUI exec'ing this path mid
    // refresh can never read a half-written file. The temp must not survive it.
    const strays = readdirSync(dirname(path)).filter((f) => f.startsWith('dsh-status-shim') && f.endsWith('.tmp'));
    expect(strays).toEqual([]);
  });

  it('re-asserts the exec bit even when the content already matches', () => {
    const path = ensureDeepSeekStatusShim()!;
    chmodSync(path, 0o600); // a restored backup / copied data dir
    resetDeepSeekStatusShimForTest();
    ensureDeepSeekStatusShim();
    expect(statSync(path).mode & 0o777).toBe(0o700);
  });
});

describe('DeepSeek status shim: the supervisor contract', () => {
  let server: Server | undefined;
  let port: number;
  const received: Array<{ body: unknown; secret: string | undefined }> = [];
  let status = 200;

  const listen = () =>
    new Promise<void>((resolve) => {
      server = createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
          received.push({
            body: (() => {
              try {
                return JSON.parse(raw);
              } catch {
                return raw;
              }
            })(),
            secret: req.headers['x-codeman-hook-secret'] as string | undefined,
          });
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end('{}');
        });
      });
      server.listen(0, '127.0.0.1', () => {
        port = (server!.address() as AddressInfo).port;
        resolve();
      });
    });

  beforeAll(() => listen());

  afterAll(() => {
    server?.close();
  });

  /**
   * Run the shim the way the TUI does, and ASYNCHRONOUSLY.
   *
   * Never spawnSync here: the listener above lives in this same process, so a
   * synchronous spawn blocks the event loop that has to accept the connection.
   * The shim then waits out its own 1500ms socket timeout and exits 1, which
   * reads exactly like a broken shim (measured: `Socket._onTimeout` in its exit
   * trace, and the server logging nothing).
   */
  const run = (args: string[], env: Record<string, string> = {}) =>
    new Promise<{ status: number | null; stderr: string }>((resolve) => {
      const path = ensureDeepSeekStatusShim()!;
      const child = spawn(process.execPath, [path, ...args], {
        env: {
          ...process.env,
          CODEMAN_API_URL: `http://127.0.0.1:${port}`,
          CODEMAN_SESSION_ID: 'sess-from-env',
          ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf-8')));
      child.on('close', (status) => resolve({ status, stderr }));
    });

  // The exact command line the harness TUI runs, from the Herdr contract.
  const report = (state: string, extra: string[] = []) => [
    'pane',
    'report-agent',
    'pane-arg-id',
    '--source',
    'custom:dsh-tui',
    '--agent',
    'dsh-tui',
    '--state',
    state,
    ...extra,
    '--seq',
    '7',
  ];

  it('forwards each harness state as its mapped hook event, and exits 0 on delivery', async () => {
    resetDeepSeekStatusShimForTest();
    for (const [state, event] of Object.entries(DEEPSEEK_STATE_TO_HOOK_EVENT)) {
      received.length = 0;
      const out = await run(report(state, ['--message', 'needs a decision']));
      expect(out.status, `${state}: ${out.stderr}`).toBe(0);
      expect(received).toHaveLength(1);
      const body = received[0].body as { event: string; sessionId: string; data: Record<string, unknown> };
      expect(body.event).toBe(event);
      // The ambient env wins over the pane argument: same code set both, and the
      // argument is whatever the TUI chose to pass.
      expect(body.sessionId).toBe('sess-from-env');
      expect(body.data.agent).toBe('dsh-tui');
      expect(body.data.message).toBe('needs a decision');
    }
  });

  it('sends the hook secret read at EXECUTION time, so rotation needs no respawn', async () => {
    resetDeepSeekStatusShimForTest();
    const secretFile = `${deepSeekStatusShimPath()}.secret-fixture`;
    writeFileSync(secretFile, 'rotated-secret\n', { mode: 0o600 });
    received.length = 0;
    const out = await run(report('idle'), { CODEMAN_HOOK_SECRET_FILE: secretFile });
    expect(out.status).toBe(0);
    expect(received[0].secret).toBe('rotated-secret');
  });

  it('exits 0 without posting for anything a retry could never fix', async () => {
    resetDeepSeekStatusShimForTest();
    for (const args of [
      ['pane', 'list'], // unknown verb
      ['something-else', 'report-agent', 'id', '--state', 'idle'], // unknown noun
      [...report('rebooting')], // a state this bridge does not map
      ['pane', 'report-agent', 'id'], // no --state at all
    ]) {
      received.length = 0;
      const out = await run(args);
      expect(out.status, `args ${args.join(' ')}`).toBe(0);
      expect(received).toEqual([]);
    }
  });

  it('exits non-zero when the post genuinely fails, so the caller retries', async () => {
    resetDeepSeekStatusShimForTest();

    // A rejecting server: transport worked, Codeman said no.
    status = 500;
    received.length = 0;
    expect((await run(report('idle'))).status).not.toBe(0);
    expect(received).toHaveLength(1);
    status = 200;

    // Nothing listening at all.
    expect((await run(report('idle'), { CODEMAN_API_URL: 'http://127.0.0.1:1' })).status).not.toBe(0);
    // No API url to post to.
    expect((await run(report('idle'), { CODEMAN_API_URL: '' })).status).not.toBe(0);
  });
});
