/**
 * @fileoverview Opt-in case sync, server side (live server, ephemeral port, real settings.json): the shared
 * per-case options merge inside the serialised settings writer, a non-admin never reads them, and a case
 * rename or delete carries them along (CASE-SYNC-001, CASE-SYNC-002).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebServer } from '../src/web/server.js';
import { TmuxManager } from '../src/tmux-manager.js';
import { SETTINGS_PATH } from '../src/web/route-helpers.js';
import { getCasesDir } from '../src/config/cases-dir.js';
import { settingsForNonAdmin } from '../src/web/routes/system-routes.js';
import {
  dropCaseSettings,
  MAX_SHARED_CASES,
  mergeCaseSettings,
  renameCaseSettings,
} from '../src/web/case-state-sync.js';

vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);

const on = { agentTeams: true, opusContext1m: false };
const off = { agentTeams: false, opusContext1m: true };

let server: WebServer;
const url = (p: string) => `http://localhost:${server.boundPort}${p}`;
const seed = (value: unknown) => writeFileSync(SETTINGS_PATH, JSON.stringify(value, null, 2));
const readSettings = () => JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8')) as Record<string, any>;
async function send(method: string, path: string, body?: unknown) {
  const res = await fetch(url(path), {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

let n = 0;
const caseName = () => `case-sync-${process.pid}-${++n}`;

beforeAll(async () => {
  mkdirSync(join(SETTINGS_PATH, '..'), { recursive: true });
  seed({});
  server = new WebServer(0, false, true);
  await server.start();
}, 30000);

afterAll(async () => {
  await server?.stop();
  vi.restoreAllMocks();
}, 30000);

describe('shared case options', () => {
  beforeEach(() => seed({ syncCaseState: true }));

  it('merges concurrent saves of different cases instead of letting the second discard the first', async () => {
    const [a, b, c] = await Promise.all([
      send('PUT', '/api/settings', { caseSettings: { alpha: on } }),
      send('PUT', '/api/settings', { caseSettings: { beta: off } }),
      send('PUT', '/api/settings', { caseSettings: { gamma: on } }),
    ]);
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
    expect(readSettings().caseSettings).toEqual({ alpha: on, beta: off, gamma: on });
  });

  it('ignores a caseSettings PUT while syncCaseState is off, and takes one that turns it on', async () => {
    seed({ syncCaseState: false, caseSettings: { kept: off } });
    expect((await send('PUT', '/api/settings', { caseSettings: { alpha: on } })).status).toBe(200);
    expect(readSettings().caseSettings).toEqual({ kept: off });
    seed({});
    await send('PUT', '/api/settings', { caseSettings: { alpha: on } });
    expect(readSettings().caseSettings).toBeUndefined();
    await send('PUT', '/api/settings', { syncCaseState: true, caseSettings: { alpha: on } });
    expect(readSettings().caseSettings).toEqual({ alpha: on });
  });

  it('keeps the other cases when one is saved again, and every other setting', async () => {
    seed({ syncCaseState: true, lastUsedCase: 'x', caseSettings: { alpha: on, beta: off } });
    await send('PUT', '/api/settings', { caseSettings: { alpha: off } });
    expect(readSettings()).toEqual({ syncCaseState: true, lastUsedCase: 'x', caseSettings: { alpha: off, beta: off } });
  });

  it('refuses a merge that takes the file past the limit and leaves it as it was', async () => {
    const full = Object.fromEntries(Array.from({ length: MAX_SHARED_CASES }, (_, i) => [`c${i}`, on]));
    seed({ syncCaseState: true, caseSettings: full });
    const res = await send('PUT', '/api/settings', { caseSettings: { overflow: on } });
    expect(res.status).toBe(400);
    expect(Object.keys(readSettings().caseSettings)).toHaveLength(MAX_SHARED_CASES);
    expect((await send('PUT', '/api/settings', { caseSettings: { c1: off } })).status).toBe(200);
  });

  it('moves the options with a renamed case, and drops them when the case is deleted', async () => {
    const oldName = caseName();
    const newName = caseName();
    mkdirSync(join(getCasesDir(), oldName), { recursive: true });
    seed({
      syncCaseState: true,
      caseOrder: [oldName],
      lastPickedCase: oldName,
      caseSettings: { [oldName]: on, keep: off },
    });
    const renamed = await send('POST', `/api/cases/${oldName}/rename`, { newName });
    expect(renamed.body.success).toBe(true);
    expect(readSettings().caseSettings).toEqual({ [newName]: on, keep: off });
    expect(readSettings().lastPickedCase).toBe(newName);
    const deleted = await send('DELETE', `/api/cases/${newName}`);
    expect(deleted.body.success).toBe(true);
    expect(readSettings().caseSettings).toEqual({ keep: off });
  });
});

describe('what a non-admin is given', () => {
  it('has the shared map removed, and keeps the switch the page reads', () => {
    const out = settingsForNonAdmin({
      syncCaseState: true,
      caseOrder: ['a'],
      lastUsedCase: 'a',
      lastPickedCase: 'a',
      caseSettings: { a: on },
      agentSkillEnabled: true,
    });
    expect(out).toEqual({ syncCaseState: true, agentSkillEnabled: true });
  });
});

describe('case map helpers', () => {
  it('merge, rename and drop leave the input alone and report nothing to do as null', () => {
    const map = { a: on, b: off };
    expect(mergeCaseSettings(map, { c: on })).toEqual({ a: on, b: off, c: on });
    expect(renameCaseSettings(map, 'a', 'z')).toEqual({ b: off, z: on });
    expect(renameCaseSettings(map, 'nope', 'z')).toBeNull();
    expect(dropCaseSettings(map, 'a')).toEqual({ b: off });
    expect(dropCaseSettings(map, 'nope')).toBeNull();
    expect(mergeCaseSettings(undefined, { a: on })).toEqual({ a: on });
    expect(map).toEqual({ a: on, b: off });
  });
});
