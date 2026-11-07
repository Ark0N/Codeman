import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import { isNativeModelSettingsInput } from '../src/native-model-settings.js';

type Config = ConstructorParameters<typeof Session>[0];
type Internals = {
  ptyProcess: { write(data: string): void; resize(cols: number, rows: number): void; kill(): void } | null;
  _isWorking: boolean;
  _isStopped: boolean;
  _guardedPaneRevision: number;
  _guardedPendingWrites: number;
  _submitVerifier?: { cancel(): void; arm(text: string): void };
};
const cleanups: Array<() => Promise<void>> = [];

function harness(extra: Partial<Config> = {}) {
  const written: string[] = [];
  const mux = {
    isAvailable: () => true,
    capturePaneTextAsync: vi.fn(async () => 'native settings screen'),
    sendInput: vi.fn(async (_id: string, input: string) => {
      written.push(input);
      return true;
    }),
    resizeWindow: vi.fn((_name: string, _cols: number, _rows: number, complete?: (ok: boolean) => void) => {
      complete?.(true);
      return true;
    }),
  };
  const session = new Session({
    workingDir: '/tmp',
    mode: 'codex',
    useMux: true,
    mux,
    muxSession: { muxName: 'codeman-model-settings-test', sessionId: 'native-test', createdAt: 1 },
    ...extra,
  } as unknown as Config);
  const access = session as unknown as Internals;
  access.ptyProcess = { write: (input) => written.push(input), resize: vi.fn(), kill: vi.fn() };
  cleanups.push(async () => {
    access.ptyProcess = null;
    await session.stop(false);
  });
  return { session, access, mux, written };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe('native model input contract', () => {
  it.each([
    '/model\r',
    '/model gpt-6.1-sol\r',
    '/model provider/model:v2\r',
    '/model --reasoning=high\r',
    '/status\r',
    '\x1b',
    '\x1b[A',
    '\x1b[B',
    '\x1b[C',
    '\x1b[D',
    's',
  ])('admits the narrow native settings input %j', (input) => {
    expect(isNativeModelSettingsInput(input)).toBe(true);
  });
  it.each([
    '\r',
    '\n',
    '/effort high\r',
    '/clear\r',
    '/new\r',
    '/model gpt-6.1-sol\rdo something\r',
    '/model foo;command\r',
    '/model ../file\r',
    '/model --reasoning=unknown\r',
    'please change models\r',
    '1',
    's\r',
    '\x03',
  ])('refuses general prompt, submission or lifecycle input %j', (input) => {
    expect(isNativeModelSettingsInput(input)).toBe(false);
  });
});

describe('Session native model settings lease', () => {
  it.each(['codex', 'claude'] as const)(
    'admits an idle %s native terminal without marking settings as model turns',
    async (mode) => {
      const h = harness({ mode, lastSubmitAt: 123, lastRealPromptAt: 111 });
      const activity = vi.fn();
      h.session.on('promptSubmitted', activity);
      let queued!: Promise<boolean>;
      await h.session.withNativeModelSettings(
        async (lease) => {
          for (const input of [
            '/model\r',
            '/model gpt-6.1-sol\r',
            '/model --reasoning=high\r',
            '/status\r',
            '\x1b[B',
            's',
          ])
            expect(await lease.write(input)).toBe(true);
          await lease.cancelMenu();
          expect(h.session.lastSubmitAt).toBe(123);
          expect(h.session.lastRealPromptAt).toBe(111);
          expect(activity).not.toHaveBeenCalled();
          queued = h.session.writeViaMux('a real human question\r', { fromUser: true });
          expect(h.session.lastSubmitAt).toBe(123);
          expect(h.session.lastRealPromptAt).toBe(111);
        },
        () => true
      );
      await expect(queued).resolves.toBe(true);
      expect(h.session.lastSubmitAt).toBeGreaterThan(123);
      expect(h.session.lastRealPromptAt).toBe(h.session.lastSubmitAt);
      expect(activity).toHaveBeenCalledTimes(1);
    }
  );

  it('holds keyboard, managed writes and named keys, dismisses the menu, then replays them in arrival order', async () => {
    const h = harness();
    const queued: Promise<unknown>[] = [];
    await h.session.withNativeModelSettings(
      async (lease) => {
        expect(h.session.guardedSubmitInFlight).toBe(true);
        expect(await lease.write('/model\r')).toBe(true);
        queued.push(h.session.writeViaMux('first\r', { fromUser: true }));
        expect(
          h.session.holdForGuardedLease(
            () => {
              h.session.write('raw');
            },
            3,
            'raw'
          )
        ).toBe('held');
        queued.push(
          h.session.performAuxiliaryInput(async () => {
            h.written.push('named-key');
          })
        );
        queued.push(h.session.writeViaMux('second\r', { fromUser: true }));
        expect(h.written).toEqual(['/model\r']);
        expect(lease.current()).toBe(false);
        expect(await lease.write('/status\r')).toBe(false);
        await lease.cancelMenu();
        expect(h.written).toEqual(['/model\r', '\x1b']);
      },
      () => true
    );
    const after = h.session.writeViaMux('after\r', { fromUser: true });
    await Promise.all([...queued, after]);
    expect(h.written).toEqual(['/model\r', '\x1b', 'first\r', 'raw', 'named-key', 'second\r', 'after\r']);
    expect(h.session.guardedInputHeld).toBe(false);
  });

  it('refuses a second settings lease without disturbing the existing one', async () => {
    const h = harness();
    const second = vi.fn(async () => undefined);
    await h.session.withNativeModelSettings(
      async (lease) => {
        await expect(h.session.withNativeModelSettings(second, () => true)).rejects.toThrow('must be idle');
        expect(second).not.toHaveBeenCalled();
        expect(lease.current()).toBe(true);
        expect(await lease.write('/model\r')).toBe(true);
      },
      () => true
    );
    expect(h.session.guardedInputHeld).toBe(false);
  });

  it.each([
    'busy',
    'dead',
    'closed',
    'stopped',
    'pending',
    'no-pane',
    'shell',
    'opencode',
    'docker',
    'denied',
  ] as const)('refuses admission for a %s session before running the settings operation', async (reason) => {
    const h = harness(
      reason === 'no-pane'
        ? { muxSession: undefined }
        : reason === 'shell' || reason === 'opencode'
          ? { mode: reason }
          : reason === 'docker'
            ? ({ docker: { hostId: 'test', label: 'test', containerName: 'test' } } as Partial<Config>)
            : {}
    );
    if (reason === 'busy') h.access._isWorking = true;
    if (reason === 'dead') h.session.setPaneExit({ status: 0, at: 1 });
    if (reason === 'closed') h.session.markClosing(true);
    if (reason === 'stopped') h.access._isStopped = true;
    if (reason === 'pending') h.access._guardedPendingWrites = 1;
    const operation = vi.fn(async () => true);
    await expect(h.session.withNativeModelSettings(operation, () => reason !== 'denied')).rejects.toThrow(
      'must be idle'
    );
    expect(operation).not.toHaveBeenCalled();
    expect(h.mux.sendInput).not.toHaveBeenCalled();
    expect(h.mux.capturePaneTextAsync).not.toHaveBeenCalled();
    h.access._guardedPendingWrites = 0;
  });

  it.each(['input', 'scope', 'owner', 'pane', 'exit', 'closing'] as const)(
    'cancels capture and native writes when %s changes during a lease',
    async (change) => {
      const h = harness();
      let allowed = true;
      const queued: Promise<unknown>[] = [];
      await h.session.withNativeModelSettings(
        async (lease) => {
          expect(await lease.capture()).toBe('native settings screen');
          if (change === 'input') queued.push(h.session.writeViaMux('human input'));
          if (change === 'scope') allowed = false;
          if (change === 'owner') h.session.owner = 'other-user';
          if (change === 'pane') h.access._guardedPaneRevision++;
          if (change === 'exit') h.session.setPaneExit({ status: 1, at: 1 });
          if (change === 'closing') h.session.markClosing(true);
          expect(lease.current()).toBe(false);
          expect(await lease.write('/model\r')).toBe(false);
          await expect(lease.capture()).rejects.toThrow('session or input changed');
          if (['owner', 'pane', 'exit', 'closing'].includes(change)) {
            await lease.cancelMenu();
            expect(h.written).toEqual([]);
          }
        },
        () => allowed
      );
      await Promise.all(queued);
      expect(h.session.guardedSubmitInFlight).toBe(false);
    }
  );

  it('invalidates a geometry-bound operation but permits cleanup Escape in the same pane after resize', async () => {
    const h = harness();
    await h.session.withNativeModelSettings(
      async (lease) => {
        expect(await lease.write('/model\r')).toBe(true);
        h.session.resize(151, 51);
        expect(lease.current()).toBe(false);
        expect(await lease.write('\x1b[B')).toBe(false);
        await lease.cancelMenu();
        expect(h.written).toEqual(['/model\r', '\x1b']);
      },
      () => true
    );
  });

  it('rejects a late capture after the pane owner changes while the read is in flight', async () => {
    const h = harness();
    h.mux.capturePaneTextAsync.mockImplementationOnce(async () => {
      h.session.owner = 'changed-during-read';
      return 'late native screen';
    });
    await expect(
      h.session.withNativeModelSettings(
        (lease) => lease.capture(),
        () => true
      )
    ).rejects.toThrow('could not be verified');
    expect(h.written).toEqual([]);
    expect(h.session.guardedInputHeld).toBe(false);
  });

  it('refuses empty or oversized native captures and releases the lease', async () => {
    for (const text of ['', 'x'.repeat(128 * 1024 + 1)]) {
      const h = harness();
      h.mux.capturePaneTextAsync.mockResolvedValueOnce(text);
      await expect(
        h.session.withNativeModelSettings(
          (lease) => lease.capture(),
          () => true
        )
      ).rejects.toThrow('could not be verified');
      expect(h.written).toEqual([]);
      expect(h.session.guardedInputHeld).toBe(false);
    }
  });

  it('never transports arbitrary prompts, bare Enter or /effort through the privileged lease', async () => {
    const h = harness();
    await h.session.withNativeModelSettings(
      async (lease) => {
        for (const input of ['\r', '/effort high\r', 'please do work\r', '/new\r', '1'])
          expect(await lease.write(input)).toBe(false);
        expect(lease.current()).toBe(true);
        expect(await lease.write('/status\r')).toBe(true);
      },
      () => true
    );
    expect(h.written).toEqual(['/status\r']);
  });

  it('releases and replays held input after a settings operation throws', async () => {
    const h = harness();
    let queued!: Promise<boolean>;
    await expect(
      h.session.withNativeModelSettings(
        async () => {
          queued = h.session.writeViaMux('held human input');
          throw new Error('native settings failed');
        },
        () => true
      )
    ).rejects.toThrow('native settings failed');
    await expect(queued).resolves.toBe(true);
    await expect(h.session.writeViaMux('next human input')).resolves.toBe(true);
    expect(h.written).toEqual(['held human input', 'next human input']);
    expect(h.session.guardedInputHeld).toBe(false);
  });

  it('releases after a native transport failure so the next settings request is not stuck', async () => {
    const h = harness();
    h.mux.sendInput.mockRejectedValueOnce(new Error('native mux failed'));
    await expect(
      h.session.withNativeModelSettings(
        (lease) => lease.write('/model\r'),
        () => true
      )
    ).rejects.toThrow('native mux failed');
    expect(h.session.guardedInputHeld).toBe(false);
    await expect(
      h.session.withNativeModelSettings(
        (lease) => lease.write('/status\r'),
        () => true
      )
    ).resolves.toBe(true);
    expect(h.written).toEqual(['/status\r']);
  });

  it('leaves no submit-verifier Enter retry armed by a native slash command', async () => {
    const h = harness();
    let armed = true;
    const cancel = vi.fn(() => {
      armed = false;
    });
    h.access._submitVerifier = {
      cancel,
      arm: () => {
        armed = true;
      },
    };
    Object.assign(h.mux, { capturePaneText: () => 'native composer' });
    await h.session.withNativeModelSettings(
      async (lease) => {
        expect(armed).toBe(false);
        expect(await lease.write('/status\r')).toBe(true);
        expect(armed).toBe(false);
      },
      () => true
    );
    expect(armed).toBe(false);
    expect(cancel).toHaveBeenCalled();
  });
});

describe('queued Discord follow-up lease', () => {
  const empty = '› \n\n  GPT-6.1-Sol · /tmp\n  ? for shortcuts';
  it('submits once through an empty composer and marks it as real user input', async () => {
    const h = harness();
    h.mux.capturePaneTextAsync.mockResolvedValue(empty);
    expect(await h.session.submitDiscordFollowup('Review the diff\r', () => true)).toBe('accepted');
    expect(h.written.join('')).toContain('Review the diff');
    expect(h.session.lastSubmitAt).toBeGreaterThan(0);
  });
  it.each([
    '› my unfinished draft\n\n  GPT-6.1-Sol · /tmp\n  ? for shortcuts',
    'Would you like to run this command?\n› 1. Yes\n2. No\nPress enter to confirm',
    '› \n  Working (esc to interrupt)\n  GPT-6.1-Sol · /tmp',
  ])('does not type into a draft, dialog or working frame', async (screen) => {
    const h = harness();
    h.mux.capturePaneTextAsync.mockResolvedValue(screen);
    expect(await h.session.submitDiscordFollowup('Review diff\r', () => true)).toBe('blocked');
    expect(h.written).toEqual([]);
  });
  it('rechecks permission after capture and never writes if scope changes', async () => {
    const h = harness();
    let allowed = true;
    h.mux.capturePaneTextAsync.mockImplementation(async () => {
      allowed = false;
      return empty;
    });
    expect(await h.session.submitDiscordFollowup('Review diff\r', () => allowed)).toBe('blocked');
    expect(h.written).toEqual([]);
  });
  it('refuses a queue prompt containing multiple submits or a lifecycle command', async () => {
    const h = harness();
    h.mux.capturePaneTextAsync.mockResolvedValue(empty);
    expect(await h.session.submitDiscordFollowup('first\rsecond\r', () => true)).toBe('blocked');
    expect(await h.session.submitDiscordFollowup('/clear\r', () => true)).toBe('blocked');
    expect(h.written).toEqual([]);
  });
});
it('refuses native controls on an adopted pane before capture or input', async () => {
  const h = harness();
  Object.defineProperty(h.session, 'isAdopted', { get: () => true });
  await expect(
    h.session.withNativeModelSettings(
      async (lease) => lease.write('/model\r'),
      () => true
    )
  ).rejects.toThrow('idle');
  expect(h.mux.capturePaneTextAsync).not.toHaveBeenCalled();
  expect(h.written).toEqual([]);
});
