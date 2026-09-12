import { describe, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import { createSessionListeners } from '../src/web/session-listener-wiring.js';

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

  it('renames an eligible session when its first prompt is submitted', () => {
    const session = new Session({ id: 'wiring-auto-name-test', workingDir: '/tmp', name: 'w1-demo' });
    const updateSessionName = vi.fn(() => true);
    const persistSessionState = vi.fn();
    const broadcast = vi.fn();
    const getSessionStateWithRespawn = vi.fn(() => session.toState());
    const deps = {
      updateSessionName,
      persistSessionState,
      broadcast,
      getSessionStateWithRespawn,
    } as unknown as Parameters<typeof createSessionListeners>[1];

    const refs = createSessionListeners(session, deps);
    refs.promptSubmitted('整理登录模块并补充测试');

    expect(session.name).toBe('整理登录模块并补充测试');
    expect(updateSessionName).toHaveBeenCalledWith('wiring-auto-name-test', '整理登录模块并补充测试');
    expect(persistSessionState).toHaveBeenCalledWith(session);
    expect(broadcast).toHaveBeenCalled();

    session.name = '人工命名';
    refs.promptSubmitted('新的任务不能覆盖人工命名');
    expect(session.name).toBe('人工命名');
    expect(updateSessionName).toHaveBeenCalledTimes(1);
  });
});
