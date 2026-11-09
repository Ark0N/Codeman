import { claudeQuestionConversation } from './claude-question-answer.js';
/** Server adapters for native Discord UI. Reuses settings, approval and file/SSH guards. */
import { parseClaudeVisibleQuestion, claudeQuestionGone } from './claude-visible-question.js';
import type { ApprovalItem } from './approval-inbox.js';
import { claudePromptSuggestion } from '../session-submit-verifier.js';
import { discordActivityWorking } from '../discord-activity.js';
import { getCli } from '../config/cli-registry/registry.js';
import { approvalInbox } from './approval-inbox.js';
import { answerPendingApproval } from './routes/approval-routes.js';
import { discordApprovalRevision } from '../discord-task-controls.js';
import { readJsonConfig, SETTINGS_PATH } from './route-helpers.js';
import { SettingsUpdateSchema } from './schemas.js';
import { mutateSettingsFile } from './settings-writer.js';
import { discordWorkspaceResults, discordWorkspaceHasChanges } from '../discord-workspace-results.js';
import { configuredDiscordCaseKey } from '../discord-case-identity.js';
import type { DiscordNativeUiServices } from '../discord-native-ui-types.js';
import type { Session } from '../session.js';
import type { CaseInfo } from '../types.js';
interface Deps {
  sessions(): Map<string, Session>;
  cases(): Promise<CaseInfo[]>;
  allowed(): boolean;
  url(): string | undefined;
  capture?(id: string): string | null | undefined | Promise<string | null | undefined>;
  questionObserved?(item: ApprovalItem): boolean | void | Promise<boolean | void>;
  observed?(id: string): { model: string; effort?: string } | undefined;
}
/** Match the native history reader: Claude IDs do not live in Codex resume fields. */
const conversationFor = (s: Session): string | undefined =>
  getCli(s.mode)?.capabilities.transcript === 'claude-jsonl'
    ? claudeQuestionConversation(s)
    : (s.nativeResumeId ?? s.codexConfig?.resumeSessionId);
export function createDiscordNativeUiServices(deps: Deps): DiscordNativeUiServices {
  const session = (id: string) => {
    const s = deps.sessions().get(id);
    if (!deps.allowed() || !s || s.isAdopted) throw new Error('Session unavailable');
    return s;
  };
  const working = (s: Session) =>
    discordActivityWorking({
      id: s.id,
      working: s.isWorking,
      watching: s.watching,
      activityStatus: (s as Session & { activityProjection?: { activityStatus?: string } }).activityProjection
        ?.activityStatus,
    });
  const observed = new Map<
    string,
    {
      id: string;
      text: string;
      conversation: string;
      revision: string;
      delivered: boolean;
      control?: ApprovalItem['nativeQuestion'];
    }
  >();
  const reading = new Set<string>();
  const suggestion = async (s: Session) => {
    if (
      getCli(s.mode)?.capabilities.nativeSettingsProfile !== 'claude-tui' ||
      reading.has(s.id) ||
      s.paneExit ||
      s.guardedInputHeld ||
      s.guardedInputPendingWrites ||
      approvalInbox
        .listPending()
        .some((p) => p.sessionId === s.id && p.kind !== 'idle' && p.id !== observed.get(s.id)?.id)
    )
      return undefined;
    reading.add(s.id);
    try {
      const revision = s.discordQueueRevision,
        conversation = conversationFor(s);
      const frame = await deps.capture?.(s.id);
      if (
        !deps.allowed() ||
        deps.sessions().get(s.id) !== s ||
        s.paneExit ||
        s.guardedInputHeld ||
        s.guardedInputPendingWrites ||
        revision !== s.discordQueueRevision ||
        conversation !== conversationFor(s) ||
        approvalInbox
          .listPending()
          .some((p) => p.sessionId === s.id && p.kind !== 'idle' && p.id !== observed.get(s.id)?.id)
      )
        return undefined;
      if (!frame) return undefined;
      const dialog = parseClaudeVisibleQuestion(frame);
      const text = dialog?.text;
      const previous = observed.get(s.id);
      if (text && dialog && conversation && revision !== undefined) {
        if (
          !previous ||
          previous.text !== text ||
          previous.conversation !== conversation ||
          (previous.control &&
            (previous.control.state === 'answered' ||
              previous.revision !== revision ||
              previous.control.dialog.identity !== dialog.identity))
        ) {
          const item = approvalInbox.notePrompt({
            sessionId: s.id,
            sessionName: s.name || s.id.slice(0, 8),
            mode: 'claude',
            kind: 'question',
            toolName: 'AskUserQuestion',
            answerInTerminal: dialog.multiSelect || typeof s.withNativeQuestionInput !== 'function',
            nativeQuestion:
              !dialog.multiSelect && typeof s.withNativeQuestionInput === 'function'
                ? { conversation, inputRevision: revision, dialog, state: 'pending' }
                : undefined,
            message: !dialog.multiSelect && typeof s.withNativeQuestionInput === 'function' ? dialog.question : text,
            context: frame,
            cwd: s.workingDir,
          });
          observed.set(s.id, {
            id: item.id,
            text,
            conversation,
            revision,
            delivered: false,
            control: item.nativeQuestion,
          });
        }
        const current = observed.get(s.id)!;
        const item = approvalInbox.getById(current.id);
        if (item?.nativeQuestion?.state === 'pending' && item.nativeQuestion.dialog.identity === dialog.identity) {
          item.nativeQuestion.dialog = dialog;
        }
        if (item && !current.delivered) current.delivered = (await deps.questionObserved?.(item)) !== false;
        return undefined;
      }
      if (
        previous &&
        (previous.conversation !== conversation || previous.revision !== revision || claudeQuestionGone(frame))
      ) {
        if (approvalInbox.getById(previous.id)) approvalInbox.resolveForSession(s.id, 'superseded');
        observed.delete(s.id);
      }
      return !working(s) && !approvalInbox.listPending().some((p) => p.sessionId === s.id && p.kind !== 'idle')
        ? claudePromptSuggestion(frame)
        : undefined;
    } catch {
      return undefined;
    } finally {
      reading.delete(s.id);
    }
  };
  return {
    enabled: () => deps.allowed(),
    sessions: async () => {
      if (!deps.allowed()) return [];
      for (const [id, old] of observed) {
        if (!deps.sessions().has(id)) {
          if (approvalInbox.getById(old.id)) approvalInbox.resolveForSession(id, 'expired');
          observed.delete(id);
        }
      }
      const cases = await deps.cases();
      return Promise.all(
        [...deps.sessions().values()].map(async (s) => {
          const promptSuggestion = await suggestion(s);
          const pending = approvalInbox.listPending().find((p) => p.sessionId === s.id && p.kind !== 'idle');
          return {
            id: s.id,
            name: s.name || s.id.slice(0, 8),
            mode: s.mode,
            host: s.remote?.label || 'local',
            caseName:
              cases.find((c) =>
                s.remote
                  ? c.remote?.hostId === s.remote.hostId && c.remote.path === s.remote.remotePath
                  : !c.remote && c.path === s.workingDir
              )?.name || 'Unlinked workspace',
            conversation: conversationFor(s),
            inputRevision: s.discordQueueRevision,
            working: working(s),
            promptSuggestion,
            lastPromptAt: s.lastRealPromptAt || undefined,
            pendingAt: pending?.createdAt,
            pendingRevision: pending ? discordApprovalRevision(pending) : undefined,
            pending: approvalInbox.listPending().some((p) => p.sessionId === s.id && p.kind !== 'idle'),
            exited: !!s.paneExit,
            ready: !working(s) && !s.paneExit && !s.guardedInputHeld && !s.guardedInputPendingWrites,
            model: deps.observed?.(s.id)?.model
              ? deps.observed(s.id)!.model + ' (native verified)'
              : s.displayModel
                ? `${s.displayModel.model} (${s.displayModel.source})`
                : undefined,
            effort: deps.observed?.(s.id)?.effort, // launch effort is not proof of a current setting
            approval:
              getCli(s.mode)?.launch.legacyConfigField === 'codexConfig'
                ? s.codexConfig?.dangerouslyBypassApprovals
                  ? 'Approve all (launch flag)'
                  : 'CLI default / ask'
                : 'CLI-controlled',
            url: deps.url() ? `${deps.url()!.replace(/\/$/, '')}/#session=${encodeURIComponent(s.id)}` : undefined,
          };
        })
      );
    },
    cases: async () =>
      deps.allowed()
        ? (await deps.cases())
            .filter((c) => !c.docker && !c.unreachable)
            .flatMap((c) => {
              const key = configuredDiscordCaseKey(c);
              return key ? [{ key, name: c.name, host: c.remote?.hostId || 'local' }] : [];
            })
        : [],
    defaults: async () => {
      const s = await readJsonConfig<Record<string, unknown>>(SETTINGS_PATH, 'Discord defaults', {});
      return {
        model: typeof s.codexModel === 'string' ? s.codexModel : '',
        effort: typeof s.codexReasoningEffort === 'string' ? s.codexReasoningEffort : '',
        approval: s.codexDangerouslyBypassApprovals === true ? 'approve-all' : 'ask',
      };
    },
    saveDefaults: async (v, current) => {
      if (!deps.allowed() || !current()) throw new Error('Settings context changed');
      if (!['approve-all', 'ask'].includes(v.approval)) throw new Error('Approval must be approve-all or ask');
      const parsed = SettingsUpdateSchema.parse({
        codexModel: v.model,
        codexReasoningEffort: v.effort,
        codexDangerouslyBypassApprovals: v.approval === 'approve-all',
      });
      await mutateSettingsFile((s) => {
        if (!deps.allowed() || !current()) throw new Error('Settings context changed');
        return { ...s, ...parsed };
      });
    },
    question: (id) => {
      if (!deps.allowed()) return undefined;
      const p = approvalInbox.listPending().find((p) => p.sessionId === id);
      if (!p || !approvalInbox.verifyStillAnswerable(p.id)) return undefined;
      return {
        id: p.id,
        revision: discordApprovalRevision(p),
        kind: p.kind,
        text: p.message || p.toolSummary || p.context || 'Reply to the current prompt',
        options: p.options ?? [],
        terminalOnly: !!p.answerInTerminal,
      };
    },
    answer: async (id, question, revision, value, current = () => true) => {
      const s = session(id),
        p = approvalInbox.getById(question);
      if (!p || p.sessionId !== id || discordApprovalRevision(p) !== revision)
        throw new Error('Question changed or was answered elsewhere');
      const answer =
        p.kind === 'idle'
          ? { action: 'text' as const, text: value }
          : value === 'deny'
            ? { action: 'deny' as const }
            : { action: 'option' as const, option: Number(value) };
      const result = await answerPendingApproval(
        s,
        question,
        answer,
        () => current() && deps.allowed() && deps.sessions().get(id) === s
      );
      if (!result.success) throw new Error('Native approval service refused the answer');
      return 'Answer sent to the exact pending prompt.';
    },
    workspaceHasChanges: async (id) => {
      const s = session(id);
      return discordWorkspaceHasChanges({
        workingDir: s.workingDir,
        remote: s.remote,
        docker: s.docker,
        isAdopted: s.isAdopted,
      });
    },
    workspace: async (id) => {
      const s = session(id);
      return discordWorkspaceResults({
        workingDir: s.workingDir,
        remote: s.remote,
        docker: s.docker,
        isAdopted: s.isAdopted,
      });
    },
    submitQueued: async (id, text, conversation, allowed, inputRevision) => {
      const s = session(id);
      return s.submitDiscordFollowup(
        text,
        () =>
          deps.allowed() &&
          !working(s) &&
          inputRevision !== undefined &&
          s.discordQueueRevision === inputRevision &&
          allowed() &&
          deps.sessions().get(id) === s &&
          conversationFor(s) === conversation &&
          !approvalInbox.listPending().some((p) => p.sessionId === id && p.kind !== 'idle')
      );
    },
  };
}
