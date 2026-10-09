/**
 * @fileoverview `codeman agent …` — the three invariants from `src/cli-agent.ts`
 * plus every verb against a recording fake transport, and the real HTTP transport
 * against a local server (headers, auth, query encoding).
 */

import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AgentGuardError,
  EXIT,
  agentInterrupt,
  agentLs,
  agentRead,
  agentRm,
  agentSend,
  agentSpawn,
  agentWait,
  baseHeaders,
  sendPromptFromArgs,
  composerReadyMark,
  buildInterruptBody,
  buildSendBody,
  deleteRefusal,
  describeFailure,
  httpRequest,
  inputRefusal,
  isSelfSession,
  MIN_ID_PREFIX_LENGTH,
  parsePositiveInt,
  registerAgentCommands,
  resolveAgentContext,
  stripAnsi,
  waitExitCode,
  type AgentContext,
  type AgentDeps,
  type ApiResponse,
  type RequestOptions,
} from '../src/cli-agent.js';
import { readCodemanEnvFile } from '../src/codeman-credentials.js';

const SELF = '058ee7b5-b2aa-4c33-8cc1-e900eb0b28af';
const OTHER = '94990c6d-e461-4a29-aa83-89275327732c';

function ctx(overrides: Partial<AgentContext> = {}): AgentContext {
  return { apiUrl: 'http://127.0.0.1:1', selfId: SELF, ...overrides };
}

/** Recording transport: answers from a queue (or a resolver) and keeps every call. */
function fakeDeps(
  answer: ((options: RequestOptions) => ApiResponse) | ApiResponse[],
  json = false
): AgentDeps & { calls: RequestOptions[]; out: string[]; err: string[] } {
  const calls: RequestOptions[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const queue = Array.isArray(answer) ? [...answer] : undefined;
  return {
    ctx: ctx(),
    calls,
    out,
    err,
    json,
    now: () => 1_700_000_000_000,
    io: { out: (l) => out.push(l), err: (l) => err.push(l) },
    request: async (_c, options) => {
      calls.push(options);
      if (queue) {
        const next = queue.shift();
        if (!next) throw new Error('fake transport: no answer queued');
        return next;
      }
      return (answer as (o: RequestOptions) => ApiResponse)(options);
    },
  };
}

function ok(data: unknown): ApiResponse {
  return { status: 200, json: { success: true, data }, text: '' };
}

function apiError(status: number, errorCode: string, error: string): ApiResponse {
  return { status, json: { success: false, errorCode, error }, text: '' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Invariant 1: the guard
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveAgentContext (guard)', () => {
  const inside = { CODEMAN_MUX: '1', CODEMAN_API_URL: 'http://127.0.0.1:3459', CODEMAN_SESSION_ID: SELF };

  it('refuses outside a Codeman session', () => {
    expect(() => resolveAgentContext({}, () => ({}))).toThrow(AgentGuardError);
    expect(() => resolveAgentContext({ ...inside, CODEMAN_MUX: '0' }, () => ({}))).toThrow(/CODEMAN_MUX/);
  });

  it('never guesses an API URL', () => {
    expect(() => resolveAgentContext({ ...inside, CODEMAN_API_URL: '' }, () => ({}))).toThrow(/refusing to guess/);
    expect(() => resolveAgentContext({ ...inside, CODEMAN_API_URL: undefined }, () => ({}))).toThrow(AgentGuardError);
  });

  it('needs its own session id to tell self from others', () => {
    expect(() => resolveAgentContext({ ...inside, CODEMAN_SESSION_ID: '' }, () => ({}))).toThrow(/CODEMAN_SESSION_ID/);
  });

  it('takes the password from the environment first, the .env file second, and none means open', () => {
    expect(
      resolveAgentContext({ ...inside, CODEMAN_PASSWORD: 'pw' }, () => ({ CODEMAN_PASSWORD: 'file' })).auth
    ).toEqual({
      username: 'admin',
      password: 'pw',
    });
    expect(resolveAgentContext(inside, () => ({ CODEMAN_USERNAME: 'joe', CODEMAN_PASSWORD: 'file' })).auth).toEqual({
      username: 'joe',
      password: 'file',
    });
    expect(resolveAgentContext(inside, () => ({})).auth).toBeUndefined();
  });

  it('resolves each field the way attach and the TUI do (one shared order)', () => {
    // Password from the environment, username from the file: joe, not admin.
    expect(
      resolveAgentContext({ ...inside, CODEMAN_PASSWORD: 'pw' }, () => ({ CODEMAN_USERNAME: 'joe' })).auth
    ).toEqual({ username: 'joe', password: 'pw' });
  });

  it('reads a hand-authored .env with quotes and export prefixes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codeman-agent-env-'));
    try {
      const file = join(dir, '.env');
      writeFileSync(file, '# comment\nexport CODEMAN_USERNAME="joe"\nCODEMAN_PASSWORD=\'s3cret\'\nnot a line\n');
      expect(readCodemanEnvFile(file)).toEqual({ CODEMAN_USERNAME: 'joe', CODEMAN_PASSWORD: 's3cret' });
      expect(readCodemanEnvFile(join(dir, 'missing'))).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Invariant 2: send is printable text + \r; ESC lives only in interrupt
// ─────────────────────────────────────────────────────────────────────────────

describe('send transmits printable text only', () => {
  it('refuses every control byte and DEL, naming it', () => {
    expect(inputRefusal('\u0003')).toMatch(/0x03/); // Ctrl+C: opencode's app_exit
    expect(inputRefusal('ls\u001b')).toMatch(/0x1b/);
    expect(inputRefusal('a\u007fb')).toMatch(/0x7f/);
    expect(inputRefusal('two\nlines')).toMatch(/single line/); // not the ESC hint
    expect(inputRefusal('a\tb')).toMatch(/single line/);
    expect(inputRefusal('x\u009bmy')).toMatch(/0x9b/); // 8-bit CSI
    expect(inputRefusal('')).toMatch(/empty/);
  });

  it('accepts ordinary prompts, including unicode', () => {
    expect(inputRefusal('review the diff in src/, then say DONE_4711')).toBeUndefined();
    expect(inputRefusal('prüfe die Ändërung ❯ ok')).toBeUndefined();
  });

  it('appends exactly one \\r, or nothing with --no-enter, and never anything else', () => {
    const base = { clientId: 'c', seq: 1 };
    expect(buildSendBody('hi', { ...base, enter: true }).input).toBe('hi\r');
    expect(buildSendBody('hi', { ...base, enter: false }).input).toBe('hi');
    const body = buildSendBody('hi', { ...base, enter: true, wait: 'stop,exit', waitTimeout: 5000 });
    expect(body).toEqual({ input: 'hi\r', useMux: true, clientId: 'c', seq: 1, wait: 'stop,exit', waitTimeout: 5000 });
    expect(buildSendBody('hi', { ...base, enter: true })).not.toHaveProperty('wait');
  });

  it('interrupt is a bare ESC with no Enter', () => {
    const body = buildInterruptBody('c-interrupt', 7);
    expect(body.input).toBe('\u001b');
    expect(String(body.input)).not.toContain('\r');
    expect(body).toEqual({ input: '\u001b', useMux: true, clientId: 'c-interrupt', seq: 7 });
  });

  it('agentSend refuses control bytes BEFORE touching the transport', async () => {
    const deps = fakeDeps([]);
    expect(await agentSend(deps, { id: OTHER, text: 'q\u0003', enter: true })).toBe(EXIT.refused);
    expect(deps.calls).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Invariant 3: rm fails closed
// ─────────────────────────────────────────────────────────────────────────────

describe('rm fails closed', () => {
  it('refuses an empty id, a short self id, and a prefix match in either direction', () => {
    expect(deleteRefusal(SELF, '')).toMatch(/empty/);
    expect(deleteRefusal('058ee7', OTHER)).toMatch(/too short/);
    expect(deleteRefusal(SELF, SELF)).toMatch(/is me/);
    expect(deleteRefusal(SELF, SELF.slice(0, 8))).toMatch(/is me/); // 8-char form of me
    expect(deleteRefusal(SELF.slice(0, 8), SELF)).toMatch(/is me/); // Docker's truncated $SELF
    expect(deleteRefusal(SELF, OTHER)).toBeUndefined();
    expect(deleteRefusal(SELF, OTHER.slice(0, 8))).toBeUndefined();
  });

  it('isSelfSession treats an unprovable self as "maybe me"', () => {
    expect(isSelfSession('short', OTHER)).toBe(true);
    expect(isSelfSession(SELF, '')).toBe(true);
    expect(isSelfSession(SELF, OTHER)).toBe(false);
  });

  it('agentRm never calls DELETE on a refusal', async () => {
    const deps = fakeDeps([]);
    expect(await agentRm(deps, { id: SELF.slice(0, 8) })).toBe(EXIT.refused);
    expect(deps.calls).toEqual([]);
  });

  it('agentRm deletes a foreign id plainly (killMux default, no query)', async () => {
    const deps = fakeDeps([ok({})]);
    expect(await agentRm(deps, { id: OTHER })).toBe(EXIT.ok);
    expect(deps.calls[0]).toMatchObject({ method: 'DELETE', path: `/api/v1/sessions/${OTHER}` });
    expect(deps.calls[0].query).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Verbs against the fake transport
// ─────────────────────────────────────────────────────────────────────────────

describe('agent ls', () => {
  const sessions = [
    { id: SELF, mode: 'claude', status: 'busy', name: 'w1-Codeman' },
    { id: OTHER, mode: 'opencode', status: 'idle', workingDir: '/home/joe/wiki' },
  ];

  it('marks this session and falls back to workingDir for the name', async () => {
    const deps = fakeDeps([ok(sessions)]);
    expect(await agentLs(deps)).toBe(EXIT.ok);
    const text = deps.out.join('\n');
    expect(text).toMatch(/\*\s+058ee7b5\s+claude\s+busy\s+w1-Codeman/);
    expect(text).toMatch(/94990c6d\s+opencode\s+idle\s+\/home\/joe\/wiki/);
  });

  it('--json is the envelope data plus a self flag', async () => {
    const deps = fakeDeps([ok(sessions)], true);
    await agentLs(deps);
    const parsed = JSON.parse(deps.out.join('')) as Array<{ id: string; self: boolean }>;
    expect(parsed.map((s) => [s.id.slice(0, 8), s.self])).toEqual([
      ['058ee7b5', true],
      ['94990c6d', false],
    ]);
  });

  it('surfaces a plain-text 401 as a credentials hint, not a parse error', async () => {
    const deps = fakeDeps([{ status: 401, text: 'Unauthorized' }]);
    expect(await agentLs(deps)).toBe(EXIT.error);
    expect(deps.err.join('')).toMatch(/401.*password/);
  });
});

describe('agent send', () => {
  it('refuses to type into its own composer', async () => {
    const deps = fakeDeps([]);
    expect(await agentSend(deps, { id: SELF.slice(0, 8), text: 'hi', enter: true })).toBe(EXIT.refused);
    expect(deps.calls).toEqual([]);
  });

  it('fire-and-forget: input + \\r, a fixed clientId per caller, seq from the clock', async () => {
    const deps = fakeDeps([ok({ delivered: true })]);
    expect(await agentSend(deps, { id: OTHER, text: 'say DONE_1', enter: true })).toBe(EXIT.ok);
    expect(deps.calls[0]).toMatchObject({
      method: 'POST',
      path: `/api/v1/sessions/${OTHER}/input`,
      body: { input: 'say DONE_1\r', useMux: true, clientId: 'codeman-agent-cli-058ee7b5', seq: 1_700_000_000_000 },
    });
    expect(deps.calls[0].body).not.toHaveProperty('wait');
  });

  it('--wait passes the signal list and timeout through and maps the result to an exit code', async () => {
    const stop = fakeDeps([ok({ delivered: true, wait: { signal: 'stop', timedOut: false } })]);
    expect(await agentSend(stop, { id: OTHER, text: 'go', enter: true, wait: 'stop,exit', timeoutMs: 5000 })).toBe(
      EXIT.ok
    );
    expect(stop.calls[0].body).toMatchObject({ wait: 'stop,exit', waitTimeout: 5000 });

    const timeout = fakeDeps([ok({ delivered: true, wait: { timedOut: true, timeoutMs: 5000 } })]);
    expect(await agentSend(timeout, { id: OTHER, text: 'go', enter: true, wait: true, timeoutMs: 5000 })).toBe(
      EXIT.timeout
    );

    const dead = fakeDeps([ok({ delivered: true, wait: { signal: 'exit' } })]);
    expect(await agentSend(dead, { id: OTHER, text: 'go', enter: true, wait: true })).toBe(EXIT.dead);
  });

  it('delivered:false without duplicate is "the bytes went nowhere": exit 3, never a ✓', async () => {
    const deps = fakeDeps([ok({ delivered: false, duplicate: false, wait: { ended: true, signal: null } })]);
    expect(await agentSend(deps, { id: OTHER, text: 'go', enter: true, wait: true })).toBe(EXIT.dead);
    expect(deps.out.join('')).not.toMatch(/delivered to/);
    expect(deps.err.join('')).toMatch(/not delivered.*restart/);
  });

  it('fire-and-forget says "accepted", not "delivered" (the route answers before the write)', async () => {
    const deps = fakeDeps([ok({})]);
    expect(await agentSend(deps, { id: OTHER, text: 'go', enter: true })).toBe(EXIT.ok);
    expect(deps.out.join('')).toMatch(/accepted for/);
    expect(deps.out.join('')).not.toMatch(/delivered to/);
  });

  it('a sleeping remote host: `buffered` gets its own line and exit 0, never "accepted"', async () => {
    const deps = fakeDeps([ok({ buffered: true })]);
    expect(await agentSend(deps, { id: OTHER, text: 'go', enter: true })).toBe(EXIT.ok);
    expect(deps.out.join('')).toMatch(/buffered for .*asleep/);
    expect(deps.out.join('')).not.toMatch(/accepted for/);
  });

  it('`dropped` (over the wake buffer cap) is a failure: exit 1, nothing claims success', async () => {
    const deps = fakeDeps([ok({ buffered: true, dropped: true })]);
    expect(await agentSend(deps, { id: OTHER, text: 'go', enter: true })).toBe(EXIT.error);
    expect(deps.err.join('')).toMatch(/dropped: .*nothing will be typed/);
    expect(deps.out).toEqual([]);

    const json = fakeDeps([ok({ buffered: true, dropped: true })], true);
    expect(await agentSend(json, { id: OTHER, text: 'go', enter: true })).toBe(EXIT.error);
    expect(JSON.parse(json.out.join(''))).toEqual({ buffered: true, dropped: true });
  });

  it('reports a tagged duplicate instead of claiming delivery', async () => {
    const deps = fakeDeps([ok({ delivered: false, duplicate: true })]);
    await agentSend(deps, { id: OTHER, text: 'go', enter: true });
    expect(deps.out.join('')).toMatch(/duplicate/);
  });
});

describe('agent wait', () => {
  it('--until goes to /wait and a 400 for a hook-less mode is passed through, not papered over', async () => {
    const deps = fakeDeps([apiError(400, 'INVALID_INPUT', 'until=stop is not available for mode opencode')]);
    expect(await agentWait(deps, { id: OTHER, until: 'stop', timeoutMs: 1000 })).toBe(EXIT.error);
    expect(deps.calls[0]).toMatchObject({
      method: 'GET',
      path: `/api/v1/sessions/${OTHER}/wait`,
      query: { until: 'stop', timeout: 1000 },
    });
    expect(deps.err.join('')).toMatch(/INVALID_INPUT.*opencode/);
  });

  it('--match goes to /wait-output with from=buffer by default', async () => {
    const deps = fakeDeps([ok({ wait: { matched: true, match: 'DONE_1', snippet: 'DONE_1' } })]);
    expect(await agentWait(deps, { id: OTHER, match: 'DONE_1', timeoutMs: 1000 })).toBe(EXIT.ok);
    expect(deps.calls[0]).toMatchObject({
      path: `/api/v1/sessions/${OTHER}/wait-output`,
      query: { match: 'DONE_1', from: 'buffer', timeout: 1000 },
    });
  });

  it('refuses --until together with --match', async () => {
    const deps = fakeDeps([]);
    expect(await agentWait(deps, { id: OTHER, until: 'idle', match: 'x', timeoutMs: 1000 })).toBe(EXIT.refused);
    expect(deps.calls).toEqual([]);
  });

  it('a wait that ended without an answer is reported as dead, not as `signal: null`', async () => {
    const deps = fakeDeps([ok({ wait: { ended: true, signal: null, timedOut: false } })]);
    expect(await agentWait(deps, { id: OTHER, until: 'stop', timeoutMs: 1000 })).toBe(EXIT.dead);
    expect(deps.out.join('')).toMatch(/went away/);
    expect(deps.out.join('')).not.toMatch(/signal: null/);
  });

  it('exit codes: matched/signal 0, timeout 2, exit 3', () => {
    expect(waitExitCode({ signal: 'stop' })).toBe(EXIT.ok);
    expect(waitExitCode({ matched: true })).toBe(EXIT.ok);
    expect(waitExitCode({ matched: false, timedOut: true })).toBe(EXIT.timeout);
    expect(waitExitCode({ timedOut: true })).toBe(EXIT.timeout);
    expect(waitExitCode({ signal: 'exit' })).toBe(EXIT.dead);
    // A worker that dies during --until stop: the registry only satisfies waiters that
    // listed `exit`, then cancels the rest → ended:true, signal:null. Never "done".
    expect(waitExitCode({ ended: true, signal: null, timedOut: false })).toBe(EXIT.dead);
    expect(waitExitCode({ ended: true, matched: false, timedOut: false })).toBe(EXIT.dead);
    expect(waitExitCode(undefined)).toBe(EXIT.error);
  });
});

describe('agent read', () => {
  it('defaults to last-response and prints the text', async () => {
    const deps = fakeDeps([ok({ text: 'the answer', timestamp: 't' })]);
    expect(await agentRead(deps, { id: OTHER })).toBe(EXIT.ok);
    expect(deps.calls[0].path).toBe(`/api/v1/sessions/${OTHER}/last-response`);
    expect(deps.out).toEqual(['the answer']);
  });

  it('says why an empty transcript is empty instead of printing nothing', async () => {
    const deps = fakeDeps([ok({ text: '' })]);
    await agentRead(deps, { id: OTHER });
    expect(deps.err.join('')).toMatch(/nothing answered yet.*--tail 3000/);
  });

  it('--tail fetches the terminal and strips ANSI', async () => {
    const deps = fakeDeps([ok({ terminalBuffer: '\u001b]0;w1 title\u0007\u001b[32m❯\u001b[0m ready \u001b(B' })]);
    expect(await agentRead(deps, { id: OTHER, tail: 500 })).toBe(EXIT.ok);
    expect(deps.calls[0]).toMatchObject({ path: `/api/v1/sessions/${OTHER}/terminal`, query: { tail: 500 } });
    expect(deps.out).toEqual(['❯ ready ']);
  });

  it('--full prints every message with its role', async () => {
    const deps = fakeDeps([
      ok({
        text: 'b',
        messages: [
          { role: 'user', text: 'a' },
          { role: 'assistant', text: 'b' },
        ],
      }),
    ]);
    await agentRead(deps, { id: OTHER, full: true });
    expect(deps.calls[0].query).toMatchObject({ context: 'full' });
    expect(deps.out.map(stripAnsi)).toEqual(['user: a', 'assistant: b']);
  });
});

describe('agent interrupt', () => {
  it('sends the bare ESC body under its own clientId, never to itself', async () => {
    const deps = fakeDeps([ok({ delivered: true })]);
    expect(await agentInterrupt(deps, { id: OTHER })).toBe(EXIT.ok);
    expect(deps.calls[0].body).toEqual({
      input: '\u001b',
      useMux: true,
      clientId: 'codeman-agent-cli-058ee7b5-interrupt',
      seq: 1_700_000_000_000,
    });
    const self = fakeDeps([]);
    expect(await agentInterrupt(self, { id: SELF })).toBe(EXIT.refused);
    expect(self.calls).toEqual([]);
  });
});

describe('send takes the prompt as ONE argument', () => {
  it('refuses several words, which an unquoted multi-line $(…) becomes after word splitting', () => {
    expect(sendPromptFromArgs(['review src/, then say DONE'])).toEqual({ text: 'review src/, then say DONE' });
    expect(sendPromptFromArgs(['line', 'one', 'line', 'two'])).toMatchObject({
      error: expect.stringMatching(/ONE argument, got 4/),
    });
    // A leading "-" is commander's option syntax, so the hint names the escape.
    expect(sendPromptFromArgs(['a', 'b'])).toMatchObject({ error: expect.stringContaining('send <id> -- "- fix') });
  });
});

describe('agent spawn: a worker that dies during the readiness wait', () => {
  it('is exit 3 with its own line, not the composer-timeout hint', async () => {
    const deps = fakeDeps([ok({ sessionId: OTHER, caseName: 'c' }), ok({ wait: { ended: true, matched: false } })]);
    expect(await agentSpawn(deps, { caseName: 'c', mode: 'claude', ready: true, timeoutMs: 1000 })).toBe(EXIT.dead);
    expect(deps.err.join('')).toMatch(/exited during the readiness wait/);
    expect(deps.err.join('')).not.toMatch(/composer not seen/);
  });
});

describe('agent wait: a timeout is an answer, not a failure', () => {
  it('prints a neutral line and exits 2', async () => {
    const deps = fakeDeps([ok({ wait: { timedOut: true, timeoutMs: 1000 } })]);
    expect(await agentWait(deps, { id: OTHER, until: 'stop', from: 'buffer', timeoutMs: 1000 })).toBe(EXIT.timeout);
    const line = deps.out.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    expect(line).toBe('timed out after 1000 ms (exit 2)');
    expect(deps.err).toEqual([]);
  });
});

describe('agent spawn', () => {
  it('quick-starts with lineage and waits for the claude composer', async () => {
    const deps = fakeDeps([
      ok({ sessionId: OTHER, caseName: 'scratch-1', casePath: '/x' }),
      ok({ wait: { matched: true } }),
    ]);
    expect(await agentSpawn(deps, { caseName: 'scratch-1', mode: 'claude', ready: true, timeoutMs: 2000 })).toBe(
      EXIT.ok
    );
    expect(deps.calls[0]).toMatchObject({
      method: 'POST',
      path: '/api/v1/quick-start',
      body: { caseName: 'scratch-1', mode: 'claude', parentSessionId: SELF },
    });
    expect(deps.calls[1]).toMatchObject({
      path: `/api/v1/sessions/${OTHER}/wait-output`,
      query: { match: 'shift+tab', from: 'buffer', timeout: 2000 },
    });
    expect(deps.out).toEqual([OTHER]); // stdout is the id ALONE, so `SID=$(…)` works; prose goes to stderr
    expect(deps.err.join('')).toMatch(/spawned .*composer up/s);
  });

  it('labels the case as agent scratch on the spawn request, and on no other request', async () => {
    // The label drives a recursive-delete affordance in the Add Case UI: it may only ride
    // the request that can CREATE a case directory (quick-start), never anything else.
    const spawn = fakeDeps([ok({ sessionId: OTHER, caseName: 'c' }), ok({ wait: { matched: true } })]);
    await agentSpawn(spawn, { caseName: 'c', mode: 'claude', ready: true, timeoutMs: 1000 });
    expect(spawn.calls[0].headers).toEqual({ 'X-Codeman-Agent-Origin': 'codeman-agent-cli' });
    expect(spawn.calls[1].headers?.['X-Codeman-Agent-Origin']).toBeUndefined(); // the readiness wait

    const everyOther = fakeDeps((o) =>
      o.path === '/api/v1/sessions' ? ok([]) : ok({ wait: { signal: 'stop' }, text: '' })
    );
    await agentLs(everyOther);
    await agentSend(everyOther, { id: OTHER, text: 'hi', enter: true });
    await agentWait(everyOther, { id: OTHER, until: 'stop', from: 'buffer', timeoutMs: 1000 });
    await agentRead(everyOther, { id: OTHER });
    await agentInterrupt(everyOther, { id: OTHER });
    await agentRm(everyOther, { id: OTHER });
    expect(everyOther.calls.length).toBeGreaterThan(5);
    for (const call of everyOther.calls) expect(call.headers?.['X-Codeman-Agent-Origin'], call.path).toBeUndefined();
    expect(baseHeaders(ctx())).not.toHaveProperty('X-Codeman-Agent-Origin');
  });

  it('takes the readiness mark from the CLI registry, not from a mode list', () => {
    expect(composerReadyMark('claude')).toBe('shift+tab');
    expect(composerReadyMark('deepseek')).toBe('❯');
    expect(composerReadyMark('pi')).toBeUndefined();
    expect(composerReadyMark('no-such-cli')).toBeUndefined();
  });

  it('a composer that never shows up is exit 2 and the session is left for inspection, not deleted', async () => {
    const deps = fakeDeps([ok({ sessionId: OTHER, caseName: 'c' }), ok({ wait: { matched: false, timedOut: true } })]);
    expect(await agentSpawn(deps, { caseName: 'c', mode: 'claude', ready: true, timeoutMs: 1000 })).toBe(EXIT.timeout);
    expect(deps.calls.map((c) => c.method)).toEqual(['POST', 'GET']);
    expect(deps.err.join('')).toMatch(/startup dialog/);
  });

  it('a mode without a readiness mark returns after the create, and --no-ready skips the wait everywhere', async () => {
    const pi = fakeDeps([ok({ sessionId: OTHER, caseName: 'c' })]);
    expect(await agentSpawn(pi, { caseName: 'c', mode: 'pi', ready: true, timeoutMs: 1000 })).toBe(EXIT.ok);
    expect(pi.calls).toHaveLength(1);
    const noReady = fakeDeps([ok({ sessionId: OTHER, caseName: 'c' })]);
    expect(await agentSpawn(noReady, { caseName: 'c', mode: 'claude', ready: false, timeoutMs: 1000 })).toBe(EXIT.ok);
    expect(noReady.calls).toHaveLength(1);
  });

  it('a failed readiness call reports its own reason instead of the trust-dialog hint', async () => {
    const deps = fakeDeps([ok({ sessionId: OTHER, caseName: 'c' }), apiError(429, 'RATE_LIMITED', 'waiter pool full')]);
    expect(await agentSpawn(deps, { caseName: 'c', mode: 'claude', ready: true, timeoutMs: 1000 })).toBe(EXIT.error);
    expect(deps.err.join('')).toMatch(/readiness check failed: RATE_LIMITED/);
    expect(deps.err.join('')).not.toMatch(/trust dialog/);
    expect(deps.out).toEqual([OTHER]); // the session exists; the id is still handed back
  });

  it('a failed quick-start is terminal: the error code is shown and nothing else is called', async () => {
    const deps = fakeDeps([apiError(409, 'SESSION_BUSY', 'session cap reached')]);
    expect(await agentSpawn(deps, { caseName: 'c', mode: 'claude', ready: true, timeoutMs: 1000 })).toBe(EXIT.error);
    expect(deps.calls).toHaveLength(1);
    expect(deps.err.join('')).toMatch(/SESSION_BUSY/);
  });
});

describe('session id prefixes', () => {
  const THIRD = '94990c6d-ffff-4000-8000-000000000000';
  const list = ok([{ id: SELF }, { id: OTHER }, { id: THIRD }]);

  it('a full id goes straight to the route, no list call', async () => {
    const deps = fakeDeps([ok({ text: 'x' })]);
    await agentRead(deps, { id: OTHER });
    expect(deps.calls.map((c) => c.path)).toEqual([`/api/v1/sessions/${OTHER}/last-response`]);
  });

  it('a unique prefix (what `ls` prints) resolves through the list — the routes 404 on prefixes', async () => {
    const deps = fakeDeps([ok([{ id: SELF }, { id: OTHER }]), ok({ text: 'x' })]);
    expect(await agentRead(deps, { id: '94990c6d' })).toBe(EXIT.ok);
    expect(deps.calls.map((c) => c.path)).toEqual(['/api/v1/sessions', `/api/v1/sessions/${OTHER}/last-response`]);
  });

  it('an ambiguous prefix refuses instead of picking one', async () => {
    const deps = fakeDeps([list]);
    expect(await agentRead(deps, { id: '94990c6d' })).toBe(EXIT.error);
    expect(deps.err.join('')).toMatch(/ambiguous.*94990c6d-e461.*94990c6d-ffff/);
    expect(deps.calls).toHaveLength(1);
  });

  it('an unknown prefix names the problem', async () => {
    const deps = fakeDeps([list]);
    expect(await agentRm(deps, { id: 'deadbeef' })).toBe(EXIT.error);
    expect(deps.err.join('')).toMatch(/no session starts with "deadbeef"/);
    expect(deps.calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('a prefix shorter than 8 characters refuses (exit 4) before any request, on every verb', async () => {
    expect(MIN_ID_PREFIX_LENGTH).toBe(8);
    // The maintainer's repro: `rm 9` with one other session starting with 9 deleted it.
    const rm = fakeDeps([ok([{ id: SELF }, { id: OTHER }]), ok({})]);
    expect(await agentRm(rm, { id: '9' })).toBe(EXIT.refused);
    expect(rm.calls).toEqual([]);
    expect(rm.err.join('')).toMatch(/"9" is shorter than 8 characters.*8-character id `agent ls` prints/);

    const short = OTHER.slice(0, 7);
    const verbs: Array<[string, (deps: AgentDeps) => Promise<number>]> = [
      ['send', (d) => agentSend(d, { id: short, text: 'go', enter: true })],
      ['wait', (d) => agentWait(d, { id: short, until: 'idle', timeoutMs: 1000 })],
      ['read', (d) => agentRead(d, { id: short })],
      ['interrupt', (d) => agentInterrupt(d, { id: short })],
      ['rm', (d) => agentRm(d, { id: short })],
    ];
    for (const [verb, call] of verbs) {
      const deps = fakeDeps([ok([{ id: SELF }, { id: OTHER }]), ok({ delivered: true })]);
      expect(await call(deps), verb).toBe(EXIT.refused);
      expect(deps.calls, verb).toEqual([]);
    }
  });

  it('rm runs the self guard before the list and again on the resolved id', async () => {
    const first = fakeDeps([ok([{ id: SELF }])]);
    expect(await agentRm(first, { id: SELF.slice(0, 8) })).toBe(EXIT.refused);
    expect(first.calls).toEqual([]); // refused before any request
    const resolved = fakeDeps([ok([{ id: SELF }, { id: OTHER }])]);
    expect(await agentRm(resolved, { id: 'deadbeef' })).toBe(EXIT.error); // nothing to delete
    expect(resolved.calls.map((c) => c.method)).toEqual(['GET']);
  });
});

describe('help texts carry the traps the skill documents', () => {
  const agent = registerAgentCommands(new Command());
  const sub = (name: string) => agent.commands.find((c) => c.name() === name)!;

  it('--match says the prompt must not contain the marker verbatim, and how to split it', () => {
    const match = sub('wait').options.find((o) => o.long === '--match')!;
    expect(match.description).toMatch(/never put the marker verbatim in the prompt/);
    expect(match.description).toMatch(/WORKDONE followed by _4711.*WORKDONE_4711/);
  });

  it('send names the -- escape for a prompt that starts with "-"', () => {
    expect(sub('send').description()).toContain('send <id> -- "- fix the bug"');
  });

  it('rm does not claim a lineage check it does not make', () => {
    expect(sub('rm').description()).toMatch(/^Delete any session except this one/);
  });
});

describe('option parsing', () => {
  it('positive integers only, the server rejects the rest', () => {
    expect(parsePositiveInt(undefined, 60000)).toBe(60000);
    expect(parsePositiveInt('1500', 1)).toBe(1500);
    for (const bad of ['0', '-1', '1.5', '30s', '']) expect(() => parsePositiveInt(bad, 1)).toThrow(/positive integer/);
  });

  it('describeFailure prefers the envelope and falls back to the status line', () => {
    expect(describeFailure(apiError(404, 'NOT_FOUND', 'no such session'))).toBe(
      'NOT_FOUND: no such session (HTTP 404)'
    );
    expect(describeFailure({ status: 403, text: 'Forbidden: host not allowed' })).toBe(
      'HTTP 403 Forbidden: host not allowed'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The real transport against a local server
// ─────────────────────────────────────────────────────────────────────────────

describe('httpRequest', () => {
  let server: http.Server;
  let apiUrl: string;
  const seen: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
        if (req.url?.startsWith('/plain')) {
          res.writeHead(401, { 'Content-Type': 'text/plain' }).end('Unauthorized');
          return;
        }
        res
          .writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ success: true, data: { echo: true } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    apiUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('carries lineage headers, Basic auth and a urlencoded query (the + in shift+tab survives)', async () => {
    const res = await httpRequest(ctx({ apiUrl, auth: { username: 'joe', password: 'pw' } }), {
      method: 'GET',
      path: '/api/v1/sessions/x/wait-output',
      query: { match: 'shift+tab', from: 'buffer', timeout: 1000, nocase: undefined },
    });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ success: true, data: { echo: true } });
    const last = seen.at(-1)!;
    expect(last.url).toBe('/api/v1/sessions/x/wait-output?match=shift%2Btab&from=buffer&timeout=1000');
    expect(last.headers['x-codeman-parent-session']).toBe(SELF);
    expect(last.headers['x-codeman-agent-origin']).toBeUndefined(); // only spawn's quick-start carries it
    expect(last.headers.authorization).toBe(`Basic ${Buffer.from('joe:pw').toString('base64')}`);
  });

  it('posts JSON bodies with a length, and no auth header when the server is open', async () => {
    await httpRequest(ctx({ apiUrl }), {
      method: 'POST',
      path: '/api/v1/sessions/x/input',
      body: { input: 'hi\r', seq: 1 },
    });
    const last = seen.at(-1)!;
    expect(last.method).toBe('POST');
    expect(JSON.parse(last.body)).toEqual({ input: 'hi\r', seq: 1 });
    expect(last.headers['content-type']).toBe('application/json');
    expect(last.headers.authorization).toBeUndefined();
  });

  it('keeps a plain-text body when the answer is not JSON', async () => {
    const res = await httpRequest(ctx({ apiUrl }), { method: 'GET', path: '/plain' });
    expect(res.status).toBe(401);
    expect(res.json).toBeUndefined();
    expect(res.text).toBe('Unauthorized');
  });
});
