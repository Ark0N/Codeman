/**
 * @fileoverview Boot recovery re-derives a saved custom-model selection through
 * `_rebuildCustomModelEnv`, and the `linkFromRealHome` recipe must resolve the CLI's
 * real home from the SESSION's own env overrides first: the user who relocated dsh
 * (allowlisted `DSH_HOME`) runs their CLI against THAT home, and recovery must link the
 * regenerated config dir back to it, not to whatever the server's environment says.
 *
 * `_rebuildCustomModelEnv` reads no `this` state (it re-derives everything from the endpoint
 * store and the Session it is handed), so it is driven straight off the prototype with an
 * empty receiver — `restoreMuxSessions()` itself cannot be reached under vitest, the same
 * constraint recorded in test/session-model-recovery.test.ts.
 */
import { mkdirSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDataDir } from '../src/config/instance.js';
import { writeCustomModelHosts, type CustomModelHost } from '../src/custom-model-hosts.js';
import { customModelConfigDir, removeConfigDir } from '../src/custom-model-injection-apply.js';
import { Session } from '../src/session.js';
import { WebServer } from '../src/web/server.js';
import type { CustomModelBookkeeping } from '../src/types/session.js';

type RebuildFn = (session: Session, saved: CustomModelBookkeeping) => Promise<Record<string, string> | undefined>;

/** The real method, with an empty receiver — see the file header for why that is sound. */
function rebuildCustomModelEnv(session: Session, saved: CustomModelBookkeeping) {
  const fn = (WebServer.prototype as unknown as { _rebuildCustomModelEnv: RebuildFn })._rebuildCustomModelEnv;
  expect(typeof fn, '_rebuildCustomModelEnv vanished from WebServer.prototype').toBe('function');
  return fn.call({}, session, saved);
}

function endpoint(): CustomModelHost {
  return {
    id: 'ep',
    label: 'Ep',
    baseUrl: 'http://localhost:8080',
    apiKey: 'recovery-probe-key',
    models: ['qwen3'],
  };
}

describe('_rebuildCustomModelEnv: real-home resolution for linkFromRealHome', () => {
  const configs: string[] = [];

  afterEach(() => {
    for (const id of configs.splice(0)) removeConfigDir(customModelConfigDir(id));
    vi.unstubAllEnvs();
  });

  it('links an isolated deepseek home from the SESSION’s own DSH_HOME, not the server’s', async () => {
    // The user who relocated dsh runs their CLI against THAT home; recovery must re-link
    // the session's generated config dir back to it even though the value never persists
    // into the server's environment. The server's DSH_HOME is emptied deliberately: with
    // the session lookup working, the fallback home is never consulted, and with it
    // broken this test gets a link into ~/.dsh rather than a pass.
    const sessionHome = join(homedir(), 'codeman-recovery-dsh-home');
    mkdirSync(join(sessionHome, 'profiles'), { recursive: true });
    vi.stubEnv('DSH_HOME', '');
    await writeCustomModelHosts(getDataDir(), [endpoint()]);
    const session = new Session({ workingDir: '/tmp', mode: 'deepseek', envOverrides: { DSH_HOME: sessionHome } });
    configs.push(session.id);

    const env = await rebuildCustomModelEnv(session, { endpointId: 'ep', modelId: 'qwen3', envKeys: [] });

    expect(env?.DSH_HOME).toBe(customModelConfigDir(session.id));
    expect(realpathSync(join(env!.DSH_HOME, 'profiles'))).toBe(join(sessionHome, 'profiles'));
    rmSync(sessionHome, { recursive: true, force: true });
  });
});
