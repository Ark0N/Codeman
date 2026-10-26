/**
 * @fileoverview Every writer of the server's settings.json is serialized, atomic, and refuses to
 * overwrite a file that does not parse (live server, ephemeral port, real file on disk).
 *
 * The upstream CI flake in test/quick-start.test.ts ("accepts the setting via PUT, then injects")
 * was a torn settings.json: `SyntaxError: Unexpected non-whitespace character after JSON at
 * position 31`. Quick-start saved `lastUsedCase` with an un-awaited, non-atomic read-modify-write,
 * PUT /api/settings ran its own unserialized one, and the two overlapping truncate-then-write
 * calls left one write's bytes over the tail of the other. The PUT then read the torn file as `{}`
 * and wrote back only its own keys, erasing every other setting.
 *
 * Writes to settings.json (and its temp files) are slowed down here, which is what a busy CI disk
 * does: a writer that answers before its write lands, or two writers that both read before either
 * writes, then fail deterministically instead of once in a while.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fsp from 'node:fs/promises';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebServer } from '../src/web/server.js';
import { TmuxManager } from '../src/tmux-manager.js';
import { SETTINGS_PATH } from '../src/web/route-helpers.js';
import { getCasesDir } from '../src/config/cases-dir.js';

vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);

/** How long every write to settings.json (or a temp file beside it) is held before it starts. */
const SLOW_WRITE_MS = 200;
const realWriteFile = fsp.writeFile.bind(fsp);
vi.spyOn(fsp, 'writeFile').mockImplementation((async (file: unknown, data: unknown, options?: unknown) => {
  if (typeof file === 'string' && file.startsWith(SETTINGS_PATH)) {
    await new Promise((resolve) => setTimeout(resolve, SLOW_WRITE_MS));
  }
  return realWriteFile(file as string, data as string, options as undefined);
}) as typeof fsp.writeFile);

/** The bytes the CI run left behind: the PUT's 31-byte file over the tail of quick-start's longer one. */
const TORN = '{\n  "agentSkillEnabled": true\n}' + 'rt-1761000000000"\n}';

const REFUSAL = {
  success: false,
  errorCode: 'CONFLICT',
  error: `${SETTINGS_PATH} is not a valid JSON object, so this change was not saved (saving would have replaced every other setting in it). Fix or delete the file, or restore it from a config backup, then try again.`,
};

let server: WebServer;
const url = (p: string) => `http://localhost:${server.boundPort}${p}`;
const seed = (value: unknown) => writeFileSync(SETTINGS_PATH, JSON.stringify(value, null, 2));
const readSettings = () => JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8')) as Record<string, unknown>;

async function send(method: string, path: string, body: unknown) {
  const res = await fetch(url(path), {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

let caseCounter = 0;
const newCaseName = () => `settings-race-${process.pid}-${++caseCounter}`;

beforeAll(async () => {
  // The boot pass resets a persisted tunnelEnabled (the tunnel only starts from the UI); that write
  // goes through the same writer and must keep every other key.
  mkdirSync(join(SETTINGS_PATH, '..'), { recursive: true });
  seed({ tunnelEnabled: true, caseOrder: ['boot'] });
  server = new WebServer(0, false, true);
  await server.start();
}, 30000);

afterAll(async () => {
  await server?.stop();
  vi.restoreAllMocks();
}, 30000);

describe('settings.json writes', () => {
  it('resets tunnelEnabled at boot without dropping the other keys', () => {
    expect(readSettings()).toEqual({ tunnelEnabled: false, caseOrder: ['boot'] });
  });

  describe('with a valid file', () => {
    beforeEach(() => seed({ lastUsedCase: 'seeded' }));

    it('answers a quick-start only after its lastUsedCase has landed', async () => {
      const caseName = newCaseName();
      const res = await send('POST', '/api/quick-start', { caseName });
      expect(res.body.success).toBe(true);
      expect(readSettings()).toEqual({ lastUsedCase: caseName });
    });

    it('answers a Ralph loop start only after its lastUsedCase has landed', async () => {
      const caseName = newCaseName();
      const res = await send('POST', '/api/ralph-loop/start', { caseName, taskDescription: 'x' });
      expect(res.body.success).toBe(true);
      expect(readSettings()).toEqual({ lastUsedCase: caseName });
    });

    it('keeps every key when quick-start, the settings PUT, model config and case order write at once', async () => {
      const caseName = newCaseName();
      const [quick, put, model, order] = await Promise.all([
        send('POST', '/api/quick-start', { caseName }),
        send('PUT', '/api/settings', { agentSkillEnabled: true }),
        send('PUT', '/api/execution/model-config', { defaultModel: 'opus' }),
        send('PUT', '/api/cases/order', { order: ['a', 'b'] }),
      ]);
      expect(quick.body.success).toBe(true);
      expect(put).toEqual({ status: 200, body: { success: true, data: {} } });
      expect(model).toEqual({ status: 200, body: { success: true, data: {} } });
      expect(order).toEqual({ status: 200, body: { success: true, data: { order: ['a', 'b'] } } });
      expect(readSettings()).toEqual({
        lastUsedCase: caseName,
        agentSkillEnabled: true,
        modelConfig: { defaultModel: 'opus' },
        caseOrder: ['a', 'b'],
      });
    });

    it('keeps a settings PUT that lands while a case rename rewrites caseOrder', async () => {
      const oldName = newCaseName();
      const newName = newCaseName();
      mkdirSync(join(getCasesDir(), oldName), { recursive: true });
      seed({ lastUsedCase: oldName, caseOrder: [oldName, 'other'] });
      const [rename, put] = await Promise.all([
        send('POST', `/api/cases/${oldName}/rename`, { newName }),
        send('PUT', '/api/settings', { agentSkillEnabled: true }),
      ]);
      expect(rename.body.success).toBe(true);
      expect(put).toEqual({ status: 200, body: { success: true, data: {} } });
      expect(readSettings()).toEqual({ lastUsedCase: newName, caseOrder: [newName, 'other'], agentSkillEnabled: true });
    });

    it('writes the file 0600, since it can hold an API key', async () => {
      await send('PUT', '/api/settings', { agentSkillEnabled: true });
      expect(statSync(SETTINGS_PATH).mode & 0o777).toBe(0o600);
    });
  });

  it('starts from {} when the file is missing or empty', async () => {
    rmSync(SETTINGS_PATH, { force: true });
    expect(await send('PUT', '/api/settings', { agentSkillEnabled: true })).toEqual({
      status: 200,
      body: { success: true, data: {} },
    });
    expect(readFileSync(SETTINGS_PATH, 'utf-8')).toBe('{\n  "agentSkillEnabled": true\n}');

    writeFileSync(SETTINGS_PATH, '  \n');
    await send('PUT', '/api/execution/model-config', { defaultModel: 'opus' });
    expect(readSettings()).toEqual({ modelConfig: { defaultModel: 'opus' } });
  });

  it('writes through a symlinked settings.json to its target', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'codeman-settings-link-'));
    const target = join(elsewhere, 'settings.json');
    writeFileSync(target, JSON.stringify({ lastUsedCase: 'linked' }));
    rmSync(SETTINGS_PATH, { force: true });
    symlinkSync(target, SETTINGS_PATH);
    try {
      await send('PUT', '/api/settings', { agentSkillEnabled: true });
      expect(lstatSync(SETTINGS_PATH).isSymbolicLink()).toBe(true);
      expect(readlinkSync(SETTINGS_PATH)).toBe(target);
      expect(JSON.parse(readFileSync(target, 'utf-8'))).toEqual({ lastUsedCase: 'linked', agentSkillEnabled: true });
    } finally {
      rmSync(SETTINGS_PATH, { force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  describe('refuses to overwrite a file that is not a JSON object, and leaves its bytes alone', () => {
    for (const [label, bytes] of [
      ['a torn file', TORN],
      ['a JSON array', '[1, 2]'],
      ['JSON null', 'null'],
      ['a JSON string', '"settings"'],
    ] as const) {
      it(`${label}: every settings write route answers 409 CONFLICT`, async () => {
        writeFileSync(SETTINGS_PATH, bytes);
        expect(await send('PUT', '/api/settings', { agentSkillEnabled: true })).toEqual({ status: 409, body: REFUSAL });
        expect(await send('PUT', '/api/execution/model-config', { defaultModel: 'opus' })).toEqual({
          status: 409,
          body: REFUSAL,
        });
        expect(await send('PUT', '/api/cases/order', { order: ['a'] })).toEqual({ status: 409, body: REFUSAL });
        expect(readFileSync(SETTINGS_PATH, 'utf-8')).toBe(bytes);
      });
    }

    it('a torn file: quick-start and a Ralph loop start still succeed without touching it', async () => {
      writeFileSync(SETTINGS_PATH, TORN);
      expect((await send('POST', '/api/quick-start', { caseName: newCaseName() })).body.success).toBe(true);
      expect(
        (await send('POST', '/api/ralph-loop/start', { caseName: newCaseName(), taskDescription: 'x' })).body.success
      ).toBe(true);
      expect(readFileSync(SETTINGS_PATH, 'utf-8')).toBe(TORN);
    });

    it('a torn file: a refusal does not wedge later writes once the file is fixed', async () => {
      writeFileSync(SETTINGS_PATH, TORN);
      expect((await send('PUT', '/api/settings', { agentSkillEnabled: true })).status).toBe(409);
      seed({ lastUsedCase: 'fixed' });
      expect(await send('PUT', '/api/settings', { agentSkillEnabled: true })).toEqual({
        status: 200,
        body: { success: true, data: {} },
      });
      expect(readSettings()).toEqual({ lastUsedCase: 'fixed', agentSkillEnabled: true });
    });
  });
});
