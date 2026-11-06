// @vitest-environment node
/**
 * @fileoverview The Discord startup hint reaches Claude as `--append-system-prompt`, only while the
 * bridge and its `startupHint` setting are on, and never changes a launch that does not use it.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getCli } from '../src/config/cli-registry/registry.js';
import { buildSpawnCommandFromRegistry } from '../src/session-cli-registry-bridge.js';
import {
  DiscordBridge,
  DISCORD_STARTUP_HINT,
  getDiscordStartupHint,
  writeDiscordConfig,
  DEFAULT_DISCORD_CONFIG,
} from '../src/discord-bridge.js';

const SID = '0f9c2b14-1111-2222-3333-444455556666';
const BASE = 'claude --dangerously-skip-permissions --session-id "0f9c2b14-1111-2222-3333-444455556666"';

function launch(mode: 'claude' | 'codex'): string | undefined {
  return buildSpawnCommandFromRegistry(getCli(mode)!, { mode, sessionId: SID, claudeCliVersion: null });
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'discord-hint-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function bridge() {
  return new DiscordBridge({
    configDir: dir,
    fetchImpl: async () => new Response('{}'),
    sendInput: async () => true,
    socketFactory: () => ({ send() {}, close() {}, on() {} }),
  });
}

describe('startup hint on the Claude launch', () => {
  it('is absent by default, so a launch is byte-identical to before', () => {
    expect(getDiscordStartupHint()).toBeUndefined();
    expect(launch('claude')).toBe(BASE);
  });

  it('is appended, single-quoted, while the bridge is on', async () => {
    await writeDiscordConfig(dir, {
      ...DEFAULT_DISCORD_CONFIG,
      enabled: true,
      token: 'tok',
      guildId: '111111111111111111',
      parentChannelId: '222222222222222222',
      allowedUserIds: ['333333333333333333'],
    });
    const b = bridge();
    await b.reload();
    expect(getDiscordStartupHint()).toBe(DISCORD_STARTUP_HINT);
    expect(launch('claude')).toBe(`${BASE} --append-system-prompt '${DISCORD_STARTUP_HINT}'`);
    expect(DISCORD_STARTUP_HINT).not.toContain("'");
    expect(launch('codex')).not.toContain('append-system-prompt');
    b.stop();
    expect(launch('claude')).toBe(BASE);
  });

  it('is absent when startupHint is switched off', async () => {
    await writeDiscordConfig(dir, {
      ...DEFAULT_DISCORD_CONFIG,
      enabled: true,
      token: 'tok',
      guildId: '111111111111111111',
      parentChannelId: '222222222222222222',
      allowedUserIds: ['333333333333333333'],
      startupHint: false,
    });
    const b = bridge();
    await b.reload();
    expect(launch('claude')).toBe(BASE);
    b.stop();
  });
});
