/**
 * @fileoverview Tests for hooks config generation
 *
 * Tests the generation of .claude/settings.local.json with Claude Code
 * hook definitions for desktop notifications.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateHooksConfig, writeHooksConfig } from '../src/hooks-config.js';

describe('generateHooksConfig', () => {
  it('should return an object with hooks key', () => {
    const config = generateHooksConfig();
    expect(config).toHaveProperty('hooks');
  });

  it('should have Notification hooks array', () => {
    const config = generateHooksConfig();
    expect(config.hooks.Notification).toBeInstanceOf(Array);
    expect(config.hooks.Notification).toHaveLength(3);
  });

  it('should have Stop hooks array', () => {
    const config = generateHooksConfig();
    expect(config.hooks.Stop).toBeInstanceOf(Array);
    expect(config.hooks.Stop).toHaveLength(1);
  });

  it('should configure idle_prompt matcher', () => {
    const config = generateHooksConfig();
    const notifHooks = config.hooks.Notification as Array<{ matcher?: string }>;
    const idleHook = notifHooks.find(h => h.matcher === 'idle_prompt');
    expect(idleHook).toBeDefined();
  });

  it('should configure permission_prompt matcher', () => {
    const config = generateHooksConfig();
    const notifHooks = config.hooks.Notification as Array<{ matcher?: string }>;
    const permHook = notifHooks.find(h => h.matcher === 'permission_prompt');
    expect(permHook).toBeDefined();
  });

  it('should configure elicitation_dialog matcher', () => {
    const config = generateHooksConfig();
    const notifHooks = config.hooks.Notification as Array<{ matcher?: string }>;
    const elicitHook = notifHooks.find(h => h.matcher === 'elicitation_dialog');
    expect(elicitHook).toBeDefined();
  });

  it('should use env vars in curl commands (not hardcoded URLs)', () => {
    const config = generateHooksConfig();
    const notifHooks = config.hooks.Notification as Array<{ hooks: Array<{ command: string }> }>;
    const cmd = notifHooks[0].hooks[0].command;
    expect(cmd).toContain('$CLAUDEMAN_API_URL');
    expect(cmd).toContain('$CLAUDEMAN_SESSION_ID');
    expect(cmd).not.toContain('localhost');
  });

  it('should include || true for silent failure', () => {
    const config = generateHooksConfig();
    const notifHooks = config.hooks.Notification as Array<{ hooks: Array<{ command: string }> }>;
    expect(notifHooks[0].hooks[0].command).toContain('|| true');
  });

  it('should set timeout to 10000ms', () => {
    const config = generateHooksConfig();
    const notifHooks = config.hooks.Notification as Array<{ hooks: Array<{ timeout: number }> }>;
    expect(notifHooks[0].hooks[0].timeout).toBe(10000);
  });

  it('should include correct event names in curl payloads', () => {
    const config = generateHooksConfig();
    const notifHooks = config.hooks.Notification as Array<{ hooks: Array<{ command: string }> }>;
    expect(notifHooks[0].hooks[0].command).toContain('idle_prompt');
    expect(notifHooks[1].hooks[0].command).toContain('permission_prompt');
    expect(notifHooks[2].hooks[0].command).toContain('elicitation_dialog');
    const stopHooks = config.hooks.Stop as Array<{ hooks: Array<{ command: string }> }>;
    expect(stopHooks[0].hooks[0].command).toContain('stop');
  });

  it('should read stdin and forward as data field', () => {
    const config = generateHooksConfig();
    const notifHooks = config.hooks.Notification as Array<{ hooks: Array<{ command: string }> }>;
    // Should capture stdin via cat and include as $HOOK_DATA
    expect(notifHooks[0].hooks[0].command).toContain('HOOK_DATA=$(cat');
    expect(notifHooks[0].hooks[0].command).toContain('$HOOK_DATA');
  });

  it('should set hook type to command', () => {
    const config = generateHooksConfig();
    const notifHooks = config.hooks.Notification as Array<{ hooks: Array<{ type: string }> }>;
    expect(notifHooks[0].hooks[0].type).toBe('command');
    const stopHooks = config.hooks.Stop as Array<{ hooks: Array<{ type: string }> }>;
    expect(stopHooks[0].hooks[0].type).toBe('command');
  });
});

describe('writeHooksConfig', () => {
  const testDir = join(tmpdir(), 'claudeman-hooks-test-' + Date.now());

  beforeEach(() => {
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should create .claude directory if it does not exist', () => {
    writeHooksConfig(testDir);
    expect(existsSync(join(testDir, '.claude'))).toBe(true);
  });

  it('should create settings.local.json', () => {
    writeHooksConfig(testDir);
    const settingsPath = join(testDir, '.claude', 'settings.local.json');
    expect(existsSync(settingsPath)).toBe(true);
  });

  it('should write valid JSON', () => {
    writeHooksConfig(testDir);
    const settingsPath = join(testDir, '.claude', 'settings.local.json');
    const content = readFileSync(settingsPath, 'utf-8');
    expect(() => JSON.parse(content)).not.toThrow();
  });

  it('should include hooks config in output', () => {
    writeHooksConfig(testDir);
    const settingsPath = join(testDir, '.claude', 'settings.local.json');
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(parsed.hooks).toBeDefined();
    expect(parsed.hooks.Notification).toHaveLength(3);
    expect(parsed.hooks.Stop).toHaveLength(1);
  });

  it('should merge with existing settings.local.json', () => {
    const claudeDir = join(testDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, 'settings.local.json'),
      JSON.stringify({ existingKey: 'existingValue', permissions: { allow: ['Read'] } }, null, 2),
    );

    writeHooksConfig(testDir);

    const parsed = JSON.parse(readFileSync(join(claudeDir, 'settings.local.json'), 'utf-8'));
    expect(parsed.existingKey).toBe('existingValue');
    expect(parsed.permissions).toEqual({ allow: ['Read'] });
    expect(parsed.hooks).toBeDefined();
  });

  it('should overwrite existing hooks key', () => {
    const claudeDir = join(testDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, 'settings.local.json'),
      JSON.stringify({ hooks: { oldHook: [] } }, null, 2),
    );

    writeHooksConfig(testDir);

    const parsed = JSON.parse(readFileSync(join(claudeDir, 'settings.local.json'), 'utf-8'));
    expect(parsed.hooks.oldHook).toBeUndefined();
    expect(parsed.hooks.Notification).toBeDefined();
  });

  it('should handle malformed existing settings.local.json', () => {
    const claudeDir = join(testDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, 'settings.local.json'), 'not valid json{{{');

    writeHooksConfig(testDir);

    const parsed = JSON.parse(readFileSync(join(claudeDir, 'settings.local.json'), 'utf-8'));
    expect(parsed.hooks).toBeDefined();
  });

  it('should end file with newline', () => {
    writeHooksConfig(testDir);
    const content = readFileSync(join(testDir, '.claude', 'settings.local.json'), 'utf-8');
    expect(content.endsWith('\n')).toBe(true);
  });
});
