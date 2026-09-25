/**
 * @fileoverview Oversized input must never poison the durable input queue (#484).
 *
 * The failure: a paste over MAX_INPUT_LENGTH was queued for reliable delivery,
 * refused by both transports (the WebSocket silently, the POST with a 400), and
 * never dropped by the client, which treated a 400 like a transient failure. It
 * was re-sent every 2 s forever, blocked every later input for that session
 * behind it, and came back from localStorage on every reload.
 *
 * The fix, pinned here: the client splits a large paste into in-limit frames
 * (one limit, shared with the server), drops a frame the server refused for
 * good, and prunes oversized frames persisted by an older build.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { MAX_INPUT_LENGTH } from '../src/config/terminal-limits.js';
import { SessionInputWithLimitSchema } from '../src/web/schemas.js';

const pub = (f: string) => readFileSync(resolve(import.meta.dirname, '../src/web/public', f), 'utf8');
const appSource = pub('app.js');

type InputLimit = { FRAME_MAX_CHARS: number; PASTE_MAX_CHARS: number; split: (d: string, max?: number) => string[] };

function loadLimit(): InputLimit {
  const context = vm.createContext({ window: {}, globalThis: {} });
  vm.runInContext(pub('constants.js'), context, { filename: 'constants.js' });
  return (context.window as { CodemanInputLimit: InputLimit }).CodemanInputLimit;
}

describe('one input limit on both sides', () => {
  it('the frontend frame limit equals the server MAX_INPUT_LENGTH', () => {
    expect(loadLimit().FRAME_MAX_CHARS).toBe(MAX_INPUT_LENGTH);
  });

  it('the composer budget is derived from the same number', () => {
    expect(pub('keyboard-accessory.js')).toMatch(
      new RegExp(`COMPOSER_INPUT_FRAME_LIMIT = (64 \\* 1024|${MAX_INPUT_LENGTH});`)
    );
    expect(MAX_INPUT_LENGTH).toBe(64 * 1024);
  });

  it('the POST schema caps input at MAX_INPUT_LENGTH, not a second number', () => {
    expect(SessionInputWithLimitSchema.safeParse({ input: 'x'.repeat(MAX_INPUT_LENGTH) }).success).toBe(true);
    expect(SessionInputWithLimitSchema.safeParse({ input: 'x'.repeat(MAX_INPUT_LENGTH + 1) }).success).toBe(false);
  });
});

describe('splitInputFrames', () => {
  const { split } = loadLimit();

  it('returns a short input as one frame and nothing for empty input', () => {
    expect(split('abc')).toEqual(['abc']);
    expect(split('')).toEqual([]);
  });

  it('splits a large paste into in-limit frames that rejoin byte-identically', () => {
    const paste = '\x1b[200~' + 'log line\n'.repeat(15000) + '\x1b[201~';
    const frames = split(paste);
    expect(frames.length).toBeGreaterThan(1);
    for (const f of frames) expect(f.length).toBeLessThanOrEqual(MAX_INPUT_LENGTH);
    expect(frames.join('')).toBe(paste);
  });

  it('never cuts a surrogate pair in half', () => {
    const paste = 'a' + '😀'.repeat(10); // pairs start at odd offsets
    const frames = split(paste, 4);
    expect(frames.join('')).toBe(paste);
    for (const f of frames) {
      const last = f.charCodeAt(f.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
      const first = f.charCodeAt(0);
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
    }
  });
});

describe('the client never queues or keeps an undeliverable frame', () => {
  const sendAsync = appSource.slice(
    appSource.indexOf('_sendInputAsync(sessionId, input, opts) {'),
    appSource.indexOf('_sendInputEphemeral(sessionId, input) {')
  );

  it('splits an oversized paste, and refuses an oversized mux write or giant paste with a toast', () => {
    expect(sendAsync).toContain('limit.split(input)');
    expect(sendAsync).toMatch(/useMux \|\| input\.length > limit\.PASTE_MAX_CHARS/);
    expect(sendAsync).toContain('showToast');
  });

  it('drops a POST the server refused as invalid instead of retrying it forever', () => {
    const drain = appSource.slice(appSource.indexOf('_drainSession(sessionId) {'));
    const body = drain.slice(0, drain.indexOf('_dropRejectedInput(sessionId, rec) {'));
    expect(body).toMatch(
      /resp\.status === 400 \|\| resp\.status === 413\)\) \{\s*[\s\S]{0,400}this\._dropRejectedInput\(sessionId, rec\);/
    );
  });

  it('drops a frame the WebSocket refused with an error ACK', () => {
    const handler = appSource.slice(appSource.indexOf('_onWsInputAck(seq, msg) {'));
    expect(handler.slice(0, 600)).toMatch(/if \(msg && msg\.err\)/);
  });

  it('prunes oversized frames persisted by an older build on load', () => {
    const load = appSource.slice(appSource.indexOf('_loadReliableState() {'));
    expect(load.slice(0, 3000)).toMatch(/r\.data\.length <= frameMax/);
  });
});
