/**
 * @fileoverview Multi-user mode, end to end: a non-admin cannot change the server-wide
 * settings.json (live server, ephemeral port, real multi-user auth, real file on disk).
 *
 * The route tests (test/routes/system-routes-settings-admin-only.test.ts) pin each
 * gate with a mocked filesystem. This one runs the real auth middleware and reads the
 * real file back, so "settings.json is unchanged" is asserted on bytes:
 *  - PUT /api/settings, PUT /api/execution/model-config and PUT /api/cases/order are
 *    403 FORBIDDEN for a non-admin, and the file is byte-identical afterwards;
 *  - GET /api/settings stays readable by the non-admin, without the admin's Deepgram
 *    key and case names (an admin still reads the file as it is);
 *  - a non-admin's quick-start does not record its case as `lastUsedCase` (a key every
 *    user can read through GET /api/settings), while an admin's still does;
 *  - an admin's PUT /api/settings still writes;
 *  - a non-admin's bare POST /api/auth/revoke signs out only their own logins: an admin's
 *    cookie still works afterwards (it used to clear every login on the server).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { dirname } from 'node:path';
import { WebServer } from '../src/web/server.js';
import { TmuxManager } from '../src/tmux-manager.js';
import { createUser, invalidateUsersCache } from '../src/user-store.js';
import { SETTINGS_PATH } from '../src/web/route-helpers.js';

vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);

const basic = (u: string, p: string) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
const bob = { Authorization: basic('bob', 'bobpass1234') };
const root = { Authorization: basic('root', 'rootpass123') };

let server: WebServer;
const saved: Record<string, string | undefined> = {};
const url = (p: string) => `http://localhost:${server.boundPort}${p}`;

const INITIAL = {
  autoNameSessions: false,
  cliManagementEnabled: false,
  lastUsedCase: 'rootcase',
  caseOrder: ['rootcase'],
  modelConfig: { defaultModel: 'sonnet' },
  voiceSettings: { provider: 'deepgram', apiKey: 'dg-SECRET-live-456', language: 'en' },
};
const readSettingsBytes = () => fs.readFile(SETTINGS_PATH, 'utf-8');

async function send(method: string, path: string, headers: Record<string, string>, body?: unknown) {
  const res = await fetch(url(path), {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

/** The quick-start write of lastUsedCase is fire-and-forget: poll for it briefly. */
async function settleSettings(predicate: (s: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  let last: Record<string, unknown> = {};
  for (let i = 0; i < 40; i++) {
    last = JSON.parse(await readSettingsBytes());
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 25));
  }
  return last;
}

beforeAll(async () => {
  for (const k of ['CODEMAN_MULTIUSER', 'CODEMAN_PASSWORD', 'CODEMAN_USERNAME']) saved[k] = process.env[k];
  process.env.CODEMAN_MULTIUSER = '1';
  delete process.env.CODEMAN_PASSWORD;
  delete process.env.CODEMAN_USERNAME;
  invalidateUsersCache();
  await createUser({ username: 'root', role: 'admin', password: 'rootpass123' });
  await createUser({ username: 'bob', role: 'user', password: 'bobpass1234' });

  await fs.mkdir(dirname(SETTINGS_PATH), { recursive: true });
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(INITIAL, null, 2));

  server = new WebServer(0, false, true);
  await server.start();
});

afterAll(async () => {
  await server?.stop();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  invalidateUsersCache();
});

describe('a non-admin and the server-wide settings.json', () => {
  it('cannot write it through any settings route, and the file stays byte-identical', async () => {
    const before = await readSettingsBytes();
    for (const [path, body] of [
      ['/api/settings', { autoNameSessions: true, cliManagementEnabled: true, runMode: 'shell' }],
      ['/api/execution/model-config', { defaultModel: 'opus' }],
      ['/api/cases/order', { order: ['bobcase'] }],
    ] as const) {
      const res = await send('PUT', path, bob, body);
      expect(res.status, path).toBe(403);
      expect(res.body.success, path).toBe(false);
      expect(res.body.errorCode, path).toBe('FORBIDDEN');
    }
    expect(await readSettingsBytes()).toBe(before);
  });

  it("can still read it, without the admin's Deepgram key and case names", async () => {
    const res = await send('GET', '/api/settings', bob);
    expect(res.status).toBe(200);
    expect(res.body.data.autoNameSessions).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain('dg-SECRET-live-456');
    expect(res.body.data.voiceSettings).toEqual({ provider: 'deepgram', language: 'en' });
    expect('caseOrder' in res.body.data).toBe(false);
    expect('lastUsedCase' in res.body.data).toBe(false);

    const admin = await send('GET', '/api/settings', root);
    expect(admin.body.data.voiceSettings.apiKey).toBe('dg-SECRET-live-456');
    expect(admin.body.data.caseOrder).toEqual(['rootcase']);
  });

  it("does not get its quick-start case recorded as everyone's lastUsedCase; an admin's still is", async () => {
    const mine = await send('POST', '/api/quick-start', bob, { caseName: 'bobproj' });
    expect(mine.status).toBe(200);
    expect(mine.body.success).toBe(true);
    // Give a (wrong) fire-and-forget write every chance to land before checking.
    await new Promise((r) => setTimeout(r, 200));
    expect(JSON.parse(await readSettingsBytes()).lastUsedCase).toBe('rootcase');

    const theirs = await send('POST', '/api/quick-start', root, { caseName: 'rootproj2' });
    expect(theirs.status).toBe(200);
    expect((await settleSettings((s) => s.lastUsedCase === 'rootproj2')).lastUsedCase).toBe('rootproj2');
  });

  it('does not get its Ralph loop case recorded as lastUsedCase either; an admin still does', async () => {
    const mine = await send('POST', '/api/ralph-loop/start', bob, { caseName: 'bobralph', taskDescription: 'x' });
    expect(mine.status).toBe(200);
    expect(mine.body.success).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect(JSON.parse(await readSettingsBytes()).lastUsedCase).toBe('rootproj2');

    const theirs = await send('POST', '/api/ralph-loop/start', root, { caseName: 'rootralph', taskDescription: 'x' });
    expect(theirs.status).toBe(200);
    expect((await settleSettings((s) => s.lastUsedCase === 'rootralph')).lastUsedCase).toBe('rootralph');
  });
});

describe("a non-admin's Revoke All", () => {
  /** Sign in with Basic auth and keep only the session cookie it mints. */
  async function cookieFor(headers: Record<string, string>) {
    const res = await fetch(url('/api/status'), { headers });
    expect(res.status).toBe(200);
    const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
    expect(cookie).toMatch(/^codeman_session=/);
    return { Cookie: cookie };
  }

  it("signs out only the non-admin's own logins, never an admin's", async () => {
    const rootCookie = await cookieFor(root);
    const bobCookie = await cookieFor(bob);
    expect((await fetch(url('/api/status'), { headers: rootCookie })).status).toBe(200);

    const res = await send('POST', '/api/auth/revoke', bobCookie, {});
    expect(res.status).toBe(200);

    expect((await fetch(url('/api/status'), { headers: rootCookie })).status).toBe(200);
    expect((await fetch(url('/api/status'), { headers: bobCookie })).status).toBe(401);
  });
});

describe('an admin and the server-wide settings.json', () => {
  it('still writes it', async () => {
    const res = await send('PUT', '/api/settings', root, { autoNameSessions: true });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(JSON.parse(await readSettingsBytes()).autoNameSessions).toBe(true);
  });
});
