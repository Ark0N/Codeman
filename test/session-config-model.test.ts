/**
 * The config source of a session's `displayModel`: the model its CLI's own config pins
 * (`capabilities.modelDetect.configResolver`), read at each pane start, attach or
 * relaunch, ranked below any report from the running CLI.
 *
 * The reader is mocked here so the session's own rules are what is tested: when it
 * reads, with what, and which answer wins. The reader itself (dsh-TUI's route) is
 * `test/deepseek-route-config.test.ts`; one end-to-end read over a fixture dsh home
 * is in `test/session-display-model.test.ts`.
 *
 * Port: N/A.
 */
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

const resolveConfigModel = vi.fn();
vi.mock('../src/model-config-resolvers.js', () => ({
  resolveConfigModel: (...a: unknown[]) => resolveConfigModel(...a),
}));

const { Session } = await import('../src/session.js');

type Internals = {
  _withPaneLifecycle<T>(op: () => Promise<T>): Promise<T>;
  _isStopped: boolean;
};

/** A deferred answer, so a test decides when (and in which order) reads land. */
function deferred() {
  let resolve!: (v: string | null) => void;
  const promise = new Promise<string | null>((r) => (resolve = r));
  return { promise, resolve };
}

function session(extra: Record<string, unknown> = {}, mode = 'deepseek') {
  return new Session({ workingDir: '/tmp', mode, ...extra } as ConstructorParameters<typeof Session>[0]);
}
/** One pane start: what triggers the read. */
const start = (s: InstanceType<typeof Session>) => (s as unknown as Internals)._withPaneLifecycle(async () => {});
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  resolveConfigModel.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("a session's config model", () => {
  it("is read at each pane start, with the session's own config and env", async () => {
    resolveConfigModel.mockResolvedValue('qwen3.8-27b');
    // The server has a dsh home of its own; the session's override is the one its CLI gets.
    const before = process.env.DSH_HOME;
    process.env.DSH_HOME = '/srv/server-dsh';
    onTestFinished(() => {
      if (before === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = before;
    });
    const s = session({ deepSeekConfig: { profile: 'dsh-tui' }, envOverrides: { DSH_HOME: '/srv/dsh-copy' } });
    const changed = vi.fn();
    s.on('displayModelChanged', changed);
    expect(resolveConfigModel).not.toHaveBeenCalled();
    await start(s);
    await flush();
    expect(resolveConfigModel).toHaveBeenCalledTimes(1);
    const [name, ctx] = resolveConfigModel.mock.calls[0];
    expect(name).toBe('deepseek-route');
    expect(ctx.config).toEqual({ profile: 'dsh-tui' });
    expect(ctx.env('DSH_HOME')).toBe('/srv/dsh-copy');
    expect(s.toState().displayModel).toEqual({ model: 'qwen3.8-27b', source: 'config' });
    expect(changed).toHaveBeenCalledTimes(1);
    // A relaunch reads again; the same answer announces nothing new.
    await start(s);
    await flush();
    expect(resolveConfigModel).toHaveBeenCalledTimes(2);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('without a session DSH_HOME the server one is what the CLI inherits', async () => {
    resolveConfigModel.mockResolvedValue(null);
    const before = process.env.DSH_HOME;
    process.env.DSH_HOME = '/srv/server-dsh';
    try {
      const s = session();
      await start(s);
      expect(resolveConfigModel.mock.calls[0][1].env('DSH_HOME')).toBe('/srv/server-dsh');
    } finally {
      if (before === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = before;
    }
  });

  it('the screen wins over the config whenever it names a model, in either order', async () => {
    resolveConfigModel.mockResolvedValue('qwen3.8-27b');
    const s = session();
    await start(s);
    await flush();
    s.noteReportedModel('screen', 'deepseek-v4-flash');
    expect(s.toState().displayModel).toEqual({ model: 'deepseek-v4-flash', source: 'screen' });
    await start(s);
    await flush();
    expect(s.toState().displayModel).toEqual({ model: 'deepseek-v4-flash', source: 'screen' });
  });

  it('a screen value restored after a restart outranks a fresh config read', async () => {
    resolveConfigModel.mockResolvedValue('qwen3.8-27b');
    const s = session({ displayModel: { model: 'deepseek-v4-flash', source: 'screen' } });
    await start(s);
    await flush();
    expect(s.toState().displayModel).toEqual({ model: 'deepseek-v4-flash', source: 'screen' });
  });

  it('the config outranks the launch model, and a config that pins nothing leaves it', async () => {
    resolveConfigModel.mockResolvedValue('qwen-from-config');
    const codex = session({ codexConfig: { model: 'gpt-5.5' } }, 'codex');
    await start(codex);
    await flush();
    // codex declares no config reader: nothing is read, the launch model stays.
    expect(resolveConfigModel).not.toHaveBeenCalled();
    expect(codex.toState().displayModel).toEqual({ model: 'gpt-5.5', source: 'launch' });
    resolveConfigModel.mockResolvedValue(null);
    const s = session();
    await start(s);
    await flush();
    expect(s.toState().displayModel).toBeUndefined();
  });

  it('a read that lands after a newer one is dropped, and so is one after the session stopped', async () => {
    const first = deferred();
    const second = deferred();
    resolveConfigModel.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const s = session();
    await start(s);
    await start(s);
    second.resolve('newer');
    await flush();
    first.resolve('older');
    await flush();
    expect(s.toState().displayModel?.model).toBe('newer');

    const late = deferred();
    resolveConfigModel.mockReturnValueOnce(late.promise);
    const stopped = session();
    await start(stopped);
    (stopped as unknown as Internals)._isStopped = true;
    late.resolve('too late');
    await flush();
    expect(stopped.toState().displayModel).toBeUndefined();
  });

  it('a remote or docker session reads nothing locally', async () => {
    resolveConfigModel.mockResolvedValue('qwen3.8-27b');
    await start(session({ remote: { hostId: 'h', label: 'h', host: 'h', username: 'u', remotePath: '/w' } }));
    await start(
      session({
        docker: {
          hostId: 'd',
          label: 'd',
          engine: 'docker',
          image: 'i',
          containerName: 'c',
          hostWorkspacePath: '/w',
          containerWorkdir: '/w',
        },
      })
    );
    await flush();
    expect(resolveConfigModel).not.toHaveBeenCalled();
  });

  it('a config model is untrusted text: control characters dropped, length capped', async () => {
    resolveConfigModel.mockResolvedValue(`\x1b[31mqwen\x1b[0m${'x'.repeat(200)}`);
    const s = session();
    await start(s);
    await flush();
    const dm = s.toState().displayModel!;
    expect(dm.source).toBe('config');
    expect(dm.model.startsWith('qwenx')).toBe(true);
    expect(dm.model.length).toBe(64);
  });
});
