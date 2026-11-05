import { afterEach, it, expect, vi } from 'vitest';
import { approvalInbox } from '../src/web/approval-inbox.js';
import { discordTaskControl } from '../src/discord-task-controls.js';
import type { Session } from '../src/session.js';
const dialog = 'Claude needs permission\n ❯ 1. Allow once\n   2. Deny';
afterEach(() => approvalInbox.resolveForSession('s1', 'session_ended'));
const session = () =>
  ({
    id: 's1',
    mode: 'claude',
    lastSubmitAt: 123,
    isWorking: true,
    writeViaMux: vi.fn(async () => true),
  }) as unknown as Session;
it('uses exact parsed choices, consumes once and rejects a stale prompt revision', async () => {
  const s = session();
  approvalInbox.notePrompt({
    sessionId: 's1',
    sessionName: 'one',
    kind: 'permission',
    mode: 'claude',
    capture: () => dialog,
  });
  const pending = await discordTaskControl(s, 'pending');
  expect(pending?.actions?.length).toBeGreaterThan(0);
  const command = pending!.actions![0].command;
  const result = await discordTaskControl(s, command);
  expect(result?.text).toContain('Answer sent');
  expect(s.writeViaMux).toHaveBeenCalledExactlyOnceWith('1');
  await discordTaskControl(s, command);
  expect(s.writeViaMux).toHaveBeenCalledTimes(1);
});
it('keeps unverified provider dialogs terminal-only and never blindly sends approval keys', async () => {
  const s = session();
  approvalInbox.notePrompt({
    sessionId: 's1',
    sessionName: 'one',
    kind: 'question',
    mode: 'codex',
    answerInTerminal: true,
    capture: () => dialog,
  });
  const reply = await discordTaskControl(s, 'pending');
  expect(reply?.actions).toBeUndefined();
  expect(reply?.text).toContain('requires the terminal');
  expect(s.writeViaMux).not.toHaveBeenCalled();
});
it('requires confirmation of the current task before Ctrl+C and rejects a changed task', async () => {
  const s = session();
  const reply = await discordTaskControl(s, 'interrupt');
  expect(s.writeViaMux).not.toHaveBeenCalled();
  await discordTaskControl(s, 'interrupt confirm 124');
  expect(s.writeViaMux).not.toHaveBeenCalled();
  await discordTaskControl(s, reply!.actions![0].command);
  expect(s.writeViaMux).toHaveBeenCalledExactlyOnceWith('\x03', { fromUser: true });
});
