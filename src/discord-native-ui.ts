/** Native Discord controls. Tokens bind actor, origin, configuration and exact conversation. */
import { createHash, randomUUID } from 'node:crypto';
import {
  activityFromHistory,
  activityText,
  activityPreviewText,
  newerActivity,
  DISCORD_ACTIVITY_VIEWS,
  type DiscordActivityEvent,
  type DiscordActivityRecord,
  type DiscordActivityView,
} from './discord-activity-feed.js';
import type { DiscordHistory } from './discord-history.js';
import { DiscordUiStore } from './discord-ui-store.js';
import { posix } from 'node:path';
import { discordArtifactPaths, DISCORD_ARTIFACT_COUNT } from './discord-artifacts.js';
import {
  DISCORD_COMPONENTS_V2,
  DISCORD_SUPPRESS_NOTIFICATIONS,
  discordDetailPages,
  discordResponsePosts,
  formatDiscordResponseText,
} from './discord-response-format.js';
import { readDiscordTaskUpdates, renderDiscordTaskUpdates, type DiscordTaskUpdates } from './discord-task-updates.js';
import { discordTableParts, type DiscordTable } from './discord-tables.js';
import { discordTablePage, discordTableCsv, discordTablePng, interactiveDiscordTable } from './discord-table-view.js';
import { discordDisplayText } from './discord-display-text.js';
import type { DiscordInteraction, GatewayMessage, DiscordPost } from './discord-bridge.js';
import type { DiscordNativeUiHost, DiscordUiPayload, DiscordUiSession } from './discord-native-ui-types.js';
/** Walk both legacy rows and V2 sections, including their accessory controls. */
export function discordUiNodes(nodes: unknown, depth = 0): Array<Record<string, unknown>> {
  if (!Array.isArray(nodes) || depth > 6) return [];
  return nodes.flatMap((node) =>
    node && typeof node === 'object'
      ? [
          node,
          ...discordUiNodes(node.components, depth + 1),
          ...discordUiNodes(node.accessory ? [node.accessory] : [], depth + 1),
        ]
      : []
  );
}
/** V2 messages cannot revert to legacy content, including ephemeral follow-up panels. */
export function uiV2Payload(payload: DiscordUiPayload): DiscordUiPayload {
  if ((payload.flags ?? 0) & DISCORD_COMPONENTS_V2) return payload;
  return {
    content: '',
    flags: DISCORD_COMPONENTS_V2 | DISCORD_SUPPRESS_NOTIFICATIONS,
    allowed_mentions: payload.allowed_mentions ?? { parse: [], users: [] },
    components: [{ type: 10, content: payload.content || 'Done.' }, ...(payload.components ?? [])],
  };
}
export function uiWirePayload(payload: DiscordUiPayload, edit = false): Record<string, unknown> {
  if (!((payload.flags ?? 0) & DISCORD_COMPONENTS_V2)) return { ...payload };
  const { content: _content, ...rest } = payload;
  return { ...rest, ...(edit ? { content: null, embeds: [] } : {}) };
}
const ownsUiMarker = (message: { content?: string; components?: unknown }, marker: string) =>
  !!message.content?.endsWith(marker) ||
  discordUiNodes(message.components)
    .filter((n) => n.type === 10)
    .map((n) => n.content)
    .join('\n')
    .endsWith(marker);

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const sourceSignature = (m: GatewayMessage) =>
  hash(JSON.stringify([m.content, (m.attachments ?? []).map((a) => [a.id, a.filename, a.size])]));
const safe = (s: string, n = 200) =>
  s
    .replace(/[@`*_~<>]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f]/g, ' ')
    .slice(0, n);
const noMentions = { parse: [] as string[], users: [] as string[] };
const row = (...components: Array<Record<string, unknown>>) => ({ type: 1, components });
const names = ['Codeman: Send to session', 'Codeman: Queue follow-up', 'Codeman: Start session'];
interface UiAction {
  scope: string;
  channel: string;
  actor?: string;
  session?: string;
  conversation?: string;
  expires: number;
  message?: string;
  group?: string;
  submitOnly?: boolean;
  modal?: {
    title: string;
    fields: Array<{ id: string; label: string; value?: string; max?: number; optional?: boolean; multiline?: boolean }>;
  };
  run: (m: DiscordInteraction, values: Record<string, string>) => Promise<DiscordUiPayload | void>;
}
interface UiContext {
  channel: string;
  actor?: string;
  session?: string;
  conversation?: string;
  group?: string;
}
export class DiscordNativeUi {
  readonly store: DiscordUiStore;
  private actions = new Map<string, UiAction>();
  private cardActions = new Map<string, string[]>();
  private consumedGroups = new Map<string, number>();
  lastError: string | null = null;
  private polls?: Promise<void>;
  private registrations?: Promise<void>;
  private registeredScope = '';
  private commands = new Map<string, string>();
  private cardCursor = 0;
  private dashboardDue = 0;
  private activitySnapshot?: { scope?: string; sessions: DiscordUiSession[]; at: number };
  private errors = new Map<string, number>();
  private epoch = randomUUID();
  private questionPanels = new Map<
    string,
    { interaction: DiscordInteraction; session: string; id: string; revision: string; expires: number }
  >();
  constructor(private readonly host: DiscordNativeUiHost) {
    this.store = new DiscordUiStore(host.dir, host.now);
  }
  private payload(content: string, components: DiscordUiPayload['components'] = []): DiscordUiPayload {
    return { content: content.slice(0, 1950), components, allowed_mentions: noMentions };
  }
  private prune(): void {
    for (const [id, until] of this.consumedGroups) if (until < this.host.now()) this.consumedGroups.delete(id);
    for (const [id, a] of this.actions) if (a.expires < this.host.now()) this.actions.delete(id);
  }
  private action(
    ctx: UiContext,
    label: string,
    run: UiAction['run'],
    modal?: UiAction['modal'],
    style = 2,
    identity?: string,
    suffix = ''
  ): Record<string, unknown> {
    this.prune();
    const id =
      'cmui:' +
      (identity ? hash(JSON.stringify([this.host.scope(), ctx, identity])).slice(0, 40) : randomUUID()) +
      suffix;
    if (!this.actions.has(id) && this.actions.size >= 2048)
      throw new Error('Too many open controls; retry after older menus expire');
    this.actions.set(id, { ...ctx, scope: this.host.scope()!, expires: this.host.now() + 6 * 60_000, run, modal });
    return { type: 2, style, label: label.slice(0, 80), custom_id: id };
  }
  private select(
    ctx: UiContext,
    placeholder: string,
    choices: Array<{ label: string; value: string; description?: string }>,
    run: (m: DiscordInteraction, value: string) => Promise<DiscordUiPayload | void>
  ): Record<string, unknown> {
    const button = this.action(ctx, placeholder, (m, values) => run(m, values.selection));
    const allowed = new Set(choices.map((c) => c.value));
    const id = button.custom_id as string;
    const original = this.actions.get(id)!.run;
    this.actions.get(id)!.run = (m, values) => {
      if (!allowed.has(values.selection)) throw new Error('This selection is not in the original menu');
      return original(m, values);
    };
    return {
      type: 3,
      custom_id: id,
      placeholder: placeholder.slice(0, 100),
      min_values: 1,
      max_values: 1,
      options: choices.slice(0, 25).map((c) => ({
        label: safe(c.label, 100) || 'Unknown',
        value: c.value,
        ...(c.description ? { description: safe(c.description, 100) } : {}),
      })),
    };
  }
  private async target(id: string, conversation?: string): Promise<DiscordUiSession> {
    const session = (await this.host.services.sessions()).find((s) => s.id === id);
    if (!session || session.exited || (conversation !== undefined && session.conversation !== conversation))
      throw new Error('The session or conversation changed. Reopen its controls.');
    const channel = this.host.channelForSession(id);
    if (!channel) throw new Error('This session has no current Discord destination');
    await this.host.verify(id, channel);
    return session;
  }
  private ctx(m: DiscordInteraction, s?: DiscordUiSession): UiContext {
    return {
      channel: m.channel_id!,
      actor: m.member?.user?.id ?? m.user?.id,
      session: s?.id,
      conversation: s?.conversation,
    };
  }
  private async upsert(key: string, channel: string, payload: DiscordUiPayload, pin = false): Promise<void> {
    const scope = this.host.scope();
    if (!scope) return;
    const storeKey = hash(this.host.config().guild + ':' + channel + ':' + key),
      marker = `\n-# Codeman · ${key.split(':')[0]} · ${storeKey.slice(0, 10)}`;
    payload =
      (payload.flags ?? 0) & DISCORD_COMPONENTS_V2
        ? { ...payload, components: [...(payload.components ?? []), { type: 10, content: marker }] }
        : { ...payload, content: payload.content.slice(0, 1880) + marker };
    const digest = hash(JSON.stringify(payload));
    const old = (await this.store.snapshot()).cards[storeKey];
    const current = () => this.host.scope() === scope && this.host.ownsChannel(channel);
    if (!current()) return;
    if (old?.phase === 'ready' && old.message && old.channel === channel && old.hash === digest) return;
    let message = old?.channel === channel ? old.message : undefined;
    if (!message && old && old.phase !== 'ready') {
      const recent = (await this.host.request('GET', `/channels/${channel}/messages?limit=50`)) as Array<{
        id: string;
        content?: string;
        components?: unknown;
        author?: { id: string };
      }>;
      const bot = await this.host.botId();
      const found = Array.isArray(recent) ? recent.filter((m) => m.author?.id === bot && ownsUiMarker(m, marker)) : [];
      if (found.length !== 1)
        throw new Error('Previous control-card creation is unconfirmed; inspect Discord before retrying');
      message = found[0].id;
    }
    if (!current()) return;
    if (message) {
      try {
        await this.host.request('GET', `/channels/${channel}/messages/${message}`);
      } catch (e) {
        if ((e as { status?: number }).status !== 404) throw e;
        message = undefined;
      }
    }
    if (message) {
      // Verify that a persisted ID still names our own bot message before editing it.
      const existing = (await this.host.request('GET', `/channels/${channel}/messages/${message}`)) as {
        author?: { id: string };
        content?: string;
        components?: unknown;
      };
      if (existing.author?.id !== (await this.host.botId()) || !ownsUiMarker(existing, marker))
        throw new Error('Control-card ownership changed');
      if (!current()) return;
      await this.host.request('PATCH', `/channels/${channel}/messages/${message}`, uiWirePayload(payload, true));
    } else {
      await this.store.edit((s) => {
        s.cards[storeKey] = {
          channel,
          hash: digest,
          kind: key.split(':')[0] as 'session' | 'delivery' | 'result' | 'dashboard',
          phase: 'posting',
          updated: this.host.now(),
        };
      });
      try {
        const posted = (await this.host.request('POST', `/channels/${channel}/messages`, {
          ...uiWirePayload(payload),
          nonce: storeKey.slice(0, 24),
          enforce_nonce: true,
        })) as { id?: string };
        if (!posted?.id || !/^\d{15,25}$/.test(posted.id)) throw new Error('Discord did not confirm a message ID');
        message = posted.id;
      } catch (e) {
        await this.store.edit((s) => {
          s.cards[storeKey].phase = 'uncertain';
        });
        throw e;
      }
    }
    await this.store.edit((s) => {
      s.cards[storeKey] = {
        channel,
        message,
        hash: digest,
        kind: key.split(':')[0] as 'session' | 'delivery' | 'result' | 'dashboard',
        phase: 'ready',
        updated: this.host.now(),
      };
    });
    for (const component of discordUiNodes(payload.components)) {
      const action = this.actions.get(component.custom_id as string);
      if (action) action.message = message;
    }
    if (pin && current()) {
      // Pin permission is optional: the durable card remains usable without it.
      await this.host.request('PUT', `/channels/${channel}/messages/pins/${message}`).catch(() => undefined);
    }
  }
  private async sessionCard(s: DiscordUiSession): Promise<DiscordUiPayload> {
    const ctx: UiContext = { channel: this.host.channelForSession(s.id)!, session: s.id, conversation: s.conversation };
    const q = (await this.store.snapshot()).queue.filter(
      (p) => p.session === s.id && p.channel === this.host.channelForSession(s.id)
    );
    const receipts = await this.host.receipts(s.id);
    const last = receipts[0];
    const status = s.exited ? '⚫ Agent exited' : s.pending ? '🔴 Needs input' : s.working ? '🟡 Working' : '⚫ Idle';
    const stateLabels: Record<string, string> = {
      received: 'Received',
      awaiting_choice: 'Waiting for send/queue choice',
      queued: 'Queued for this conversation',
      cancelled: 'No input sent / choice closed',
      files_transferred: 'Files prepared',
      submitting: 'Submission in progress; unconfirmed',
      input_accepted: 'Input delivered; native submission unconfirmed',
      submitted: 'Submitted (native acknowledgement)',
      running: 'Working (native execution)',
      completed: 'Finished (native execution)',
      uncertain: 'Unconfirmed — check before resending',
      failed: 'Not submitted / failed',
      interrupted: 'Interrupted (native execution)',
      execution_error: 'Execution failed (native event)',
    };
    const controls = [
      row(
        this.action(
          ctx,
          'Interrupt',
          async () => {
            await this.target(s.id, s.conversation);
            const r = await this.host.control(s.id, 'interrupt');
            await this.host.postControl(s.id, ctx.channel, r, 'ui-interrupt:' + randomUUID());
            return this.payload(r.text);
          },
          undefined,
          4
        ),
        this.action(ctx, 'Settings', (m) => this.settings(m, s.id)),
        this.action(ctx, 'History', async () => {
          const target = await this.target(s.id, s.conversation);
          const h = await this.host.history(target.id);
          return this.payload(
            '**Recent conversation**\n' +
              h.turns
                .filter((t) => t.role !== 'tool')
                .slice(-4)
                .map((t) => `**${t.role}** · ${t.text.slice(0, 350)}`)
                .join('\n\n')
          );
        }),
        this.action(ctx, 'Question', (m) => this.question(m, s.id))
      ),
      row(
        this.action(ctx, `Queue (${q.length})`, (m) => this.queueView(m, s.id)),
        this.action(ctx, 'Results & files', (m) => this.results(m, s.id)),
        this.action(ctx, 'Delivery status', (m) => this.delivery(m, s.id))
      ),
    ];
    const suggestion =
      s.mode === 'claude' && s.ready && !s.working && !s.pending && !s.exited ? s.promptSuggestion : undefined;
    const conversation = s.conversation,
      inputRevision = s.inputRevision;
    if (suggestion && conversation && inputRevision) {
      controls.push(
        row(
          this.action(
            ctx,
            'Use suggestion',
            async (m, fields) => {
              const fresh = await this.target(s.id, conversation);
              if (
                !fresh.ready ||
                fresh.working ||
                fresh.pending ||
                fresh.promptSuggestion !== suggestion ||
                fresh.inputRevision !== inputRevision
              )
                throw new Error('The suggestion or session changed. Reopen the session card.');
              const text = fields.prompt?.trim();
              if (!text || text.length > 1000) throw new Error('Enter a prompt of up to 1000 characters.');
              const actor = m.member?.user?.id ?? m.user?.id;
              if (!actor) throw new Error('Discord user unavailable');
              const result = await this.host.submit(
                s.id,
                this.host.channelForSession(s.id)!,
                actor,
                'suggestion:' + m.id,
                text,
                conversation,
                true,
                inputRevision
              );
              return this.payload(
                result === 'accepted'
                  ? 'Prompt delivered. Native submission is not yet confirmed.'
                  : result === 'blocked'
                    ? 'Session changed or is busy. Nothing was sent.'
                    : 'Submission unconfirmed; inspect the session before retrying.'
              );
            },
            {
              title: 'Review Claude suggestion',
              fields: [
                {
                  id: 'prompt',
                  label: 'Edit the prompt, then Submit to send',
                  value: suggestion,
                  multiline: true,
                  max: 1000,
                },
              ],
            },
            1
          )
        )
      );
    }
    if (s.url && /^https?:\/\//.test(s.url))
      controls[1].components.push({ type: 2, style: 5, label: 'Open Codeman', url: s.url });
    const task = this.host.latestPrompt?.(s.id, s.conversation) ?? '';
    return this.payload(
      `**${safe(s.caseName)} · ${safe(s.host)}**\n${status} · ${safe(s.mode)}\n${suggestion ? '\n**Claude suggests:** ' + safe(suggestion, 600) + '\n' : ''}\n**Model:** ${safe(s.model || 'Not reported')}\n**Effort:** ${safe(s.effort || 'Not reported')}\n**Launch approvals:** ${safe(s.approval || 'CLI default / not reported')}\n**Conversation:** ${safe(s.conversation || 'Not yet identified')}\n${task ? '\n**Latest prompt:** ' + safe(task, 240) + '\n' : ''}${last ? '\n**Latest delivery:** ' + (stateLabels[last.state] ?? safe(last.state)) : ''}${q.some((p) => p.state === 'uncertain') ? '\n⚠ A queued submission is unconfirmed; it will not replay.' : ''}`,
      controls
    );
  }
  /** Read-only response controls have stable IDs so multipart retries keep an identical fingerprint. */
  async responseControls(
    id: string,
    channel: string,
    userCursor: string,
    responseCursor?: string
  ): Promise<NonNullable<DiscordPost['components']>> {
    const s = await this.target(id);
    if (this.host.channelForSession(id) !== channel) throw new Error('Response destination changed');
    const ctx: UiContext = { channel, session: id, conversation: s.conversation };
    const scope = this.host.scope();
    const responseHistory = async () => {
      const h = await this.host.history(id);
      await this.target(id, ctx.conversation);
      if (
        scope !== this.host.scope() ||
        h.conversationId !== ctx.conversation ||
        this.host.channelForSession(id) !== channel
      )
        throw new Error('Response conversation or Discord configuration changed.');
      return h;
    };
    if (!scope || !ctx.conversation) throw new Error('Native conversation is unavailable.');
    const anchor = responseCursor ?? userCursor;
    const bind = (label: string, run: UiAction['run']) =>
      this.action(ctx, label, run, undefined, 2, anchor + ':' + label);
    const controls: Array<Record<string, unknown>> = [
      bind('Show updates', async (m) => {
        const panel = { ...ctx, actor: m.member?.user?.id ?? m.user?.id };
        const state = await readDiscordTaskUpdates(this.taskReader(panel, scope), ctx.conversation!, userCursor);
        return this.updatesView(panel, userCursor, state, 0, scope);
      }),
    ];
    if (responseCursor) {
      controls.push(
        bind('Download response', async () => {
          const h = await responseHistory();
          let turn = h.turns.find((t) => t.cursor === responseCursor && t.role === 'assistant');
          if (!turn) {
            let task: DiscordTaskUpdates | undefined;
            for (let i = 0; i < 4; i++) {
              task = await readDiscordTaskUpdates(
                this.taskReader(ctx, scope),
                ctx.conversation!,
                userCursor,
                task,
                responseCursor
              );
              if (task.response || task.complete) break;
            }
            turn = task?.response;
          }
          if (!turn)
            throw new Error('Response is outside this bounded read. Use Updates to load more original task history.');
          await this.host.postFile(
            channel,
            { name: 'response.txt', data: Buffer.from(discordDisplayText(turn.text)) },
            'Requested assistant response',
            () => scope === this.host.scope() && this.host.channelForSession(id) === channel
          );
          return this.payload('Response file posted in this session thread.');
        }),
        bind('Results & files', (m) => this.results(m, id, { userCursor, responseCursor }))
      );
    }
    if (s.url && /^https?:\/\//.test(s.url))
      controls.unshift({ type: 2, style: 5, label: 'Open in Codeman', url: s.url });
    const ref = {
      scope: scope!,
      session: id,
      channel,
      conversation: ctx.conversation!,
      userCursor,
      ...(responseCursor ? { responseCursor } : {}),
      updated: this.host.now(),
    };
    const key = hash(JSON.stringify([scope, ctx, anchor]));
    const saved = (await this.store.snapshot()).responses[key];
    if (!saved)
      await this.store.edit((state) => {
        state.responses[key] = ref;
      });
    return [row(...controls)];
  }
  /** Initial table cards retain exact response readers; browsing opens an actor-owned private panel. */
  async tableResponsePosts(
    id: string,
    channel: string,
    userCursor: string,
    responseCursor: string,
    text: string,
    options: Parameters<typeof discordResponsePosts>[1] = {}
  ): Promise<DiscordPost[] | undefined> {
    const parts = discordTableParts(text);
    const tables = parts.filter((p) => 'table' in p);
    if (
      !tables.length ||
      tables.length > 4 ||
      text.length > 12000 ||
      tables.some((p) => !interactiveDiscordTable(p.table))
    )
      return undefined;
    const s = await this.target(id);
    if (this.host.channelForSession(id) !== channel || !s.conversation) throw new Error('Response destination changed');
    const ctx: UiContext = { channel, session: id, conversation: s.conversation };
    const scope = this.host.scope();
    const posts: DiscordPost[] = [];
    let index = 0;
    for (const part of parts) {
      if ('text' in part) {
        if (part.text.trim()) posts.push(...discordResponsePosts(part.text, { ...options, controls: [] }));
      } else {
        const view = this.tableView(ctx, scope, userCursor, responseCursor, part.table, index++, 0);
        const container = view.components![0];
        container.accent_color = options.color ?? 0x58a6ff;
        (container.components as unknown[]).unshift({
          type: 10,
          content: `**${options.title ?? 'Response'}**${options.subtitle ? '\n-# ' + options.subtitle : ''}`,
        });
        posts.push({
          ...view,
          allowed_mentions: noMentions,
          flags: DISCORD_COMPONENTS_V2 | 4 | (options.silent || posts.length > 0 ? DISCORD_SUPPRESS_NOTIFICATIONS : 0),
        });
      }
    }
    // Keep adjacent prose and compact rows in one card when Discord's limits permit.
    const merged: DiscordPost[] = [];
    for (const post of posts) {
      const previous = merged.at(-1);
      const left = previous?.components?.[0].components as Array<Record<string, unknown>> | undefined;
      const right = post.components?.[0].components as Array<Record<string, unknown>> | undefined;
      if (left && right) {
        const body = right[0]?.type === 10 && right[0].content === left[0]?.content ? right.slice(1) : right;
        const joined = [...left, { type: 14, divider: true, spacing: 1 }, ...body];
        const count = (nodes: Array<Record<string, unknown>>): number =>
          nodes.reduce((n, c) => n + 1 + (Array.isArray(c.components) ? count(c.components) : 0), 0);
        const size = joined.reduce((n, c) => n + (typeof c.content === 'string' ? c.content.length : 0), 0);
        if (size <= 3500 && count(joined) <= 30) {
          previous!.components![0].components = joined;
          continue;
        }
      }
      if (merged.length) post.flags = (post.flags ?? 0) | DISCORD_SUPPRESS_NOTIFICATIONS;
      merged.push(post);
    }
    if (merged.length > 8) return undefined;
    if (options.controls?.length) {
      const last = merged.at(-1)!;
      const container = last.components![0];
      (container.components as unknown[]).push({ type: 14, divider: true, spacing: 1 }, ...options.controls);
    }
    return merged;
  }
  private async responseTable(
    ctx: UiContext,
    scope: string | undefined,
    userCursor: string,
    responseCursor: string,
    index: number
  ): Promise<DiscordTable> {
    const reader = this.taskReader(ctx, scope);
    const recent = await this.host.history(ctx.session!);
    await this.target(ctx.session!, ctx.conversation);
    if (
      scope !== this.host.scope() ||
      recent.conversationId !== ctx.conversation ||
      this.host.channelForSession(ctx.session!) !== ctx.channel
    )
      throw new Error('Response conversation changed');
    let turn = recent.turns.find((t) => t.role === 'assistant' && t.cursor === responseCursor);
    if (!turn) {
      let state: DiscordTaskUpdates | undefined;
      for (let n = 0; n < 4; n++) {
        state = await readDiscordTaskUpdates(reader, ctx.conversation!, userCursor, state, responseCursor);
        if (state.response || state.complete) break;
      }
      turn = state?.response;
    }
    if (!turn)
      throw new Error('Original table is outside this bounded history read. Open Codeman for older responses.');
    const table = discordTableParts(discordDisplayText(turn.text)).filter((p) => 'table' in p)[index]?.table;
    if (!table || !interactiveDiscordTable(table)) throw new Error('Original table changed or is unavailable');
    return table;
  }
  private tableView(
    ctx: UiContext,
    scope: string | undefined,
    userCursor: string,
    responseCursor: string,
    table: DiscordTable,
    index: number,
    page: number
  ): DiscordUiPayload {
    const current = () =>
      scope === this.host.scope() &&
      this.host.channelForSession(ctx.session!) === ctx.channel &&
      (!ctx.actor || this.host.config().allowed.includes(ctx.actor));
    const button = (label: string, targetPage: number, op: 'page' | 'png' | 'csv', disabled = false) => {
      const b = this.action(
        ctx,
        label,
        async (m) => {
          const panel = { ...ctx, actor: m.member?.user?.id ?? m.user?.id };
          const authorized = () => current() && this.host.config().allowed.includes(panel.actor ?? '');
          const original = await this.responseTable(panel, scope, userCursor, responseCursor, index);
          if (!authorized() || hash(original.source) !== hash(table.source)) throw new Error('Original table changed');
          if (op === 'page')
            return this.tableView(panel, scope, userCursor, responseCursor, original, index, targetPage);
          const file =
            op === 'csv'
              ? { name: `table-${index + 1}.csv`, data: discordTableCsv(original) }
              : {
                  name: `table-${index + 1}-page-${targetPage + 1}.png`,
                  data: await discordTablePng(original, targetPage),
                };
          await this.target(ctx.session!, ctx.conversation);
          if (!authorized()) throw new Error('Response destination changed');
          await this.host.postFile(
            ctx.channel,
            file,
            op === 'csv' ? 'Requested table · all rows' : 'Requested table preview · CSV includes all rows',
            authorized
          );
          return this.tableView(panel, scope, userCursor, responseCursor, original, index, targetPage);
        },
        undefined,
        2,
        `${responseCursor}:table:${index}:${targetPage}:${op}:${hash(table.source).slice(0, 32)}`,
        `:t:${index}:${targetPage}:${op}:${hash(table.source).slice(0, 32)}`
      );
      if (disabled) b.disabled = true;
      return b;
    };
    const components = discordTablePage(table, page);
    if (table.rows.length > 3)
      components.push(
        row(
          button('Previous', Math.max(0, page - 1), 'page', page === 0),
          button(
            'Next',
            Math.min(Math.ceil(table.rows.length / 3) - 1, page + 1),
            'page',
            (page + 1) * 3 >= table.rows.length
          )
        )
      );
    components.push(row(button('View table', page, 'png'), button('Download CSV', page, 'csv')));
    return {
      content: '',
      flags: DISCORD_COMPONENTS_V2 | DISCORD_SUPPRESS_NOTIFICATIONS,
      allowed_mentions: noMentions,
      components: [{ type: 17, accent_color: 0x58a6ff, components }],
    };
  }
  private taskReader(
    ctx: UiContext,
    scope: string | undefined
  ): (after: string) => Promise<import('./discord-history.js').DiscordHistory> {
    const current = () =>
      scope === this.host.scope() &&
      this.host.channelForSession(ctx.session!) === ctx.channel &&
      (!ctx.actor || this.host.config().allowed.includes(ctx.actor));
    return async (after) => {
      if (!current()) throw new Error('Discord configuration changed.');
      const h = await this.host.history(ctx.session!, { after });
      await this.target(ctx.session!, ctx.conversation);
      if (!current() || h.conversationId !== ctx.conversation) throw new Error('Original task conversation changed.');
      return h;
    };
  }
  private updatesView(
    ctx: UiContext,
    userCursor: string,
    state: DiscordTaskUpdates,
    page: number,
    scope: string | undefined
  ): DiscordUiPayload {
    const text = renderDiscordTaskUpdates(state.updates),
      pages = discordDetailPages(text);
    const body = pages[page] ?? 'No assistant progress updates in the loaded task history.';
    const actions: Array<Record<string, unknown>> = [];
    if (page > 0)
      actions.push(this.action(ctx, 'Previous', async () => this.updatesView(ctx, userCursor, state, page - 1, scope)));
    if (page + 1 < pages.length)
      actions.push(this.action(ctx, 'Next', async () => this.updatesView(ctx, userCursor, state, page + 1, scope)));
    if (!state.complete)
      actions.push(
        this.action(ctx, 'Load more', async () => {
          const next = await readDiscordTaskUpdates(this.taskReader(ctx, scope), ctx.conversation!, userCursor, state);
          return this.updatesView(ctx, userCursor, next, page, scope);
        })
      );
    actions.push(
      this.action(ctx, 'Download updates', async () => {
        let full = state;
        for (let i = 0; i < 4 && !full.complete; i++)
          full = await readDiscordTaskUpdates(this.taskReader(ctx, scope), ctx.conversation!, userCursor, full);
        if (!full.complete) return this.updatesView(ctx, userCursor, full, page, scope);
        await this.target(ctx.session!, ctx.conversation);
        const current = () =>
          scope === this.host.scope() &&
          this.host.channelForSession(ctx.session!) === ctx.channel &&
          (!ctx.actor || this.host.config().allowed.includes(ctx.actor));
        if (!current()) throw new Error('Discord configuration changed.');
        const output = renderDiscordTaskUpdates(full.updates);
        if (Buffer.byteLength(output) > 8 * 1024 * 1024)
          throw new Error('Updates export exceeds the 8 MB Discord limit.');
        await this.host.postFile(
          ctx.channel,
          { name: 'updates.txt', data: Buffer.from(output || 'No assistant progress updates for this task.') },
          'Requested task updates',
          current
        );
        return this.payload(`Downloaded all ${full.updates.length} updates for this task.`);
      })
    );
    actions.push(
      this.action(ctx, 'Refresh', async () => {
        const refreshed = await readDiscordTaskUpdates(this.taskReader(ctx, scope), ctx.conversation!, userCursor);
        return this.updatesView(ctx, userCursor, refreshed, 0, scope);
      })
    );
    const rows = [];
    for (let i = 0; i < actions.length; i += 5) rows.push(row(...actions.slice(i, i + 5)));
    return this.payload(
      `**Updates · ${state.updates.length}${state.complete ? '' : ' loaded · more history available'}** · page ${Math.min(page + 1, Math.max(1, pages.length))}/${Math.max(1, pages.length)}\n\n${body}`,
      rows
    );
  }

  /** Reconstruct only response readers; never revive transient approval/queue/settings actions. */
  private async recoverResponseAction(
    m: DiscordInteraction,
    custom: string,
    scope: string
  ): Promise<UiAction | undefined> {
    const channel = m.channel_id!,
      id = this.host.sessionForChannel(channel);
    if (!id || !m.message?.id || !/^\d{15,25}$/.test(m.message.id)) return undefined;
    const s = await this.target(id);
    const conversation = s.conversation;
    if (!conversation) return undefined;
    const current = () =>
      scope === this.host.scope() &&
      this.host.channelForSession(id) === channel &&
      this.host.config().allowed.includes(m.member?.user?.id ?? m.user?.id ?? '');
    const message = (await this.host.request(
      'GET',
      `/channels/${channel}/messages/${m.message.id}`,
      undefined,
      current
    )) as { id?: string; channel_id?: string; author?: { id?: string }; components?: unknown[] } | null;
    const bot = await this.host.botId();
    const contains = (value: unknown, depth = 0): boolean => {
      if (depth > 8 || !value || typeof value !== 'object') return false;
      if (Array.isArray(value)) return value.slice(0, 40).some((v) => contains(v, depth + 1));
      const node = value as { custom_id?: string; components?: unknown };
      return node.custom_id === custom || contains(node.components, depth + 1);
    };
    if (
      !current() ||
      !bot ||
      message?.id !== m.message.id ||
      message.channel_id !== channel ||
      message.author?.id !== bot ||
      !contains(message.components)
    )
      return undefined;
    const refs = Object.values((await this.store.snapshot()).responses);
    for (const ref of refs) {
      if (ref.scope !== scope || ref.session !== id || ref.channel !== channel || ref.conversation !== conversation)
        continue;
      const ctx: UiContext = { channel, session: id, conversation };
      const anchor = ref.responseCursor ?? ref.userCursor;
      const route = /^cmui:[a-f0-9]{40}:t:(\d{1,2}):(\d{1,2}):(page|png|csv):([a-f0-9]{32})$/.exec(custom);
      if (route && ref.responseCursor) {
        const index = Number(route[1]),
          page = Number(route[2]),
          op = route[3];
        if (index >= 4 || page >= 67) continue;
        const key =
          'cmui:' +
          hash(JSON.stringify([scope, ctx, `${ref.responseCursor}:table:${index}:${page}:${op}:${route[4]}`])).slice(
            0,
            40
          );
        if (!custom.startsWith(key + ':t:')) continue;
        const table = await this.responseTable(ctx, scope, ref.userCursor, ref.responseCursor, index);
        if (hash(table.source).slice(0, 32) !== route[4]) return undefined;
        // Register this exact target page action, including neighboring navigation targets.
        this.tableView(ctx, scope, ref.userCursor, ref.responseCursor, table, index, page);
        // A page route encodes its destination; its button is generated on a neighboring page.
        if (op === 'page' && !this.actions.has(custom)) {
          this.tableView(ctx, scope, ref.userCursor, ref.responseCursor, table, index, page > 0 ? page - 1 : 1);
        }
        if (!current()) return undefined;
        const restored = this.actions.get(custom);
        if (restored) restored.message = m.message.id;
        return restored;
      }
      const match = ['Show updates', 'Download response', 'Results & files'].some(
        (label) => custom === 'cmui:' + hash(JSON.stringify([scope, ctx, anchor + ':' + label])).slice(0, 40)
      );
      if (!match) continue;
      await this.responseControls(id, channel, ref.userCursor, ref.responseCursor);
      if (!current()) return undefined;
      const restored = this.actions.get(custom);
      if (restored) restored.message = m.message.id;
      return restored;
    }
    const h = await this.host.history(id);
    if (!current() || h.conversationId !== conversation) return undefined;
    await this.target(id, conversation);
    if (!current()) return undefined;
    const ctx: UiContext = { channel, session: id, conversation };
    const matches = (anchor: string, labels: string[]) =>
      labels.some(
        (label) => custom === 'cmui:' + hash(JSON.stringify([scope, ctx, anchor + ':' + label])).slice(0, 40)
      );
    let restored = false;
    let user: string | undefined;
    for (const turn of h.turns.slice(-2048)) {
      if (turn.role === 'user') {
        user = turn.cursor;
        if (matches(user, ['Show updates'])) {
          await this.responseControls(id, channel, user);
          restored = true;
          break;
        }
      } else if (
        turn.role === 'assistant' &&
        user &&
        matches(turn.cursor, ['Show updates', 'Download response', 'Results & files'])
      ) {
        await this.responseControls(id, channel, user, turn.cursor);
        restored = true;
        break;
      }
    }
    if (!restored || !current()) return undefined;
    const action = this.actions.get(custom);
    if (action) action.message = m.message.id;
    return action;
  }

  async poll(): Promise<void> {
    if (this.polls) return this.polls;
    this.polls = this.runPoll()
      .catch((e) => {
        this.lastError = e instanceof Error ? e.message : 'Discord UI synchronization failed';
        throw e;
      })
      .finally(() => {
        this.polls = undefined;
      });
    return this.polls;
  }
  private async runPoll(): Promise<void> {
    if (!this.host.scope()) return;
    this.prune();
    await this.refreshQuestionPanels();
    await this.register();
    await this.retireLegacyCards();
    let sessions: DiscordUiSession[];
    try {
      sessions = await this.host.services.sessions();
    } catch (error) {
      await this.publishDashboard();
      throw error;
    }
    await this.observeSessionActivity(sessions);
    const list = sessions.filter((s) => this.host.channelForSession(s.id));
    for (let i = 0; i < Math.min(3, list.length); i++) {
      const s = list[(this.cardCursor + i) % list.length];
      const key = 'session:' + s.id;
      if ((this.errors.get(key) ?? 0) > this.host.now()) continue;
      try {
        const channel = this.host.channelForSession(s.id)!;
        if (!(await this.host.passive(s.id, channel))) continue;
        // Tokens rotate every two minutes, and immediately after process restart.
        const signature = hash(
          JSON.stringify([
            this.host.scope(),
            this.host.latestPrompt?.(s.id, s.conversation),
            s,
            (await this.host.receipts(s.id))[0],
            (await this.store.snapshot()).queue.filter((p) => p.session === s.id),
            Math.floor(this.host.now() / 120000),
            this.epoch,
          ])
        );
        const oldTokens = this.cardActions.get(key) ?? [];
        if (this.cardActions.get(key + ':signature')?.[0] !== signature) {
          const before = new Set(this.actions.keys());
          const payload = await this.sessionCard(s);
          await this.upsert(key, channel, payload, !this.cardActions.has(key));
          oldTokens.forEach((t) => this.actions.delete(t));
          this.cardActions.set(
            key,
            [...this.actions.keys()].filter((k) => !before.has(k))
          );
          this.cardActions.set(key + ':signature', [signature]);
        }
        await this.dispatchQueue(s);
      } catch (e) {
        this.lastError = e instanceof Error ? e.message : 'Session card update failed';
        this.errors.set(key, this.host.now() + 30000);
      }
    }
    this.cardCursor += Math.min(3, list.length);
    await this.publishDashboard(sessions);
  }
  private async publishDashboard(sessions?: DiscordUiSession[]): Promise<void> {
    if (this.host.now() >= this.dashboardDue) {
      this.dashboardDue = this.host.now() + 20000;
      const channel = this.host.config().parent;
      if (channel && this.host.ownsChannel(channel))
        try {
          const key = 'dashboard:main',
            before = new Set(this.actions.keys());
          await this.upsert(
            key,
            channel,
            await this.dashboard({ channel }, 'recent', 0, sessions),
            !this.cardActions.has(key)
          );
          for (const token of this.cardActions.get(key) ?? []) this.actions.delete(token);
          this.cardActions.set(
            key,
            [...this.actions.keys()].filter((k) => !before.has(k))
          );
        } catch (error) {
          this.lastError = error instanceof Error ? error.message : 'Activity dashboard update failed';
        }
    }
  }
  /** Receipt state stays in reactions/the journal; retire only our legacy per-prompt cards. */
  async receipt(id: string, receiptId: string): Promise<void> {
    const scope = this.host.scope(),
      channel = this.host.channelForSession(id);
    if (!scope || !channel) return;
    await this.retireLegacyCards(new Set([hash(scope + ':' + channel + ':delivery:' + receiptId)]));
  }
  private async retireLegacyCards(keys?: Set<string>): Promise<void> {
    const scope = this.host.scope();
    if (!scope) return;
    const cards = Object.entries((await this.store.snapshot()).cards)
      .filter(
        ([key, card]) =>
          (card.kind === 'delivery' || card.kind === 'result') &&
          card.phase === 'ready' &&
          card.message &&
          (!keys || keys.has(key)) &&
          (this.errors.get('retire:' + key) ?? 0) <= this.host.now() &&
          this.host.sessionForChannel(card.channel) &&
          this.host.ownsChannel(card.channel)
      )
      .slice(0, 3);
    for (const [key, card] of cards) {
      const session = this.host.sessionForChannel(card.channel)!;
      const current = () =>
        this.host.scope() === scope &&
        this.host.ownsChannel(card.channel) &&
        this.host.sessionForChannel(card.channel) === session &&
        this.host.channelForSession(session) === card.channel;
      try {
        if (!current()) return;
        if (!(await this.host.passive(session, card.channel))) {
          this.errors.set('retire:' + key, this.host.now() + 60000);
          continue;
        }
        const path = `/channels/${card.channel}/messages/${card.message}`;
        let missing = false;
        try {
          const message = (await this.host.request('GET', path)) as { author?: { id: string }; content?: string };
          const bot = await this.host.botId();
          const marker = `\n-# Codeman · ${card.kind} · ${key.slice(0, 10)}`;
          if (
            !bot ||
            message.author?.id !== bot ||
            !message.content?.startsWith(card.kind === 'result' ? '**Results & files · ' : '**Prompt delivery**') ||
            !message.content.endsWith(marker)
          )
            throw new Error('Legacy delivery-card ownership changed');
        } catch (error) {
          if ((error as { status?: number }).status !== 404) throw error;
          missing = true;
        }
        if (!current()) return;
        if (!missing) {
          try {
            await this.host.request('DELETE', path, undefined, current);
          } catch (error) {
            if ((error as { status?: number }).status !== 404) throw error;
          }
        }
        if (!current()) return;
        await this.store.edit((state) => {
          if (state.cards[key]?.message === card.message) delete state.cards[key];
        });
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : 'Legacy delivery-card cleanup failed';
        this.errors.set('retire:' + key, this.host.now() + 60000);
      }
    }
  }
  async register(): Promise<void> {
    if (this.registrations) return this.registrations;
    const scope = this.host.scope();
    if (!scope || this.registeredScope === scope) return;
    this.registrations = (async () => {
      const bot = await this.host.botId();
      if (!bot || this.host.scope() !== scope) return;
      const path = `/applications/${bot}/guilds/${this.host.config().guild}/commands`;
      const existing = (await this.host.request('GET', path)) as Array<{
        name: string;
        id: string;
        type: number;
        description?: string;
      }>;
      if (!Array.isArray(existing)) throw new Error('Cannot read Discord command registration');
      for (const name of names) {
        if (scope !== this.host.scope()) return;
        const found = existing.find((c) => c.name === name && c.type === 3);
        // The dedicated Codeman prefix reserves these app-local names; never bulk overwrite commands.
        const command = found ?? ((await this.host.request('POST', path, { name, type: 3 })) as { id: string });
        if (command?.id) this.commands.set(name, command.id);
      }
      const marker = 'Codeman: open the workspace dashboard';
      const found = existing.find((c) => c.name === 'codeman' && c.type === 1);
      if (!found || found.description === marker) {
        const command =
          found ??
          ((await this.host.request('POST', path, { name: 'codeman', type: 1, description: marker, options: [] })) as {
            id: string;
          });
        if (command?.id) this.commands.set('codeman', command.id);
      }
      if (scope === this.host.scope()) this.registeredScope = scope;
    })().finally(() => {
      this.registrations = undefined;
    });
    return this.registrations;
  }
  async interaction(m: DiscordInteraction): Promise<boolean> {
    const custom = m.data?.custom_id;
    const isCommand =
      m.type === 2 && this.commands.get(m.data?.name ?? '') === m.data?.id && this.commands.has(m.data?.name ?? '');
    if (!isCommand && !custom?.startsWith('cmui:')) return false;
    const scope = this.host.scope(),
      actor = m.member?.user?.id ?? m.user?.id;
    const reject = async (text: string) => {
      await this.host
        .respond(m, { type: 4, data: { content: text, flags: 64, allowed_mentions: noMentions } })
        .catch(() => undefined);
    };
    if (
      !scope ||
      !actor ||
      !this.host.config().allowed.includes(actor) ||
      m.guild_id !== this.host.config().guild ||
      !m.channel_id
    ) {
      await reject('This control is unavailable.');
      return true;
    }
    let action: UiAction | undefined;
    let recovering = false;
    if (custom) {
      action = this.actions.get(custom);
      recovering =
        m.type === 3 &&
        /^cmui:[a-f0-9]{40}(?::t:\d{1,2}:\d{1,2}:(?:page|png|csv):[a-f0-9]{32})?$/.test(custom) &&
        (!action || action.expires <= this.host.now());
      if (
        !recovering &&
        (!action ||
          (action.submitOnly ? m.type !== 5 : m.type !== 3) ||
          (action.group !== undefined && this.consumedGroups.has(action.group)) ||
          action.scope !== scope ||
          action.channel !== m.channel_id ||
          (action.actor && action.actor !== actor) ||
          action.expires <= this.host.now() ||
          (m.type === 3 && action.message && m.message?.id !== action.message))
      ) {
        await reject('This menu expired or changed. Use /codeman or !codeman ui to reopen it.');
        return true;
      }
      if (!recovering && action && !action.modal && (action.actor || action.group || action.submitOnly))
        this.actions.delete(custom);
      if (!recovering && action?.group) this.consumedGroups.set(action.group, this.host.now() + 6 * 60_000);
      if (!recovering && action?.modal && m.type === 3) {
        const id = 'cmui:' + randomUUID();
        this.actions.set(id, {
          ...action,
          modal: undefined,
          actor,
          message: undefined,
          group: undefined,
          submitOnly: true,
        });
        await this.host.respond(m, {
          type: 9,
          data: {
            custom_id: id,
            title: action.modal.title.slice(0, 45),
            components: action.modal.fields.map((f) =>
              row({
                type: 4,
                custom_id: f.id,
                label: f.label.slice(0, 45),
                style: f.multiline ? 2 : 1,
                required: !f.optional,
                max_length: f.max ?? 1000,
                ...(f.value ? { value: f.value } : {}),
              })
            ),
          },
        });
        return true;
      }
    }
    // All network/disk and provider work happens after Discord's immediate acknowledgement.
    await this.host.respond(
      m,
      !recovering && action?.actor && m.type === 3 ? { type: 6 } : { type: 5, data: { flags: 64 } }
    );
    try {
      if (!(await this.host.claim(m))) {
        await this.host.finish(m, this.payload('This interaction was already received; no action was replayed.'));
        return true;
      }
      if (scope !== this.host.scope() || !this.host.config().allowed.includes(actor))
        throw new Error('Discord configuration changed');
      if (recovering) {
        action = await this.recoverResponseAction(m, custom!, scope);
        if (!action) {
          await this.host.finish(
            m,
            this.payload(
              'This response control is no longer available in the current session history. Use /codeman or !codeman ui for current controls.'
            )
          );
          return true;
        }
      }
      if (action?.session) await this.target(action.session, action.conversation);
      let result: DiscordUiPayload | void;
      if (action) {
        const values: Record<string, string> = {};
        if (m.type === 3 && m.data?.values?.length === 1) values.selection = m.data.values[0];
        if (m.type === 5)
          for (const r of m.data?.components ?? [])
            for (const c of r.components ?? [])
              if (typeof c.value === 'string' && typeof c.custom_id === 'string') values[c.custom_id] = c.value;
        result = await action.run(m, values);
      } else if (m.data?.name === 'codeman') result = await this.dashboard(this.ctx(m));
      else result = await this.contextMessage(m);
      await this.host.finish(m, result ?? this.payload('Done. Reopen the session card for current state.'));
    } catch (e) {
      await this.host
        .finish(
          m,
          this.payload(
            'Action not confirmed: ' +
              safe(e instanceof Error ? e.message : 'Unknown error', 1400) +
              '\nCheck the current session before retrying. No ambiguous submission is replayed automatically.'
          )
        )
        .catch(() => undefined);
    }
    return true;
  }
  async command(id: string, channel: string, actor: string, command: string): Promise<boolean> {
    if (!['ui', 'dashboard', 'queue', 'settings', 'results'].includes(command)) return false;
    const m = { channel_id: channel, member: { user: { id: actor } } } as DiscordInteraction;
    const result =
      command === 'dashboard' || id.startsWith('__')
        ? await this.dashboard(this.ctx(m))
        : command === 'settings'
          ? await this.settings(m, id)
          : command === 'queue'
            ? await this.queueView(m, id)
            : command === 'results'
              ? await this.results(m, id)
              : await this.sessionCard(await this.target(id));
    await this.host.request('POST', `/channels/${channel}/messages`, uiWirePayload(result));
    return true;
  }
  private async settings(m: DiscordInteraction, id: string): Promise<DiscordUiPayload> {
    const s = await this.target(id),
      ctx = this.ctx(m, s);
    return this.payload(
      `**Settings · ${safe(s.name)}**\nReported model: ${safe(s.model || 'unknown')}\nReported effort: ${safe(s.effort || 'unknown')}\nLaunch approvals: ${safe(s.approval || 'CLI default')}\n\nSession changes use the provider’s native controls and preserve the conversation. Approval changes apply to future launches; this process is never restarted silently.`,
      [
        row(
          this.action(ctx, 'Model', (x) => this.nativeChoices(x, id, 'model')),
          this.action(ctx, 'Effort', (x) => this.nativeChoices(x, id, 'effort')),
          this.action(ctx, 'Future Codex defaults', async (x) => this.defaults(x))
        ),
      ]
    );
  }
  private async nativeChoices(m: DiscordInteraction, id: string, kind: 'model' | 'effort'): Promise<DiscordUiPayload> {
    const s = await this.target(id),
      result = await this.host.control(id, kind);
    if (!result.actions?.length) return this.payload(result.text);
    const choices = result.actions.map((a, i) => ({ label: a.label, value: String(i) }));
    return this.payload(result.text, [
      row(
        this.select(this.ctx(m, s), `Choose ${kind} for this session`, choices, async (_m, value) => {
          const a = result.actions![Number(value)];
          if (!this.host.current(id, a.validity))
            throw new Error('The native settings menu changed; request choices again');
          const r = await this.host.control(id, a.command);
          if (r.actions?.length)
            await this.host.postControl(id, this.host.channelForSession(id)!, r, 'ui-model:' + randomUUID());
          return this.payload(r.text);
        })
      ),
    ]);
  }
  private async defaults(m: DiscordInteraction): Promise<DiscordUiPayload> {
    const v = await this.host.services.defaults();
    return this.payload(
      `**Future Codex launch defaults**\nModel: ${safe(v.model || 'CLI default')}\nEffort: ${safe(v.effort || 'CLI default')}\nApprovals: ${safe(v.approval)}\nChanges affect future built-in launches only. Running sessions and complete custom commands retain their current settings.`,
      [
        row(
          this.action(
            this.ctx(m),
            'Edit future defaults',
            async (_m, fields) => {
              const scope = this.host.scope();
              await this.host.services.saveDefaults(
                {
                  model: fields.model?.trim() ?? '',
                  effort: fields.effort?.trim() ?? '',
                  approval: fields.approval?.trim() ?? '',
                },
                () => this.host.scope() === scope
              );
              return this.payload('Future Codex defaults saved. No running session was restarted or changed.');
            },
            {
              title: 'Future Codex launch defaults',
              fields: [
                { id: 'model', label: 'Model ID (blank = CLI default)', value: v.model, optional: true, max: 100 },
                { id: 'effort', label: 'Effort (blank = CLI default)', value: v.effort, optional: true, max: 20 },
                { id: 'approval', label: 'Approval: approve-all or ask', value: v.approval, max: 20 },
              ],
            }
          )
        ),
      ]
    );
  }
  private async refreshQuestionPanels(): Promise<void> {
    for (const [key, panel] of this.questionPanels) {
      if (panel.expires <= this.host.now()) {
        this.questionPanels.delete(key);
        continue;
      }
      const current = this.host.services.question(panel.session);
      if (!current || current.id !== panel.id || current.revision !== panel.revision) {
        this.questionPanels.delete(key);
        await this.host
          .finish(
            panel.interaction,
            this.payload('This prompt was resolved or replaced. Its old controls are disabled.')
          )
          .catch(() => undefined);
      }
    }
  }
  private async resolveQuestionPanels(id: string, revision: string, text: string): Promise<void> {
    for (const [key, panel] of this.questionPanels)
      if (panel.id === id && panel.revision === revision) {
        this.questionPanels.delete(key);
        await this.host
          .finish(panel.interaction, this.payload(text + '\nThe old prompt controls are disabled.'))
          .catch(() => undefined);
      }
  }
  private async question(m: DiscordInteraction, id: string): Promise<DiscordUiPayload> {
    const s = await this.target(id),
      q = this.host.services.question(id),
      ctx = this.ctx(m, s);
    const questionScope = this.host.scope();
    if (!q) return this.payload('No pending question or permission request.');
    if (q.terminalOnly)
      return this.payload(
        '**Needs input in the terminal**\n' +
          safe(q.text, 1200) +
          '\nThis CLI dialog cannot be answered safely through Discord. Open the exact session in Codeman.'
      );
    if (this.questionPanels.size < 128)
      this.questionPanels.set(hash(m.token + ':' + m.id), {
        interaction: m,
        session: id,
        id: q.id,
        revision: q.revision,
        expires: this.host.now() + 6 * 60_000,
      });
    const answer = async (value: string) => {
      const fresh = this.host.services.question(id);
      if (!fresh || fresh.id !== q.id || fresh.revision !== q.revision)
        throw new Error('This question was answered elsewhere or changed');
      const result = await this.host.services.answer(
        id,
        q.id,
        q.revision,
        value,
        () =>
          questionScope === this.host.scope() &&
          this.host.channelForSession(id) === ctx.channel &&
          !!ctx.actor &&
          this.host.config().allowed.includes(ctx.actor)
      );
      const label =
        q.kind === 'idle'
          ? value
          : value === 'deny'
            ? 'Deny'
            : (q.options.find((o) => String(o.n) === value)?.label ?? value);
      await this.resolveQuestionPanels(q.id, q.revision, 'Answered: ' + safe(label, 700));
      return this.payload(
        result +
          ' Selected answer: ' +
          safe(label, 700) +
          '\nThe prompt is resolved when the native answer service confirms it; old controls cannot answer a newer prompt.'
      );
    };
    if (q.kind === 'idle')
      return this.payload('**Your response**\n' + safe(q.text, 1200), [
        row(
          this.action(ctx, 'Write response', (_m, f) => answer(f.response), {
            title: 'Reply to this exact prompt',
            fields: [{ id: 'response', label: 'Response', multiline: true, max: 1000 }],
          })
        ),
      ]);
    const options = q.options.filter((o) => o.n >= 0 && o.n <= 9).map((o) => ({ label: o.label, value: String(o.n) }));
    if (q.kind === 'permission') options.push({ label: 'Deny', value: 'deny' });
    return this.payload(
      '**' +
        (q.kind === 'permission' ? 'Permission needed' : 'Question') +
        '**\n' +
        safe(q.text, 1200) +
        '\nChoose one supported answer. Multi-select and free text are unavailable for this native dialog.',
      options.length ? [row(this.select(ctx, 'Choose your answer', options, (_m, value) => answer(value)))] : []
    );
  }
  private async delivery(m: DiscordInteraction, id: string): Promise<DiscordUiPayload> {
    const receipts = (await this.host.receipts(id)).slice(0, 5);
    return this.payload(
      '**Recent prompt deliveries**\n' +
        (receipts
          .map(
            (r) =>
              `• ${safe(r.state)}${r.reason ? ' · ' + safe(r.reason) : ''}${r.message ? ' · source ' + safe(r.message) : ''}`
          )
          .join('\n') || 'No tracked input yet.') +
        '\n\nReceived ≠ submitted. “input_accepted” confirms transport delivery only. Native execution events confirm submitted, working and finished. Ambiguous input is never replayed.',
      [
        row(
          this.action(this.ctx(m, await this.target(id)), 'Refresh status', async (x) => {
            await this.host.history(id);
            return this.delivery(x, id);
          })
        ),
      ]
    );
  }
  private async queueView(m: DiscordInteraction, id: string): Promise<DiscordUiPayload> {
    const s = await this.target(id),
      ctx = this.ctx(m, s),
      items = (await this.store.snapshot()).queue.filter(
        (p) => p.session === id && p.channel === this.host.channelForSession(id)
      );
    const components = [
      row(
        this.action(
          ctx,
          'Add follow-up',
          async (_m, v) => {
            if (!s.conversation) throw new Error('Conversation unavailable');
            await this.store.enqueue({
              session: id,
              conversation: s.conversation,
              inputRevision: s.inputRevision,
              scope: this.host.scope()!,
              channel: this.host.channelForSession(id)!,
              actor: ctx.actor!,
              source: 'queue:' + _m.id,
              text: v.prompt.trim(),
            });
            return this.queueView(_m, id);
          },
          {
            title: 'Queue a follow-up',
            fields: [{ id: 'prompt', label: 'Prompt for the next idle boundary', multiline: true, max: 1000 }],
          }
        )
      ),
    ];
    if (items.length)
      components.push(
        row(
          this.select(
            ctx,
            'Edit, remove or inspect a queued prompt',
            items.map((p, i) => ({ label: `${i + 1}. ${p.text.slice(0, 65)}`, value: p.id, description: p.state })),
            async (x, value) => this.queueItem(x, id, value)
          )
        )
      );
    return this.payload(
      '**Follow-up queue · ' +
        safe(s.name) +
        '**\n' +
        (items
          .map(
            (p, i) =>
              `${i + 1}. ${safe(p.text, 130)}\n   ${p.state === 'uncertain' ? '⚠ Submission unconfirmed — manual review required' : p.scope !== this.host.scope() ? 'Paused: configuration changed' : p.conversation !== s.conversation ? 'Paused: conversation changed' : p.inputRevision !== s.inputRevision ? 'Paused: input changed; remove and add explicitly' : p.created < this.host.now() - 86400000 ? 'Expired: remove or edit before dispatch' : p.state}`
          )
          .join('\n') || 'No follow-ups queued.') +
        '\n\n10 prompts per session · queued text is stored privately until submission/removal · expires after 24 hours. Attachments prepared through the bridge remain in the workspace. Dispatch pauses for drafts, questions, disconnects and changed conversations.',
      components
    );
  }
  private async queueItem(m: DiscordInteraction, id: string, promptId: string): Promise<DiscordUiPayload> {
    const s = await this.target(id),
      p = (await this.store.snapshot()).queue.find(
        (v) => v.id === promptId && v.session === id && v.channel === this.host.channelForSession(id)
      );
    if (!p) throw new Error('Queued prompt is gone');
    const ctx = this.ctx(m, s),
      revision = hash(JSON.stringify(p));
    const edit = async (text?: string) =>
      this.store.edit((state) => {
        const at = state.queue.findIndex((v) => v.id === promptId);
        if (at < 0 || hash(JSON.stringify(state.queue[at])) !== revision) throw new Error('Queue changed; reopen it');
        if (state.queue[at].state === 'submitting') throw new Error('Prompt is already submitting');
        if (text !== undefined) {
          if (state.queue[at].scope !== this.host.scope())
            throw new Error('Configuration changed; remove the old prompt and create a new one explicitly');
          if (state.queue[at].state !== 'queued')
            throw new Error('Unconfirmed submissions cannot be edited or resubmitted');
          state.queue[at].text = text;
          state.queue[at].created = this.host.now();
        } else state.queue.splice(at, 1);
      });
    return this.payload(
      `**Queued prompt**\n${safe(p.text, 1200)}\nState: ${safe(p.state)}${p.state === 'uncertain' ? '\nInspect the terminal before removing this record. Removal never resubmits it.' : ''}`,
      [
        row(
          this.action(
            ctx,
            'Edit',
            async (x, v) => {
              await edit(v.prompt.trim());
              return this.queueView(x, id);
            },
            {
              title: 'Edit queued prompt',
              fields: [{ id: 'prompt', label: 'Prompt', value: p.text.slice(0, 1000), multiline: true, max: 1000 }],
            }
          ),
          this.action(
            ctx,
            'Remove',
            async (x) => {
              await edit();
              return this.queueView(x, id);
            },
            undefined,
            4
          )
        ),
      ]
    );
  }
  private async dispatchQueue(s: DiscordUiSession): Promise<void> {
    if (s.working || s.pending || s.exited || !s.ready || !s.conversation) return;
    const scope = this.host.scope(),
      p = (await this.store.snapshot()).queue.find((p) => p.session === s.id && p.scope === scope);
    if (
      !p ||
      p.state !== 'queued' ||
      p.conversation !== s.conversation ||
      !p.inputRevision ||
      p.inputRevision !== s.inputRevision ||
      p.created < this.host.now() - 86400000 ||
      !this.host.config().allowed.includes(p.actor)
    )
      return;
    const history = await this.host.history(s.id);
    if (
      history.conversationId !== p.conversation ||
      !['completed', 'interrupted'].includes(history.executions?.at(-1)?.state ?? '')
    )
      return;
    let taken = false;
    await this.store.edit((state) => {
      const current = state.queue.find((v) => v.id === p.id);
      if (current?.state === 'queued' && current.text === p.text) {
        current.state = 'submitting';
        taken = true;
      }
    });
    if (!taken) return;
    let result: 'accepted' | 'uncertain' | 'blocked' = 'uncertain';
    try {
      result = await this.host.submit(
        s.id,
        p.channel,
        p.actor,
        p.source,
        p.text,
        p.conversation,
        true,
        p.inputRevision
      );
    } catch {
      /* Ambiguous submissions never return to the automatic queue. */
    }
    await this.store.edit((state) => {
      const at = state.queue.findIndex((v) => v.id === p.id);
      if (at < 0) return;
      if (result === 'accepted') state.queue.splice(at, 1);
      else state.queue[at].state = result === 'blocked' ? 'queued' : 'uncertain';
    });
  }
  /** Explicit results view; output controls stay bound to the chosen native response. */
  private async results(
    m: DiscordInteraction,
    id: string,
    selected?: { userCursor: string; responseCursor: string }
  ): Promise<DiscordUiPayload> {
    const s = await this.target(id),
      ctx = this.ctx(m, s),
      scope = this.host.scope();
    const history = await this.host.history(id);
    await this.target(id, ctx.conversation);
    if (history.conversationId !== ctx.conversation || scope !== this.host.scope())
      throw new Error('Result conversation changed. Reopen its controls.');
    let answer = selected
      ? history.turns.find((t) => t.cursor === selected.responseCursor && t.role === 'assistant')
      : [...history.turns].reverse().find((t) => t.role === 'assistant' && t.phase !== 'commentary');
    if (selected && !answer) {
      let task: DiscordTaskUpdates | undefined;
      for (let page = 0; page < 4; page++) {
        task = await readDiscordTaskUpdates(
          this.taskReader(ctx, scope),
          ctx.conversation!,
          selected.userCursor,
          task,
          selected.responseCursor
        );
        if (task.response || task.complete) break;
      }
      answer = task?.response;
      if (!answer)
        throw new Error('This response is outside the available history. Use Show updates to load the original task.');
    }
    const text = answer ? discordDisplayText(answer.text) : '';
    const paths = discordArtifactPaths(text).slice(0, DISCORD_ARTIFACT_COUNT);
    const controls: Array<Record<string, unknown>> = paths.map((path) =>
      this.action(ctx, 'Download ' + safe(posix.basename(path), 65), async () => {
        await this.target(id, ctx.conversation);
        const file = await this.host.file(id, path);
        await this.target(id, ctx.conversation);
        await this.host.postFile(
          ctx.channel,
          file,
          'File from this answer · ' + safe(file.name),
          () => scope === this.host.scope() && this.host.channelForSession(id) === ctx.channel
        );
        return this.payload('File uploaded. Discord previews supported formats.');
      })
    );
    let changed = false;
    try {
      if (this.host.services.workspaceHasChanges) changed = await this.host.services.workspaceHasChanges(id);
      else {
        const changes = await this.host.services.workspace(id);
        changed = !!changes.diff.trim() && !changes.diff.startsWith('No exportable tracked diff.');
      }
    } catch {
      /* Non-Git or unavailable workspace: the answer still works. */
    }
    if (changed)
      controls.push(
        this.action(ctx, 'View changes', async () => {
          const current = await this.host.services.workspace(id);
          return this.payload(
            '**Workspace changes**\n' +
              current.summary.slice(0, 1400) +
              '\n\nIncludes changes from other sessions using this workspace.'
          );
        })
      );
    const pages = discordDetailPages(formatDiscordResponseText(text));
    if (pages.length > 1)
      controls.push(
        this.action(ctx, 'Download answer', async () => {
          await this.target(id, ctx.conversation);
          await this.host.postFile(
            ctx.channel,
            { name: 'response.txt', data: Buffer.from(text) },
            'Full answer',
            () => scope === this.host.scope() && this.host.channelForSession(id) === ctx.channel
          );
          return this.payload('Full answer uploaded.');
        })
      );
    controls.push(this.action(ctx, 'More', (x) => this.resultDetails(x, id)));
    await this.target(id, ctx.conversation);
    if (scope !== this.host.scope()) throw new Error('Discord configuration changed. Reopen results.');
    const answerIndex = answer ? history.turns.findIndex((t) => t.cursor === answer.cursor) : -1;
    const userCursor =
      selected?.userCursor ??
      (answerIndex >= 0
        ? history.turns
            .slice(0, answerIndex)
            .reverse()
            .find((t) => t.role === 'user')?.cursor
        : undefined);
    const state = history.executions?.find((e) => e.userCursor === userCursor)?.state;
    const status =
      state === 'completed'
        ? '✓ Completed'
        : state === 'running'
          ? 'Working'
          : state === 'interrupted'
            ? 'Interrupted'
            : '';
    const preview = pages[0];
    return this.payload(
      `**${safe(s.name)}**${status ? ' · ' + status : ''}\n\n${preview || 'No answer is available yet.'}${pages.length > 1 ? '\n\nChoose Download answer for the full response.' : ''}`,
      controls.length ? [row(...controls.slice(0, 5)), ...(controls.length > 5 ? [row(...controls.slice(5))] : [])] : []
    );
  }
  private async resultDetails(m: DiscordInteraction, id: string): Promise<DiscordUiPayload> {
    const s = await this.target(id),
      ctx = this.ctx(m, s);
    let execution = 'Not available';
    try {
      execution = (await this.host.history(id)).executions?.at(-1)?.state ?? 'Not available';
    } catch {
      /* Explicit unknown. */
    }
    return this.payload(
      `**More · ${safe(s.name)}**\nNative execution: ${safe(execution)}\n\nWorkspace changes are a shared-worktree snapshot, not automatically attributed to this task. Verification results are not inferred from assistant prose. Use History for the agent’s report and inspect the actual evidence.`,
      [
        row(
          this.action(ctx, 'Workspace changes', async () => {
            const changes = await this.host.services.workspace(id);
            return this.payload('**Workspace snapshot — attribution unverified**\n' + changes.summary.slice(0, 1500));
          }),
          this.action(ctx, 'Download diff', async () => {
            const changes = await this.host.services.workspace(id);
            await this.host.postFile(
              m.channel_id!,
              { name: 'workspace-snapshot.diff', data: Buffer.from(changes.diff) },
              'Workspace diff snapshot — may include other sessions’ changes.'
            );
            return this.payload('Workspace diff uploaded. Task attribution is not assumed.');
          }),
          this.action(
            ctx,
            'Download / preview file',
            async (_m, v) => {
              const file = await this.host.file(id, v.path.trim());
              await this.target(id, s.conversation);
              await this.host.postFile(m.channel_id!, file, 'Session workspace file · ' + safe(file.name));
              return this.payload('File uploaded. Discord previews supported image/document formats.');
            },
            {
              title: 'Open a workspace artifact',
              fields: [{ id: 'path', label: 'Absolute file path in this workspace', max: 1000 }],
            }
          )
        ),
        row(
          this.action(ctx, 'Download execution receipt', async () => {
            const receipts = await this.host.receipts(id);
            await this.host.postFile(
              m.channel_id!,
              {
                name: 'execution-receipt.json',
                data: Buffer.from(
                  JSON.stringify(
                    {
                      session: s.id,
                      conversation: s.conversation,
                      inputRevision: s.inputRevision,
                      nativeExecution: execution,
                      deliveries: receipts,
                      verification: 'not inferred from conversational text',
                    },
                    null,
                    2
                  )
                ),
              },
              'Observed execution and delivery metadata.'
            );
            return this.payload('Execution receipt uploaded.');
          })
        ),
      ]
    );
  }
  private activityKey(id: string): string {
    return hash(JSON.stringify([this.host.scope(), this.host.channelForSession(id), id]));
  }
  /** The event time comes from native evidence, never from a dashboard refresh. */
  async observeHistory(id: string, history: DiscordHistory): Promise<void> {
    const event = activityFromHistory(history, this.host.now());
    if (!event || event.at < this.host.now() - 30 * 86400000) return;
    const scope = this.host.scope(),
      channel = this.host.channelForSession(id);
    if (!scope || !channel) return;
    if (this.host.sessionForChannel(channel) !== id) return;
    const message = event.responseCursor ? await this.host.responseMessage?.(id, event.responseCursor) : undefined;
    if (this.host.scope() !== scope || this.host.channelForSession(id) !== channel) return;
    const key = this.activityKey(id),
      old = (await this.store.snapshot()).activities[key];
    const same = old?.conversation === event.conversation && old.cursor === event.cursor && old.kind === event.kind;
    if (!newerActivity(old, event) && !(same && message && old.message !== message)) return;
    await this.store.edit((state) => {
      const prior = state.activities[key];
      if (newerActivity(prior, event) || (same && message))
        state.activities[key] = { scope, session: id, channel, ...event, ...(message ? { message } : {}) };
    });
  }
  private async observeSessionActivity(sessions: DiscordUiSession[]): Promise<void> {
    const scope = this.host.scope();
    if (!scope) return;
    const snapshot = await this.store.snapshot();
    const changes: Array<[string, DiscordActivityRecord]> = [];
    for (const s of sessions) {
      const channel = this.host.channelForSession(s.id);
      if (!channel) continue;
      const key = this.activityKey(s.id),
        old = snapshot.activities[key];
      let event: DiscordActivityEvent | undefined;
      if (s.lastPromptAt && s.lastPromptAt <= this.host.now())
        event = {
          conversation: s.conversation ?? '',
          kind: 'prompt',
          cursor: 'prompt:' + s.lastPromptAt,
          at: s.lastPromptAt,
          summary: 'New prompt submitted.',
        };
      if (s.pending) {
        const cursor = 'question:' + (s.pendingRevision ?? 'observed');
        const at =
          old?.kind === 'question' && old.cursor === cursor && old.conversation === (s.conversation ?? '')
            ? old.at
            : (s.pendingAt ?? this.host.now());
        const question: DiscordActivityEvent = {
          conversation: s.conversation ?? '',
          kind: 'question',
          cursor,
          at: Math.min(at, this.host.now()),
          summary: 'Waiting for your answer to continue.',
        };
        if (newerActivity(event, question)) event = question;
      }
      if (event && event.at >= this.host.now() - 30 * 86400000 && newerActivity(old, event))
        changes.push([key, { scope, session: s.id, channel, ...event }]);
    }
    if (changes.length && this.host.scope() === scope)
      await this.store.edit((state) => {
        for (const [key, event] of changes)
          if (newerActivity(state.activities[key], event)) state.activities[key] = event;
      });
  }
  private async dashboard(
    ctx: UiContext,
    view: DiscordActivityView = 'recent',
    page = 0,
    observed?: DiscordUiSession[]
  ): Promise<DiscordUiPayload> {
    const scope = this.host.scope();
    let all: DiscordUiSession[],
      stale = false;
    try {
      all = observed ?? (await this.host.services.sessions());
      this.activitySnapshot = { scope, sessions: all, at: this.host.now() };
    } catch (error) {
      if (!this.activitySnapshot || this.activitySnapshot.scope !== scope) throw error;
      all = this.activitySnapshot.sessions;
      stale = true;
    }
    await this.observeSessionActivity(all);
    const stored = (await this.store.snapshot()).activities;
    const entries = all
      .map((s) => {
        const record = stored[this.activityKey(s.id)];
        const activity =
          record?.scope === scope &&
          record.channel === this.host.channelForSession(s.id) &&
          (!s.conversation || record.conversation === s.conversation)
            ? record
            : undefined;
        const finished =
          !s.working &&
          !s.pending &&
          !s.exited &&
          activity?.kind === 'completed' &&
          activity.at >= this.host.now() - 3600000;
        const error = activity?.kind === 'error' && activity.at >= this.host.now() - 3600000;
        return { s, activity, finished, error };
      })
      .sort((a, b) => (b.activity?.at ?? 0) - (a.activity?.at ?? 0) || a.s.name.localeCompare(b.s.name));
    const filtered = entries.filter(
      (e) =>
        view === 'recent' ||
        (view === 'working'
          ? e.s.working && !e.s.pending && !e.s.exited
          : view === 'finished'
            ? e.finished
            : e.s.pending || e.error)
    );
    const last = Math.max(0, Math.ceil(filtered.length / 5) - 1);
    page = Math.max(0, Math.min(page, last));
    const visible = filtered.slice(page * 5, page * 5 + 5);
    const text = (content: string) => ({ type: 10, content });
    const header: Array<Record<string, unknown>> = [
      text('-# CODEMAN · WORKSPACE\n## Activity\nPick up where the work is happening.'),
      text(
        `🟡 **${entries.filter((e) => e.s.working && !e.s.pending && !e.s.exited).length} working** · ✅ **${entries.filter((e) => e.finished).length} done** · 🔴 **${entries.filter((e) => e.s.pending || e.error).length} needs you**\n-# ${all.length} sessions`
      ),
    ];
    if (stale) header.push(text('⚠️ **Connection interrupted**\nShowing the last known activity.'));
    const select = this.select(
      ctx,
      'Choose activity view',
      Object.entries(DISCORD_ACTIVITY_VIEWS).map(([value, [label, description]]) => ({ value, label, description })),
      (m, value) => this.dashboard(this.ctx(m), value as DiscordActivityView)
    );
    for (const option of select.options as Array<Record<string, unknown>>) option.default = option.value === view;
    header.push(row(select));
    const body: Array<Record<string, unknown>> = [
      text(
        `**${view === 'recent' ? 'Recent activity' : DISCORD_ACTIVITY_VIEWS[view][0]}**\n-# ${DISCORD_ACTIVITY_VIEWS[view][1]}.`
      ),
    ];
    if (!visible.length)
      body.push(
        text(
          view === 'attention'
            ? '✅ **You’re all caught up**\nNo sessions need your answer.'
            : '**Nothing here yet**\nNew activity will appear automatically.'
        )
      );
    for (const [i, { s, activity, finished, error }] of visible.entries()) {
      if (i) body.push({ type: 14, divider: true, spacing: 1 });
      const channel = this.host.channelForSession(s.id);
      const threadUrl = channel ? `https://discord.com/channels/${this.host.config().guild}/${channel}` : undefined;
      const icon = s.pending || error ? '🔴' : s.exited ? '⚫' : s.working ? '🟡' : finished ? '✅' : '⚫';
      const labels = {
        prompt: 'Prompt submitted',
        update: 'Progress update',
        response: 'Response received',
        completed: 'Turn finished',
        question: 'Needs your answer',
        error: 'Task failed',
        interrupted: 'Interrupted',
      };
      const label = s.pending
        ? 'Needs your answer'
        : s.exited
          ? 'Offline'
          : activity
            ? activity.kind === 'question'
              ? 'Question resolved'
              : labels[activity.kind]
            : s.working
              ? 'Working'
              : 'Idle';
      const time = activity ? ` · <t:${Math.floor(activity.at / 1000)}:R>` : '';
      const summary = activity?.summary || (s.working ? 'Work is in progress.' : 'Ready for your next message.');
      let accessory: Record<string, unknown>;
      if (s.pending)
        accessory = this.action(
          ctx,
          'Review',
          async (m) => {
            await this.target(s.id, s.conversation);
            return this.question(m, s.id);
          },
          undefined,
          1
        );
      else if (channel)
        accessory = {
          type: 2,
          style: 5,
          label: activity?.message && !s.working ? 'View reply' : 'Open thread',
          url: `https://discord.com/channels/${this.host.config().guild}/${channel}${activity?.message && !s.working ? '/' + activity.message : ''}`,
        };
      else
        accessory = {
          ...this.action(ctx, 'Unavailable', async () =>
            this.payload('This session has no current Discord destination.')
          ),
          disabled: true,
        };
      const heading = `${icon} ${activityText(s.name, 60)}`;
      const preview = activityPreviewText(summary, 120) || 'Open the thread for the latest update.';
      body.push({
        type: 9,
        components: [
          text(
            `**${heading}**\n${label}${time}\n-# ${threadUrl ? `[${preview}](${threadUrl})` : preview}\n-# ${activityText(s.caseName, 40)} · ${activityText(s.host, 30)}`
          ),
        ],
        accessory,
      });
    }
    const refresh = (m: DiscordInteraction, p = page) => this.dashboard(this.ctx(m), view, p);
    const actions = row(
      { ...this.action(ctx, 'Previous', (m) => refresh(m, page - 1)), disabled: page === 0 },
      { ...this.action(ctx, 'Next', (m) => refresh(m, page + 1)), disabled: page >= last },
      this.action(ctx, 'Refresh', (m) => refresh(m))
    );
    const launch = row(this.action(ctx, '+ New session', (m) => this.launchPicker(m), undefined, 1));
    const url = all.find((s) => s.url)?.url;
    if (url) launch.components.push({ type: 2, style: 5, label: 'Open Codeman', url });
    return {
      content: '',
      flags: DISCORD_COMPONENTS_V2 | DISCORD_SUPPRESS_NOTIFICATIONS,
      allowed_mentions: noMentions,
      components: [
        { type: 17, accent_color: stale ? 0xf0b35b : 0x9b8afb, components: header },
        { type: 17, components: body },
        text(
          `-# ${filtered.length ? `${page * 5 + 1}–${Math.min((page + 1) * 5, filtered.length)} of ${filtered.length}` : '0 sessions'} · ${stale ? 'Last synced' : 'Synced'} <t:${Math.floor((this.activitySnapshot?.at ?? this.host.now()) / 1000)}:R> · Updates silently`
        ),
        actions,
        launch,
      ],
    };
  }
  private async launchPicker(m: DiscordInteraction, source?: GatewayMessage, page = 0): Promise<DiscordUiPayload> {
    const cases = await this.host.services.cases(),
      list = cases.slice(page * 25, page * 25 + 25),
      ctx = this.ctx(m);
    if (!list.length) return this.payload('No supported case is available. Configure a case in Codeman.');
    const rows = [
      row(
        this.select(
          ctx,
          'Choose case and host',
          list.map((c) => ({ label: c.name, value: c.key, description: c.host })),
          async (x, key) => this.chooseLaunchMode(x, key, source)
        )
      ),
    ];
    if (page > 0 || cases.length > (page + 1) * 25)
      rows.push(
        row(
          ...(page > 0 ? [this.action(ctx, 'Previous', (x) => this.launchPicker(x, source, page - 1))] : []),
          ...(cases.length > (page + 1) * 25
            ? [this.action(ctx, 'Next', (x) => this.launchPicker(x, source, page + 1))]
            : [])
        )
      );
    return this.payload(
      '**Start a session**\nChoose the exact case and host. Launch defaults apply. You will review the launch before it starts.' +
        (source ? '\nSelected message and attachments are retained for a separate, explicit send after creation.' : ''),
      rows
    );
  }
  private async chooseLaunchMode(
    m: DiscordInteraction,
    key: string,
    source?: GatewayMessage
  ): Promise<DiscordUiPayload> {
    const ctx = this.ctx(m),
      modes = this.host.modes();
    if (!modes.length) return this.payload('No enabled CLI is available. Enable one in Codeman settings.');
    return this.payload('**Choose the CLI**', [
      row(
        this.select(
          ctx,
          'CLI',
          modes.map((value) => ({ label: value, value })),
          async (x, mode) => {
            const result = await this.host.launch('__management__', key, mode);
            return this.confirmLaunch(x, result, source);
          }
        )
      ),
    ]);
  }
  private confirmLaunch(
    m: DiscordInteraction,
    result: import('./discord-bridge.js').DiscordControlReply,
    source?: GatewayMessage
  ): DiscordUiPayload {
    const ctx = this.ctx(m);
    return this.payload(
      result.text,
      result.actions?.length
        ? [
            row(
              ...result.actions.slice(0, 5).map((a) =>
                this.action(ctx, a.label, async (x) => {
                  if (!this.host.current('__management__', a.validity)) throw new Error('Launch confirmation expired');
                  const r = await this.host.control('__management__', a.command);
                  if (r.locateSessionId) {
                    const destination = await this.host.locate(r.locateSessionId);
                    const located = destination
                      ? '\n<#' + destination + '>'
                      : '\nDestination not yet available; open Codeman to inspect the new session.';
                    if (source)
                      return this.payload('Session created. Source message has not been submitted.' + located, [
                        row(
                          this.action(this.ctx(x), 'Review source for new session', async (y) =>
                            this.contextReview(y, source, r.locateSessionId!, 'Queue next')
                          )
                        ),
                      ]);
                    return this.payload(r.text + located);
                  }
                  return this.payload(r.text);
                })
              )
            ),
          ]
        : []
    );
  }
  private async contextMessage(m: DiscordInteraction): Promise<DiscordUiPayload> {
    const selected = m.data?.target_id,
      raw = selected ? m.data?.resolved?.messages?.[selected] : undefined;
    if (!selected || !raw || raw.channel_id !== m.channel_id) throw new Error('Selected message is unavailable');
    const source = (await this.host.request('GET', `/channels/${m.channel_id}/messages/${selected}`)) as GatewayMessage;
    if (source.id !== selected || source.channel_id !== m.channel_id) throw new Error('Selected source changed');
    if (m.data?.name === names[2]) return this.launchPicker(m, source);
    return this.contextPicker(m, source, m.data?.name === names[1] ? 'Queue next' : 'Send now');
  }
  private async contextPicker(
    m: DiscordInteraction,
    source: GatewayMessage,
    timing: string,
    page = 0
  ): Promise<DiscordUiPayload> {
    const sessions = (await this.host.services.sessions()).filter(
        (s) => !s.exited && this.host.channelForSession(s.id)
      ),
      list = sessions.slice(page * 25, page * 25 + 25),
      ctx = this.ctx(m);
    if (!list.length) return this.payload('No session is available. Use /codeman to start one.');
    const rows = [
      row(
        this.select(
          ctx,
          'Choose the destination session',
          list.map((s) => ({ label: s.name, value: s.id, description: s.caseName + ' · ' + s.host })),
          (x, id) => this.contextReview(x, source, id, timing)
        )
      ),
    ];
    if (page > 0 || sessions.length > (page + 1) * 25)
      rows.push(
        row(
          ...(page > 0 ? [this.action(ctx, 'Previous', (x) => this.contextPicker(x, source, timing, page - 1))] : []),
          ...(sessions.length > (page + 1) * 25
            ? [this.action(ctx, 'Next', (x) => this.contextPicker(x, source, timing, page + 1))]
            : [])
        )
      );
    return this.payload(
      '**Select a destination**\n' +
        safe(source.content || 'Attached files', 500) +
        `\n${source.attachments?.length ?? 0} attachment(s). Nothing has been submitted.`,
      rows
    );
  }
  private async contextReview(
    m: DiscordInteraction,
    source: GatewayMessage,
    id: string,
    timing: string
  ): Promise<DiscordUiPayload> {
    const s = await this.target(id);
    if (!s.conversation)
      throw new Error(
        'Wait for this session’s exact conversation to be identified, then reopen the source message action'
      );
    const ctx = { ...this.ctx(m, s), group: 'context:' + m.id + ':' + source.id };
    const send = async (queue: boolean) => {
      const fresh = (await this.host.request(
        'GET',
        `/channels/${source.channel_id}/messages/${source.id}`
      )) as GatewayMessage;
      if (sourceSignature(fresh) !== sourceSignature(source))
        throw new Error('Source message changed; select it again');
      const text = await this.host.prepare(id, {
        ...fresh,
        author: { id: ctx.actor! },
        content: `[Selected Discord message ${source.id}; user-provided context]\n${source.content}`,
      });
      await this.target(id, s.conversation);
      const sourceKey = `context:${m.id}:${source.id}`;
      if (queue) {
        await this.store.enqueue({
          session: id,
          conversation: s.conversation!,
          inputRevision: s.inputRevision,
          scope: this.host.scope()!,
          channel: this.host.channelForSession(id)!,
          actor: ctx.actor!,
          source: sourceKey,
          text: text.replace(/\r$/, ''),
        });
        return this.payload('Selected message and attachments queued for ' + safe(s.name) + '.');
      }
      const result = await this.host.submit(
        id,
        this.host.channelForSession(id)!,
        ctx.actor!,
        sourceKey,
        text,
        s.conversation!
      );
      return this.payload(
        result === 'accepted'
          ? 'Selected context delivered. Native submission is not yet confirmed.'
          : result === 'blocked'
            ? 'Session unavailable or dialog pending. Nothing was sent.'
            : 'Submission unconfirmed; inspect the session before retrying.'
      );
    };
    return this.payload(
      `**Review destination: ${safe(s.name)} · ${safe(s.host)}**\n${safe(source.content, 800)}\n${source.attachments?.length ?? 0} attachment(s)\n\nRequested timing: ${timing}. Confirm explicitly. Source content is user-provided material.`,
      [
        row(
          this.action(ctx, 'Send now', () => send(false), undefined, 1),
          this.action(ctx, 'Queue next', () => send(true)),
          this.action(ctx, 'Cancel', async () => this.payload('Cancelled. Nothing submitted.'))
        ),
      ]
    );
  }
  /** Config disable invalidates every open ephemeral control immediately. Durable queue remains paused. */
  stop(): void {
    this.actions.clear();
    this.questionPanels.clear();
    this.cardActions.clear();
    this.consumedGroups.clear();
    this.registeredScope = '';
    this.commands.clear();
  }
}
