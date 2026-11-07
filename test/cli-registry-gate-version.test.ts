/**
 * @fileoverview A launch gate is measured against its OWN CLI's version.
 *
 * `capabilities.gates` used to be resolved with `getClaudeCliVersion()` for every entry,
 * because claude was the only CLI with a gate. Codex's `noDaemonFlag` (0.162.0) would then
 * have passed on any claude 2.x and handed an older codex `--no-daemon`, which makes codex
 * exit on launch. The bridge now asks `resolveSessionCliVersion(entry.id)`; this pins that
 * with both resolvers mocked to DIFFERENT versions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const versions: Record<string, string | null> = {};

vi.mock('../src/utils/cli-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/cli-resolver.js')>();
  return { ...actual, resolveSessionCliVersion: vi.fn((mode: string) => versions[mode] ?? null) };
});
vi.mock('../src/utils/claude-cli-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/claude-cli-resolver.js')>();
  return { ...actual, getClaudeCliVersion: vi.fn(() => '2.1.316') };
});

const { getCli } = await import('../src/config/cli-registry/registry.js');
const { buildSpawnCommandFromRegistry, launchGatePasses } = await import('../src/session-cli-registry-bridge.js');

const SID = '00000000-0000-4000-8000-000000000000';

function codexCommand(): string | undefined {
  return buildSpawnCommandFromRegistry(getCli('codex')!, { mode: 'codex', sessionId: SID });
}

describe('launch gates read the gated CLI version', () => {
  beforeEach(() => {
    for (const key of Object.keys(versions)) delete versions[key];
  });

  it("does not pass codex's gate on claude's version", () => {
    versions.claude = '2.1.316';
    versions.codex = '0.161.0';
    expect(codexCommand()).toBe('codex');
    expect(launchGatePasses('codex', 'noDaemonFlag')).toBe(false);
  });

  it("passes codex's gate on codex's own version", () => {
    versions.codex = '0.162.0';
    expect(codexCommand()).toBe('codex --no-daemon');
    expect(launchGatePasses('codex', 'noDaemonFlag')).toBe(true);
  });

  it('fails closed when the codex version is unknown', () => {
    versions.claude = '2.1.316';
    expect(codexCommand()).toBe('codex');
  });

  it("still measures claude's gates on claude's version", () => {
    versions.claude = '2.1.316';
    versions.codex = '0.1.0';
    expect(launchGatePasses('claude', 'nameFlag')).toBe(true);
  });
});
