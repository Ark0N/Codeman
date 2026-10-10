/**
 * @fileoverview Multi-user routing of the `remote:*` SSE family (server.ts `deriveSseHint`).
 *
 * The wake events carry `hostId`/`label`, which `GET /api/remote-hosts` withholds from
 * non-admins, and their toast fires before any session check on the client — so an
 * event that falls through to the global branch shows every logged-in user "Waking
 * <label>" for a session they do not own. Constructs the server without starting it:
 * the hint is a pure function of the event, the payload and the sessions map.
 */
import { describe, expect, it } from 'vitest';
import { WebServer } from '../src/web/server.js';

type Hint = { owner?: string; username?: string; adminOnly?: boolean; sessionScoped?: boolean } | undefined;

function hintFor(event: string, payload: Record<string, unknown>, owners: Record<string, string> = {}): Hint {
  const server = new WebServer(0, false, true) as unknown as {
    sessions: Map<string, { owner?: string }>;
    deriveSseHint(event: string, data: unknown): Hint;
  };
  for (const [id, owner] of Object.entries(owners)) server.sessions.set(id, { owner });
  return server.deriveSseHint(event, payload);
}

describe('deriveSseHint — remote: events are session-scoped', () => {
  it('routes a session wake to that session’s owner', () => {
    expect(hintFor('remote:hostWaking', { sessionId: 's1', hostId: 'h', label: 'H' }, { s1: 'alice' })).toEqual({
      owner: 'alice',
      sessionScoped: true,
    });
    expect(hintFor('remote:sessionReconnected', { sessionId: 's1' }, { s1: 'alice' })).toEqual({
      owner: 'alice',
      sessionScoped: true,
    });
  });

  it('routes a create/attach wake (no session yet) to the user who asked for it', () => {
    expect(hintFor('remote:hostWaking', { forNewSession: true, username: 'bob', hostId: 'h', label: 'H' })).toEqual({
      username: 'bob',
      sessionScoped: true,
    });
    expect(hintFor('remote:hostWakeFailed', { forNewSession: true, username: 'bob', hostId: 'h' })).toEqual({
      username: 'bob',
      sessionScoped: true,
    });
  });

  it('fails closed (admins only) when it names neither a session nor a requester', () => {
    const hint = hintFor('remote:hostWaking', { forNewSession: true, hostId: 'h', label: 'H' });
    expect(hint).toEqual({ owner: undefined, sessionScoped: true });
  });

  it('never lets a wake event reach the global branch', () => {
    expect(hintFor('remote:hostWaking', {})).not.toBeUndefined();
    expect(hintFor('remote:reconnectExhausted', {})).not.toBeUndefined();
  });
});
