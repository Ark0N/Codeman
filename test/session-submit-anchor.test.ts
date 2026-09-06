/**
 * @fileoverview The pane's last-Enter timestamp must survive a Codeman restart.
 *
 * `start()` resets `claudeSessionId` to the launch id even when re-attaching to
 * a mux session whose CLI has since moved on (a `/clear` before the restart), so
 * `lastSubmitAt` is the response viewer's only anchor for re-deriving the live
 * conversation. If it is not persisted, a recovered pane shows the pre-`/clear`
 * transcript until the user happens to type again — hours, in practice.
 *
 * Port: N/A (no server needed)
 */

import { describe, it, expect } from 'vitest';
import { Session } from '../src/session.js';
import { deriveAutoSessionName, SubmittedPromptTracker } from '../src/session-auto-name.js';

describe('session submit anchor', () => {
  it('records the pane Enter and carries it into persisted state', () => {
    const session = new Session({ workingDir: '/tmp' });
    expect(session.lastSubmitAt).toBe(0);
    expect(session.toState().lastSubmitAt).toBeUndefined();

    const before = Date.now();
    session.write('hello\r');
    const after = Date.now();

    expect(session.lastSubmitAt).toBeGreaterThanOrEqual(before);
    expect(session.lastSubmitAt).toBeLessThanOrEqual(after);
    expect(session.toState().lastSubmitAt).toBe(session.lastSubmitAt);
  });

  it('leaves the anchor unset for keystrokes that never submit', () => {
    const session = new Session({ workingDir: '/tmp' });
    session.write('hello');
    session.write('\x1b[A'); // arrow-up: history recall, not a submit

    expect(session.lastSubmitAt).toBe(0);
    expect(session.toState().lastSubmitAt).toBeUndefined();
  });

  it('restores the anchor from persisted state on boot recovery', () => {
    const submitted = new Session({ workingDir: '/tmp' });
    submitted.write('prompt\r');
    const persisted = submitted.toState();

    const recovered = new Session({ workingDir: '/tmp', lastSubmitAt: persisted.lastSubmitAt });

    expect(recovered.lastSubmitAt).toBe(submitted.lastSubmitAt);
    expect(recovered.toState().lastSubmitAt).toBe(submitted.lastSubmitAt);
  });

  it('starts a pane with no persisted anchor at zero rather than NaN', () => {
    const recovered = new Session({ workingDir: '/tmp', lastSubmitAt: undefined });
    expect(recovered.lastSubmitAt).toBe(0);
  });
});

describe('automatic session names', () => {
  it('builds a bounded title from the first sentence without exposing controls', () => {
    expect(deriveAutoSessionName('  修复登录跳转问题。\n不要改数据库')).toBe('修复登录跳转问题。');
    expect(deriveAutoSessionName('/clear')).toBeNull();
    expect(deriveAutoSessionName('\x1b[31m整理项目文档\x1b[0m')).toBe('整理项目文档');
    expect(Array.from(deriveAutoSessionName('a'.repeat(200)) ?? '')).toHaveLength(72);
  });

  it('tracks chunked typing, backspace, and Enter without treating arrows as prompt text', () => {
    const tracker = new SubmittedPromptTracker();
    expect(tracker.feed('修复登')).toEqual([]);
    expect(tracker.feed('录跳转\x7f问题\r')).toEqual(['修复登录跳问题']);
    expect(tracker.feed('旧内容\x1b[A新内容\r')).toEqual(['新内容']);
  });

  it('keeps manual names protected while generated names remain eligible', () => {
    const generated = new Session({ workingDir: '/tmp', name: 'w1-demo' });
    expect(generated.nameSource).toBe('auto');
    expect(generated.applyAutoName('修复登录')).toBe(true);
    expect(generated.applyAutoName('继续重命名')).toBe(true);

    const manual = new Session({ workingDir: '/tmp', name: '我的工作窗口' });
    expect(manual.nameSource).toBe('manual');
    expect(manual.applyAutoName('不应覆盖')).toBe(false);
    expect(manual.name).toBe('我的工作窗口');
  });
});
