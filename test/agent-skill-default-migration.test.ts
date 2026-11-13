/**
 * @fileoverview The one-time boot migration that lets the 1.50.0 agent skill default reach
 * installs that saved App Settings before it (src/web/agent-skill-default-migration.ts).
 *
 * What is pinned, and why it matters:
 *  - An absent key, a stored `true` or no settings.json at all: settings.json is not written
 *    (byte-identical, odd formatting kept) and the marker is set.
 *  - A stored `false` (what every 1.49 save wrote, chosen or not) becomes `true`, every other key
 *    kept, exactly once: the log line prints once, and a second start reports `already-done`
 *    without reading the file.
 *  - An off set AFTER the migration stays off: through the real `PUT /api/settings` (what the
 *    page's Save sends), then a second start. The PUT neither writes nor drops the marker, and
 *    `GET /api/settings` never returns it, so the page cannot hold it to send it back.
 *  - A settings.json that does not parse is left byte-identical, no marker is written, nothing
 *    throws, and the next start (after the fix) does the migration.
 *  - A marker that cannot be checked switches nothing on (a deliberate off must not be cleared
 *    twice).
 *  - The marker is not a config-backup file, and `WebServer.start()` runs the migration before
 *    its first settings read and before it listens (source wiring guard: the boot call is skipped
 *    in test mode, like the other boot-time writes).
 *
 * The page's side (a device blob holding the old `false`) is pinned in
 * test/agent-skill-setting-ui.test.ts.
 *
 * Port: 0 (one WebServer for the PUT/GET cases).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { WebServer } from '../src/web/server.js';
import { TmuxManager } from '../src/tmux-manager.js';
import { SETTINGS_PATH } from '../src/web/route-helpers.js';
import { dataPath } from '../src/config/instance.js';
import { CONFIG_BACKUP_FILES } from '../src/config-backup.js';
import {
  AGENT_SKILL_DEFAULT_MARKER,
  AGENT_SKILL_DEFAULT_MIGRATED_LOG,
  migrateAgentSkillDefault,
} from '../src/web/agent-skill-default-migration.js';

vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);

const MARKER = dataPath(AGENT_SKILL_DEFAULT_MARKER);

/** Written with a formatting no writer of ours produces, so any rewrite shows in the bytes. */
const seedRaw = (text: string) => writeFileSync(SETTINGS_PATH, text);
const seed = (value: unknown) => seedRaw(JSON.stringify(value));
const raw = () => readFileSync(SETTINGS_PATH, 'utf-8');
const stored = () => JSON.parse(raw()) as Record<string, unknown>;
const marker = () => JSON.parse(readFileSync(MARKER, 'utf-8')) as { migratedAt: string; switchedOn: boolean };

/** The bytes of a torn settings.json (test/settings-json-write-serialization.test.ts). */
const TORN = '{\n  "agentSkillEnabled": false\n}' + 'rt-1761000000000"\n}';

let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
const migratedLogs = () => logSpy.mock.calls.filter(([line]) => line === AGENT_SKILL_DEFAULT_MIGRATED_LOG).length;

beforeEach(() => {
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  rmSync(SETTINGS_PATH, { force: true });
  rmSync(MARKER, { force: true });
  logSpy = vi.spyOn(console, 'log');
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
});

describe('nothing to switch on', () => {
  it('an absent key: settings.json is not written, the marker is set', async () => {
    seed({ lastUsedCase: 'demo' });
    const before = raw();
    expect(await migrateAgentSkillDefault()).toBe('nothing-to-change');
    expect(raw()).toBe(before);
    expect(marker()).toMatchObject({ switchedOn: false });
    expect(migratedLogs()).toBe(0);
  });

  it('no settings.json at all: none is created, the marker is set', async () => {
    expect(await migrateAgentSkillDefault()).toBe('nothing-to-change');
    expect(existsSync(SETTINGS_PATH)).toBe(false);
    expect(marker()).toMatchObject({ switchedOn: false });
  });

  it('a stored true is left untouched', async () => {
    seed({ agentSkillEnabled: true, caseOrder: ['a'] });
    const before = raw();
    expect(await migrateAgentSkillDefault()).toBe('nothing-to-change');
    expect(raw()).toBe(before);
    expect(marker()).toMatchObject({ switchedOn: false });
  });
});

describe('a stored false from before 1.50.0', () => {
  it('is switched on once, every other key kept, with one log line', async () => {
    seed({ agentSkillEnabled: false, lastUsedCase: 'demo', nice: { enabled: true, niceValue: 5 } });
    expect(await migrateAgentSkillDefault()).toBe('switched-on');
    expect(stored()).toEqual({ agentSkillEnabled: true, lastUsedCase: 'demo', nice: { enabled: true, niceValue: 5 } });
    expect(marker()).toMatchObject({ switchedOn: true });
    expect(Number.isNaN(Date.parse(marker().migratedAt))).toBe(false);
    expect(migratedLogs()).toBe(1);

    // A second start finds the marker and reads nothing.
    const after = raw();
    expect(await migrateAgentSkillDefault()).toBe('already-done');
    expect(raw()).toBe(after);
    expect(migratedLogs()).toBe(1);
  });

  it('a false written by hand after the migration is never switched on again', async () => {
    seed({ agentSkillEnabled: false });
    expect(await migrateAgentSkillDefault()).toBe('switched-on');
    seed({ agentSkillEnabled: false });
    expect(await migrateAgentSkillDefault()).toBe('already-done');
    expect(stored()).toEqual({ agentSkillEnabled: false });
  });
});

describe('a settings.json that does not parse', () => {
  it('is left alone, writes no marker, does not throw, and the next start after the fix migrates', async () => {
    seedRaw(TORN);
    expect(await migrateAgentSkillDefault()).toBe('refused');
    expect(raw()).toBe(TORN);
    expect(existsSync(MARKER)).toBe(false);
    expect(
      warnSpy.mock.calls.some(([line]) => String(line).startsWith('[agent-skill] default migration skipped'))
    ).toBe(true);

    // The user repairs the file (or restores a backup): the migration has not run yet, so it runs now.
    seed({ agentSkillEnabled: false });
    expect(await migrateAgentSkillDefault()).toBe('switched-on');
    expect(stored()).toEqual({ agentSkillEnabled: true });
  });
});

describe('a marker that cannot be checked', () => {
  it('switches nothing on and writes no marker', async () => {
    seed({ agentSkillEnabled: false });
    // A path below a regular file: lstat answers ENOTDIR, not ENOENT.
    expect(await migrateAgentSkillDefault(join(SETTINGS_PATH, 'marker.json'))).toBe('refused');
    expect(stored()).toEqual({ agentSkillEnabled: false });
    expect(existsSync(MARKER)).toBe(false);
  });
});

describe('with the page and the server (port 0)', () => {
  let server: WebServer;
  const url = (p: string) => `http://localhost:${server.boundPort}${p}`;

  beforeAll(async () => {
    server = new WebServer(0, false, true);
    await server.start();
  }, 30000);

  afterAll(async () => {
    await server?.stop();
  }, 30000);

  it('an off saved through PUT /api/settings after the migration stays off at the next start, and the PUT leaves the marker alone', async () => {
    seed({ agentSkillEnabled: false, lastUsedCase: 'demo' });
    expect(await migrateAgentSkillDefault()).toBe('switched-on');
    const markerBytes = readFileSync(MARKER, 'utf-8');

    // What the page sends when the user turns the switch off (plus another synced key).
    const res = await fetch(url('/api/settings'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentSkillEnabled: false, autoNameSessions: true }),
    });
    expect(res.status).toBe(200);
    expect(stored()).toEqual({ agentSkillEnabled: false, lastUsedCase: 'demo', autoNameSessions: true });
    expect(readFileSync(MARKER, 'utf-8')).toBe(markerBytes);

    expect(await migrateAgentSkillDefault()).toBe('already-done');
    expect(stored().agentSkillEnabled).toBe(false);
  });

  it('GET /api/settings never carries the marker, so the page cannot hold or send it', async () => {
    seed({ agentSkillEnabled: false });
    await migrateAgentSkillDefault();
    const res = await fetch(url('/api/settings'));
    const body = (await res.json()) as Record<string, unknown>;
    const data = (body.success === true ? body.data : body) as Record<string, unknown>;
    expect(data).toEqual({ agentSkillEnabled: true });
  });
});

describe('placement', () => {
  it('the marker is not a config-backup file, so a restore never re-arms or drops it', () => {
    expect(CONFIG_BACKUP_FILES as readonly string[]).not.toContain(AGENT_SKILL_DEFAULT_MARKER);
  });

  it('WebServer.start() runs it before its first settings read, the restore and listen, and drops the settings cache', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/web/server.ts'), 'utf8');
    const start = source.slice(source.indexOf('  async start(): Promise<void> {'));
    const call = start.indexOf('await migrateAgentSkillDefault()');
    expect(call).toBeGreaterThan(0);
    for (const later of [
      'await this.getAgentInboxPersistEnabled()',
      'await this.restoreMuxSessions()',
      'await this.app.listen(',
    ]) {
      expect(start.indexOf(later), later).toBeGreaterThan(call);
    }
    expect(start.slice(call, call + 200)).toContain('this._settingsCache = null;');
  });
});
