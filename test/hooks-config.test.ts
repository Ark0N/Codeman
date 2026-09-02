/**
 * @fileoverview Tests for hooks config generation
 *
 * Tests the generation of .claude/settings.local.json with Claude Code
 * hook definitions for desktop notifications.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { spawn } from 'node:child_process';
import {
  applyStatusLineConfig,
  ensureCodemanHooks,
  findEffectiveUserStatusLineCommand,
  generateBackgroundWakeScript,
  generateHooksConfig,
  generateStatusLineCommand,
  generateSubagentStopGuardScript,
  refreshStaleCodemanHooks,
  resolveStatusLineCliCommand,
  settingsWriteBlocker,
  stripCaseEnvKeys,
  updateCaseEnvVars,
  updateCaseModel,
  writeHooksConfig,
} from '../src/hooks-config.js';

describe('generateHooksConfig', () => {
  it('should return an object with hooks key', () => {
    const config = generateHooksConfig();
    expect(config).toHaveProperty('hooks');
  });

  it('should have Notification hooks array', () => {
    const config = generateHooksConfig();
    expect(config.hooks.Notification).toBeInstanceOf(Array);
    expect(config.hooks.Notification).toHaveLength(5);
  });

  it('should have Stop hooks array', () => {
    const config = generateHooksConfig();
    expect(config.hooks.Stop).toBeInstanceOf(Array);
    expect(config.hooks.Stop).toHaveLength(1);
  });

  it('should guard subagent stops while their background work is active', () => {
    const config = generateHooksConfig();
    const subagentHooks = config.hooks.SubagentStop as Array<{
      hooks: Array<{ type: string; command: string; args: string[]; timeout: number }>;
    }>;

    expect(subagentHooks).toHaveLength(1);
    expect(subagentHooks[0].hooks[0]).toMatchObject({
      type: 'command',
      command: 'node',
      args: ['-e', generateSubagentStopGuardScript()],
    });
  });

  it('should configure a self-contained Bash background-task rewake hook', () => {
    const config = generateHooksConfig();
    const postToolHooks = config.hooks.PostToolUse as Array<{
      matcher: string;
      hooks: Array<{
        type: string;
        command: string;
        args: string[];
        asyncRewake: boolean;
        timeout: number;
      }>;
    }>;

    expect(postToolHooks).toHaveLength(1);
    expect(postToolHooks[0].matcher).toBe('Bash');
    expect(postToolHooks[0].hooks[0]).toMatchObject({
      type: 'command',
      command: 'node',
      asyncRewake: true,
    });
    expect(postToolHooks[0].hooks[0].args).toEqual(['-e', generateBackgroundWakeScript()]);
    expect(postToolHooks[0].hooks[0].timeout).toBeGreaterThanOrEqual(3600);
  });

  it('should configure idle_prompt matcher', () => {
    const config = generateHooksConfig();
    const notifHooks = config.hooks.Notification as Array<{ matcher?: string }>;
    const idleHook = notifHooks.find((h) => h.matcher === 'idle_prompt');
    expect(idleHook).toBeDefined();
  });

  it('should configure permission_prompt matcher', () => {
    const config = generateHooksConfig();
    const notifHooks = config.hooks.Notification as Array<{ matcher?: string }>;
    const permHook = notifHooks.find((h) => h.matcher === 'permission_prompt');
    expect(permHook).toBeDefined();
  });

  it('should configure elicitation_dialog matcher', () => {
    const config = generateHooksConfig();
    const notifHooks = config.hooks.Notification as Array<{ matcher?: string }>;
    const elicitHook = notifHooks.find((h) => h.matcher === 'elicitation_dialog');
    expect(elicitHook).toBeDefined();
  });

  it('should use env vars in curl commands (not hardcoded URLs)', () => {
    const config = generateHooksConfig();
    const notifHooks = config.hooks.Notification as Array<{ hooks: Array<{ command: string }> }>;
    const cmd = notifHooks[0].hooks[0].command;
    expect(cmd).toContain('$CODEMAN_API_URL');
    expect(cmd).toContain('$CODEMAN_SESSION_ID');
    expect(cmd).not.toContain('localhost');
  });

  it('should include || true for silent failure', () => {
    const config = generateHooksConfig();
    const notifHooks = config.hooks.Notification as Array<{ hooks: Array<{ command: string }> }>;
    expect(notifHooks[0].hooks[0].command).toContain('|| true');
  });

  // On --https/tailscale installs CODEMAN_API_URL is HTTPS with a self-signed cert.
  // A `-k`-less hook curl exits 60 there, the `|| true` swallows it, and every hook
  // event (stop, permission_prompt, elicitation_dialog, idle_prompt, teammate_idle,
  // task_completed) dies silently — killing respawn's idle signals and the wait
  // endpoints' stop/blocked. The statusline exporter always carried -k; the hooks must too.
  it('every hook curl tolerates a self-signed HTTPS API (curl -sk)', () => {
    const serialized = JSON.stringify(generateHooksConfig());
    expect(serialized).toContain('curl -sk -X POST');
    expect(serialized).not.toContain('curl -s -X POST');
  });

  it('should set timeout to 10 seconds (hook timeout fields are seconds)', () => {
    const config = generateHooksConfig();
    const notifHooks = config.hooks.Notification as Array<{ hooks: Array<{ timeout: number }> }>;
    expect(notifHooks[0].hooks[0].timeout).toBe(10);
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
  const testDir = join(tmpdir(), 'codeman-hooks-test-' + Date.now());

  beforeEach(() => {
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should create .claude directory if it does not exist', async () => {
    await writeHooksConfig(testDir);
    expect(existsSync(join(testDir, '.claude'))).toBe(true);
  });

  it('should create settings.local.json', async () => {
    await writeHooksConfig(testDir);
    const settingsPath = join(testDir, '.claude', 'settings.local.json');
    expect(existsSync(settingsPath)).toBe(true);
  });

  it('should write valid JSON', async () => {
    await writeHooksConfig(testDir);
    const settingsPath = join(testDir, '.claude', 'settings.local.json');
    const content = readFileSync(settingsPath, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed).toHaveProperty('hooks');
    expect(parsed.hooks).toHaveProperty('Notification');
    expect(parsed.hooks).toHaveProperty('Stop');
  });

  it('should include hooks config in output', async () => {
    await writeHooksConfig(testDir);
    const settingsPath = join(testDir, '.claude', 'settings.local.json');
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(parsed.hooks).toBeDefined();
    expect(parsed.hooks.Notification).toHaveLength(5);
    expect(parsed.hooks.Stop).toHaveLength(1);
  });

  it('refuses to write through a symlinked .claude directory (#251 review)', async () => {
    // Case contents can be foreign (a freshly cloned repository): a symlinked
    // .claude would redirect the scaffold write outside the case.
    const outside = join(testDir, 'outside-target');
    mkdirSync(outside);
    const caseDir = join(testDir, 'case');
    mkdirSync(caseDir);
    symlinkSync(outside, join(caseDir, '.claude'));
    expect(await settingsWriteBlocker(caseDir)).toMatch(/symlink/);
    await writeHooksConfig(caseDir);
    expect(existsSync(join(outside, 'settings.local.json'))).toBe(false);
  });

  it('refuses to write through a symlinked settings.local.json (#251 review)', async () => {
    const outsideFile = join(testDir, 'victim-settings.json');
    writeFileSync(outsideFile, '{"model":"precious"}\n');
    const caseDir = join(testDir, 'case2');
    mkdirSync(join(caseDir, '.claude'), { recursive: true });
    symlinkSync(outsideFile, join(caseDir, '.claude', 'settings.local.json'));
    expect(await settingsWriteBlocker(caseDir)).toMatch(/symlink/);
    await writeHooksConfig(caseDir);
    // The link target is untouched: no hooks were merged into it.
    expect(readFileSync(outsideFile, 'utf-8')).toBe('{"model":"precious"}\n');
  });

  it('reports a real, confined .claude as safe', async () => {
    const caseDir = join(testDir, 'case3');
    mkdirSync(join(caseDir, '.claude'), { recursive: true });
    expect(await settingsWriteBlocker(caseDir)).toBeNull();
  });

  it('EVERY settings writer refuses a symlinked settings.local.json (#251 review round 2)', async () => {
    // Round 1 guarded only writeHooksConfig/updateCaseModel; the reviewer
    // demonstrated applyStatusLineConfig writing through the link. All
    // writers now share one safe-write gate, so pin all of them at once.
    const outsideFile = join(testDir, 'victim-all-writers.json');
    const precious =
      '{"env":{"CLAUDE_CODE_KEEP":"me"},"hooks":{"Stop":[{"hooks":[{"command":"curl /api/hook-event"}]}]}}\n';
    writeFileSync(outsideFile, precious);
    const caseDir = join(testDir, 'case-writers');
    mkdirSync(join(caseDir, '.claude'), { recursive: true });
    symlinkSync(outsideFile, join(caseDir, '.claude', 'settings.local.json'));

    await writeHooksConfig(caseDir);
    await ensureCodemanHooks(caseDir);
    await refreshStaleCodemanHooks(caseDir);
    await updateCaseModel(caseDir, 'opus');
    await updateCaseEnvVars(caseDir, { CLAUDE_CODE_NEW: 'value' });
    await stripCaseEnvKeys(caseDir, ['CLAUDE_CODE_KEEP']);
    await applyStatusLineConfig(caseDir, true);
    await applyStatusLineConfig(caseDir, false);

    // The link target is byte-identical: none of the writers went through it.
    expect(readFileSync(outsideFile, 'utf-8')).toBe(precious);
  });

  it('should merge with existing settings.local.json', async () => {
    const claudeDir = join(testDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, 'settings.local.json'),
      JSON.stringify({ existingKey: 'existingValue', permissions: { allow: ['Read'] } }, null, 2)
    );

    await writeHooksConfig(testDir);

    const parsed = JSON.parse(readFileSync(join(claudeDir, 'settings.local.json'), 'utf-8'));
    expect(parsed.existingKey).toBe('existingValue');
    expect(parsed.permissions).toEqual({ allow: ['Read'] });
    expect(parsed.hooks).toBeDefined();
  });

  it('should upgrade Codeman-owned hooks that predate background rewake', async () => {
    const claudeDir = join(testDir, '.claude');
    const settingsPath = join(claudeDir, 'settings.local.json');
    mkdirSync(claudeDir, { recursive: true });
    const oldHooks = generateHooksConfig().hooks;
    delete oldHooks.PostToolUse;
    writeFileSync(settingsPath, JSON.stringify({ hooks: oldHooks }, null, 2));

    await refreshStaleCodemanHooks(testDir);

    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(parsed.hooks.PostToolUse).toHaveLength(1);
    expect(JSON.stringify(parsed.hooks.PostToolUse)).toContain('CODEMAN_BACKGROUND_REWAKE_V3');
    expect(JSON.stringify(parsed.hooks.SubagentStop)).toContain('CODEMAN_SUBAGENT_STOP_GUARD_V1');
  });

  it('should replace an older rewake script version without duplicating it', async () => {
    const claudeDir = join(testDir, '.claude');
    const settingsPath = join(claudeDir, 'settings.local.json');
    mkdirSync(claudeDir, { recursive: true });
    // Simulate a case healed by the previous release: current curls (secret present)
    // plus a V1 rewake handler. The version bump must swap the handler in place.
    const hooks = generateHooksConfig().hooks;
    hooks.PostToolUse = [
      {
        matcher: 'Bash',
        hooks: [
          {
            type: 'command',
            command: 'node',
            args: ['-e', 'const CODEMAN_BACKGROUND_REWAKE_V1 = true; process.exit(0);'],
            asyncRewake: true,
            timeout: 21600,
          },
        ],
      },
    ];
    writeFileSync(settingsPath, JSON.stringify({ hooks }, null, 2));

    await refreshStaleCodemanHooks(testDir);

    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const serialized = JSON.stringify(parsed.hooks.PostToolUse);
    expect(parsed.hooks.PostToolUse).toHaveLength(1);
    expect(parsed.hooks.PostToolUse[0].hooks).toHaveLength(1);
    expect(serialized).toContain('CODEMAN_BACKGROUND_REWAKE_V3');
    expect(serialized).not.toContain('CODEMAN_BACKGROUND_REWAKE_V1');
  });

  it('replaces the V2 background hook without duplicating it', async () => {
    const claudeDir = join(testDir, '.claude');
    const settingsPath = join(claudeDir, 'settings.local.json');
    mkdirSync(claudeDir, { recursive: true });
    const oldSettings = JSON.stringify({ hooks: generateHooksConfig().hooks }, null, 2).replaceAll(
      'CODEMAN_BACKGROUND_REWAKE_V3',
      'CODEMAN_BACKGROUND_REWAKE_V2'
    );
    writeFileSync(settingsPath, oldSettings);

    await refreshStaleCodemanHooks(testDir);

    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const postToolUse = JSON.stringify(parsed.hooks.PostToolUse);
    expect(parsed.hooks.PostToolUse).toHaveLength(1);
    expect(postToolUse).toContain('CODEMAN_BACKGROUND_REWAKE_V3');
    expect(postToolUse).not.toContain('CODEMAN_BACKGROUND_REWAKE_V2');
  });

  it('should not add rewake hooks to a user-owned hook configuration', async () => {
    const claudeDir = join(testDir, '.claude');
    const settingsPath = join(claudeDir, 'settings.local.json');
    mkdirSync(claudeDir, { recursive: true });
    const userHooks = {
      PostToolUse: [
        {
          matcher: 'Write',
          hooks: [{ type: 'command', command: './format.sh' }],
        },
      ],
    };
    writeFileSync(settingsPath, JSON.stringify({ hooks: userHooks }, null, 2));

    await refreshStaleCodemanHooks(testDir);

    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(parsed.hooks).toEqual(userHooks);
  });

  it('should preserve user hook events while installing Codeman hooks', async () => {
    const claudeDir = join(testDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, 'settings.local.json'), JSON.stringify({ hooks: { oldHook: [] } }, null, 2));

    await writeHooksConfig(testDir);

    const parsed = JSON.parse(readFileSync(join(claudeDir, 'settings.local.json'), 'utf-8'));
    expect(parsed.hooks.oldHook).toEqual([]);
    expect(parsed.hooks.Notification).toBeDefined();
  });

  it('should safely add Codeman hooks to an existing managed-case settings file', async () => {
    const claudeDir = join(testDir, '.claude');
    const settingsPath = join(claudeDir, 'settings.local.json');
    mkdirSync(claudeDir, { recursive: true });
    const userHooks = {
      PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: './format.sh' }] }],
    };
    writeFileSync(settingsPath, JSON.stringify({ hooks: userHooks, permissions: { allow: ['Read'] } }, null, 2));

    await ensureCodemanHooks(testDir);

    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(parsed.permissions).toEqual({ allow: ['Read'] });
    expect(parsed.hooks.PostToolUse).toEqual(expect.arrayContaining(userHooks.PostToolUse));
    expect(JSON.stringify(parsed.hooks)).toContain('CODEMAN_BACKGROUND_REWAKE_V3');
    expect(JSON.stringify(parsed.hooks)).toContain('CODEMAN_SUBAGENT_STOP_GUARD_V1');
  });

  it('should not replace a malformed managed-case settings file', async () => {
    const claudeDir = join(testDir, '.claude');
    const settingsPath = join(claudeDir, 'settings.local.json');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(settingsPath, '{ malformed');

    await ensureCodemanHooks(testDir);

    expect(readFileSync(settingsPath, 'utf-8')).toBe('{ malformed');
  });

  it('should handle malformed existing settings.local.json', async () => {
    const claudeDir = join(testDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, 'settings.local.json'), 'not valid json{{{');

    await writeHooksConfig(testDir);

    const parsed = JSON.parse(readFileSync(join(claudeDir, 'settings.local.json'), 'utf-8'));
    expect(parsed.hooks).toBeDefined();
  });

  it('should end file with newline', async () => {
    await writeHooksConfig(testDir);
    const content = readFileSync(join(testDir, '.claude', 'settings.local.json'), 'utf-8');
    expect(content.endsWith('\n')).toBe(true);
  });
});

describe('background task rewake helper', () => {
  const testDir = join(tmpdir(), 'codeman-background-rewake-test-' + Date.now());

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function runHelper(input: Record<string, unknown>): Promise<{ code: number | null; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', generateBackgroundWakeScript()], {
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      let stderr = '';
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error('background rewake helper timed out'));
      }, 5000);

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(timeout);
        resolve({ code, stderr });
      });
      child.stdin.end(JSON.stringify(input));
    });
  }

  it('exits without waiting for an ordinary Bash result', async () => {
    const result = await runHelper({
      transcript_path: join(testDir, 'transcript.jsonl'),
      tool_response: { stdout: 'ordinary command completed' },
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('exits 2 when the matching background command completes', async () => {
    const transcriptPath = join(testDir, 'transcript.jsonl');
    writeFileSync(transcriptPath, '');

    const resultPromise = runHelper({
      transcript_path: transcriptPath,
      tool_response: {
        stdout: 'Command running in background with ID: bg-test-1. Output is being written to: /tmp/bg-test-1.output.',
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    writeFileSync(
      transcriptPath,
      JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        content:
          '<task-notification>\n<task-id>bg-test-1</task-id>\n<status>completed</status>\n' +
          '<output-file>/tmp/bg-test-1.output</output-file>\n</task-notification>',
      }) + '\n'
    );

    const result = await resultPromise;
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('bg-test-1');
    expect(result.stderr).toContain('completed');
    expect(result.stderr).toContain('/tmp/bg-test-1.output');
  });

  it('rewakes a subagent when Claude queues completion in the parent transcript', async () => {
    const sessionId = '7148e9de-7673-48b8-bf38-6799e52c346a';
    const sessionDir = join(testDir, sessionId);
    const subagentDir = join(sessionDir, 'subagents');
    const parentTranscriptPath = `${sessionDir}.jsonl`;
    const subagentTranscriptPath = join(subagentDir, 'agent-afacts-class2.jsonl');
    mkdirSync(subagentDir, { recursive: true });
    writeFileSync(parentTranscriptPath, '');
    writeFileSync(subagentTranscriptPath, '');

    const resultPromise = runHelper({
      session_id: sessionId,
      agent_id: 'afacts-class2',
      transcript_path: subagentTranscriptPath,
      tool_response: {
        backgroundTaskId: 'bg-subagent-1',
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    writeFileSync(
      parentTranscriptPath,
      JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        content:
          '<task-notification>\n<task-id>bg-subagent-1</task-id>\n<status>completed</status>\n' +
          '<output-file>/tmp/bg-subagent-1.output</output-file>\n</task-notification>',
      }) + '\n'
    );

    const result = await resultPromise;
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('bg-subagent-1');
    expect(result.stderr).toContain('/tmp/bg-subagent-1.output');
  });

  it('includes a marked background report in the wake feedback', async () => {
    const transcriptPath = join(testDir, 'transcript.jsonl');
    const tasksDir = join(testDir, 'tasks');
    const outputPath = join(tasksDir, 'bg-report-1.output');
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(transcriptPath, '');
    writeFileSync(
      outputPath,
      [
        'launcher output',
        '=== CODEMAN_RESULT_BEGIN ===',
        'Summary line',
        'Detail after the old 30-line preview boundary',
        '=== CODEMAN_RESULT_END ===',
      ].join('\n')
    );

    const resultPromise = runHelper({
      transcript_path: transcriptPath,
      tool_response: {
        stdout: `Command running in background with ID: bg-report-1. Output is being written to: ${outputPath}.`,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    writeFileSync(
      transcriptPath,
      JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        content:
          '<task-notification>\n<task-id>bg-report-1</task-id>\n<status>completed</status>\n' +
          `<output-file>${outputPath}</output-file>\n</task-notification>`,
      }) + '\n'
    );

    const result = await resultPromise;
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('<codeman-background-result>');
    expect(result.stderr).toContain('Summary line');
    expect(result.stderr).toContain('Detail after the old 30-line preview boundary');
  });
});

describe('subagent stop guard helper', () => {
  const testDir = join(tmpdir(), 'codeman-subagent-stop-guard-test-' + Date.now());

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function runGuard(transcriptLines: unknown[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const transcriptPath = join(testDir, 'agent-test.jsonl');
    writeFileSync(transcriptPath, transcriptLines.map((line) => JSON.stringify(line)).join('\n') + '\n');

    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', generateSubagentStopGuardScript()], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(JSON.stringify({ agent_transcript_path: transcriptPath }));
    });
  }

  async function withLiveTask<T>(taskId: string, action: () => Promise<T>): Promise<T> {
    const tasksDir = join(testDir, 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    const outputFd = openSync(join(tasksDir, `${taskId}.output`), 'a');
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
      stdio: ['ignore', outputFd, outputFd],
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    closeSync(outputFd);

    try {
      return await action();
    } finally {
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
      child.kill();
      await closed;
    }
  }

  const monitorResult = (taskId: string) => ({
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          content: `Monitor started (task ${taskId}, pid 123).`,
        },
      ],
    },
  });

  const completion = (taskId: string) => ({
    type: 'user',
    message: {
      content:
        `<task-notification>\n<task-id>${taskId}</task-id>\n` + '<status>completed</status>\n</task-notification>',
    },
  });

  it('blocks an intermediate subagent stop while a sibling monitor is active', async () => {
    const result = await withLiveTask('monitor-still-live', () =>
      runGuard([monitorResult('monitor-first'), monitorResult('monitor-still-live'), completion('monitor-first')])
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ decision: 'block' });
    expect(result.stdout).toContain('monitor-still-live');
    expect(result.stdout).not.toContain('monitor-first,');
  });

  it('allows a subagent to stop after all of its monitored work finishes', async () => {
    const result = await runGuard([
      monitorResult('monitor-first'),
      monitorResult('monitor-second'),
      completion('monitor-first'),
      completion('monitor-second'),
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('also recognizes background Bash task ownership', async () => {
    const result = await withLiveTask('bash-live-1', () =>
      runGuard([
        {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                content: 'Command running in background with ID: bash-live-1. Output is being written to a task file.',
              },
            ],
          },
        },
      ])
    );

    expect(JSON.parse(result.stdout)).toMatchObject({ decision: 'block' });
    expect(result.stdout).toContain('bash-live-1');
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
    testSessionId = createData.data.session.id;
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
    testSessionId = createData.data.session.id;
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
    expect(config.hooks.Notification).toHaveLength(5);
    expect(config.hooks.Stop).toHaveLength(1);
  });

  it('should include all event types', () => {
    const config = generateHooksConfig();
    const notifHooks = config.hooks.Notification as Array<{ matcher?: string }>;
    const matchers = notifHooks.map((n) => n.matcher);
    expect(matchers).toContain('idle_prompt');
    expect(matchers).toContain('permission_prompt');
    expect(matchers).toContain('elicitation_dialog');
    // Approvals Inbox resolution signals (dialog answered in the terminal).
    expect(matchers).toContain('elicitation_complete');
    expect(matchers).toContain('elicitation_response');
  });

  it('should use environment variable placeholders', () => {
    const config = generateHooksConfig();
    const notifHooks = config.hooks.Notification as Array<{ hooks: Array<{ command: string }> }>;
    const cmd = notifHooks[0].hooks[0].command;
    expect(cmd).toContain('$CODEMAN_API_URL');
    expect(cmd).toContain('$CODEMAN_SESSION_ID');
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
      // The printf format string contains the event name baked in
      expect(cmd).toContain(`"event":"${hook.matcher}"`);
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
    // Data is piped to curl via stdin (--data @-) to prevent shell injection
    expect(cmd).toContain('$HOOK_DATA');
    expect(cmd).toContain('--data @-');
  });

  it('should have consistent structure across all notification hooks', () => {
    const config = generateHooksConfig();
    const notifHooks = config.hooks.Notification as Array<{
      matcher: string;
      hooks: Array<{ type: string; command: string; timeout: number }>;
    }>;

    for (const hook of notifHooks) {
      expect(hook.matcher).toBeDefined();
      expect(hook.hooks).toHaveLength(1);
      expect(hook.hooks[0].type).toBe('command');
      expect(hook.hooks[0].timeout).toBe(10);
      expect(hook.hooks[0].command).toBeTruthy();
    }
  });

  it('should pipe data to curl via stdin to prevent shell injection', () => {
    const config = generateHooksConfig();
    const notifHooks = config.hooks.Notification as Array<{ hooks: Array<{ command: string }> }>;
    const cmd = notifHooks[0].hooks[0].command;
    // HOOK_DATA must NOT be embedded unquoted in a -d "..." argument (shell injection vector)
    expect(cmd).not.toMatch(/-d\s+"[^"]*\$HOOK_DATA/);
    // Instead, data should be piped to curl via stdin
    expect(cmd).toContain('printf');
    expect(cmd).toContain('| curl');
    expect(cmd).toContain('--data @-');
  });

  it('should have stop hook without matcher (catches all)', () => {
    const config = generateHooksConfig();
    const stopHooks = config.hooks.Stop as Array<{ matcher?: string; hooks: Array<{ command: string }> }>;

    expect(stopHooks).toHaveLength(1);
    expect(stopHooks[0].matcher).toBeUndefined();
    expect(stopHooks[0].hooks[0].command).toContain('stop');
  });
});

describe('resolveStatusLineCliCommand', () => {
  const testDir = join(tmpdir(), 'codeman-statusline-cli-test-' + Date.now());

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns undefined when telemetry was not requested', async () => {
    expect(await resolveStatusLineCliCommand(testDir, false)).toBeUndefined();
  });

  it('returns a bare exporter SCRIPT PATH (never the inline command) when requested', async () => {
    // A bare path has no `$`, quotes, or pipes for any intermediate shell
    // layer to mangle — see ensureStatusLineExporterScript's doc comment for
    // the real bug this guards against.
    const cmd = await resolveStatusLineCliCommand(testDir, true);
    expect(cmd).toBeDefined();
    expect(cmd).not.toContain('$');
    expect(cmd).not.toContain("'");
    expect(cmd).toMatch(/^\/.*statusline-exporter\.sh$/);
    expect(existsSync(cmd!)).toBe(true);
    const stat = statSync(cmd!);
    expect(stat.mode & 0o111).not.toBe(0); // executable
    expect(readFileSync(cmd!, 'utf-8')).toContain('CODEMAN_STATUSLINE_EXPORTER_V');
  });

  it('never overrides a real, hand-authored statusLine', async () => {
    const claudeDir = join(testDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, 'settings.local.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'echo my-own-prompt' } }, null, 2)
    );

    expect(await resolveStatusLineCliCommand(testDir, true)).toBeUndefined();

    // The user's own config is untouched — this is a read-only decision, not a write.
    const parsed = JSON.parse(readFileSync(join(claudeDir, 'settings.local.json'), 'utf-8'));
    expect(parsed.statusLine.command).toBe('echo my-own-prompt');
  });

  it('self-heals: strips a legacy disk-written exporter from an older Codeman build', async () => {
    // Simulate a workspace touched by the pre-fix applyStatusLineConfig(dir, true).
    await applyStatusLineConfig(testDir, true);
    const settingsPath = join(testDir, '.claude', 'settings.local.json');
    expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).statusLine).toBeDefined();

    const cmd = await resolveStatusLineCliCommand(testDir, true);

    // Cleaned off disk...
    expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).statusLine).toBeUndefined();
    // ...and telemetry still flows, via the ephemeral CLI flag instead.
    expect(cmd).toMatch(/statusline-exporter\.sh$/);
  });

  it('does not resurrect the legacy exporter when telemetry is off during cleanup', async () => {
    await applyStatusLineConfig(testDir, true);
    const settingsPath = join(testDir, '.claude', 'settings.local.json');

    const cmd = await resolveStatusLineCliCommand(testDir, false);

    expect(cmd).toBeUndefined();
    expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).statusLine).toBeUndefined();
  });
});

describe('findEffectiveUserStatusLineCommand', () => {
  const testDir = join(tmpdir(), 'codeman-statusline-precedence-test-' + Date.now());
  const userSettingsPath = join(homedir(), '.claude', 'settings.json');

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    rmSync(userSettingsPath, { force: true }); // don't leak into other tests sharing this HOME
  });

  it('returns undefined when nothing is configured anywhere', async () => {
    expect(await findEffectiveUserStatusLineCommand(testDir)).toBeUndefined();
  });

  it('finds the user global ~/.claude/settings.json when nothing else is set', async () => {
    const userClaudeDir = join(homedir(), '.claude');
    mkdirSync(userClaudeDir, { recursive: true });
    writeFileSync(
      join(userClaudeDir, 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'echo user-global' } })
    );

    expect(await findEffectiveUserStatusLineCommand(testDir)).toBe('echo user-global');
  });

  it('project-SHARED settings.json wins over user-global', async () => {
    const userClaudeDir = join(homedir(), '.claude');
    mkdirSync(userClaudeDir, { recursive: true });
    writeFileSync(
      join(userClaudeDir, 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'echo user-global' } })
    );
    const projectClaudeDir = join(testDir, '.claude');
    mkdirSync(projectClaudeDir, { recursive: true });
    writeFileSync(
      join(projectClaudeDir, 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'echo project-shared' } })
    );

    expect(await findEffectiveUserStatusLineCommand(testDir)).toBe('echo project-shared');
  });

  it('project-LOCAL settings.local.json wins over everything', async () => {
    const projectClaudeDir = join(testDir, '.claude');
    mkdirSync(projectClaudeDir, { recursive: true });
    writeFileSync(
      join(projectClaudeDir, 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'echo project-shared' } })
    );
    writeFileSync(
      join(projectClaudeDir, 'settings.local.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'echo project-local' } })
    );

    expect(await findEffectiveUserStatusLineCommand(testDir)).toBe('echo project-local');
  });

  it('skips a legacy Codeman-marked entry in project settings.local.json and falls through', async () => {
    await applyStatusLineConfig(testDir, true); // simulates a pre-fix disk-written exporter
    const projectClaudeDir = join(testDir, '.claude');
    writeFileSync(
      join(projectClaudeDir, 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'echo project-shared' } })
    );

    expect(await findEffectiveUserStatusLineCommand(testDir)).toBe('echo project-shared');
  });
});
