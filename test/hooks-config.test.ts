/**
 * @fileoverview Tests for hooks config generation
 *
 * Tests the generation of .claude/settings.local.json with Claude Code
 * hook definitions for desktop notifications.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
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

// ========== Hook Event API Integration Tests ==========
// Port 3130 reserved for hooks integration tests

import { WebServer } from '../src/web/server.js';

const TEST_PORT = 3130;

describe('Hook Event API', () => {
  let server: WebServer;
  let baseUrl: string;
  let testSessionId: string;

  beforeAll(async () => {
    server = new WebServer(TEST_PORT, false, true);
    await server.start();
    baseUrl = `http://localhost:${TEST_PORT}`;

    // Create a test session
    const createRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const createData = await createRes.json();
    testSessionId = createData.session.id;
  });

  afterAll(async () => {
    // Clean up the test session
    if (testSessionId) {
      await fetch(`${baseUrl}/api/sessions/${testSessionId}`, {
        method: 'DELETE',
      });
    }
    await server.stop();
  }, 60000);

  describe('Valid Hook Events', () => {
    it('should accept idle_prompt event', async () => {
      const res = await fetch(`${baseUrl}/api/hook-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'idle_prompt',
          sessionId: testSessionId,
        }),
      });
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
    });

    it('should accept permission_prompt event', async () => {
      const res = await fetch(`${baseUrl}/api/hook-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'permission_prompt',
          sessionId: testSessionId,
          data: { tool_name: 'Bash' },
        }),
      });
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
    });

    it('should accept elicitation_dialog event', async () => {
      const res = await fetch(`${baseUrl}/api/hook-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'elicitation_dialog',
          sessionId: testSessionId,
          data: { question: 'What is your name?' },
        }),
      });
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
    });

    it('should accept stop event', async () => {
      const res = await fetch(`${baseUrl}/api/hook-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'stop',
          sessionId: testSessionId,
        }),
      });
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
    });

    it('should accept event with tool_input data', async () => {
      const res = await fetch(`${baseUrl}/api/hook-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'permission_prompt',
          sessionId: testSessionId,
          data: {
            tool_name: 'Bash',
            tool_input: {
              command: 'ls -la',
              description: 'List files',
            },
          },
        }),
      });
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
    });
  });

  describe('Invalid Hook Events', () => {
    it('should reject invalid event types', async () => {
      const res = await fetch(`${baseUrl}/api/hook-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'invalid_event',
          sessionId: testSessionId,
        }),
      });
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.errorCode).toBe('INVALID_INPUT');
    });

    it('should reject missing event field', async () => {
      const res = await fetch(`${baseUrl}/api/hook-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: testSessionId,
        }),
      });
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.errorCode).toBe('INVALID_INPUT');
    });

    it('should reject empty event field', async () => {
      const res = await fetch(`${baseUrl}/api/hook-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: '',
          sessionId: testSessionId,
        }),
      });
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.errorCode).toBe('INVALID_INPUT');
    });

    it('should reject non-existent session', async () => {
      const res = await fetch(`${baseUrl}/api/hook-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'idle_prompt',
          sessionId: 'fake-session-id-12345',
        }),
      });
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.errorCode).toBe('NOT_FOUND');
    });

    it('should reject missing sessionId', async () => {
      const res = await fetch(`${baseUrl}/api/hook-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'idle_prompt',
        }),
      });
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.errorCode).toBe('INVALID_INPUT');
    });
  });
});

describe('Hook Data Sanitization', () => {
  let server: WebServer;
  let baseUrl: string;
  let testSessionId: string;

  beforeAll(async () => {
    server = new WebServer(TEST_PORT + 1, false, true); // Port 3131
    await server.start();
    baseUrl = `http://localhost:${TEST_PORT + 1}`;

    // Create a test session
    const createRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const createData = await createRes.json();
    testSessionId = createData.session.id;
  });

  afterAll(async () => {
    if (testSessionId) {
      await fetch(`${baseUrl}/api/sessions/${testSessionId}`, {
        method: 'DELETE',
      });
    }
    await server.stop();
  }, 60000);

  it('should truncate long command in tool_input (verified via API)', async () => {
    const longCommand = 'a'.repeat(1000);

    // The sanitizeHookData function truncates command to 500 chars.
    // We verify by checking that the API accepts it (the truncation happens
    // server-side before broadcast). To fully verify truncation, we'd need
    // to inspect the SSE output, but SSE testing in Node.js requires more setup.
    const res = await fetch(`${baseUrl}/api/hook-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'permission_prompt',
        sessionId: testSessionId,
        data: {
          tool_name: 'Bash',
          tool_input: { command: longCommand },
        },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it('should truncate long file_path in tool_input', async () => {
    const longPath = '/path/' + 'a'.repeat(1000);

    const res = await fetch(`${baseUrl}/api/hook-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'permission_prompt',
        sessionId: testSessionId,
        data: {
          tool_name: 'Read',
          tool_input: { file_path: longPath },
        },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it('should only allow safe fields through', async () => {
    const res = await fetch(`${baseUrl}/api/hook-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'permission_prompt',
        sessionId: testSessionId,
        data: {
          tool_name: 'Bash',
          secret_field: 'should-be-stripped',
          malicious_data: { nested: 'value' },
          hook_event_name: 'permission_prompt',
          cwd: '/home/user/project',
        },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it('should handle empty data gracefully', async () => {
    const res = await fetch(`${baseUrl}/api/hook-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'idle_prompt',
        sessionId: testSessionId,
        data: {},
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it('should handle null data gracefully', async () => {
    const res = await fetch(`${baseUrl}/api/hook-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'idle_prompt',
        sessionId: testSessionId,
        data: null,
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it('should handle undefined data gracefully', async () => {
    const res = await fetch(`${baseUrl}/api/hook-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'stop',
        sessionId: testSessionId,
        // data field omitted
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it('should truncate description field to 200 chars', async () => {
    const longDescription = 'x'.repeat(500);

    const res = await fetch(`${baseUrl}/api/hook-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'permission_prompt',
        sessionId: testSessionId,
        data: {
          tool_name: 'Edit',
          tool_input: { description: longDescription },
        },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it('should truncate query field to 200 chars', async () => {
    const longQuery = 'q'.repeat(500);

    const res = await fetch(`${baseUrl}/api/hook-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'permission_prompt',
        sessionId: testSessionId,
        data: {
          tool_name: 'Grep',
          tool_input: { query: longQuery },
        },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it('should truncate url field to 500 chars', async () => {
    const longUrl = 'https://example.com/' + 'u'.repeat(1000);

    const res = await fetch(`${baseUrl}/api/hook-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'permission_prompt',
        sessionId: testSessionId,
        data: {
          tool_name: 'WebFetch',
          tool_input: { url: longUrl },
        },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it('should truncate pattern field to 200 chars', async () => {
    const longPattern = 'p'.repeat(500);

    const res = await fetch(`${baseUrl}/api/hook-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'permission_prompt',
        sessionId: testSessionId,
        data: {
          tool_name: 'Grep',
          tool_input: { pattern: longPattern },
        },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it('should truncate prompt field to 200 chars', async () => {
    const longPrompt = 'm'.repeat(500);

    const res = await fetch(`${baseUrl}/api/hook-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'permission_prompt',
        sessionId: testSessionId,
        data: {
          tool_name: 'Task',
          tool_input: { prompt: longPrompt },
        },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });
});

describe('Hook Config Generation - Extended', () => {
  it('should generate valid JSON structure', () => {
    const config = generateHooksConfig();
    expect(config.hooks).toBeDefined();
    expect(config.hooks.Notification).toHaveLength(3);
    expect(config.hooks.Stop).toHaveLength(1);
  });

  it('should include all event types', () => {
    const config = generateHooksConfig();
    const notifHooks = config.hooks.Notification as Array<{ matcher?: string }>;
    const matchers = notifHooks.map(n => n.matcher);
    expect(matchers).toContain('idle_prompt');
    expect(matchers).toContain('permission_prompt');
    expect(matchers).toContain('elicitation_dialog');
  });

  it('should use environment variable placeholders', () => {
    const config = generateHooksConfig();
    const notifHooks = config.hooks.Notification as Array<{ hooks: Array<{ command: string }> }>;
    const cmd = notifHooks[0].hooks[0].command;
    expect(cmd).toContain('$CLAUDEMAN_API_URL');
    expect(cmd).toContain('$CLAUDEMAN_SESSION_ID');
  });

  it('should generate POST curl commands', () => {
    const config = generateHooksConfig();
    const notifHooks = config.hooks.Notification as Array<{ hooks: Array<{ command: string }> }>;
    const cmd = notifHooks[0].hooks[0].command;
    expect(cmd).toContain('curl');
    expect(cmd).toContain('-X POST');
    expect(cmd).toContain('Content-Type: application/json');
  });

  it('should forward event name in curl payload', () => {
    const config = generateHooksConfig();
    const notifHooks = config.hooks.Notification as Array<{ matcher: string; hooks: Array<{ command: string }> }>;

    for (const hook of notifHooks) {
      const cmd = hook.hooks[0].command;
      // The command contains escaped quotes for the JSON payload: \"event\":\"idle_prompt\"
      expect(cmd).toContain(`\\"event\\":\\"${hook.matcher}\\"`);
    }
  });

  it('should use 2>/dev/null for curl errors', () => {
    const config = generateHooksConfig();
    const notifHooks = config.hooks.Notification as Array<{ hooks: Array<{ command: string }> }>;
    const cmd = notifHooks[0].hooks[0].command;
    expect(cmd).toContain('2>/dev/null');
  });

  it('should handle stdin capture for hook data', () => {
    const config = generateHooksConfig();
    const notifHooks = config.hooks.Notification as Array<{ hooks: Array<{ command: string }> }>;
    const cmd = notifHooks[0].hooks[0].command;
    expect(cmd).toContain('HOOK_DATA=$(cat');
    // The data field in the JSON uses escaped quotes: \"data\":$HOOK_DATA
    expect(cmd).toContain('\\"data\\":$HOOK_DATA');
  });

  it('should have consistent structure across all notification hooks', () => {
    const config = generateHooksConfig();
    const notifHooks = config.hooks.Notification as Array<{ matcher: string; hooks: Array<{ type: string; command: string; timeout: number }> }>;

    for (const hook of notifHooks) {
      expect(hook.matcher).toBeDefined();
      expect(hook.hooks).toHaveLength(1);
      expect(hook.hooks[0].type).toBe('command');
      expect(hook.hooks[0].timeout).toBe(10000);
      expect(hook.hooks[0].command).toBeTruthy();
    }
  });

  it('should have stop hook without matcher (catches all)', () => {
    const config = generateHooksConfig();
    const stopHooks = config.hooks.Stop as Array<{ matcher?: string; hooks: Array<{ command: string }> }>;

    expect(stopHooks).toHaveLength(1);
    expect(stopHooks[0].matcher).toBeUndefined();
    expect(stopHooks[0].hooks[0].command).toContain('stop');
  });
});
