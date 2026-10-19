/**
 * @fileoverview The launch half of the prompt-cache keep-warm (Discussion #554): which launch
 * carries `idleCompaction: false` (decideIdleCompactionOptOut, tmux-manager.ts), that every
 * create and relaunch path decides it and records it on the mux record, that the session hands
 * its choice to both, that a restart keeps the choice and the real-prompt clock, that the app
 * settings read defaults to OFF and a 2 h cap, and that Read My Mind's capture runs through the
 * filter that drops the nudge. The argv shape itself is pinned in cli-registry-spawn-golden.
 *
 * Port: N/A (pure functions and source slices; no server).
 */

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { decideIdleCompactionOptOut } from '../src/tmux-manager.js';
import { readKeepWarmSettings, readKeepWarmSettingsOrThrow } from '../src/hooks-config.js';
import { SETTINGS_PATH } from '../src/web/route-helpers.js';
import { DEFAULT_KEEP_WARM_MAX_HOURS } from '../src/prompt-cache-keepwarm.js';

const src = (file: string) => readFileSync(resolve(import.meta.dirname, '../src', file), 'utf8');

/** The body of `signature` up to the next class member, so a pin cannot pass on a sibling. */
function methodSlice(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `${signature} not found`).toBeGreaterThan(-1);
  const next = source
    .slice(start + signature.length)
    .search(/\n {2}(?:(?:private|public|protected|static|async|get|set) )*\w+\(/);
  return source.slice(start, next === -1 ? undefined : start + signature.length + next);
}

describe('decideIdleCompactionOptOut', () => {
  const on = {
    mode: 'claude' as const,
    statusLine: 'injected' as const,
    keepWarm: true,
    keepWarmDefault: false,
    spawnedByAgent: false,
    claudeCliVersion: '2.1.290',
  };

  it('adds the key when keep-warm is on, the exporter is injected and Claude Code knows the setting', () => {
    expect(decideIdleCompactionOptOut(on)).toBe(true);
    expect(decideIdleCompactionOptOut({ ...on, claudeCliVersion: '2.1.300' })).toBe(true);
    expect(decideIdleCompactionOptOut({ ...on, keepWarm: undefined, keepWarmDefault: true })).toBe(true);
  });

  it.each<[string, Partial<typeof on> & Record<string, unknown>]>([
    ['the version is unknown (fail-closed, like --name)', { claudeCliVersion: null }],
    ['2.1.289, which idle-compacts but has no idleCompaction setting', { claudeCliVersion: '2.1.289' }],
    ['keep-warm is off for the session', { keepWarm: false, keepWarmDefault: true }],
    ['keep-warm is left to an app default that is off', { keepWarm: undefined }],
    [
      'an agent-spawned session on the app default',
      { keepWarm: undefined, keepWarmDefault: true, spawnedByAgent: true },
    ],
    ['Plan Usage was off at launch (keep-warm cannot run)', { statusLine: 'collection-off' }],
    ["the workspace's own statusLine (keep-warm cannot run)", { statusLine: 'workspace-statusline' }],
    ['a remote or Docker launch', { statusLine: 'remote' }],
    ['a CLI with no exporter at all', { statusLine: undefined }],
    ['a CLI that declares no such gate', { mode: 'codex' }],
  ])('leaves it off when %s', (_label, over) => {
    expect(decideIdleCompactionOptOut({ ...on, ...over } as Parameters<typeof decideIdleCompactionOptOut>[0])).toBe(
      false
    );
  });
});

describe('every launch decides the opt-out and records it', () => {
  const tmux = src('tmux-manager.ts');

  it.each(['async createSession(', 'async respawnPane('])('%s resolves it, renders it and records it', (sig) => {
    const body = methodSlice(tmux, sig);
    expect(body).toContain(
      'const idleCompactionOff = await this._resolveIdleCompactionOptOut(mode, statusLine, keepWarm, spawnedByAgent);'
    );
    expect(body).toMatch(/statusLineCommand,\n\s+idleCompactionOff,\n\s+sessionName: cliName,/);
  });

  it('createSession records it on the new mux record, next to statusLine', () => {
    expect(methodSlice(tmux, 'async createSession(')).toMatch(/name,\n\s+statusLine,\n\s+idleCompactionOff,\n\s+};/);
  });

  it('respawnPane re-records it on the surviving mux record', () => {
    expect(methodSlice(tmux, 'async respawnPane(')).toContain('session.idleCompactionOff = idleCompactionOff;');
  });

  it('the slice stops at the next member, private async ones included', () => {
    expect(methodSlice(tmux, 'async createSession(')).not.toContain('async respawnPane(');
    expect(methodSlice(tmux, 'private async _resolveStatusLine(')).not.toContain('_resolveIdleCompactionOptOut(\n');
  });

  it('the session hands its choice to the create AND the relaunch option bags', () => {
    const session = src('session.ts');
    const handoff = /keepWarm: this\._keepWarmEnabled,\n\s+spawnedByAgent: !!this\._parentSessionId,/;
    expect(session.match(new RegExp(handoff, 'g'))).toHaveLength(2);
    expect(methodSlice(session, 'private _buildRespawnPaneOptions(')).toMatch(handoff);
    expect(methodSlice(session, 'async startInteractive(')).toMatch(handoff);
  });
});

describe('restart keeps the choice and the real-prompt clock', () => {
  it('both constructors that rebuild a session from state.json pass them', () => {
    for (const file of ['web/server.ts', 'web/routes/reboot-restore-routes.ts']) {
      const source = src(file);
      expect(source, file).toMatch(/lastRealPromptAt: saved(State\?)?\.lastRealPromptAt,/);
      expect(source, file).toMatch(/keepWarmEnabled: saved(State\?)?\.keepWarmEnabled,/);
    }
  });
});

describe('the pane read behind the last two guards', () => {
  it('reads the usage-limit message off the same frame and counts only a reset still ahead', () => {
    const port = src('web/server.ts');
    const at = port.indexOf('readPane: (view) => {');
    expect(at).toBeGreaterThan(-1);
    const body = port.slice(at, port.indexOf('publish: (id, status) => {', at));
    expect(body).toContain('this.mux.capturePaneText?.(muxName, undefined, { styles: true })');
    expect(body).toContain('const limit = detectUsageLimitPause(plainFrame(text));');
    expect(body).toContain('limitShown: limit !== null && limit.resetAt > Date.now(),');
    expect(body).toContain('composerEmpty: composerIsEmpty(text,');
  });
});

describe('Read My Mind capture', () => {
  it('records a transcript prompt only through the filter that drops the nudge', () => {
    expect(methodSlice(src('web/server.ts'), 'private async captureIntentPrompt(')).toContain(
      'intentStore.recordPrompt('
    );
    const record = methodSlice(src('intent-store.ts'), 'recordPrompt(');
    expect(record.indexOf('if (!isCapturablePrompt(rawText)) return false;')).toBeGreaterThan(-1);
    expect(src('intent-store.ts')).toContain('if (text.trim() === KEEP_WARM_NUDGE) return false;');
  });
});

describe('readKeepWarmSettings', () => {
  afterEach(async () => {
    await rm(SETTINGS_PATH, { force: true });
  });

  it('reads the temp HOME the suite set up, never a real data dir', () => {
    expect(SETTINGS_PATH.startsWith(join(tmpdir(), 'codeman-vitest-'))).toBe(true);
  });

  it('defaults to off with a 2 h cap', async () => {
    expect(DEFAULT_KEEP_WARM_MAX_HOURS).toBe(2);
    expect(await readKeepWarmSettings()).toEqual({ keepWarmDefault: false, maxHours: 2 });
  });

  it('reads the default and the cap, and ignores a cap that is not a positive number', async () => {
    await mkdir(dirname(SETTINGS_PATH), { recursive: true });
    await writeFile(SETTINGS_PATH, JSON.stringify({ promptCacheKeepWarm: true, promptCacheKeepWarmMaxHours: 3.5 }));
    expect(await readKeepWarmSettings()).toEqual({ keepWarmDefault: true, maxHours: 3.5 });
    await writeFile(SETTINGS_PATH, JSON.stringify({ promptCacheKeepWarm: 'yes', promptCacheKeepWarmMaxHours: -1 }));
    expect(await readKeepWarmSettings()).toEqual({ keepWarmDefault: false, maxHours: 2 });
  });

  /**
   * The service keeps what it reads until the next keep-warm settings change, so its reader must
   * never hand back a fallback for a file it could not read: settings.json is rewritten in place
   * by several routes, and defaults kept from a mid-write read would hold keep-warm off.
   */
  it('the service reader rejects an unreadable file instead of falling back, and the server wires it', async () => {
    expect(await readKeepWarmSettingsOrThrow()).toEqual({ keepWarmDefault: false, maxHours: 2 });
    await mkdir(dirname(SETTINGS_PATH), { recursive: true });
    await writeFile(SETTINGS_PATH, JSON.stringify({ promptCacheKeepWarm: true, promptCacheKeepWarmMaxHours: 3.5 }));
    expect(await readKeepWarmSettingsOrThrow()).toEqual({ keepWarmDefault: true, maxHours: 3.5 });
    await writeFile(SETTINGS_PATH, '{"promptCacheKeepWarm": tr');
    await expect(readKeepWarmSettingsOrThrow()).rejects.toThrow();
    expect(await readKeepWarmSettings()).toEqual({ keepWarmDefault: false, maxHours: 2 });
    expect(src('web/server.ts')).toContain('readSettings: readKeepWarmSettingsOrThrow,');
  });
});
