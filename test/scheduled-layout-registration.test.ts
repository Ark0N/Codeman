import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { WebServer } from '../src/web/server.js';

describe('scheduled session layout registration', () => {
  it('registers the layout before lifecycle work and rolls back a rejected tentative session', async () => {
    const sessions = new Map<string, { id: string; owner?: string }>();
    const session = { id: 'scheduled-session', owner: 'alice' };
    let registeredBeforeFailure = false;
    // The layout service registers the session inside its owner lock, then the
    // write fails and it calls the undo it was handed.
    const sessionCreated = vi.fn(
      async (_owner: string, _id: string, _placement: unknown, register: () => void | (() => void)) => {
        const undo = register();
        registeredBeforeFailure = sessions.get(session.id) === session;
        if (typeof undo === 'function') undo();
        throw new Error('layout unavailable');
      }
    );
    const server = Object.create(WebServer.prototype) as {
      sessions: typeof sessions;
      tabLayouts: { sessionCreated: typeof sessionCreated };
      registerSessionWithLayout(session: typeof session): Promise<void>;
    };
    server.sessions = sessions;
    server.tabLayouts = { sessionCreated };

    await expect(server.registerSessionWithLayout(session)).rejects.toThrow('layout unavailable');

    expect(sessionCreated).toHaveBeenCalledWith('alice', 'scheduled-session', undefined, expect.any(Function));
    expect(registeredBeforeFailure).toBe(true);
    expect(sessions.has(session.id)).toBe(false);
  });

  it('uses the shared registration helper in the scheduled loop before persistence and listeners', () => {
    const source = readFileSync(new URL('../src/web/server.ts', import.meta.url), 'utf8');
    const loop = source.slice(
      source.indexOf('private async runScheduledLoop'),
      source.indexOf('private async stopScheduledRun')
    );

    expect(loop).toContain('await this.registerSessionWithLayout(session);');
    expect(loop.indexOf('await this.registerSessionWithLayout(session);')).toBeLessThan(
      loop.indexOf('this.store.incrementSessionsCreated();')
    );
    expect(loop.indexOf('await this.registerSessionWithLayout(session);')).toBeLessThan(
      loop.indexOf('await this.setupSessionListeners(session);')
    );
  });
});
