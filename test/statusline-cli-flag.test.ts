/**
 * @fileoverview Tests for the plan-usage statusLine exporter riding an EPHEMERAL
 * `claude --settings` CLI flag (buildSpawnCommand's statusLineCommand option),
 * which superseded writing it into `.claude/settings.local.json` — see
 * resolveStatusLineCliCommand in hooks-config.ts and its own tests. Verified
 * live against a real Claude CLI (isolated tmux socket, 2026-08-31) that
 * `--settings` accepts this exact shape and takes precedence over a file-based
 * statusLine.
 *
 * Extracting and re-parsing the `--settings` argument goes through a REAL
 * shell (bash -c) rather than a hand-rolled unescaper: the exporter command
 * itself embeds both single and double quotes, so trusting anything but the
 * shell's own quoting rules to reverse shellescape() would just be testing
 * this file's guess at the algorithm, not the actual behavior a spawned pane
 * sees.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { buildSpawnCommand } from '../src/tmux-manager.js';

const EXPORTER_CMD = 'curl -sk -X POST "$CODEMAN_API_URL/api/status-telemetry" --data @- 2>/dev/null || echo codeman';

/** Extract the `--settings <arg>` fragment from a built command and have a
 * real shell resolve its quoting, printing the arg back out verbatim. */
function extractSettingsJson(cmd: string): unknown {
  const idx = cmd.indexOf('--settings ');
  expect(idx).toBeGreaterThan(-1);
  const fragment = cmd.slice(idx);
  const out = execFileSync('bash', ['-c', `set -- ${fragment}; printf '%s' "$2"`]).toString();
  return JSON.parse(out);
}

describe('buildSpawnCommand statusLineCommand (claude mode)', () => {
  it('omits --settings entirely when no statusLineCommand and no effort are given', () => {
    const cmd = buildSpawnCommand({ mode: 'claude', sessionId: 'sid-1' });
    expect(cmd).not.toContain('--settings');
  });

  it('embeds the exporter command under a statusLine settings key', () => {
    const cmd = buildSpawnCommand({ mode: 'claude', sessionId: 'sid-1', statusLineCommand: EXPORTER_CMD });
    expect(cmd).toContain('--settings');
    expect(extractSettingsJson(cmd)).toEqual({ statusLine: { type: 'command', command: EXPORTER_CMD } });
  });

  it('merges statusLine and ultracode into the SAME --settings object', () => {
    const cmd = buildSpawnCommand({
      mode: 'claude',
      sessionId: 'sid-1',
      effort: 'ultracode',
      statusLineCommand: EXPORTER_CMD,
    });
    // Only one --settings flag total — never two (Claude Code accepts just one).
    expect(cmd.match(/--settings/g)).toHaveLength(1);
    expect(extractSettingsJson(cmd)).toEqual({
      ultracode: true,
      statusLine: { type: 'command', command: EXPORTER_CMD },
    });
  });

  it('keeps a regular --effort flag separate from --settings when both are present', () => {
    const cmd = buildSpawnCommand({
      mode: 'claude',
      sessionId: 'sid-1',
      effort: 'high',
      statusLineCommand: EXPORTER_CMD,
    });
    expect(cmd).toContain('--effort');
    expect(cmd).toContain('--settings');
    expect(extractSettingsJson(cmd)).toEqual({ statusLine: { type: 'command', command: EXPORTER_CMD } });
  });

  it('shell-escapes an exporter command containing single AND double quotes without breaking the flag', () => {
    // The real exporter (generateStatusLineCommand) embeds both — a naive
    // `'${value}'` wrap would be broken out of by the single quotes.
    const tricky = `echo '{}'; printf '{"a":1}' | curl -sk`;
    const cmd = buildSpawnCommand({ mode: 'claude', sessionId: 'sid-1', statusLineCommand: tricky });
    expect(extractSettingsJson(cmd)).toEqual({ statusLine: { type: 'command', command: tricky } });
  });

  it('round-trips the REAL exporter command unmodified (generateStatusLineCommand)', async () => {
    const { generateStatusLineCommand } = await import('../src/hooks-config.js');
    const real = generateStatusLineCommand();
    const cmd = buildSpawnCommand({ mode: 'claude', sessionId: 'sid-1', statusLineCommand: real });
    expect(extractSettingsJson(cmd)).toEqual({ statusLine: { type: 'command', command: real } });
  });

  it('never adds --settings for non-claude modes even if statusLineCommand is somehow set', () => {
    const cmd = buildSpawnCommand({ mode: 'omp', sessionId: 'sid-1', statusLineCommand: EXPORTER_CMD } as never);
    expect(cmd).not.toContain('--settings');
  });
});
