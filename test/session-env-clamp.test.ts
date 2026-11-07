/**
 * @fileoverview The env clamp's key list, read from the registry. A key stays clamped while
 * its CLI is disabled: a session can outlive the switch (the reboot-restore route and the
 * custom-model recovery both clamp for one that already exists), and neither the clear
 * branch of the custom-model route nor `restartCli()` checks `enabled`.
 *
 * Port: N/A (the on-disk `clis.json` uses the per-file temp HOME from test/setup.ts).
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reloadCliRegistry, registryFilePath } from '../src/config/cli-registry/registry.js';
import { clampEnvOverridesForOwner } from '../src/session-env-clamp.js';

describe('clampEnvOverridesForOwner: a disabled CLI', () => {
  const ORIGINAL = process.env.CODEMAN_MULTIUSER;

  beforeEach(() => {
    process.env.CODEMAN_MULTIUSER = '1';
    mkdirSync(dirname(registryFilePath()), { recursive: true });
    writeFileSync(registryFilePath(), JSON.stringify({ clis: { deepseek: { enabled: false } } }), { mode: 0o600 });
    reloadCliRegistry();
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.CODEMAN_MULTIUSER;
    else process.env.CODEMAN_MULTIUSER = ORIGINAL;
    rmSync(registryFilePath(), { force: true });
    reloadCliRegistry();
  });

  it('still strips its privileged keys for a non-granted owner', async () => {
    expect(await clampEnvOverridesForOwner('nobody', { DSH_HOME: '/own' })).toEqual({});
  });
});
