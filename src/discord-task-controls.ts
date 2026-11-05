/** Exact prompt-bound controls. Reuses the same answer checks as the web UI. */
import { createHash } from 'node:crypto';
import { approvalInbox, type ApprovalItem } from './web/approval-inbox.js';
import { answerPendingApproval } from './web/routes/approval-routes.js';
import type { Session } from './session.js';
import type { DiscordControlReply } from './discord-bridge.js';
export function discordApprovalRevision(item: ApprovalItem): string {
  return createHash('sha256')
    .update(
      JSON.stringify([item.id, item.kind, item.message, item.options, item.context, item.toolName, item.toolSummary])
    )
    .digest('hex')
    .slice(0, 16);
}
export function discordControlCurrent(session: Session, validity: string): boolean {
  if (validity.startsWith('interrupt:'))
    return session.isWorking && String(session.lastSubmitAt) === validity.slice(10);
  const split = validity.lastIndexOf(':');
  const item = approvalInbox.getById(validity.slice(0, split));
  return !!item && item.sessionId === session.id && discordApprovalRevision(item) === validity.slice(split + 1);
}
export async function discordTaskControl(session: Session, command: string): Promise<DiscordControlReply | undefined> {
  if (command === 'pending') {
    const item = approvalInbox.listPending().find((i) => i.sessionId === session.id && i.kind !== 'idle');
    if (!item || !approvalInbox.verifyStillAnswerable(item.id))
      return { text: 'No pending question or permission request.' };
    const revision = discordApprovalRevision(item);
    const scope = item.id + ':' + revision;
    const text = `**${item.kind === 'question' ? 'Question' : 'Permission needed'}**\n${(item.message || item.toolSummary || item.context || 'Review the pending prompt').slice(0, 1200)}\n`;
    if (item.answerInTerminal)
      return { text: text + 'This CLI requires the terminal: Codeman cannot safely verify its dialog keystrokes.' };
    const choices = (item.options ?? []).map((o) => `${o.n}. ${o.label}`).join('\n');
    const actions = (item.options ?? [])
      .filter((o) => o.n >= 0 && o.n <= 9)
      .slice(0, 4)
      .map((o) => ({ label: o.label.slice(0, 80), command: `answer ${item.id} ${revision} ${o.n}`, validity: scope }));
    if (item.kind === 'permission')
      actions.push({ label: 'Deny', command: `answer ${item.id} ${revision} deny`, validity: scope });
    return {
      text:
        text +
        choices +
        `\nText fallback: !codeman answer ${item.id} ${revision} <option number${item.kind === 'permission' ? ' or deny' : ''}>`,
      actions,
    };
  }
  const answer = /^answer (\S+) ([a-f0-9]{16}) (\d|deny)$/.exec(command);
  if (answer) {
    const item = approvalInbox.getById(answer[1]);
    if (!item || item.sessionId !== session.id || discordApprovalRevision(item) !== answer[2])
      return { text: 'This prompt changed, expired or was already answered. Use !codeman pending again.' };
    if (answer[3] === 'deny' && item.kind !== 'permission')
      return { text: 'Deny is only available for a permission request.' };
    const result = await answerPendingApproval(
      session,
      item.id,
      answer[3] === 'deny' ? { action: 'deny' } : { action: 'option', option: Number(answer[3]) }
    );
    return {
      text: result.success
        ? 'Answer sent to the exact pending prompt.'
        : 'Answer refused: ' + ('error' in result ? result.error : 'the prompt is no longer answerable'),
    };
  }
  if (command === 'interrupt') {
    if (!session.isWorking || !session.lastSubmitAt)
      return { text: 'No current task can be safely identified for interruption.' };
    const token = String(session.lastSubmitAt);
    return {
      text: `Interrupt the current task? This sends Ctrl+C; the session remains open.\nText fallback: !codeman interrupt confirm ${token}`,
      actions: [
        { label: 'Interrupt task', command: 'interrupt confirm ' + token, validity: 'interrupt:' + token, style: 4 },
      ],
    };
  }
  const interrupt = /^interrupt confirm (\d+)$/.exec(command);
  if (interrupt) {
    if (!discordControlCurrent(session, 'interrupt:' + interrupt[1]))
      return { text: 'The task changed or ended. Request !codeman interrupt again.' };
    const ok = await session.writeViaMux('\x03', { fromUser: true });
    return {
      text: ok
        ? 'Interrupt requested. Native completion/interruption still requires confirmation.'
        : 'The session is not accepting input.',
    };
  }
  return undefined;
}
