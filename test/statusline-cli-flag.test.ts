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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildSpawnCommand, TmuxManager } from '../src/tmux-manager.js';
import { SETTINGS_PATH } from '../src/web/route-helpers.js';

const EXPORTER_CMD = 'curl -sfk -X POST "$CODEMAN_API_URL/api/status-telemetry" --data @- 2>/dev/null || true';

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

  it('round-trips the REAL exporter script path unmodified (ensureStatusLineExporterScript)', async () => {
    // What resolveStatusLineCliCommand actually hands to buildSpawnCommand at spawn
    // time today is a bare script PATH (see that function's doc comment for why —
    // never the raw curl command generateStatusLineCommand() builds, which only
    // backs the legacy disk-write applyStatusLineConfig path now).
    const { ensureStatusLineExporterScript } = await import('../src/hooks-config.js');
    const real = await ensureStatusLineExporterScript();
    const cmd = buildSpawnCommand({ mode: 'claude', sessionId: 'sid-1', statusLineCommand: real });
    expect(extractSettingsJson(cmd)).toEqual({ statusLine: { type: 'command', command: real } });
  });

  it('never adds --settings for non-claude modes even if statusLineCommand is somehow set', () => {
    const cmd = buildSpawnCommand({ mode: 'omp', sessionId: 'sid-1', statusLineCommand: EXPORTER_CMD } as never);
    expect(cmd).not.toContain('--settings');
  });
});

// Why a launch does or does not carry the exporter. Recorded on the mux record and
// published as `statusLineTelemetry`, so the Status row and keep-warm can say why no
// cache report will come instead of "not reported yet" forever.
describe('TmuxManager statusLine classification', () => {
  type Resolve = (
    mode: string,
    workingDir: string,
    remoteOrDocker: boolean
  ) => Promise<{ command?: string; state?: string }>;
  let workingDir: string;
  let resolve: Resolve;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'statusline-state-'));
    const mux = new TmuxManager() as unknown as { _resolveStatusLine: Resolve };
    resolve = mux._resolveStatusLine.bind(mux);
    mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  });
  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
    rmSync(SETTINGS_PATH, { force: true });
  });

  it('injected when plan-usage collection is on (an absent key reads as on)', async () => {
    const r = await resolve('claude', workingDir, false);
    expect(r.state).toBe('injected');
    expect(r.command).toBeTruthy();
  });

  it('collection-off when the setting is explicitly false', async () => {
    writeFileSync(SETTINGS_PATH, JSON.stringify({ showPlanUsageLimits: false }));
    expect(await resolve('claude', workingDir, false)).toEqual({ command: undefined, state: 'collection-off' });
  });

  it("workspace-statusline when the workspace's settings.local.json sets its own", async () => {
    mkdirSync(join(workingDir, '.claude'));
    writeFileSync(
      join(workingDir, '.claude', 'settings.local.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'echo mine' } })
    );
    expect(await resolve('claude', workingDir, false)).toEqual({ command: undefined, state: 'workspace-statusline' });
  });

  it('remote for remote and docker launches, nothing at all for a CLI without the capability', async () => {
    expect(await resolve('claude', workingDir, true)).toEqual({ state: 'remote' });
    expect(await resolve('codex', workingDir, false)).toEqual({});
  });
});
