/**
 * @fileoverview A client whose seq counter rolled back must heal itself.
 *
 * The failure: the browser tags input with (clientId, seq) and persists the
 * counters to localStorage on a DEBOUNCED write. A tab killed between a send and
 * that write comes back counting from BELOW the server's watermark, so every
 * later keystroke is rejected as a duplicate — and, because a rejected frame was
 * ACKed exactly like an applied one, the client dropped it from its queue and the
 * UI looked perfectly healthy while the terminal took no input at all. Reloading
 * could not help: clientId and the stale counter both come back from localStorage.
 *
 * Observed live on a server session: a fresh browser (new clientId, no watermark)
 * typed into the same session fine, which is what isolated it to client state.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const appSource = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
const wsSource = readFileSync(resolve(import.meta.dirname, '../src/web/routes/ws-routes.ts'), 'utf8');

describe('the duplicate ACK carries what the client needs', () => {
  it('marks a rejected frame as dup and reports the watermark', () => {
    // A bare ACK is indistinguishable from "applied" — that ambiguity is the bug.
    expect(wsSource).toMatch(/"dup":true,"last":\$\{watermark\}/);
    expect(wsSource).toContain('lastInputSeq');
  });

  it('reads the watermark defensively, so a port without it still ACKs', () => {
    // The session arrives through a structural port. A throw inside the message
    // handler aborts it before the ACK is sent, stranding the frame in the
    // client's durable queue — which is worse than the ambiguity being fixed here.
    expect(wsSource).toMatch(/typeof \(session as \{ lastInputSeq\?/);
  });

  it('still ACKs a rejected frame, so the client can drop it from its queue', () => {
    // Silence would strand the record and the redelivery sweep would spin on it.
    const block = wsSource.slice(wsSource.indexOf('if (seq !== null && socket.readyState === 1)'));
    expect(block.slice(0, 1200)).toContain('"t":"ia"');
  });
});

describe('the client lifts itself over the watermark', () => {
  const handler = appSource.slice(
    appSource.indexOf('_onWsInputAck(seq, msg, sessionId'),
    appSource.indexOf('/** Called from ws.onopen')
  );

  it('raises the counter to the watermark it was handed', () => {
    expect(handler).toMatch(/_seqCounters\.set\(sessionId, watermark\)/);
  });

  it('re-queues a FIRST-attempt frame, whose input was genuinely lost', () => {
    expect(handler).toMatch(/rec\.tries <= 1/);
    expect(handler).toMatch(/this\._reliableSend\(sessionId, lost/);
  });

  it('does NOT re-queue a retry, which the dedup correctly suppressed', () => {
    // A retry called a duplicate means the original DID land; re-sending it would
    // type the same thing twice — the exact thing exactly-once delivery prevents.
    expect(handler).toMatch(/const lost = rec && rec\.tries <= 1 \? rec\.data : null;/);
  });

  it('persists the raised counter immediately, not on the debounce', () => {
    expect(handler).toContain('this._persistReliableNow()');
  });
});

describe('the seq counter is persisted synchronously on every send', () => {
  it('_reliableSend uses the immediate writer, never the debounced one', () => {
    // The counter is precisely what must survive a crash, so it cannot ride the
    // path most likely to be lost. (The queue PAYLOAD may still be debounced.)
    const send = appSource.slice(appSource.indexOf('_reliableSend(sessionId, data, useMux)'));
    const body = send.slice(0, send.indexOf('_nextSeq(sessionId) {'));
    expect(body).toContain('this._persistReliableNow();');
    expect(body).not.toMatch(/list\.push\(rec\);\s*\n\s*this\._persistReliableState\(\);/);
  });
});
