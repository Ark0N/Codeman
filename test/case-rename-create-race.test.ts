/**
 * @fileoverview A case rename racing a session create, against the real WebServer.
 *
 * A create constructs its `Session` (which checks the rename lock) and only puts it in the server's session
 * map later, after awaiting the owner's layout lock and a settings read. A rename that ran in that gap built its
 * list of open sessions without the new one, moved the folder, and the create then registered a session whose
 * pane would `cd` into a path that no longer existed. The rename now refuses the move while such a session is
 * still being created, and the server's registration is what lets go of it.
 *
 * The gap is widened by holding the settings read inside `TabLayoutService.sessionCreated()`
 * (`childrenFollowParent`), the await between the constructor and the registration callback.
 *
 * Port: 0 (ephemeral, read back from `server.boundPort`).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebServer } from '../src/web/server.js';
import { isCaseSessionStarting } from '../src/case-rename.js';
import { safeRmHomeTree } from './mocks/test-helpers.js';

interface LayoutDeps {
  childrenFollowParent?: () => Promise<boolean>;
}

let server: WebServer;
const made: string[] = [];
const url = (path: string) => `http://localhost:${server.boundPort}${path}`;
const post = async (path: string, body: unknown) => {
  const res = await fetch(url(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
};
const localCase = (name: string) => {
  const dir = join(homedir(), 'codeman-cases', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'CLAUDE.md'), name);
  made.push(dir);
  return dir;
};

beforeAll(async () => {
  server = new WebServer(0, false, true);
  await server.start();
}, 60000);

afterAll(async () => {
  await server?.stop();
  for (const dir of made.splice(0)) safeRmHomeTree(dir);
}, 60000);

describe('renaming a case while a session is being created in it', () => {
  it('refuses the move until the session is registered, then lists it like any open session', async () => {
    const dir = localCase('race-alpha');
    made.push(join(homedir(), 'codeman-cases', 'race-beta')); // only there if a rename got through
    const deps = (server as unknown as { tabLayouts: { deps: LayoutDeps } }).tabLayouts.deps;
    const original = deps.childrenFollowParent;
    let reached!: () => void;
    const atGap = new Promise<void>((resolve) => (reached = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    deps.childrenFollowParent = async () => {
      reached();
      await gate;
      return (await original?.()) === true;
    };
    try {
      const create = post('/api/sessions', { workingDir: dir, mode: 'shell' });
      await atGap; // constructed, not yet in the server's session map
      expect(isCaseSessionStarting(dir)).toBe(true);

      // Without the refusal the rename moves the folder and then waits on the owner's layout lock, which the
      // held create owns: bound the wait so that shows up as a failure rather than a test timeout.
      const busy = await Promise.race([
        post('/api/cases/race-alpha/rename', { newName: 'race-beta', stopSessions: true }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
      ]);
      expect(existsSync(dir), 'the folder moved under the session being created').toBe(true);
      expect(busy?.status).toBe(409);
      expect(busy?.json).toMatchObject({ errorCode: 'CONFLICT', renameCode: 'BUSY' });

      deps.childrenFollowParent = original;
      release();
      const created = await create;
      expect(created.status).toBe(200);
      const id = created.json.data.session.id as string;
      expect(isCaseSessionStarting(dir)).toBe(false);

      const listed = await post('/api/cases/race-alpha/rename', { newName: 'race-beta' });
      expect(listed.status).toBe(409);
      expect(listed.json).toMatchObject({ requiresStop: true, sessions: [{ id }] });
      expect(existsSync(dir)).toBe(true);
      await fetch(url(`/api/sessions/${id}`), { method: 'DELETE' });
    } finally {
      deps.childrenFollowParent = original;
      release();
    }
  });
});
