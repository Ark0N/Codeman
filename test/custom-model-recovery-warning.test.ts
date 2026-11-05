/**
 * @fileoverview The boot-recovery refusal warning in `_rebuildCustomModelEnv()`
 * (web/server.ts) must name the real reason. An `undefined` from
 * `applyCustomModelInjection()` covers BOTH a CLI whose recipe is `unsupported`
 * (antigravity, or a `clis.json` override of any CLI) and an Anthropic-type
 * endpoint the CLI cannot speak, and the shared `customModelApplyErrorMessage`
 * picks the sentence from `endpoint.endpointType`, so only the second warning
 * may say "Anthropic-type". The swap route and quick-start paths pin their copy
 * of the same wording in `test/routes/session-custom-model.test.ts` and
 * `test/routes/quick-start-custom-model.test.ts`; this pins the recovery copy.
 * Port: not started (`new WebServer(0, …)` is constructed but never `start()`ed;
 * the method under test touches neither the socket nor tmux).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { WebServer } from '../src/web/server.js';
import { getDataDir } from '../src/config/instance.js';
import { writeCustomModelHosts, type CustomModelHost } from '../src/custom-model-hosts.js';
import type { AppliedCustomModel } from '../src/custom-model-injection-apply.js';
import type { Session } from '../src/session.js';
import type { CustomModelBookkeeping } from '../src/types/session.js';

const OPENAI_ENDPOINT: CustomModelHost = {
  id: 'ep-open',
  label: 'llama.cpp box',
  baseUrl: 'http://192.168.1.50:8080',
  apiKey: 'k',
};

const ANTHROPIC_ENDPOINT: CustomModelHost = {
  id: 'ep-anth',
  label: 'bifrost',
  baseUrl: 'http://192.168.1.50:8080',
  apiKey: 'k',
  endpointType: 'anthropic',
};

describe('_rebuildCustomModelEnv refusal warning', () => {
  let server: WebServer;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    server = new WebServer(0, false, true);
  });

  afterAll(async () => {
    // Same discipline as every other test that constructs a WebServer: even one that
    // was never start()ed gets stopped, so no half-initialised watchers outlive the file.
    await server.stop();
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    await writeCustomModelHosts(getDataDir(), [OPENAI_ENDPOINT, ANTHROPIC_ENDPOINT]);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  async function rebuild(mode: Session['mode'], endpointId: string): Promise<AppliedCustomModel | undefined> {
    const session = { id: 'recovery-1', mode } as unknown as Session;
    const saved: CustomModelBookkeeping = { endpointId, modelId: 'some-model', envKeys: [] };
    return (
      server as unknown as {
        _rebuildCustomModelEnv(session: Session, saved: CustomModelBookkeeping): Promise<
          AppliedCustomModel | undefined
        >;
      }
    )._rebuildCustomModelEnv(session, saved);
  }

  it('warns without "Anthropic-type" when the CLI recipe is unsupported and the endpoint is OpenAI-type', async () => {
    // antigravity is stock `{ kind: 'unsupported' }` — the same undefined an override
    // produces for any CLI, and the case the old hardcoded wording lied about.
    const env = await rebuild('antigravity', 'ep-open');

    expect(env).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain('antigravity has no known custom-model mechanism');
    expect(message).not.toContain('Anthropic-type');
    expect(message).toContain('selection kept for clearing');
  });

  it('warns with the Anthropic-type sentence when an Anthropic-type endpoint meets a CLI that cannot speak it', async () => {
    const env = await rebuild('codex', 'ep-anth');

    expect(env).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain('codex cannot use an Anthropic-type endpoint; pick an OpenAI-type endpoint for it');
    expect(message).toContain('selection kept for clearing');
  });
});
