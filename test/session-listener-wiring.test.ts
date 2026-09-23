import { describe, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import { createSessionListeners } from '../src/web/session-listener-wiring.js';
import { SseEvent } from '../src/web/sse-events.js';

describe('session listener wiring', () => {
  it('forwards the attachment request source through registerAttachment', async () => {
    const session = new Session({ id: 'wiring-attach-source-test', workingDir: '/tmp', mode: 'codex' });
    const registerAttachment = vi.fn(async () => undefined);
    const deps = { registerAttachment } as unknown as Parameters<typeof createSessionListeners>[1];

    const refs = createSessionListeners(session, deps);
    refs.attachmentRequested({ path: '/tmp/mockup.png', source: 'codex-generated' });
    refs.attachmentRequested({ path: '/tmp/report.pdf', source: 'external' });

    expect(registerAttachment).toHaveBeenNthCalledWith(
      1,
      'wiring-attach-source-test',
      '/tmp/mockup.png',
      'codex-generated'
    );
    expect(registerAttachment).toHaveBeenNthCalledWith(2, 'wiring-attach-source-test', '/tmp/report.pdf', 'external');
  });

  it('pushes the session state when the watching label changes on its own', () => {
    // The badge appears on the idle transition, which broadcasts anyway. It goes AWAY
    // when the background work ends, and a CLI can do that without taking a turn — codex
    // repaints its background-terminal row away and stays idle — so nothing else fires
    // and every open page would keep drawing a badge the server had already dropped.
    const session = new Session({ id: 'wiring-watching-test', workingDir: '/tmp', mode: 'codex' });
    const broadcastSessionStateDebounced = vi.fn();
    const deps = { broadcastSessionStateDebounced } as unknown as Parameters<typeof createSessionListeners>[1];

    const refs = createSessionListeners(session, deps);
    refs.watchingChanged();

    expect(broadcastSessionStateDebounced).toHaveBeenCalledWith('wiring-watching-test');
  });

  /** The listener reads the setting asynchronously; let its promise chain settle. */
  const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

  function autoNameDeps(session: Session, enabled: boolean) {
    const deps = {
      updateSessionName: vi.fn(() => true),
      persistSessionState: vi.fn(),
      broadcast: vi.fn(),
      getSessionStateWithRespawn: vi.fn(() => session.toState()),
      isAutoNameEnabled: vi.fn(async () => enabled),
    };
    return {
      deps,
      refs: createSessionListeners(session, deps as unknown as Parameters<typeof createSessionListeners>[1]),
    };
  }

  it('names a placeholder tab after its first real prompt, in the prefix form, once', async () => {
    const session = new Session({ id: 'wiring-auto-name-test', workingDir: '/tmp', name: 'w1-demo' });
    const { deps, refs } = autoNameDeps(session, true);

    // A slash command yields no title and leaves the session eligible; the
    // setting is not even read for it.
    refs.promptSubmitted('/clear');
    await flush();
    expect(deps.isAutoNameEnabled).not.toHaveBeenCalled();
    expect(session.name).toBe('w1-demo');

    refs.promptSubmitted('整理登录模块并补充测试');
    await flush();
    expect(session.name).toBe('w1-demo: 整理登录模块并补充测试');
    expect(session.nameSource).toBe('auto');
    expect(deps.updateSessionName).toHaveBeenCalledWith('wiring-auto-name-test', 'w1-demo: 整理登录模块并补充测试');
    expect(deps.persistSessionState).toHaveBeenCalledWith(session);
    expect(deps.broadcast).toHaveBeenCalledWith(
      SseEvent.SessionUpdated,
      expect.objectContaining({ name: 'w1-demo: 整理登录模块并补充测试', nameSource: 'auto' })
    );

    // The second prompt never reaches the setting: the tab is named.
    refs.promptSubmitted('1');
    await flush();
    expect(deps.isAutoNameEnabled).toHaveBeenCalledTimes(1);
    expect(session.name).toBe('w1-demo: 整理登录模块并补充测试');
  });

  it('leaves the tab alone while the setting is off, and never touches a manual name', async () => {
    const session = new Session({ id: 'wiring-auto-name-off', workingDir: '/tmp', name: 'w1-demo' });
    const { deps, refs } = autoNameDeps(session, false);

    refs.promptSubmitted('fix the login bug');
    await flush();
    expect(deps.isAutoNameEnabled).toHaveBeenCalledTimes(1);
    expect(session.name).toBe('w1-demo');
    // Still a placeholder: flipping the setting on names the NEXT prompt.
    expect(session.nameSource).toBe('placeholder');
    expect(deps.updateSessionName).not.toHaveBeenCalled();

    session.name = '人工命名';
    refs.promptSubmitted('新的任务不能覆盖人工命名');
    await flush();
    expect(deps.isAutoNameEnabled).toHaveBeenCalledTimes(1);
    expect(session.name).toBe('人工命名');
    expect(deps.persistSessionState).not.toHaveBeenCalled();
  });
});
