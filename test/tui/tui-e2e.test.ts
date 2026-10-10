/**
 * @fileoverview End-to-end test for `codeman tui` in a real terminal.
 *
 * The dashboard is spawned under node-pty against a fake API server, so this
 * covers everything the pure tests cannot: raw-mode key decoding, the frame
 * actually reaching a terminal, SSE-driven refresh, and the exit sequence that
 * has to restore the user's screen. Frames are addressed absolutely rather than
 * newline-separated, so the assertions parse the LAST frame out of the captured
 * bytes and read its list column.
 *
 * Every verb that leaves the process is asserted on the REQUEST the fake server
 * received, not on the frame: a prompt has to arrive as one line ending in a
 * carriage return, and an approval as the exact action and option digit, both
 * of which a rendered frame would happily lie about.
 *
 * The child gets its own data dir and a tmux socket name nothing runs on, which
 * keeps the enumeration that degraded mode and the attach path use from seeing
 * the machine's real sessions. Nothing here attaches, kills or writes anything.
 *
 * TIMING: the tests share one long-lived dashboard, so each one leaves the list
 * in focus for the next. Where a notice can still be up (it clears itself after
 * ~1.5s), the wait is on the FOOTER showing the keys that must be live, because
 * an overlay would swallow the next keystroke as a dismissal.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as pty from 'node-pty';
import { computeLayout } from '../../src/tui/tui-layout.js';
import type { UnifiedSessionItem } from '../../src/services/unified-session-service.js';
import type { SearchResponseData } from '../../src/types/search.js';
import type { ApprovalItem } from '../../src/web/approval-inbox.js';
import type { AwayDigestResponse } from '../../src/web/away-digest.js';

let baseUrl: string;
const ROOT = resolve(import.meta.dirname, '..', '..');
const COLS = 100;
const ROWS = 30;
const LIST_WIDTH = computeLayout(COLS, ROWS).list.width;

const NOW = Date.now();

const ALPHA = 'aaaa1111-0000-0000-0000-000000000000';
/** The id the fake server hands back for a resumed conversation. */
const RESUMED = 'dddd4444-0000-0000-0000-000000000000';
const BETA = 'bbbb2222-0000-0000-0000-000000000000';

/** Mutable so a test can add a session and announce it over SSE. */
let sessions: UnifiedSessionItem[] = [];
/** What the dashboard can answer: pending items, keyed the way the inbox keys them. */
let approvals: ApprovalItem[] = [];
/** Terminal buffers the preview pane polls, by session id. */
const terminals = new Map<string, string>();
/**
 * The LIGHT session state (`GET /api/sessions`), which is where the turn stamp
 * and the token counters come from: the unified list carries neither, so w2-beta
 * is deliberately a session created 10 minutes ago whose turn started one minute
 * ago. A row dated by the wrong one of those reads `10m` instead of `1m`.
 */
let liveState: Array<Record<string, unknown>> = [];
/**
 * Tail reads the preview pane has asked for. On the real server that route runs
 * two synchronous tmux calls and normalizes the whole byte buffer, so how often
 * a quiet pane is re-read is a property worth pinning.
 */
let terminalReads = 0;
/** Everything the TUI posted, so a test can assert on the exact body. */
const answered: Array<{ id: string; body: Record<string, unknown> }> = [];
/** `POST /api/sessions` bodies: resuming a RECENT row is the only thing that sends one. */
const created: Array<Record<string, unknown>> = [];
/** Sessions the TUI asked to start a pane for, in order. */
const started: string[] = [];
const inputs: Array<{ sessionId: string; body: Record<string, unknown> }> = [];

const PLAN_USAGE = {
  fiveHour: { usedPercentage: 32, resetAt: NOW + 3_600_000 },
  sevenDay: { usedPercentage: 61, resetAt: NOW + 86_400_000 },
};

const SEARCH_RESULTS: SearchResponseData = {
  query: 'alpha',
  groups: [
    {
      type: 'session',
      results: [
        {
          type: 'session',
          sessionId: ALPHA,
          sessionName: 'w1-alpha',
          timestamp: NOW,
          snippet: '/tmp/alpha',
          exactMatch: true,
          jumpTo: { kind: 'session', sessionId: ALPHA },
        },
      ],
    },
    {
      type: 'file',
      results: [
        {
          type: 'file',
          sessionId: ALPHA,
          sessionName: 'w1-alpha',
          timestamp: NOW,
          snippet: 'alpha notes',
          exactMatch: false,
          jumpTo: { kind: 'file-preview', sessionId: ALPHA, relativePath: 'docs/alpha.md' },
        },
      ],
    },
  ],
  totalResults: 2,
  truncated: false,
};

const DIGEST: AwayDigestResponse = {
  range: { range: '24h', since: NOW - 86_400_000, until: NOW },
  generatedAt: NOW,
  dataFreshness: {
    lifecyclePersisted: true,
    tokenStatsPersisted: true,
    runSummariesLiveOnly: true,
    subagentsLiveOnly: true,
  },
  totals: {
    sessionsCreated: 4,
    sessionsExited: 1,
    activeSessions: 3,
    needsAttention: 1,
    completed: 1,
    errors: 0,
    warnings: 1,
    tokenWindowPrecision: 'day',
  },
  sections: {
    needsAttention: [
      {
        id: 'd1',
        sessionId: BETA,
        sessionName: 'w2-beta',
        timestamp: NOW - 300_000,
        category: 'needs_attention',
        severity: 'warning',
        title: 'waited for approval',
        source: 'lifecycle',
      },
    ],
    completed: [],
    stillRunning: [],
    idle: [],
    informational: [],
  },
};

function permissionApproval(id: string): ApprovalItem {
  return {
    id,
    sessionId: BETA,
    sessionName: 'w2-beta',
    kind: 'permission',
    createdAt: Date.now(),
    toolName: 'Bash',
    toolSummary: 'Bash(git push origin main)',
    options: [
      { n: 1, label: 'Yes' },
      { n: 2, label: 'Yes, and do not ask again' },
      { n: 3, label: 'No, tell Claude what to do' },
    ],
  };
}

function resetSessions(): void {
  sessions = [
    {
      sessionId: BETA,
      name: 'w2-beta',
      mode: 'claude',
      sources: ['live'],
      isWorking: true,
      workingDir: '/tmp/beta',
      createdAt: NOW - 600_000,
      lastActivityAt: NOW,
    },
    {
      sessionId: ALPHA,
      name: 'w1-alpha',
      mode: 'claude',
      sources: ['live'],
      status: 'idle',
      workingDir: '/tmp/alpha',
      createdAt: NOW - 900_000,
      lastActivityAt: NOW - 60_000,
    },
    {
      sessionId: 'cccc3333-0000-0000-0000-000000000000',
      name: 'w3-gamma',
      sources: ['history'],
      workingDir: '/tmp/gamma',
      lastActivityAt: NOW - 3_600_000,
    },
  ];
  liveState = [
    { id: BETA, status: 'busy', lastSubmitAt: NOW - 60_000, inputTokens: 42_000, outputTokens: 3_200 },
    { id: ALPHA, status: 'idle', lastSubmitAt: NOW - 60_000 },
  ];
}

let server: http.Server;
const sseClients = new Set<http.ServerResponse>();
let dataDir = '';

function sendJson(res: http.ServerResponse, payload: unknown): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function pushEvent(event: string, data: unknown): void {
  for (const client of sseClients) client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  // The suite runs inside a Codeman-managed tmux pane, whose environment would
  // otherwise point the child at the LIVE server and make it think it is nested.
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.CODEMAN_SESSION_ID;
  delete env.FORCE_COLOR;
  delete env.CODEMAN_PORT;
  return {
    ...env,
    CODEMAN_API_URL: baseUrl,
    CODEMAN_DATA_DIR: dataDir,
    CODEMAN_TMUX_SOCKET: 'codeman-tui-e2e',
    CODEMAN_TUI_GLYPHS: 'ascii',
    NO_COLOR: '1',
    TERM: 'xterm-256color',
    LANG: 'C.UTF-8',
  };
}

/** The session id in `/api/sessions/<id>/<what>`, or null. */
function sessionRoute(url: string, what: string): string | null {
  const match = url.match(new RegExp(`^/api/sessions/([^/?]+)/${what}`));
  return match ? decodeURIComponent(match[1]) : null;
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((done) => {
    let raw = '';
    req.setEncoding('utf-8');
    req.on('data', (chunk: string) => {
      raw += chunk;
    });
    req.on('end', () => {
      try {
        done(JSON.parse(raw || '{}') as Record<string, unknown>);
      } catch {
        done({});
      }
    });
  });
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'codeman-tui-e2e-'));
  resetSessions();
  server = http.createServer((req, res) => {
    const url = req.url ?? '';
    if (url.startsWith('/api/events')) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`event: init\ndata: ${JSON.stringify({ version: '9.9.9', planUsage: PLAN_USAGE })}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (url.startsWith('/api/status')) {
      return sendJson(res, { success: true, data: { version: '9.9.9', planUsage: PLAN_USAGE } });
    }
    if (url.startsWith('/api/sessions/unified')) return sendJson(res, { success: true, data: { sessions } });
    if (url === '/api/sessions' || url.startsWith('/api/sessions?')) {
      if (req.method === 'POST') {
        void readBody(req).then((body) => {
          created.push(body);
          sendJson(res, { success: true, data: { session: { id: RESUMED } } });
        });
        return;
      }
      return sendJson(res, { success: true, data: liveState });
    }

    const startFor = sessionRoute(url, 'interactive');
    if (startFor) {
      started.push(startFor);
      return sendJson(res, { success: true, data: {} });
    }

    const previewFor = sessionRoute(url, 'terminal');
    if (previewFor) {
      terminalReads++;
      return sendJson(res, { success: true, data: { terminalBuffer: terminals.get(previewFor) ?? '' } });
    }

    const inputFor = sessionRoute(url, 'input');
    if (inputFor) {
      void readBody(req).then((body) => {
        inputs.push({ sessionId: inputFor, body });
        sendJson(res, { success: true, data: { delivered: true } });
      });
      return;
    }

    const answerMatch = url.match(/^\/api\/approvals\/([^/?]+)\/answer/);
    if (answerMatch) {
      const id = decodeURIComponent(answerMatch[1]);
      void readBody(req).then((body) => {
        const item = approvals.find((entry) => entry.id === id);
        if (!item) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ success: false, error: 'The dialog is no longer on screen', errorCode: 'CONFLICT' })
          );
          return;
        }
        answered.push({ id, body });
        approvals = approvals.filter((entry) => entry.id !== id);
        sendJson(res, { success: true, data: { id, sessionId: item.sessionId, action: body.action } });
        pushEvent('approval:resolved', { id, sessionId: item.sessionId, kind: item.kind, resolution: 'answered' });
      });
      return;
    }

    if (url.startsWith('/api/approvals')) return sendJson(res, { success: true, data: { approvals } });
    if (url.startsWith('/api/search')) return sendJson(res, { success: true, data: SEARCH_RESULTS });
    // The away digest predates the envelope: its payload sits at the top level.
    if (url.startsWith('/api/away-digest')) return sendJson(res, { success: true, digest: DIGEST });

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'no route', errorCode: 'NOT_FOUND' }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const client of sseClients) client.destroy();
  sseClients.clear();
  await new Promise<void>((done) => server.close(() => done()));
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Frame parsing
// ─────────────────────────────────────────────────────────────────────────────

const ANSI = /\u001b\[[0-9;?]*[a-zA-Z]/g;

/**
 * The last COMPLETE frame, one entry per terminal row. Frames start at
 * `ESC [ 1;1 H` and address every row absolutely, so splitting on the
 * addressing sequences reconstructs the lines. The pty delivers a frame in
 * several chunks, so the newest one is often half-written: taking it would make
 * every assertion that indexes a line racy.
 */
function frameLines(raw: string): string[] {
  const frames = raw.split('\u001b[1;1H').slice(1);
  for (let i = frames.length - 1; i >= 0; i--) {
    const lines = frames[i].split(/\u001b\[\d+;1H/).map((line) => line.replace(ANSI, '').replace(/\s+$/, ''));
    if (lines.length >= ROWS) return lines.slice(0, ROWS);
  }
  return [];
}

/** Just the sidebar column, so a name in the preview pane cannot answer for a row. */
function listLines(raw: string): string[] {
  return frameLines(raw).map((line) => line.slice(0, LIST_WIDTH).replace(/\s+$/, ''));
}

/** Just the preview column, for the same reason in reverse. */
function previewText(raw: string): string {
  return frameLines(raw)
    .map((line) => line.slice(LIST_WIDTH + 1).replace(/\s+$/, ''))
    .join('\n');
}

function rowFor(raw: string, name: string): string {
  return listLines(raw).find((line) => line.includes(name)) ?? '';
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 50));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The dashboard
// ─────────────────────────────────────────────────────────────────────────────

describe('codeman tui (under a pty)', () => {
  let term: pty.IPty;
  let output = '';
  let exitCode: number | null = null;

  beforeAll(async () => {
    terminals.set(BETA, '\x1b[32mready\x1b[0m\nbeta is thinking\n');
    terminals.set(ALPHA, 'alpha has been quiet\n');
    term = pty.spawn('npx', ['tsx', 'src/index.ts', 'tui'], {
      name: 'xterm-256color',
      cols: COLS,
      rows: ROWS,
      cwd: ROOT,
      env: childEnv(),
    });
    term.onData((data) => {
      output += data;
    });
    term.onExit(({ exitCode: code }) => {
      exitCode = code;
    });
    await waitFor(() => output.includes('w2-beta'), 'the first frame', 25_000);
  }, 40_000);

  afterAll(() => {
    if (exitCode === null) term.kill();
  });

  /**
   * Walk the cursor onto a row by name. Rows re-sort when an approval lands, so
   * a test can never assume a position; `j` wraps, so this always terminates.
   */
  async function selectRow(name: string): Promise<void> {
    for (let i = 0; i < 12 && !rowFor(output, name).startsWith('>'); i++) {
      term.write('j');
      await new Promise((done) => setTimeout(done, 120));
    }
    await waitFor(() => rowFor(output, name).startsWith('>'), `${name} to be selected`);
  }

  it('enters the alternate screen and hides the cursor', () => {
    expect(output).toContain('\u001b[?1049h');
    expect(output).toContain('\u001b[?25l');
  });

  it('groups the sessions the way the dashboard promises', () => {
    const lines = listLines(output);
    const index = (needle: string) => lines.findIndex((line) => line.includes(needle));
    expect(index('WORKING')).toBeGreaterThan(0);
    expect(index('WORKING')).toBeLessThan(index('w2-beta'));
    expect(index('w2-beta')).toBeLessThan(index('IDLE'));
    expect(index('IDLE')).toBeLessThan(index('w1-alpha'));
    expect(index('w1-alpha')).toBeLessThan(index('RECENT'));
    expect(index('RECENT')).toBeLessThan(index('w3-gamma'));
  });

  it('dates a working row by its turn, not by the session age', () => {
    // w2-beta was created 10 minutes ago and pressed Enter one minute ago, and
    // only `GET /api/sessions` knows the second number. `1m` proves the merge
    // ran end to end; `10m` would mean the row fell back to createdAt.
    const beta = rowFor(output, 'w2-beta');
    expect(beta).toMatch(/\b1m\b/);
    expect(beta).not.toMatch(/\b10m\b/);
    // The token column rides the same read.
    expect(beta).toContain('45.2k');
  });

  it('shows the header facts and only the keys that work', () => {
    const lines = frameLines(output);
    expect(lines[0]).toContain('codeman');
    expect(lines[0]).toContain('v9.9.9');
    // Two live rows; the history row is not a session you have open.
    expect(lines[0]).toContain('2 sessions');
    // The plan-usage chip, punctuated with this tier's separator.
    expect(lines[0]).toContain('5h 32%');
    expect(lines[0]).toContain('wk 61%');
    const footer = lines[ROWS - 1];
    expect(footer).toContain('attach');
    expect(footer).toContain('x kill');
    expect(footer).toContain('p prompt');
    expect(footer).toContain('/ search');
  });

  it('shows the selected session tail and follows it as it changes', async () => {
    await waitFor(() => previewText(output).includes('beta is thinking'), 'the preview tail');
    expect(previewText(output)).toContain('w2-beta');
    expect(previewText(output)).toContain('/tmp/beta');

    terminals.set(BETA, '\x1b[32mready\x1b[0m\nbeta is thinking\nbeta finished the job\n');
    await waitFor(() => previewText(output).includes('beta finished the job'), 'the tail to refresh');
  });

  it('starts with the first row selected and moves the cursor with j / k', async () => {
    expect(rowFor(output, 'w2-beta').startsWith('>')).toBe(true);

    term.write('j');
    await waitFor(() => rowFor(output, 'w1-alpha').startsWith('>'), 'j to select the next row');
    expect(rowFor(output, 'w2-beta').startsWith('>')).toBe(false);

    term.write('k');
    await waitFor(() => rowFor(output, 'w2-beta').startsWith('>'), 'k to select the previous row');
  });

  it('moves the cursor with the arrow keys', async () => {
    term.write('\u001b[B');
    await waitFor(() => rowFor(output, 'w1-alpha').startsWith('>'), 'the down arrow to move the cursor');
    term.write('\u001b[A');
    await waitFor(() => rowFor(output, 'w2-beta').startsWith('>'), 'the up arrow to move the cursor');
  });

  it('keeps re-reading the tail, but backs off while the pane stays quiet', async () => {
    await selectRow('w2-beta');
    // Let the selection's own immediate read land, then measure a window in
    // which nothing writes to the pane.
    await new Promise((done) => setTimeout(done, 400));
    const before = terminalReads;
    await new Promise((done) => setTimeout(done, 6_000));
    const reads = terminalReads - before;
    // Still following: a chain that forgot to re-arm would freeze the pane at
    // whatever it last showed, which no frame assertion would notice.
    expect(reads).toBeGreaterThan(0);
    // A fixed one-second poll would be six. The ladder (1s, 2s, 4s, then the
    // 5s ceiling) cannot exceed four in this window.
    expect(reads).toBeLessThanOrEqual(4);
  }, 20_000);

  it('picks up a session announced over SSE', async () => {
    sessions = [
      ...sessions,
      {
        sessionId: 'dddd4444-0000-0000-0000-000000000000',
        name: 'w4-delta',
        mode: 'shell',
        sources: ['live'],
        status: 'idle',
        workingDir: '/tmp/delta',
        createdAt: NOW,
        lastActivityAt: NOW,
      },
    ];
    pushEvent('session:created', { id: 'dddd4444-0000-0000-0000-000000000000' });
    await waitFor(() => listLines(output).some((line) => line.includes('w4-delta')), 'the new session to appear');
    expect(frameLines(output)[0]).toContain('3 sessions');
  });

  it('opens and closes the help overlay', async () => {
    term.write('?');
    await waitFor(() => frameLines(output).some((line) => line.includes('Keys')), 'the help overlay');
    expect(frameLines(output).join('\n')).toContain('kill (y to confirm)');

    term.write('\u001b');
    await waitFor(() => !frameLines(output).some((line) => line.includes('Keys')), 'escape to close the overlay');
  });

  it('asks for a y before killing anything, and names what it would kill', async () => {
    term.write('x');
    await waitFor(() => frameLines(output).some((line) => line.includes('Kill session')), 'the kill confirmation');
    const overlay = frameLines(output).join('\n');
    expect(overlay).toContain('press y to kill');
    expect(overlay).toContain('w2-beta');

    term.write('\u001b');
    await waitFor(() => !frameLines(output).some((line) => line.includes('Kill session')), 'escape to cancel the kill');
  });

  it('cancels the kill on any key that is not y, and kills nothing', async () => {
    term.write('x');
    await waitFor(() => frameLines(output).some((line) => line.includes('Kill session')), 'the kill confirmation');
    term.write('n');
    await waitFor(() => !frameLines(output).some((line) => line.includes('Kill session')), 'the dialog to close');
    // The session is still listed: `n` cancelled rather than killed.
    await waitFor(() => frameLines(output).some((line) => line.includes('w2-beta')), 'w2-beta to still be listed');
  });

  it('sends a one-line prompt with p', async () => {
    term.write('p');
    await waitFor(() => frameLines(output)[ROWS - 1].startsWith(' >'), 'the composer to open');

    term.write('deploy the thing');
    await waitFor(() => frameLines(output)[ROWS - 1].includes('deploy the thing'), 'the typed line');
    // Backspace edits the line rather than moving the list cursor.
    term.write('\u007f'.repeat(5));
    await waitFor(() => !frameLines(output)[ROWS - 1].includes('thing'), 'backspace to edit the line');

    term.write('\r');
    await waitFor(() => inputs.length > 0, 'the input POST');
    expect(inputs[0].sessionId).toBe(BETA);
    // Single line, ended with a carriage return, or the server never presses Enter.
    expect(inputs[0].body.input).toBe('deploy the\r');
    expect(String(inputs[0].body.input)).not.toContain('\n');
    expect(inputs[0].body.clientId).toBeTruthy();

    await waitFor(() => frameLines(output).join('\n').includes('sent'), 'the sent notice');
    await waitFor(() => !frameLines(output).join('\n').includes('Notice'), 'the notice to clear itself', 5_000);
  });

  it('searches with / and selects a live result', async () => {
    term.write('/');
    await waitFor(() => frameLines(output).join('\n').includes('Search'), 'the search overlay');

    term.write('alpha');
    await waitFor(() => frameLines(output).join('\n').includes('2 results'), 'the debounced search to answer');
    const overlay = frameLines(output).join('\n');
    expect(overlay).toContain('alpha_');
    expect(overlay).toContain('SESSIONS');
    expect(overlay).toContain('w1-alpha');
    expect(overlay).toContain('docs/alpha.md');

    term.write('\r');
    await waitFor(() => !frameLines(output).join('\n').includes('Search'), 'the overlay to close');
    await waitFor(() => rowFor(output, 'w1-alpha').startsWith('>'), 'the searched session to be selected');
  });

  it('shows the away digest with g', async () => {
    term.write('g');
    await waitFor(() => frameLines(output).join('\n').includes('Away digest'), 'the digest overlay');
    const panel = frameLines(output).join('\n');
    expect(panel).toContain('the last 24 hours');
    expect(panel).toContain('4 started');
    expect(panel).toContain('NEEDS ATTENTION (1)');
    expect(panel).toContain('waited for approval');

    term.write('\u001b');
    await waitFor(() => !frameLines(output).join('\n').includes('Away digest'), 'escape to close the digest');
  });

  it('renders the pending dialog as a card and rings the bell once for it', async () => {
    await selectRow('w2-beta');
    const before = output.length;

    approvals = [permissionApproval(`${BETA}:1`)];
    pushEvent('approval:pending', approvals[0]);
    await waitFor(() => previewText(output).includes('requests: Bash(git push origin main)'), 'the approval card');
    const card = previewText(output);
    expect(card).toContain('1. Yes');
    expect(card).toContain('3. No, tell Claude what to do');
    expect(card).toContain('y approve');
    expect(frameLines(output)[0]).toContain('[!] 1');

    // The same item announced twice is one prompt, so it must not ring twice.
    pushEvent('approval:pending', approvals[0]);
    await new Promise((done) => setTimeout(done, 1_200));
    expect(output.slice(before).split('\u0007')).toHaveLength(2);
  });

  it('answers the dialog with the option digit and clears the card', async () => {
    // The footer is the honest signal that the list has the keyboard: a notice
    // still on screen would swallow the digit as a dismissal.
    await waitFor(() => frameLines(output)[ROWS - 1].includes('y approve'), 'the answer keys in the footer');
    expect(frameLines(output)[ROWS - 1]).toContain('1-9 option');

    term.write('1');
    await waitFor(() => answered.length > 0, 'the answer POST');
    expect(answered[0]).toEqual({ id: `${BETA}:1`, body: { action: 'option', option: 1 } });
    await waitFor(() => !previewText(output).includes('requests: Bash'), 'the card to clear');
  });

  it('approves with y', async () => {
    approvals = [permissionApproval(`${BETA}:2`)];
    pushEvent('approval:pending', approvals[0]);
    await waitFor(() => previewText(output).includes('requests: Bash(git push origin main)'), 'the second card');
    await waitFor(() => frameLines(output)[ROWS - 1].includes('y approve'), 'the answer keys in the footer');

    term.write('y');
    await waitFor(() => answered.length > 1, 'the approve POST');
    expect(answered[1]).toEqual({ id: `${BETA}:2`, body: { action: 'approve' } });
  });

  it('says so when the dialog has already left the screen', async () => {
    approvals = [permissionApproval(`${BETA}:3`)];
    pushEvent('approval:pending', approvals[0]);
    await waitFor(() => previewText(output).includes('requests: Bash(git push origin main)'), 'the third card');

    await waitFor(() => frameLines(output)[ROWS - 1].includes('y approve'), 'the answer keys in the footer');
    // Answered in tmux a moment ago: the server 409s and the TUI explains.
    approvals = [];
    term.write('y');
    await waitFor(() => frameLines(output).join('\n').includes('no longer on screen'), 'the gone-dialog message');
    term.write('\u001b');
    await waitFor(() => !frameLines(output).join('\n').includes('no longer on screen'), 'escape to dismiss it');
  });

  it('resumes a RECENT row exactly ONCE, however long its pane takes to appear', async () => {
    await waitFor(() => frameLines(output)[ROWS - 1].includes('attach'), 'the list to have focus');
    for (let i = 0; i < 8 && !rowFor(output, 'w3-gamma').startsWith('>'); i++) {
      term.write('\u001b[B');
      await new Promise((done) => setTimeout(done, 120));
    }
    await waitFor(() => rowFor(output, 'w3-gamma').startsWith('>'), 'the history row to be selected');

    term.write('\r');
    await waitFor(() => created.length > 0, 'the resume POST');
    expect(created[0]).toMatchObject({
      // The conversation, in the directory it ran in, as a claude session.
      resumeSessionId: 'cccc3333-0000-0000-0000-000000000000',
      workingDir: '/tmp/gamma',
      mode: 'claude',
      name: 'w3-gamma',
    });
    await waitFor(() => started.includes(RESUMED), 'the resumed session to be started');

    // The pane never appears here (the child runs on an empty tmux socket), which
    // is precisely the case that used to re-enter the resume: one session per
    // second until something killed it. One press must stay one session.
    await new Promise((done) => setTimeout(done, 2_500));
    expect(created).toHaveLength(1);
    expect(started).toEqual([RESUMED]);

    term.write('\u001b');
    await waitFor(() => frameLines(output)[ROWS - 1].includes('attach'), 'the list to take focus back');
  });

  it('quits on q and restores the screen it took over', async () => {
    term.write('q');
    await waitFor(() => exitCode !== null, 'the TUI to exit', 10_000);
    expect(exitCode).toBe(0);
    expect(output).toContain('\u001b[?25h');
    expect(output).toContain('\u001b[?1049l');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The non-interactive fast paths
// ─────────────────────────────────────────────────────────────────────────────

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run the CLI with pipes, which is exactly the "not a TTY" case. */
function runPiped(args: string[]): Promise<RunResult> {
  return new Promise((done) => {
    const child = spawn('npx', ['tsx', 'src/index.ts', ...args], { cwd: ROOT, env: childEnv() });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

describe('codeman tui --list', () => {
  it('prints the numbered list and exits 0 when piped', async () => {
    const result = await runPiped(['tui', '--list']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('w2-beta');
    expect(result.stdout).toContain('w1-alpha');
    expect(result.stdout).toContain('/tmp/alpha');
    // Same ordering as the dashboard: WORKING first, history last.
    expect(result.stdout.indexOf('w2-beta')).toBeLessThan(result.stdout.indexOf('w1-alpha'));
    expect(result.stdout.indexOf('w1-alpha')).toBeLessThan(result.stdout.indexOf('w3-gamma'));
    expect(result.stdout).toMatch(/^\s+1\s+working\s+w2-beta/m);
  }, 30_000);
});

describe('codeman tui without a terminal', () => {
  it('refuses to open the dashboard and points at the fast paths', async () => {
    const result = await runPiped(['tui']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('interactive terminal');
    expect(result.stderr).toContain('--list');
    expect(result.stdout).not.toContain('\u001b[?1049h');
  }, 30_000);
});
