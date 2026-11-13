/**
 * @fileoverview The codeman skill's local model helpers: `local_model`, the `local` worker kind
 * of `spawn_worker`, and `sendmark`.
 *
 * Runs the REAL `skills/codeman/preamble.sh` in bash with `CURL` replaced by a stub that plays a
 * fake Codeman: it records every request (method, route, query, body) in order and answers from
 * files the test wrote, one per route and optionally one per call of that route. So these check
 * what the functions put on the wire and what they make of each answer, never a copy of their
 * logic, and nothing here talks to a real server.
 *
 * Port: N/A (no server; the stub answers every request).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PREAMBLE = join(__dirname, '..', 'skills', 'codeman', 'preamble.sh');
const API = 'http://127.0.0.1:9';
const SELF = 'caller-session-0000';
const SID = 'worker-local-0001';

// The preamble builds every request body with jq.
let hasJq = true;
try {
  execFileSync('jq', ['--version'], { stdio: 'ignore' });
} catch {
  hasJq = false;
}

/**
 * The fake Codeman. Each call is appended to $CALLS as one JSON line, then answered from
 * $ANSWERS/<route>.<n> (the n-th call of that route) or $ANSWERS/<route>. `<file>.code` is the
 * HTTP status `-w` reports (default 200) and `<file>.delay` seconds to sleep first. A wait-output
 * for `DONE_<token>` writes $WD/codeman-answer-<token>.md first when $ANSWER_TEXT is set, or a
 * symlink to $ANSWER_SYMLINK, the way a worker would before printing its marker; with
 * $ANSWER_APPEND it appends that line on every such call, a worker still writing its answer.
 *
 * Written without a single dollar-brace, because this is a JS template literal.
 */
const STUB = String.raw`
stub() {
  local m=GET u='' d='' q='' w='' route key n f tok
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -X) m=$2; shift ;;
      -d|--data-binary) d=$2; shift ;;
      --data-urlencode) q="$q&$2"; shift ;;
      -w) w=$2; shift ;;
      -H|-u|-o) shift ;;
      http*) u=$1 ;;
    esac
    shift
  done
  route=$(printf '%s' "$u" | sed "s|^$CODEMAN_API_URL/api/v1/||")
  case "$route" in
    local-model) key=lm-get ;;
    local-model/runtime) key=lm-runtime ;;
    quick-start) key=quick-start ;;
    sessions/*/*) key=$(basename "$route") ;;
    sessions/*) if [ "$m" = DELETE ]; then key=delete; else key=session; fi ;;
    *) key=other ;;
  esac
  jq -nc --arg m "$m" --arg k "$key" --arg q "$q" --arg d "$d" '{m:$m,key:$k,q:$q,d:$d}' >> "$CALLS"
  n=$(grep -cF "\"key\":\"$key\"" "$CALLS")
  f="$ANSWERS/$key.$n"; [ -f "$f" ] || f="$ANSWERS/$key"
  if [ "$key" = wait-output ]; then
    case "$q" in *match=DONE_*)
      tok=$(printf '%s' "$q" | sed -e 's/.*match=DONE_//' -e 's/&.*//')
      if [ -n "$ANSWER_TEXT" ]; then printf '%s' "$ANSWER_TEXT" > "$WD/codeman-answer-$tok.md"; fi
      if [ -n "$ANSWER_APPEND" ]; then printf '%s\n' "$ANSWER_APPEND" >> "$WD/codeman-answer-$tok.md"; fi
      if [ -n "$ANSWER_SYMLINK" ]; then ln -s "$ANSWER_SYMLINK" "$WD/codeman-answer-$tok.md"; fi ;;
    esac
  fi
  [ -f "$f.delay" ] && sleep "$(cat "$f.delay")"
  if [ -f "$f" ]; then cat "$f"; else printf '%s' '{"success":false,"error":"no stub answer","errorCode":"NOT_FOUND"}'; fi
  if [ -n "$w" ]; then printf '\n%s' "$(cat "$f.code" 2>/dev/null || echo 200)"; fi
}
CURL=(stub)
`;

interface Call {
  m: string;
  key: string;
  q: string;
  d: string;
}

interface Run {
  rc: number | null;
  stdout: string;
  stderr: string;
  calls: Call[];
  wd: string;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Sources the preamble, installs the stub, runs `body`, and returns what happened. */
function runSkill(body: string, answers: Record<string, string> = {}, env: Record<string, string> = {}): Run {
  const dir = mkdtempSync(join(tmpdir(), 'codeman-local-skill-'));
  dirs.push(dir);
  const answerDir = join(dir, 'answers');
  const wd = join(dir, 'wd');
  const calls = join(dir, 'calls');
  mkdirSync(answerDir);
  mkdirSync(wd);
  writeFileSync(calls, '');
  for (const [name, content] of Object.entries(answers)) writeFileSync(join(answerDir, name), content);
  const res = spawnSync('bash', ['-c', `. "$PREAMBLE" >/dev/null\n${STUB}\n${body}`], {
    encoding: 'utf-8',
    timeout: 20_000,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      PREAMBLE,
      CALLS: calls,
      ANSWERS: answerDir,
      WD: wd,
      CODEMAN_API_URL: API,
      CODEMAN_SESSION_ID: SELF,
      ...env,
    },
  });
  const callList = readFileSync(calls, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Call);
  return { rc: res.status, stdout: res.stdout, stderr: res.stderr, calls: callList, wd };
}

/** The `data` of GET /api/local-model, as the server builds it. */
function status(install: Record<string, unknown>, recommendation: Record<string, unknown> = {}): string {
  return JSON.stringify({
    success: true,
    data: {
      hardware: { platform: 'darwin' },
      recommendation: { verdict: 'ok', headline: { text: 'A model fits.' }, ...recommendation },
      catalogUpdated: '2026-11-06',
      install: { running: false, actions: [], ...install },
    },
  });
}

const INSTALLED = {
  state: 'installed',
  cli: 'opencode',
  cliLabel: 'OpenCode',
  endpointId: 'local-ollama',
  model: { id: 'qwen3.6:35b-a3b', label: 'Qwen3.6 35B-A3B' },
};
const RUNNING = status({ ...INSTALLED, running: true, actions: ['start-session', 'stop', 'remove'] });
const STOPPED = status({ ...INSTALLED, running: false, actions: ['start', 'remove'] });
/** What a 1.51 server lists beside `cli`: the agents the model can be run with, and the models on the Mac. */
const AGENTS = [
  { cli: 'opencode', cliLabel: 'OpenCode', default: true, status: 'ready', readyMark: '┃', actions: ['start-session'] },
  { cli: 'pi', cliLabel: 'Pi', default: false, status: 'ready', actions: ['start-session'] },
  {
    cli: 'deepseek',
    cliLabel: 'DeepSeek',
    default: false,
    status: 'ready',
    readyMark: '❯',
    actions: ['start-session'],
  },
  { cli: 'claude', cliLabel: 'Claude Code', default: false, status: 'installable', installCommand: 'x', actions: [] },
];
const LIBRARY = [
  { id: 'qwen3.6:35b-a3b', label: 'Qwen3.6 35B-A3B', active: true, verified: true, status: 'ready', sizeGb: '23.1' },
  { id: 'gpt-oss:20b', label: 'GPT-OSS 20B', active: false, verified: true, status: 'ready', sizeGb: '13.8' },
];
const WITH_AGENTS = status({
  ...INSTALLED,
  running: true,
  harnesses: AGENTS,
  library: LIBRARY,
  actions: ['start-session', 'stop', 'remove'],
});
const QUICK_START = JSON.stringify({ success: true, data: { sessionId: SID, casePath: '/tmp/summ' } });
const MATCHED = JSON.stringify({ success: true, data: { wait: { matched: true, timedOut: false, ended: false } } });
const NOT_MATCHED = JSON.stringify({ success: true, data: { wait: { matched: false, timedOut: true, ended: false } } });

function lastJson(stdout: string): Record<string, unknown> {
  const lines = stdout.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
}

describe.skipIf(!hasJq)('preamble local_model', () => {
  const cases: Array<{ name: string; body: string; code?: string; rc: number; expect: Record<string, unknown> }> = [
    {
      name: 'a running model: spawnable now, with the harness, endpoint and model',
      body: RUNNING,
      rc: 0,
      expect: {
        spawnable: true,
        running: true,
        cli: 'opencode',
        cliLabel: 'OpenCode',
        endpointId: 'local-ollama',
        modelId: 'qwen3.6:35b-a3b',
        modelLabel: 'Qwen3.6 35B-A3B',
      },
    },
    {
      name: 'a server that lists them: the agents with their status and mark, and the models on this Mac',
      body: WITH_AGENTS,
      rc: 0,
      expect: {
        spawnable: true,
        cli: 'opencode',
        agents: [
          { cli: 'opencode', cliLabel: 'OpenCode', status: 'ready', default: true, readyMark: '┃' },
          { cli: 'pi', cliLabel: 'Pi', status: 'ready', default: false },
          { cli: 'deepseek', cliLabel: 'DeepSeek', status: 'ready', default: false, readyMark: '❯' },
          { cli: 'claude', cliLabel: 'Claude Code', status: 'installable', default: false },
        ],
        models: [
          { id: 'qwen3.6:35b-a3b', label: 'Qwen3.6 35B-A3B', active: true, status: 'ready', sizeGb: '23.1' },
          { id: 'gpt-oss:20b', label: 'GPT-OSS 20B', active: false, status: 'ready', sizeGb: '13.8' },
        ],
      },
    },
    {
      name: 'installed, but no coding agent that can run it is on this Mac: no-agent, running or stopped',
      body: status({
        ...INSTALLED,
        running: false,
        harnesses: [
          { cli: 'opencode', cliLabel: 'OpenCode', default: true, status: 'installable', actions: ['install'] },
        ],
        // `start` with no error alone would read as spawnable.
        actions: ['start', 'install-agent', 'remove'],
      }),
      rc: 1,
      expect: { spawnable: false, reason: 'no-agent', agents: [{ cli: 'opencode', status: 'installable' }] },
    },
    {
      name: 'an installed model whose runtime is stopped: spawnable once started',
      body: STOPPED,
      rc: 0,
      expect: { spawnable: true, running: false, cli: 'opencode' },
    },
    {
      name: 'start offered beside an error (another program holds the port): blocked, with the sentence',
      body: status({
        ...INSTALLED,
        actions: ['start', 'remove'],
        error: {
          code: 'port-in-use',
          next: 'other-port',
          message: { text: 'Port {port} is in use by another program.', vars: { port: '11435' } },
        },
      }),
      rc: 1,
      expect: {
        spawnable: false,
        reason: 'blocked',
        errorCode: 'port-in-use',
        message: 'Port 11435 is in use by another program.',
      },
    },
    {
      name: 'not a Mac',
      body: JSON.stringify({
        success: true,
        data: {
          hardware: { platform: 'linux' },
          recommendation: { verdict: 'none', reason: 'not-macos', headline: { text: 'x' } },
          install: { state: 'idle', running: false, actions: ['install'] },
        },
      }),
      rc: 1,
      expect: { spawnable: false, reason: 'not-mac' },
    },
    {
      name: 'nothing installed',
      body: status({ state: 'idle', actions: ['install'] }),
      rc: 1,
      expect: { spawnable: false, reason: 'not-installed' },
    },
    {
      name: 'nothing installed on a Mac that fits none: the reason is the server sentence',
      body: status(
        { state: 'idle', actions: ['install'] },
        {
          verdict: 'none',
          reason: 'memory',
          headline: { text: 'Nothing fits in {budget} GB.', vars: { budget: '12' } },
        }
      ),
      rc: 1,
      expect: {
        spawnable: false,
        reason: 'not-installed',
        message: 'No local model is installed. Nothing fits in 12 GB.',
      },
    },
    {
      name: 'an install that has not finished',
      body: status({ state: 'paused', step: 'model', actions: ['resume', 'install', 'remove'] }),
      rc: 1,
      expect: { spawnable: false, reason: 'install-unfinished', state: 'paused', step: 'model' },
    },
    {
      name: 'admin only in multi-user mode (403)',
      body: JSON.stringify({ success: false, error: 'Admin only in multi-user mode', errorCode: 'FORBIDDEN' }),
      code: '403',
      rc: 1,
      expect: { spawnable: false, reason: 'admin-only' },
    },
    {
      name: 'a Codeman without local model support (404)',
      body: JSON.stringify({ message: 'Route GET:/api/local-model not found', error: 'Not Found', statusCode: 404 }),
      code: '404',
      rc: 1,
      expect: { spawnable: false, reason: 'unsupported' },
    },
    {
      name: 'refused credentials (a plain-text 401)',
      body: 'Unauthorized',
      code: '401',
      rc: 1,
      expect: { spawnable: false, reason: 'unauthorized' },
    },
    {
      name: 'no answer at all',
      body: '',
      code: '000',
      rc: 1,
      expect: { spawnable: false, reason: 'unreachable' },
    },
    {
      name: 'any other failure carries its status and error',
      body: JSON.stringify({ success: false, error: 'boom', errorCode: 'INTERNAL_ERROR' }),
      code: '500',
      rc: 1,
      expect: { spawnable: false, reason: 'error', status: '500', message: 'boom' },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const answers: Record<string, string> = { 'lm-get': c.body };
      if (c.code) answers['lm-get.code'] = c.code;
      const run = runSkill('local_model', answers);
      expect(run.rc).toBe(c.rc);
      expect(run.stdout.trim().split('\n')).toHaveLength(1);
      expect(lastJson(run.stdout)).toMatchObject(c.expect);
      // One read-only GET of the alias path, and nothing else.
      expect(run.calls.map((call) => `${call.m} ${call.key}`)).toEqual(['GET lm-get']);
    });
  }
});

describe.skipIf(!hasJq)('preamble spawn_worker <name> local', () => {
  it('starts a stopped runtime, then quick-starts the harness on the endpoint and waits for its composer', () => {
    const run = runSkill(
      'spawn_worker summ local',
      {
        'lm-get.1': STOPPED,
        'lm-runtime': JSON.stringify({ success: true, data: { state: 'installed', running: false } }),
        'lm-get.2': RUNNING,
        'quick-start': QUICK_START,
        'wait-output': MATCHED,
      },
      // A cloud advisor must never be attached to a worker on the local model.
      { CODEMAN_WORKER_ADVISOR: 'opus' }
    );
    expect(run.stderr).toBe('');
    expect(run.rc).toBe(0);
    expect(run.stdout).toBe(`${SID}\n`);
    expect(run.calls.map((call) => `${call.m} ${call.key}`)).toEqual([
      'GET lm-get',
      'POST lm-runtime',
      'GET lm-get',
      'POST quick-start',
      'GET wait-output',
    ]);
    expect(JSON.parse(run.calls[1].d)).toEqual({ action: 'start' });
    expect(JSON.parse(run.calls[3].d)).toEqual({
      caseName: 'summ',
      mode: 'opencode',
      parentSessionId: SELF,
      customModel: { endpointId: 'local-ollama', modelId: 'qwen3.6:35b-a3b' },
    });
    expect(run.calls[4].q).toContain('match=┃');
    expect(run.calls[4].q).toContain('from=buffer');
  });

  it('does not touch a runtime that already runs', () => {
    const run = runSkill('spawn_worker summ local', {
      'lm-get': RUNNING,
      'quick-start': QUICK_START,
      'wait-output': MATCHED,
    });
    expect(run.rc).toBe(0);
    expect(run.stdout).toBe(`${SID}\n`);
    expect(run.calls.map((call) => call.key)).toEqual(['lm-get', 'quick-start', 'wait-output']);
  });

  for (const answer of [
    { requiresContextWarning: true, modelId: 'qwen3.6:35b-a3b', contextLength: 32768, minSafeContextTokens: 40000 },
    { requiresConfirmation: true, currentlyLoadedModel: 'other', affectedSessions: [{ id: 'x', name: 'w9' }] },
  ]) {
    it(`never confirms on anyone's behalf: ${Object.keys(answer)[0]} fails the spawn with empty stdout`, () => {
      // The route returns these bare; the server's envelope wraps them as success data.
      const run = runSkill('spawn_worker summ local', {
        'lm-get': RUNNING,
        'quick-start': JSON.stringify({ success: true, data: answer }),
      });
      expect(run.rc).toBe(1);
      expect(run.stdout).toBe('');
      expect(run.stderr).toMatch(/wants a person to confirm/);
      expect(run.stderr).toContain(Object.keys(answer)[0]);
      // One quick-start, sent without any confirmation flag, and nothing after it.
      expect(run.calls.map((call) => call.key)).toEqual(['lm-get', 'quick-start']);
      expect(JSON.parse(run.calls[1].d).customModel).toEqual({
        endpointId: 'local-ollama',
        modelId: 'qwen3.6:35b-a3b',
      });
    });
  }

  it('reports a refused launch (the runtime check in quick-start) and spawns nothing', () => {
    const run = runSkill('spawn_worker summ local', {
      'lm-get': RUNNING,
      'quick-start': JSON.stringify({
        success: false,
        error: 'The model on this Mac is not running.',
        errorCode: 'OPERATION_FAILED',
      }),
    });
    expect(run.rc).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('OPERATION_FAILED');
    expect(run.calls.map((call) => call.key)).toEqual(['lm-get', 'quick-start']);
  });

  it('refuses before any quick-start when no local model is installed', () => {
    const run = runSkill('spawn_worker summ local', { 'lm-get': status({ state: 'idle', actions: ['install'] }) });
    expect(run.rc).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toMatch(/no local model to spawn on \(not-installed\)/);
    expect(run.calls.map((call) => call.key)).toEqual(['lm-get']);
  });

  it('reports a runtime that was started but did not come up, and spawns nothing', () => {
    const failed = status({
      ...INSTALLED,
      actions: ['start', 'remove'],
      error: { code: 'runtime-start-failed', next: 'start', message: { text: 'The runtime did not start.' } },
    });
    const run = runSkill('spawn_worker summ local', {
      'lm-get.1': STOPPED,
      'lm-runtime': JSON.stringify({ success: true, data: { state: 'installed', running: false } }),
      'lm-get.2': failed,
    });
    expect(run.rc).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toMatch(/started, but \(blocked\): The runtime did not start\./);
    expect(run.calls.map((call) => call.key)).toEqual(['lm-get', 'lm-runtime', 'lm-get']);
  });

  it('deletes a worker whose composer never drew and hands back nothing', () => {
    const run = runSkill('spawn_worker summ local', {
      'lm-get': RUNNING,
      'quick-start': QUICK_START,
      'wait-output': JSON.stringify({ success: true, data: { wait: { matched: false, timedOut: true } } }),
      delete: JSON.stringify({ success: true, data: {} }),
    });
    expect(run.rc).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toMatch(/never drew/);
    expect(run.calls.map((call) => `${call.m} ${call.key}`)).toEqual([
      'GET lm-get',
      'POST quick-start',
      'GET wait-output',
      'DELETE delete',
    ]);
  });

  it('refuses a harness it knows no composer mark for, unless LOCAL_READY_MARK names one', () => {
    const other = status({ ...INSTALLED, cli: 'omp', running: true, actions: ['start-session', 'stop', 'remove'] });
    const refused = runSkill('spawn_worker summ local', { 'lm-get': other });
    expect(refused.rc).toBe(1);
    expect(refused.stdout).toBe('');
    expect(refused.stderr).toMatch(/LOCAL_READY_MARK/);
    expect(refused.calls.map((call) => call.key)).toEqual(['lm-get']);

    const marked = runSkill(
      'spawn_worker summ local',
      { 'lm-get': other, 'quick-start': QUICK_START, 'wait-output': MATCHED },
      { LOCAL_READY_MARK: 'omp-ready' }
    );
    expect(marked.rc).toBe(0);
    expect(marked.stdout).toBe(`${SID}\n`);
    expect(JSON.parse(marked.calls[1].d).mode).toBe('omp');
    expect(marked.calls[2].q).toContain('match=omp-ready');
  });

  describe("local:<agent>: the coding agent is the caller's choice", () => {
    const spawn = (kind: string, lm: string = WITH_AGENTS, env: Record<string, string> = {}) =>
      runSkill(`spawn_worker summ ${kind}`, { 'lm-get': lm, 'quick-start': QUICK_START, 'wait-output': MATCHED }, env);

    it('plain local still starts the default agent, with the mark the server names', () => {
      const run = spawn('local');
      expect(run.rc).toBe(0);
      expect(JSON.parse(run.calls[1].d)).toEqual({
        caseName: 'summ',
        mode: 'opencode',
        parentSessionId: SELF,
        customModel: { endpointId: 'local-ollama', modelId: 'qwen3.6:35b-a3b' },
      });
      expect(run.calls[2].q).toContain('match=┃');
    });

    it('local:pi starts Pi without trusting the folder, and waits for the end of its startup', () => {
      const run = spawn('local:pi');
      expect(run.stderr).toBe('');
      expect(run.rc).toBe(0);
      expect(run.stdout).toBe(`${SID}\n`);
      expect(run.calls.map((call) => call.key)).toEqual(['lm-get', 'quick-start', 'wait-output']);
      expect(JSON.parse(run.calls[1].d)).toEqual({
        caseName: 'summ',
        mode: 'pi',
        parentSessionId: SELF,
        // --no-approve: the task prompt must never answer Pi's trust question.
        piConfig: { approveProjectTrust: false },
        customModel: { endpointId: 'local-ollama', modelId: 'qwen3.6:35b-a3b' },
      });
      // Not its composer rule, which is painted before Pi takes Enter.
      expect(run.calls[2].q).toContain('match=extended-keys');
      expect(run.calls[2].q).not.toContain('match=─');
    });

    it('local:deepseek starts DeepSeek Harness with the permission posture of the Run button, at its composer glyph', () => {
      const run = spawn('local:deepseek');
      expect(run.rc).toBe(0);
      expect(JSON.parse(run.calls[1].d)).toEqual({
        caseName: 'summ',
        mode: 'deepseek',
        parentSessionId: SELF,
        deepSeekConfig: { permissionMode: 'danger-full-access' },
        customModel: { endpointId: 'local-ollama', modelId: 'qwen3.6:35b-a3b' },
      });
      expect(run.calls[2].q).toContain('match=❯');
    });

    it('a DeepSeek Harness worker that opened its setup guide is deleted, never handed back: its cursor is the mark too', () => {
      // dsh-TUI 0.19.0, as the rendered pane reads: the guide, with `❯` on its first step.
      const guide = JSON.stringify({
        success: true,
        data: {
          terminalBuffer:
            '\u001b[1mWelcome to dsh-TUI\u001b[0m   Step 1 of 4\r\n  ✗ No DEEPSEEK_API_KEY yet\r\n❯ Sign in to a subscription (OAuth)\r\n',
        },
      });
      const composer = JSON.stringify({
        success: true,
        data: {
          terminalBuffer:
            '╭────╮\r\n│ ❯ Say something, or type / for commands…\r\n╰────╯\r\n qwen3.6:35b-a3b  ·  standard\r\n',
        },
      });
      const answers = { 'lm-get': WITH_AGENTS, 'quick-start': QUICK_START, 'wait-output': MATCHED };

      const blocked = runSkill('spawn_worker rev local:deepseek', {
        ...answers,
        terminal: guide,
        delete: JSON.stringify({ success: true, data: {} }),
      });
      expect(blocked.rc).toBe(1);
      expect(blocked.stdout).toBe('');
      expect(blocked.stderr).toMatch(/setup guide/);
      expect(blocked.calls.map((call) => `${call.m} ${call.key}`)).toEqual([
        'GET lm-get',
        'POST quick-start',
        'GET wait-output',
        'GET terminal',
        'DELETE delete',
      ]);

      const ready = runSkill('spawn_worker rev local:deepseek', { ...answers, terminal: composer });
      expect(ready.stderr).toBe('');
      expect(ready.rc).toBe(0);
      expect(ready.stdout).toBe(`${SID}\n`);

      // The same look for a DeepSeek worker that is not on the local model.
      const cloud = runSkill('spawn_worker rev deepseek', {
        'quick-start': QUICK_START,
        'wait-output': MATCHED,
        terminal: guide,
        delete: JSON.stringify({ success: true, data: {} }),
      });
      expect(cloud.rc).toBe(1);
      expect(cloud.stdout).toBe('');
      expect(cloud.stderr).toMatch(/setup guide/);
      expect(cloud.calls.map((call) => call.key)).toEqual(['quick-start', 'wait-output', 'terminal', 'delete']);
    });

    it('a mark the server names wins over the one this skill measured, and LOCAL_READY_MARK over both', () => {
      const named = status({
        ...INSTALLED,
        running: true,
        harnesses: AGENTS.map((agent) => (agent.cli === 'pi' ? { ...agent, readyMark: 'pi-is-up' } : agent)),
        actions: ['start-session', 'stop', 'remove'],
      });
      expect(spawn('local:pi', named).calls[2].q).toContain('match=pi-is-up');
      expect(spawn('local:pi', named, { LOCAL_READY_MARK: 'mine' }).calls[2].q).toContain('match=mine');
      expect(spawn('local:opencode', WITH_AGENTS, { LOCAL_READY_MARK: 'mine' }).calls[2].q).toContain('match=mine');
    });

    it('refuses an agent that is not startable, names the ones that are, and starts nothing', () => {
      const run = spawn('local:claude');
      expect(run.rc).toBe(1);
      expect(run.stdout).toBe('');
      expect(run.stderr).toContain("'claude' is not startable on this Mac (installable)");
      expect(run.stderr).toContain('Startable now: opencode, pi, deepseek');
      expect(run.calls.map((call) => call.key)).toEqual(['lm-get']);
    });

    it('refuses an agent the model cannot be run with at all', () => {
      const run = spawn('local:grok');
      expect(run.rc).toBe(1);
      expect(run.stdout).toBe('');
      expect(run.stderr).toContain("cannot be run with 'grok'");
      expect(run.stderr).toContain('Startable: opencode, pi, deepseek');
      expect(run.calls.map((call) => call.key)).toEqual(['lm-get']);
    });

    it('a Codeman that lists no agents: its one agent can be named, another cannot', () => {
      const same = spawn('local:opencode', RUNNING);
      expect(same.rc).toBe(0);
      expect(JSON.parse(same.calls[1].d).mode).toBe('opencode');
      expect(same.calls[2].q).toContain('match=┃');

      const other = spawn('local:pi', RUNNING);
      expect(other.rc).toBe(1);
      expect(other.stdout).toBe('');
      expect(other.stderr).toMatch(/lists one coding agent for the local model, opencode/);
      expect(other.calls.map((call) => call.key)).toEqual(['lm-get']);
    });

    it('with no agent that can be started nothing is spawned, whatever was asked for', () => {
      const none = status({
        ...INSTALLED,
        running: true,
        harnesses: [{ cli: 'opencode', cliLabel: 'OpenCode', default: true, status: 'installing', actions: [] }],
        actions: ['stop', 'remove'],
      });
      for (const kind of ['local', 'local:opencode']) {
        const run = spawn(kind, none);
        expect(run.rc).toBe(1);
        expect(run.stdout).toBe('');
        expect(run.stderr).toMatch(/no local model to spawn on \(no-agent\)/);
        expect(run.calls.map((call) => call.key)).toEqual(['lm-get']);
      }
    });

    it('a worker whose mark never shows is deleted, and the message names the agent', () => {
      const run = runSkill('spawn_worker summ local:pi', {
        'lm-get': WITH_AGENTS,
        'quick-start': QUICK_START,
        'wait-output': NOT_MATCHED,
        delete: JSON.stringify({ success: true, data: {} }),
      });
      expect(run.rc).toBe(1);
      expect(run.stdout).toBe('');
      expect(run.stderr).toMatch(/\(pi\) never drew 'extended-keys'/);
      expect(run.calls.map((call) => `${call.m} ${call.key}`)).toEqual([
        'GET lm-get',
        'POST quick-start',
        'GET wait-output',
        'DELETE delete',
      ]);
    });

    it('spawn_workers takes name:local:agent in a mixed fleet', () => {
      const run = runSkill('spawn_workers a:local:pi', {
        'lm-get': WITH_AGENTS,
        'quick-start': QUICK_START,
        'wait-output': MATCHED,
      });
      expect(run.calls.map((call) => call.key)).toContain('quick-start');
      const body = JSON.parse(run.calls.find((call) => call.key === 'quick-start')!.d);
      expect([body.caseName, body.mode]).toEqual(['a', 'pi']);
    });
  });

  it('runs a claude harness through the claude readiness path (hooks vetted, shift+tab)', () => {
    const claude = status({ ...INSTALLED, cli: 'claude', running: true, actions: ['start-session', 'stop', 'remove'] });
    const run = runSkill(
      `mkdir -p "$WD/.claude" && printf '%s' '{"hooks":{"Stop":[{"command":"curl /api/hook-event"}]}}' > "$WD/.claude/settings.local.json"
       printf '%s' "{\\"success\\":true,\\"data\\":{\\"sessionId\\":\\"${SID}\\",\\"casePath\\":\\"$WD\\"}}" > "$ANSWERS/quick-start"
       spawn_worker summ local`,
      { 'lm-get': claude, 'wait-output': MATCHED },
      { CODEMAN_WORKER_ADVISOR: 'opus' }
    );
    expect(run.stderr).toBe('');
    expect(run.rc).toBe(0);
    expect(run.stdout).toBe(`${SID}\n`);
    const body = JSON.parse(run.calls[1].d);
    expect(body.mode).toBe('claude');
    expect(body.advisorModel).toBeUndefined();
    expect(body.customModel).toEqual({ endpointId: 'local-ollama', modelId: 'qwen3.6:35b-a3b' });
    expect(run.calls[2].q).toContain('match=shift+tab');
    // The advisor read-back is skipped too: no GET of the session.
    expect(run.calls.map((call) => call.key)).toEqual(['lm-get', 'quick-start', 'wait-output']);
  });
});

describe.skipIf(!hasJq)('preamble sendmark', () => {
  const delivered = JSON.stringify({
    success: true,
    data: { delivered: true, duplicate: false, wait: { timedOut: true, ended: false, signal: null } },
  });

  /** Answers GET /api/sessions/:id with the run's own working directory, then runs `body`. */
  function withSession(body: string): string {
    return `printf '%s' "{\\"success\\":true,\\"data\\":{\\"id\\":\\"${SID}\\",\\"workingDir\\":\\"$WD\\"}}" > "$ANSWERS/session"; ${body}`;
  }

  it('sends once, waits for the split marker, and returns the answer file', () => {
    const run = runSkill(
      withSession(`sendmark ${SID} $'Summarize these files:\\n- a.md\\n- b.md' 30`),
      { input: delivered, 'wait-output': MATCHED },
      { ANSWER_TEXT: 'a.md: setup. b.md: usage.' }
    );
    expect(run.stderr).toBe('');
    expect(run.rc).toBe(0);
    const out = lastJson(run.stdout);
    expect(out).toMatchObject({
      delivered: true,
      matched: true,
      answer: 'a.md: setup. b.md: usage.',
      truncated: false,
    });
    const token = out.token as string;
    expect(token).toMatch(/^m[0-9a-f]+$/);
    expect(out.answerFile).toBe(join(run.wd, `codeman-answer-${token}.md`));

    expect(run.calls.map((call) => `${call.m} ${call.key}`)).toEqual(['GET session', 'POST input', 'GET wait-output']);
    const input = JSON.parse(run.calls[1].d) as Record<string, unknown>;
    // The exactly-once body: the per-worker clientId, an epoch-second seq, one Enter at the end.
    expect(input.clientId).toBe(`codeman-agent-1-${SID}`);
    expect(typeof input.seq).toBe('number');
    expect(input).toMatchObject({ useMux: true, wait: 'exit', waitTimeout: 1000 });
    const text = input.input as string;
    expect(text.endsWith('\r')).toBe(true);
    expect(text.slice(0, -1)).not.toMatch(/[\r\n]/);
    expect(text.startsWith('Summarize these files: - a.md - b.md (When you are done')).toBe(true);
    expect(text).toContain(`codeman-answer-${token}.md`);
    expect(text).toContain(`the word DONE immediately followed by _${token}`);
    // Split: the typed prompt never holds the joined marker, so its echo cannot match.
    expect(text).not.toContain(`DONE_${token}`);
    expect(run.calls[2].q).toContain(`match=DONE_${token}`);
    expect(run.calls[2].q).toContain('from=buffer');
  });

  it('answers 2 when no marker prints before the timeout, and deletes nothing', () => {
    const run = runSkill(withSession(`sendmark ${SID} 'count to three' 1`), {
      input: delivered,
      'wait-output': NOT_MATCHED,
      'wait-output.delay': '1',
    });
    expect(run.rc).toBe(2);
    expect(lastJson(run.stdout)).toMatchObject({ delivered: true, matched: false, answer: null });
    expect(run.calls.some((call) => call.key === 'delete')).toBe(false);
  });

  // Seen on a Mac (2026-11-12): Claude Code runs zsh there, and zsh hands every subshell the same
  // $RANDOM. A lead sent two workers in ONE folder their tasks in the same second, both prompts
  // named the same answer file, and one worker's summary replaced the other's.
  it('gives each worker its own token and answer file, in the same second and with the same $RANDOM', () => {
    const other = 'b7e1c2d3-0000-4000-8000-00000000beef';
    const run = runSkill(
      withSession(
        // Two calls at once that draw the same number: what zsh does by itself. bash reseeds its
        // generator in every subshell, so here the variable is made a plain one that always reads 7.
        `unset RANDOM; RANDOM=7
         ( sendmark ${SID} 'count to three' 1 >/dev/null ) &
         ( sendmark ${other} 'count to three' 1 >/dev/null ) &
         wait; true`
      ),
      { input: delivered, 'wait-output': NOT_MATCHED, 'wait-output.delay': '1' }
    );
    expect(run.stderr).toBe('');
    const tokens = run.calls
      .filter((call) => call.key === 'input')
      .map((call) => /codeman-answer-(m[0-9a-f]+)\.md/.exec((JSON.parse(call.d) as { input: string }).input)?.[1] ?? '')
      .sort();
    expect(tokens).toHaveLength(2);
    // m, eight digits of the second, four of $RANDOM, six of the worker's id.
    for (const token of tokens) expect(token).toMatch(/^m[0-9a-f]{18}$/);
    // The same draw in both calls...
    expect(tokens.map((token) => token.slice(9, 13))).toEqual(['0007', '0007']);
    // ...and still two files, told apart by the workers' own ids.
    expect(tokens[0]).not.toBe(tokens[1]);
    expect(tokens.map((token) => token.slice(13)).sort()).toEqual(['b7e1c2', 'eca000']);
  });

  it('reads the answer file without a marker once it held still for a round (a full-screen pane draws the marker in pieces)', () => {
    // Measured on opencode 1.3.0: a reply streamed a character or two at a time reaches the
    // stripped stream as D, spinner, O, spinner, N, ... and never matches, while the screen
    // shows the whole token. The file must still end the wait.
    const run = runSkill(
      withSession(`sendmark ${SID} 'count to three' 30`),
      { input: delivered, 'wait-output': NOT_MATCHED },
      { ANSWER_TEXT: 'one two three' }
    );
    expect(run.stderr).toBe('');
    expect(run.rc).toBe(0);
    expect(lastJson(run.stdout)).toMatchObject({ delivered: true, matched: false, answer: 'one two three' });
    // The first round finds the file, the second finds it unchanged: two marker waits, then done.
    expect(run.calls.map((call) => call.key)).toEqual(['session', 'input', 'wait-output', 'wait-output']);
    for (const call of run.calls.slice(2)) expect(call.q).toContain('timeout=10000');
  });

  it('does not read an answer file that is still changing, and answers 2 at the timeout', () => {
    const run = runSkill(
      withSession(`sendmark ${SID} 'count to three' 3`),
      { input: delivered, 'wait-output': NOT_MATCHED, 'wait-output.delay': '1' },
      { ANSWER_APPEND: 'one more line' }
    );
    expect(run.rc).toBe(2);
    expect(lastJson(run.stdout)).toMatchObject({ matched: false, answer: null });
    expect(run.calls.filter((call) => call.key === 'wait-output').length).toBeGreaterThanOrEqual(2);
  });

  it('answers 3 when the worker ends while it waits for the answer file after the marker', () => {
    const run = runSkill(withSession(`sendmark ${SID} 'count to three' 30`), {
      input: delivered,
      'wait-output': MATCHED,
      wait: JSON.stringify({ success: true, data: { wait: { signal: 'exit', ended: false, timedOut: false } } }),
    });
    expect(run.rc).toBe(3);
    expect(lastJson(run.stdout)).toMatchObject({ matched: true, answer: null, ended: true });
    expect(run.calls.map((call) => call.key)).toEqual(['session', 'input', 'wait-output', 'wait']);
  });

  it('still waits two seconds per check for the answer file when the exit wait gets no answer', () => {
    const started = Date.now();
    const run = runSkill(
      withSession(`sendmark ${SID} 'count to three' 30`),
      // No answer file for `wait`: the stub answers success:false, as a server that is gone.
      { input: delivered, 'wait-output': MATCHED },
      { SENDMARK_FILE_WAIT: '2' }
    );
    expect(run.rc).toBe(4);
    expect(run.calls.map((call) => call.key)).toEqual(['session', 'input', 'wait-output', 'wait']);
    expect(Date.now() - started).toBeGreaterThanOrEqual(2000);
  });

  it('answers 4 when the marker printed but no answer file turned up', () => {
    const run = runSkill(
      withSession(`sendmark ${SID} 'count to three' 30`),
      { input: delivered, 'wait-output': MATCHED },
      { SENDMARK_FILE_WAIT: '0' }
    );
    expect(run.rc).toBe(4);
    expect(lastJson(run.stdout)).toMatchObject({ matched: true, answer: null });
  });

  it('refuses to read an answer file that is a symlink', () => {
    const secret = join(tmpdir(), 'codeman-sendmark-not-read');
    const run = runSkill(
      withSession(
        `printf 'private' > "${secret}"; sendmark ${SID} 'count to three' 30; rc=$?; rm -f "${secret}"; exit $rc`
      ),
      { input: delivered, 'wait-output': MATCHED },
      { ANSWER_SYMLINK: secret, SENDMARK_FILE_WAIT: '0' }
    );
    expect(run.rc).toBe(4);
    expect(run.stderr).toMatch(/is a symlink, not read/);
    expect(run.stdout).not.toContain('private');
    expect(lastJson(run.stdout)).toMatchObject({ matched: true, answer: null });
  });

  it('answers 3 when the pane did not take the prompt because the worker ended', () => {
    const run = runSkill(withSession(`sendmark ${SID} 'count to three' 30`), {
      input: JSON.stringify({
        success: true,
        data: { delivered: false, duplicate: false, wait: { ended: true, aborted: false } },
      }),
    });
    expect(run.rc).toBe(3);
    expect(lastJson(run.stdout)).toMatchObject({ delivered: false, matched: false });
    expect(run.calls.map((call) => call.key)).toEqual(['session', 'input']);
  });

  it('answers 3 when the worker ends while it waits for the marker', () => {
    const run = runSkill(withSession(`sendmark ${SID} 'count to three' 30`), {
      input: delivered,
      'wait-output': JSON.stringify({
        success: true,
        data: { wait: { matched: false, timedOut: false, ended: true } },
      }),
    });
    expect(run.rc).toBe(3);
    expect(lastJson(run.stdout)).toMatchObject({ matched: false, ended: true });
  });

  it('with SENDMARK_ANSWER_FILE=0 asks for the marker alone and reads no session', () => {
    const run = runSkill(
      `sendmark ${SID} 'review this' 30`,
      { input: delivered, 'wait-output': MATCHED },
      { SENDMARK_ANSWER_FILE: '0' }
    );
    expect(run.rc).toBe(0);
    expect(lastJson(run.stdout)).toMatchObject({ matched: true, answerFile: null, answer: null });
    expect(run.calls.map((call) => call.key)).toEqual(['input', 'wait-output']);
    const text = (JSON.parse(run.calls[0].d) as { input: string }).input;
    expect(text).not.toContain('codeman-answer-');
    expect(text).toContain('the word DONE immediately followed by _');
  });

  it('refuses an empty prompt before sending anything', () => {
    const run = runSkill(withSession(`sendmark ${SID} $'  \\n\\t\\n'`));
    expect(run.rc).toBe(1);
    expect(run.stderr).toMatch(/sendmark: empty prompt/);
    expect(run.calls).toEqual([]);
  });
});
