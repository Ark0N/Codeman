/** @fileoverview Guarded input observes all production write and lifecycle primitives. */
import { expect, it, vi } from 'vitest';
import { formatPaneSnapshot } from '../src/tmux-manager.js';
import { Session } from '../src/session.js';
import { promptSha256 } from '../src/agent-staging.js';
it('fences writes and reused-pid pane lifecycles without persisting prompt content', async () => {
  let screen = '› \n  GPT-6-Luna default · ~/case\n';
  const mux = {
    isAvailable: () => true,
    capturePaneBuffer: (
      _name: string,
      _pane?: string,
      opts?: { capturedGeometry?: { cols: number; rows: number } }
    ) => {
      if (opts) opts.capturedGeometry = { cols: 100, rows: 20 };
      return formatPaneSnapshot(screen.trimEnd().split('\n'), {
        cols: 100,
        rows: 20,
        cursorX: screen.startsWith('› hello') ? 7 : 2,
        cursorY: 0,
      });
    },
    sendInput: async () => true,
  };
  const session = new Session({
    workingDir: '/tmp',
    mode: 'codex',
    mux,
    muxSession: { muxName: 'codeman-test', sessionId: 'test', createdAt: 1, pid: 12345 },
  } as unknown as ConstructorParameters<typeof Session>[0]);
  const before = session.guardedInputSnapshot();
  expect(before?.composerSha).toBe(promptSha256(''));
  await session.writeViaMux('hello');
  screen = '› hello\n  GPT-6-Luna default · ~/case\n';
  expect(session.guardedInputSnapshot()?.revision).toBe(before!.revision + 1);
  session.trackUserInput('x');
  expect(session.guardedInputSnapshot()?.revision).toBe(before!.revision + 2);
  await session.performAuxiliaryInput(async () => {});
  expect(session.guardedInputSnapshot()?.revision).toBe(before!.revision + 3);
  const generation = session.inspectionGeneration;
  await (session as unknown as { _withPaneLifecycle(op: () => Promise<void>): Promise<void> })._withPaneLifecycle(
    async () => {
      expect(session.guardedInputSnapshot()).toBeNull();
    }
  );
  expect(session.inspectionGeneration).not.toBe(generation);
  session.markPromptSubmitted();
  expect(session.guardedInputSnapshot()?.revision).toBe(before!.revision + 4);
  await session.stop(false);
  expect(session.guardedInputSnapshot()).toBeNull();
});

it('checks conditional Enter at the dispatch boundary and rejects concurrent browser input', async () => {
  let dispatch: (() => void) | undefined;
  const writes: string[] = [];
  const mux = {
    isAvailable: () => true,
    capturePaneBuffer: (
      _name: string,
      _pane?: string,
      opts?: { capturedGeometry?: { cols: number; rows: number } }
    ) => {
      if (opts) opts.capturedGeometry = { cols: 100, rows: 20 };
      return formatPaneSnapshot(['› hello', '  GPT-6-Luna default · ~/case'], {
        cols: 100,
        rows: 20,
        cursorX: 7,
        cursorY: 0,
      });
    },
    sendInput: async (_id: string, text: string, options?: { beforeDispatch?: () => boolean }) => {
      await new Promise<void>((resolve) => {
        dispatch = resolve;
      });
      if (options?.beforeDispatch && !options.beforeDispatch()) return false;
      writes.push(text);
      return true;
    },
  };
  const session = new Session({
    workingDir: '/tmp',
    mode: 'codex',
    mux,
    muxSession: { muxName: 'codeman-test', sessionId: 'test', createdAt: 1, pid: 1 },
  } as unknown as ConstructorParameters<typeof Session>[0]);
  try {
    const expected = session.guardedInputSnapshot()!;
    const sending = session.submitGuardedInput(expected);
    expect(await session.writeViaMux('other')).toBe(false);
    dispatch!();
    expect(await sending).toBe(false);
    expect(writes).toEqual([]);
    const next = session.submitGuardedInput(session.guardedInputSnapshot()!);
    dispatch!();
    expect(await next).toBe(true);
    expect(writes).toEqual(['\r']);
    const restarting = session.submitGuardedInput(session.guardedInputSnapshot()!);
    await (session as unknown as { _withPaneLifecycle(op: () => Promise<void>): Promise<void> })._withPaneLifecycle(
      async () => {}
    );
    dispatch!();
    expect(await restarting).toBe(false);
    expect(writes).toEqual(['\r']);
    const auxiliary = session.submitGuardedInput(session.guardedInputSnapshot()!);
    await expect(
      session.performAuxiliaryInput(async () => {
        throw new Error('must not execute');
      })
    ).rejects.toThrow('Guarded submission');
    dispatch!();
    expect(await auxiliary).toBe(false);
    expect(writes).toEqual(['\r']);
  } finally {
    await session.stop(false);
  }
});

it('cancels an older automatic submit verifier before staging an identical prompt', async () => {
  vi.useFakeTimers();
  let composer = '';
  const writes: string[] = [];
  const mux = {
    isAvailable: () => true,
    capturePaneBuffer: (
      _name: string,
      _pane?: string,
      opts?: { capturedGeometry?: { cols: number; rows: number } }
    ) => {
      if (opts) opts.capturedGeometry = { cols: 100, rows: 20 };
      return formatPaneSnapshot([`› ${composer}`, '  GPT-6-Luna default · ~/case'], {
        cols: 100,
        rows: 20,
        cursorX: 2 + composer.length,
        cursorY: 0,
      });
    },
    capturePaneText: () => `› ${composer}\n  GPT-6-Luna default · ~/case`,
    sendInput: async (_id: string, text: string) => {
      writes.push(text);
      composer += text;
      return true;
    },
  };
  const session = new Session({
    workingDir: '/tmp',
    mode: 'codex',
    mux,
    muxSession: { muxName: 'codeman-test', sessionId: 'test', createdAt: 1, pid: 1 },
  } as unknown as ConstructorParameters<typeof Session>[0]);
  try {
    session.verifySubmitted('hello');
    expect(await session.stageGuardedInput('hello')).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(writes).toEqual(['hello']);
  } finally {
    await session.stop(false);
    vi.useRealTimers();
  }
});

it('routes automatic verifier Enter through the shared guarded input boundary', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const writes: string[] = [];
  const mux = {
    isAvailable: () => true,
    capturePaneBuffer: (
      _name: string,
      _pane?: string,
      opts?: { capturedGeometry?: { cols: number; rows: number } }
    ) => {
      if (opts) opts.capturedGeometry = { cols: 100, rows: 20 };
      return formatPaneSnapshot(['› hello', '  GPT-6-Luna default · ~/case'], {
        cols: 100,
        rows: 20,
        cursorX: 7,
        cursorY: 0,
      });
    },
    capturePaneText: () => '› hello\n  GPT-6-Luna default · ~/case',
    sendInput: async (_id: string, text: string, options?: { beforeDispatch?: () => boolean }) => {
      if (options?.beforeDispatch) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        if (!options.beforeDispatch()) return false;
      }
      writes.push(text);
      return true;
    },
  };
  const session = new Session({
    workingDir: '/tmp',
    mode: 'codex',
    mux,
    muxSession: { muxName: 'codeman-test', sessionId: 'test', createdAt: 1, pid: 1 },
  } as unknown as ConstructorParameters<typeof Session>[0]);
  try {
    session.verifySubmitted('hello');
    const submission = session.submitGuardedInput(session.guardedInputSnapshot()!);
    await vi.advanceTimersByTimeAsync(2000);
    release();
    expect(await submission).toBe(false);
    await vi.advanceTimersByTimeAsync(60000);
    expect(writes).toEqual([]);
  } finally {
    await session.stop(false);
    vi.useRealTimers();
  }
});

it('refuses legacy one-shot prompt entrypoints during a guarded submission before spawning', async () => {
  let release!: () => void;
  const writes: string[] = [];
  const mux = {
    isAvailable: () => true,
    capturePaneBuffer: (
      _name: string,
      _pane?: string,
      opts?: { capturedGeometry?: { cols: number; rows: number } }
    ) => {
      if (opts) opts.capturedGeometry = { cols: 100, rows: 20 };
      return formatPaneSnapshot(['› hello', '  GPT-6-Luna default · ~/case'], {
        cols: 100,
        rows: 20,
        cursorX: 7,
        cursorY: 0,
      });
    },
    sendInput: async (_id: string, text: string, options?: { beforeDispatch?: () => boolean }) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      if (options?.beforeDispatch && !options.beforeDispatch()) return false;
      writes.push(text);
      return true;
    },
  };
  const session = new Session({
    workingDir: '/tmp',
    mode: 'codex',
    mux,
    muxSession: { muxName: 'codeman-test', sessionId: 'test', createdAt: 1, pid: 1 },
  } as unknown as ConstructorParameters<typeof Session>[0]);
  const access = session as unknown as { ptyProcess: { write(data: string): void } | null };
  try {
    const submission = session.submitGuardedInput(session.guardedInputSnapshot()!);
    // This also prevents a real spawn if the lease guard regresses.
    access.ptyProcess = {
      write: () => {
        throw new Error('must not write');
      },
    };
    await expect(session.runPrompt('other')).rejects.toThrow('Guarded submission');
    await expect(session.sendInput('other')).rejects.toThrow('Guarded submission');
    access.ptyProcess = null;
    release();
    expect(await submission).toBe(false);
    expect(writes).toEqual([]);
  } finally {
    access.ptyProcess = null;
    await session.stop(false);
  }
});

it('counts an ordinary transport pending window before any awaited acknowledgement', async () => {
  let release!: () => void;
  const session = new Session({
    workingDir: '/tmp',
    mode: 'codex',
    mux: {
      isAvailable: () => true,
      sendInput: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return true;
      },
    },
    muxSession: { muxName: 'codeman-12345678', sessionId: 'test', createdAt: 1, pid: 1 },
  } as unknown as ConstructorParameters<typeof Session>[0]);
  try {
    const writing = session.writeViaMux('hello');
    expect(session.guardedInputPendingWrites).toBe(1);
    release();
    await writing;
    expect(session.guardedInputPendingWrites).toBe(0);
  } finally {
    release?.();
    await session.stop(false);
  }
});

it('uses fresh normalized pane rows for working/dialog denial before exact composer proof', async () => {
  let working = false;
  const capture = vi.fn(() =>
    formatPaneSnapshot(
      [working ? '• Working (1s · esc to interrupt)' : 'ready', '› hello', '  GPT-6-Luna default · ~/case'],
      { cols: 100, rows: 20, cursorX: 7, cursorY: 1 }
    )
  );
  const session = new Session({
    workingDir: '/tmp',
    mode: 'codex',
    mux: {
      isAvailable: () => true,
      capturePaneBuffer: (
        _name: string,
        _pane?: string,
        opts?: { capturedGeometry?: { cols: number; rows: number } }
      ) => {
        if (opts) opts.capturedGeometry = { cols: 100, rows: 20 };
        return capture();
      },
      capturePaneText: () => {
        throw Error('must use same frame');
      },
    },
    muxSession: { muxName: 'codeman-12345678', sessionId: 'test', createdAt: 1, pid: 1 },
  } as unknown as ConstructorParameters<typeof Session>[0]);
  try {
    const blocked = vi.spyOn(session as unknown as { _paneShowsBlocked(text: string): boolean }, '_paneShowsBlocked');
    expect(session.guardedInputSnapshot()).not.toBeNull();
    expect(blocked.mock.calls[0][0]).toContain('ready\n› hello\n');
    working = true;
    expect(session.guardedInputSnapshot()).toBeNull();
    blocked.mockReturnValue(true);
    working = false;
    expect(session.guardedInputSnapshot()).toBeNull();
  } finally {
    await session.stop(false);
  }
});

it('keeps raw user input synchronous and preserves receipts for focus/mouse/noop reports', async () => {
  const writes: string[] = [];
  const session = new Session({
    workingDir: '/tmp',
    mode: 'codex',
    mux: {
      isAvailable: () => true,
      capturePaneBuffer: (
        _name: string,
        _pane?: string,
        opts?: { capturedGeometry?: { cols: number; rows: number } }
      ) => {
        if (opts) opts.capturedGeometry = { cols: 100, rows: 20 };
        return formatPaneSnapshot(['› hello', '  GPT-6-Luna default · ~/case'], {
          cols: 100,
          rows: 20,
          cursorX: 7,
          cursorY: 0,
        });
      },
    },
    muxSession: { muxName: 'codeman-12345678', sessionId: 'test', createdAt: 1, pid: 1 },
  } as unknown as ConstructorParameters<typeof Session>[0]);
  const access = session as unknown as {
    ptyProcess: { write(data: string): void; resize(cols: number, rows: number): void } | null;
  };
  access.ptyProcess = {
    write: (text) => {
      writes.push(text);
    },
    resize: () => {},
  };
  try {
    const before = session.guardedInputSnapshot()!;
    for (const data of ['\x1b[I', '\x1b[O', '\x1b[<0;10;5M', '\x1b[M !!', '']) {
      expect(session.write(data, { fromUser: true })).toBe(true);
      expect(writes.at(-1)).toBe(data);
      expect(session.guardedInputSnapshot()?.revision).toBe(before.revision);
    }
    session.write('\x1b[Oedit');
    expect(session.guardedInputSnapshot()?.revision).toBe(before.revision + 1);
    const generation = session.inspectionGeneration;
    session.owner = 'other';
    session.owner = undefined;
    expect(session.inspectionGeneration).not.toBe(generation);
    const priorResize = session.guardedInputGeneration;
    session.resize(80, 24);
    expect(session.guardedInputGeneration).not.toBe(priorResize);
  } finally {
    access.ptyProcess = null;
    await session.stop(false);
  }
});

it('refuses a message that would wrap using the actual captured indent and width before any write', async () => {
  const writes: string[] = [];
  const session = new Session({
    workingDir: '/tmp',
    mode: 'codex',
    mux: {
      isAvailable: () => true,
      capturePaneBuffer: (
        _name: string,
        _pane: string,
        opts: { capturedGeometry?: { cols: number; rows: number } }
      ) => {
        if (opts) opts.capturedGeometry = { cols: 30, rows: 20 };
        return formatPaneSnapshot(['    › ', '  GPT-6 default · ~/case'], {
          cols: 30,
          rows: 20,
          cursorX: 6,
          cursorY: 0,
        });
      },
      sendInput: async (_id: string, text: string) => {
        writes.push(text);
        return true;
      },
    },
    muxSession: { muxName: 'codeman-12345678', sessionId: 'test', createdAt: 1, pid: 1 },
  } as unknown as ConstructorParameters<typeof Session>[0]);
  const { GuardedStageStore, guardedComposerChrome } = await import('../src/agent-staging.js');
  const { getCli } = await import('../src/config/cli-registry/registry.js');
  try {
    const store = new GuardedStageStore();
    const target = {
      id: session.id,
      chrome: () => guardedComposerChrome(getCli('codex')),
      snapshot: () => session.guardedInputSnapshot(),
      write: (text: string) => session.stageGuardedInput(text),
      submit: (snap: Parameters<Session['submitGuardedInput']>[0]) => session.submitGuardedInput(snap),
    };
    await expect(store.stage(target, 'alice', 'x'.repeat(24))).rejects.toThrow(/wrap/);
    expect(writes).toEqual([]);
  } finally {
    await session.stop(false);
  }
});

it('keeps inspection generations stable across resize but invalidates a staged snapshot', async () => {
  const session = new Session({ workingDir: '/tmp', mode: 'codex' });
  const access = session as unknown as { ptyProcess: { resize(cols: number, rows: number): void } | null };
  access.ptyProcess = { resize: () => {} };
  try {
    const inspection = session.inspectionGeneration;
    const staging = session.guardedInputGeneration;
    session.resize(80, 24);
    expect(session.inspectionGeneration).toBe(inspection);
    expect(session.guardedInputGeneration).not.toBe(staging);
  } finally {
    access.ptyProcess = null;
    await session.stop(false);
  }
});

it('records a verifier re-press as the latest submit time', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(10000);
  const session = new Session({
    workingDir: '/tmp',
    mode: 'codex',
    mux: { isAvailable: () => true, capturePaneText: () => '› hello\n', sendInput: async () => true },
    muxSession: { muxName: 'codeman-12345678', sessionId: 'test', createdAt: 1, pid: 1 },
  } as unknown as ConstructorParameters<typeof Session>[0]);
  try {
    await session.writeViaMux('hello\r');
    const initial = session.lastSubmitAt;
    await vi.advanceTimersByTimeAsync(2000);
    expect(session.lastSubmitAt).toBe(initial + 2000);
  } finally {
    await session.stop(false);
    vi.useRealTimers();
  }
});

it('stages through a real session whose first post-write capture is the torn frame codex produces', async () => {
  // Reproduces the live 0.162.0 race: right after the keys land, the screen still
  // shows the empty composer while the caret is already past the new text. That
  // frame proves nothing; the repaint a few ms later does.
  let composer = '';
  let torn = 0;
  const writes: string[] = [];
  const session = new Session({
    workingDir: '/tmp',
    mode: 'codex',
    mux: {
      isAvailable: () => true,
      capturePaneBuffer: (
        _name: string,
        _pane?: string,
        opts?: { capturedGeometry?: { cols: number; rows: number } }
      ) => {
        if (opts) opts.capturedGeometry = { cols: 100, rows: 20 };
        const shown = torn > 0 ? '' : composer;
        if (torn > 0) torn--;
        return formatPaneSnapshot([`› ${shown}`, '  GPT-6-Luna default · ~/case'], {
          cols: 100,
          rows: 20,
          cursorX: 2 + composer.length,
          cursorY: 0,
        });
      },
      sendInput: async (_id: string, text: string, options?: { beforeDispatch?: () => boolean }) => {
        if (options?.beforeDispatch && !options.beforeDispatch()) return false;
        writes.push(text);
        if (text !== '\r') {
          composer += text;
          torn = 2;
        }
        return true;
      },
    },
    muxSession: { muxName: 'codeman-12345678', sessionId: 'test', createdAt: 1, pid: 1 },
  } as unknown as ConstructorParameters<typeof Session>[0]);
  const { GuardedStageStore, guardedComposerChrome } = await import('../src/agent-staging.js');
  const { getCli } = await import('../src/config/cli-registry/registry.js');
  const sleeps: number[] = [];
  const store = new GuardedStageStore(Date.now, 1024, 120000, {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  const target = {
    id: session.id,
    chrome: () => guardedComposerChrome(getCli('codex')),
    snapshot: () => session.guardedInputSnapshot(),
    write: (text: string) => session.stageGuardedInput(text),
    submit: (snap: Parameters<Session['submitGuardedInput']>[0]) => session.submitGuardedInput(snap),
  };
  try {
    const receipt = await store.stage(target, 'alice', 'hello');
    expect(receipt.sha256).toBe(promptSha256('hello'));
    expect(sleeps).toHaveLength(2);
    await expect(store.submit(target, 'alice', receipt.stageId, receipt.sha256)).resolves.toMatchObject({
      submitted: true,
    });
    expect(writes).toEqual(['hello', '\r']);
  } finally {
    await session.stop(false);
  }
});
