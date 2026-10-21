/**
 * @fileoverview `sendwait` in the packaged agent preamble sends one line.
 *
 * Runs the REAL `skills/codeman/preamble.sh` in bash with `CURL` replaced by a stub
 * that records the request body, so it checks what the function puts on the wire,
 * not a copy of its logic. The server pastes a multi-line prompt as one block, and
 * neither sendwait's Enter loop nor the server's submit check can recognise a pasted
 * block still sitting on the composer, so the prompt must arrive as one line, the
 * way `toSingleLine` joins it for the other unattended senders.
 *
 * Port: N/A (no server; the stub answers every request).
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toSingleLine } from '../src/utils/single-line.js';

const PREAMBLE = join(__dirname, '..', 'skills', 'codeman', 'preamble.sh');

// The preamble builds every request body with jq.
let hasJq = true;
try {
  execFileSync('jq', ['--version'], { stdio: 'ignore' });
} catch {
  hasJq = false;
}

/** The `input` field of the first body sendwait posts for `prompt`. */
function sentInput(prompt: string): string {
  // sendwait calls CURL inside $(...), a subshell, so the stub records to a file.
  const dir = mkdtempSync(join(tmpdir(), 'codeman-sendwait-'));
  const bodies = join(dir, 'bodies');
  const script = `
    . "$PREAMBLE" >/dev/null
    stub() {
      while [ "$#" -gt 0 ]; do
        if [ "$1" = --data-binary ]; then printf '%s\\n' "$2" >> "$BODIES"; shift; fi
        shift
      done
      printf '%s' '{"data":{"delivered":true,"wait":{"timedOut":false}}}'
    }
    CURL=(stub)
    sendwait worker1234 "$PROMPT" 7 >/dev/null
  `;
  try {
    execFileSync('bash', ['-c', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        PREAMBLE,
        PROMPT: prompt,
        BODIES: bodies,
        CODEMAN_API_URL: 'http://127.0.0.1:9',
        CODEMAN_SESSION_ID: 'caller-session-0000',
      },
    });
    const first = readFileSync(bodies, 'utf-8').split('\n')[0];
    return (JSON.parse(first) as { input: string }).input;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!hasJq)('preamble sendwait', () => {
  it('joins a multi-line prompt onto one line before sending it', () => {
    expect(sentInput('Review this:\n- item 1\n- item 2')).toBe('Review this: - item 1 - item 2\r');
  });

  it('joins the same way as toSingleLine (trimmed lines, blank lines dropped, \\r\\n as a break)', () => {
    const prompt = '  first line  \r\n\n\t second\n\n   \nthird\n';
    expect(sentInput(prompt)).toBe(toSingleLine(prompt) + '\r');
  });

  it('refuses a prompt made only of blank lines instead of sending a bare Enter', () => {
    expect(() => sentInput('  \n \t\n')).toThrow(/sendwait: empty prompt/);
  });

  it('leaves a single-line prompt, glob characters included, as it was', () => {
    expect(sentInput('fix * in ?.ts  ')).toBe('fix * in ?.ts  \r');
  });
});
