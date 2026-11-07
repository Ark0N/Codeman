/**
 * @fileoverview `guardSessionConfigDirHome` probes a session-supplied configDir home before
 * the apply runs synchronous fs calls on it (the #516 rule): a home that does not answer is
 * hidden from the apply, so it links from the server's own home instead and says so.
 *
 * The probe is mocked: a mount that never answers is the case under test, and a real one
 * cannot be made here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/utils/bounded-path-probe.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/bounded-path-probe.js')>();
  return { ...actual, probePathKind: vi.fn() };
});

import { getCli } from '../src/config/cli-registry/registry.js';
import { getDataDir } from '../src/config/instance.js';
import { writeCustomModelHosts } from '../src/custom-model-hosts.js';
import { customModelConfigDir, removeConfigDir } from '../src/custom-model-injection-apply.js';
import { Session } from '../src/session.js';
import { probePathKind } from '../src/utils/bounded-path-probe.js';
import { guardSessionConfigDirHome } from '../src/web/routes/session-routes.js';
import { WebServer } from '../src/web/server.js';
import type { CustomModelBookkeeping } from '../src/types/session.js';

const probe = vi.mocked(probePathKind);
const deepseek = () => getCli('deepseek')!;
const env =
  (values: Record<string, string>) =>
  (name: string): string | undefined =>
    values[name];

describe('guardSessionConfigDirHome', () => {
  afterEach(() => {
    probe.mockReset();
    vi.restoreAllMocks();
  });

  it('hides only the home when it does not answer, and warns that the server home is used', async () => {
    probe.mockResolvedValue('unknown');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const lookup = await guardSessionConfigDirHome(deepseek(), env({ DSH_HOME: '/mnt/dead/dsh', OTHER: 'kept' }));

    expect(lookup('DSH_HOME')).toBeUndefined();
    expect(lookup('OTHER')).toBe('kept');
    expect(probe).toHaveBeenCalledWith('/mnt/dead/dsh', { pastCap: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('/mnt/dead/dsh');
  });

  it('passes a home that answers straight through', async () => {
    probe.mockResolvedValue('directory');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const base = env({ DSH_HOME: '/home/u/.dsh' });

    expect(await guardSessionConfigDirHome(deepseek(), base)).toBe(base);
    expect(warn).not.toHaveBeenCalled();
  });

  it("guards claude's own config dir too: the apply makes its projects folder", async () => {
    probe.mockResolvedValue('unknown');
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const lookup = await guardSessionConfigDirHome(getCli('claude')!, env({ CLAUDE_CONFIG_DIR: '/mnt/dead/claude' }));

    expect(lookup('CLAUDE_CONFIG_DIR')).toBeUndefined();
    expect(probe).toHaveBeenCalledWith('/mnt/dead/claude', { pastCap: true });
  });

  it('boot recovery probes the own home under the stall cap: it is a bulk pass, not one request', async () => {
    probe.mockResolvedValue('unknown');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await writeCustomModelHosts(getDataDir(), [{ id: 'ep', label: 'Ep', baseUrl: 'http://box:8080' }]);
    const session = new Session({ workingDir: '/tmp', mode: 'deepseek' });
    const saved: CustomModelBookkeeping = { endpointId: 'ep', modelId: 'q', envKeys: [] };
    const proto = WebServer.prototype as unknown as {
      _rebuildCustomModelEnv: (session: Session, saved: CustomModelBookkeeping, ownEnv: object) => Promise<unknown>;
    };

    await proto._rebuildCustomModelEnv(session, saved, { DSH_HOME: '/mnt/dead/dsh' });

    expect(probe).toHaveBeenCalledWith('/mnt/dead/dsh', {});
    removeConfigDir(customModelConfigDir(session.id));
  });

  it('never probes a relative home: the apply refuses to join one', async () => {
    const base = env({ DSH_HOME: 'relative/dsh' });

    expect(await guardSessionConfigDirHome(deepseek(), base)).toBe(base);
    expect(probe).not.toHaveBeenCalled();
  });

  it('never probes for a CLI with no linkFromRealHome recipe', async () => {
    const base = env({ CODEX_HOME: '/mnt/dead/codex' });

    expect(await guardSessionConfigDirHome(getCli('codex')!, base)).toBe(base);
    expect(probe).not.toHaveBeenCalled();
  });
});
