/**
 * @fileoverview Tests for the GitHub Copilot CLI resolver wrapper.
 *
 * Copilot is a resolver with a version probe: `copilot` is a generic binary name, so a
 * resolved path is only accepted once `copilot --version` prints a
 * `GitHub Copilot CLI <semver>` string (e.g. `GitHub Copilot CLI 1.0.94.`). The probe EXECUTES the candidate, which is
 * exactly why it must never run under vitest — the hermeticity test below pins
 * that gate with a real executable fixture that would make the test fail
 * loudly if the gate were deleted again.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCopilotResolverForTest } from '../src/utils/copilot-cli-resolver.js';
import {
  cliResolveRetryDelayMs,
  createProductionCliResolverHost,
  type CliResolverHost,
} from '../src/utils/cli-executable-resolver.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createHost(
  options: {
    processPathResult?: string | null;
    loginShellResults?: Array<string | null>;
    existingPaths?: string[];
  } = {}
): CliResolverHost {
  const loginShellResults = [...(options.loginShellResults ?? [])];
  const existingPaths = new Set(options.existingPaths ?? []);
  return {
    processPath: '/service/bin',
    shellPath: '/bin/zsh',
    shellArgs: ['-l'],
    findOnProcessPath: () => options.processPathResult ?? null,
    findInLoginShell: () => loginShellResults.shift() ?? null,
    exists: (path) => existingPaths.has(path),
  };
}

describe('GitHub Copilot CLI resolver', () => {
  it('accepts a candidate the version probe verifies and carries the version as metadata', () => {
    const binaryPath = '/service/bin/copilot';
    const probe = vi.fn(() => '1.0.94');
    const resolver = createCopilotResolverForTest(
      createHost({ processPathResult: binaryPath, existingPaths: [binaryPath] }),
      probe
    );

    expect(resolver.resolve()).toMatchObject({
      binaryPath,
      directory: '/service/bin',
      source: 'process-path',
      metadata: '1.0.94',
    });
    expect(probe).toHaveBeenCalledWith(binaryPath);
  });

  it('rejects a candidate the probe refuses and falls through to a later one', () => {
    // An unrelated `copilot` on the service PATH (probe returns null) must not mask
    // the real coding agent found by the login shell.
    const impostor = '/service/bin/copilot';
    const genuine = '/login-shell/bin/copilot';
    const probe = vi.fn((binPath: string) => (binPath === genuine ? '1.0.94' : null));
    const resolver = createCopilotResolverForTest(
      createHost({
        processPathResult: impostor,
        loginShellResults: [genuine],
        existingPaths: [impostor, genuine],
      }),
      probe
    );

    expect(resolver.resolve()).toMatchObject({ binaryPath: genuine, source: 'login-shell', metadata: '1.0.94' });
  });

  it('negative-caches a miss and retries only after the backoff elapses', () => {
    const binaryPath = '/late/bin/copilot';
    let now = 0;
    const probe = vi.fn(() => '1.0.94');
    const resolver = createCopilotResolverForTest(
      createHost({ loginShellResults: [null, binaryPath], existingPaths: [binaryPath] }),
      probe,
      () => now
    );

    expect(resolver.resolve()).toBeNull();
    expect(resolver.resolve()).toBeNull(); // within the backoff: no re-run
    expect(probe).not.toHaveBeenCalled();
    now = cliResolveRetryDelayMs(1);
    expect(resolver.resolve()?.metadata).toBe('1.0.94');
    expect(resolver.resolve()?.binaryPath).toBe(binaryPath);
  });

  it('never executes a copilot candidate under vitest (the ambient probe is VITEST-gated)', () => {
    // A REAL executable fixture that prints a valid version. If the guard in
    // probeCopilotVersion is ever removed again, the probe runs this script, the
    // resolution SUCCEEDS, and this test fails — pinning hermeticity by
    // behavior rather than by source text. (The suites must never execute
    // whatever `copilot` binary the machine running them happens to carry.)
    const root = mkdtempSync(join(tmpdir(), 'codeman-copilot-vitest-gate-'));
    temporaryDirectories.push(root);
    const binaryPath = join(root, 'copilot');
    writeFileSync(binaryPath, '#!/bin/sh\necho GitHub Copilot CLI 0.99.0.\n');
    chmodSync(binaryPath, 0o755);
    const hostOptions = {
      processPath: root,
      shellPath: '/bin/bash',
      shellArgs: ['-i', '-l'] as string[],
      runCommand: () => '',
      isExecutableFile: (path: string) => path === binaryPath,
    };

    // Default (ambient) probe: the candidate is found but never executed, so
    // the VITEST gate reports it unusable and resolution misses.
    const gated = createCopilotResolverForTest(createProductionCliResolverHost(hostOptions));
    expect(gated.resolve()).toBeNull();

    // Control: identical setup with an injected probe resolves, proving the
    // null above comes from the gate, not from the fixture or the host.
    const control = createCopilotResolverForTest(createProductionCliResolverHost(hostOptions), () => '0.99.0');
    expect(control.resolve()).toMatchObject({ binaryPath, metadata: '0.99.0' });
  });
});
