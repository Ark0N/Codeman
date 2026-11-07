import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiscordNativeUi, discordUiNodes, uiV2Payload, uiWirePayload } from '../src/discord-native-ui.js';
import { DiscordUiStore } from '../src/discord-ui-store.js';
import type {
  DiscordNativeUiHost,
  DiscordUiPayload,
  DiscordUiQuestion,
  DiscordUiSession,
} from '../src/discord-native-ui-types.js';
import type { DiscordInteraction, GatewayMessage } from '../src/discord-bridge.js';
const guild = '111111111111111111',
  channel = '222222222222222222',
  parent = '333333333333333333',
  actor = '444444444444444444',
  bot = '555555555555555555';
let seq = 100000000000000000n;
const snow = () => String(seq++);
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'discord-ui-test-'));
  dirs.push(dir);
  let scope: string | undefined = 'scope-a',
    now = 1000000;
  const sessions: DiscordUiSession[] = [
    {
      id: 's1',
      name: 'w1-Codeman',
      host: 'beelink',
      caseName: 'Codeman',
      mode: 'codex',
      conversation: 'conversation-one',
      inputRevision: 'input-one',
      working: true,
      pending: false,
      ready: true,
      exited: false,
      model: 'gpt-6.1 (screen)',
      approval: 'Approve all',
    },
  ];
  const messages = new Map<string, DiscordUiPayload & { id: string; channel: string; author: { id: string } }>();
  const commands: Array<{ id: string; name: string; type: number; description?: string }> = [];
  const responses: unknown[] = [],
    finishes: DiscordUiPayload[] = [];
  const claims = new Set<string>();
  let q: DiscordUiQuestion | undefined;
  const host: DiscordNativeUiHost = {
    dir,
    scope: () => scope,
    now: () => now,
    config: () => ({ guild, parent, allowed: [actor] }),
    services: {
      enabled: () => true,
      sessions: async () => sessions,
      cases: async () => [{ key: 'case-one', name: 'Codeman', host: 'beelink' }],
      defaults: async () => ({ model: 'gpt-6.1', effort: 'high', approval: 'approve-all' }),
      saveDefaults: vi.fn(async () => {}),
      question: () => q,
      answer: vi.fn(async () => {
        q = undefined;
        return 'Exact prompt answered';
      }),
      workspace: vi.fn(async () => ({ summary: '• src/example.ts', diff: '+ fixed\n' })),
      submitQueued: vi.fn(async () => 'accepted' as const),
    },
    sessionForChannel: (c) => (c === channel ? 's1' : undefined),
    channelForSession: (id) => (id === 's1' ? channel : undefined),
    ownsChannel: (c) => [channel, parent].includes(c),
    verify: vi.fn(async () => {}),
    passive: vi.fn(async () => true),
    request: vi.fn(async (method, path, body) => {
      if (path.endsWith('/commands')) {
        if (method === 'GET') return commands;
        if (method === 'POST') {
          const cmd = { ...(body as object), id: snow() } as (typeof commands)[number];
          commands.push(cmd);
          return cmd;
        }
      }
      if (path.includes('/pins/')) return null;
      if (method === 'GET' && path.includes('?limit='))
        return [...messages.values()].filter((m) => path.includes(m.channel));
      const match = /\/channels\/([^/]+)\/messages(?:\/([^/?]+))?$/.exec(path);
      if (match) {
        const [, c, id] = match;
        if (method === 'POST') {
          const m = { ...(body as DiscordUiPayload), id: snow(), channel: c, author: { id: bot } };
          messages.set(m.id, m);
          return m;
        }
        if (!id || !messages.has(id)) throw Object.assign(new Error('not found'), { status: 404 });
        if (method === 'DELETE') {
          messages.delete(id);
          return null;
        }
        if (method === 'PATCH') {
          const m = { ...messages.get(id)!, ...(body as DiscordUiPayload) };
          messages.set(id, m);
          return m;
        }
        return messages.get(id);
      }
      throw new Error('Unexpected request ' + method + ' ' + path);
    }),
    respond: vi.fn(async (_m, body) => {
      responses.push(body);
    }),
    finish: vi.fn(async (_m, body) => {
      finishes.push(body);
    }),
    control: vi.fn(async (_id, cmd) =>
      cmd === 'model' || cmd === 'effort'
        ? {
            text: 'Supported native choices',
            actions: [
              { label: cmd === 'model' ? 'GPT-6.1' : 'High', command: cmd + ' choose verified', validity: 'verified' },
            ],
          }
        : { text: 'Verified in the same conversation' }
    ),
    current: () => true,
    postControl: vi.fn(async () => {}),
    history: vi.fn(async () => ({
      conversationId: 'conversation-one',
      turns: [{ role: 'user' as const, text: 'Fix Discord defaults', cursor: 'u1', timestamp: '' }],
      partial: false,
      executions: [{ userCursor: 'u1', promptHash: 'abc', state: 'completed' as const }],
    })),
    prepare: vi.fn(async (_id, m) => m.content + '\r'),
    submit: vi.fn(async () => 'accepted' as const),
    note: vi.fn(async () => {}),
    receipts: async () => [{ id: 'input-one', state: 'input_accepted', updated: now }],
    claim: async (m) => {
      if (claims.has(m.id)) return false;
      claims.add(m.id);
      return true;
    },
    file: vi.fn(async () => ({ name: 'report.html', data: Buffer.from('report') })),
    postFile: vi.fn(async () => {}),
    launch: vi.fn(async () => ({
      text: 'Confirm launch',
      actions: [{ label: 'Confirm', command: 'confirm launch', validity: 'launch' }],
    })),
    modes: () => ['codex', 'claude'],
    locate: vi.fn(async () => channel),
    botId: async () => bot,
  };
  const ui = new DiscordNativeUi(host);
  const findCard = () => [...messages.values()].find((m) => (m.content ?? '').includes('Launch approvals'))!;
  const component = (view: DiscordUiPayload, label: string) =>
    discordUiNodes(view.components).find((c) => c.label === label || c.placeholder === label)!;
  const event = (
    c: Record<string, unknown>,
    extra: Partial<DiscordInteraction> = {},
    values?: string[]
  ): DiscordInteraction => ({
    id: snow(),
    application_id: bot,
    token: 'fake-token',
    guild_id: guild,
    channel_id: channel,
    type: 3,
    member: { user: { id: actor } },
    message: { id: findCard()?.id ?? snow() },
    data: { custom_id: c.custom_id as string, ...(values ? { values } : {}) },
    ...extra,
  });
  const click = async (
    view: DiscordUiPayload,
    label: string,
    values?: string[],
    extra: Partial<DiscordInteraction> = {}
  ) => {
    const c = component(view, label);
    expect(c, label).toBeDefined();
    await ui.interaction(event(c, extra, values));
    return finishes.at(-1)!;
  };
  const command = async (name: string, extra: Partial<DiscordInteraction> = {}) => {
    await ui.register();
    const c = commands.find((c) => c.name === name)!;
    expect(c).toBeDefined();
    await ui.interaction({
      id: snow(),
      application_id: bot,
      token: 'fake',
      guild_id: guild,
      channel_id: parent,
      type: 2,
      member: { user: { id: actor } },
      data: { name, id: c.id },
      ...extra,
    });
    return finishes.at(-1)!;
  };
  return {
    ui,
    host,
    sessions,
    messages,
    commands,
    responses,
    finishes,
    dir,
    findCard,
    component,
    event,
    click,
    command,
    setScope: (v: string | undefined) => (scope = v),
    advance: (ms: number) => (now += ms),
    setQuestion: (v: DiscordUiQuestion | undefined) => (q = v),
  };
}
describe('native Discord UI', () => {
  it('never reopens an archived or locked thread for passive cards or queue dispatch', async () => {
    const f = await fixture();
    vi.mocked(f.host.passive).mockResolvedValue(false);
    await f.ui.store.enqueue({
      session: 's1',
      conversation: 'conversation-one',
      inputRevision: 'input-one',
      scope: 'scope-a',
      channel,
      actor,
      source: 'q',
      text: 'Do this next',
    });
    f.sessions[0].working = false;
    await f.ui.poll();
    expect(f.findCard()).toBeUndefined();
    expect(f.host.submit).not.toHaveBeenCalled();
    expect(f.host.verify).not.toHaveBeenCalled();
  });
  it('publishes one owned control card and dashboard; updates after restart without duplicate posts', async () => {
    const f = await fixture();
    await f.ui.poll();
    expect(f.messages.size).toBe(2);
    const card = f.findCard();
    expect(card.content).toContain('Input delivered; native submission unconfirmed');
    expect(card.components!.flatMap((r) => r.components).map((c) => c.label)).toContain('Settings');
    await f.ui.poll();
    expect(f.messages.size).toBe(2);
    expect(f.host.request).toHaveBeenCalledWith('PUT', `/channels/${channel}/messages/pins/${card.id}`);
    const restored = new DiscordNativeUi(f.host);
    await restored.poll();
    expect(f.messages.size).toBe(2);
    expect((await restored.store.snapshot()).cards).toBeDefined();
  });
  it('does not post duplicate results cards when a task completes', async () => {
    const f = await fixture();
    f.host.receipts = async () => [{ id: 'completed-input', state: 'completed', updated: 1 }];
    await f.ui.poll();
    expect([...f.messages.values()].some((m) => (m.content ?? '').startsWith('**Results & files'))).toBe(false);
    expect(f.host.verify).not.toHaveBeenCalled();
  });
  it('recreates a deleted owned card and refuses a message now owned by someone else', async () => {
    const f = await fixture();
    await f.ui.poll();
    const first = f.findCard();
    f.messages.delete(first.id);
    f.sessions[0].working = false;
    await f.ui.poll();
    expect(f.findCard().id).not.toBe(first.id);
    const next = f.findCard();
    next.author.id = '999999999999999999';
    f.sessions[0].working = true;
    await f.ui.poll();
    expect(f.ui.lastError).toContain('ownership');
  });
  it('opens native settings selects and applies only a still-current choice', async () => {
    const f = await fixture();
    await f.ui.poll();
    const settings = await f.click(f.findCard(), 'Settings');
    const models = await f.click(settings, 'Model');
    const selected = models.components![0].components[0];
    expect(selected.type).toBe(3);
    await f.ui.interaction(f.event(selected, {}, ['0']));
    expect(f.host.control).toHaveBeenCalledWith('s1', 'model choose verified');
    expect(f.finishes.at(-1)?.content).toContain('Verified');
  });
  it('offers a future-defaults modal separately and never calls session input', async () => {
    const f = await fixture();
    await f.ui.poll();
    const settings = await f.click(f.findCard(), 'Settings');
    const defaults = await f.click(settings, 'Future Codex defaults');
    await f.click(defaults, 'Edit future defaults');
    const modal = f.responses.at(-1) as { type: number; data: { custom_id: string } };
    expect(modal.type).toBe(9);
    await f.ui.interaction({
      id: snow(),
      application_id: bot,
      token: 'fake',
      guild_id: guild,
      channel_id: channel,
      type: 5,
      member: { user: { id: actor } },
      data: {
        custom_id: modal.data.custom_id,
        components: [
          {
            components: [
              { custom_id: 'model', value: 'gpt-6.1' },
              { custom_id: 'effort', value: 'high' },
              { custom_id: 'approval', value: 'ask' },
            ],
          },
        ],
      },
    });
    expect(f.host.services.saveDefaults).toHaveBeenCalledWith(
      { model: 'gpt-6.1', effort: 'high', approval: 'ask' },
      expect.any(Function)
    );
    expect(f.host.submit).not.toHaveBeenCalled();
  });
  it('lets a cancelled form reopen while consuming each submitted form token once', async () => {
    const f = await fixture();
    await f.ui.poll();
    const settings = await f.click(f.findCard(), 'Settings');
    const defaults = await f.click(settings, 'Future Codex defaults');
    await f.click(defaults, 'Edit future defaults');
    expect((f.responses.at(-1) as { type: number }).type).toBe(9);
    await f.click(defaults, 'Edit future defaults');
    expect((f.responses.at(-1) as { type: number }).type).toBe(9);
    expect(f.host.services.saveDefaults).not.toHaveBeenCalled();
  });
  it('binds menus to actor, origin, message, scope, interaction type and conversation', async () => {
    const f = await fixture();
    await f.ui.poll();
    const control = f.component(f.findCard(), 'Settings');
    await f.ui.interaction(f.event(control, { member: { user: { id: '777777777777777777' } } }));
    expect(f.finishes).toHaveLength(0);
    await f.ui.interaction(f.event(control, { message: { id: '888888888888888888' } }));
    expect(f.finishes).toHaveLength(0);
    await f.ui.interaction(f.event(control, { type: 5 }));
    expect(f.finishes).toHaveLength(0);
    f.sessions[0].conversation = 'different';
    await f.ui.interaction(f.event(control));
    expect(f.finishes.at(-1)?.content).toContain('conversation changed');
    const fresh = await fixture();
    await fresh.ui.poll();
    const c = fresh.component(fresh.findCard(), 'Settings');
    fresh.setScope('new-scope');
    await fresh.ui.interaction(fresh.event(c));
    expect(fresh.finishes).toHaveLength(0);
  });
  it('renders prompt-bound choices and rejects an answer resolved in another UI', async () => {
    const f = await fixture();
    f.setQuestion({
      id: 'q1',
      revision: 'rev1',
      kind: 'question',
      text: 'Which test?',
      options: [
        { n: 1, label: 'Targeted tests' },
        { n: 2, label: 'Full suite' },
      ],
      terminalOnly: false,
    });
    await f.ui.poll();
    const q = await f.click(f.findCard(), 'Question');
    const select = q.components![0].components[0];
    f.setQuestion(undefined);
    await f.ui.interaction(f.event(select, {}, ['1']));
    expect(f.host.services.answer).not.toHaveBeenCalled();
    expect(f.finishes.at(-1)?.content).toContain('answered elsewhere');
  });
  it('clears existing native question panels when another interface resolves the prompt', async () => {
    const f = await fixture();
    f.setQuestion({
      id: 'q1',
      revision: 'rev1',
      kind: 'question',
      text: 'Which test?',
      options: [{ n: 1, label: 'Targeted' }],
      terminalOnly: false,
    });
    await f.ui.poll();
    await f.click(f.findCard(), 'Question');
    f.setQuestion(undefined);
    await f.ui.poll();
    expect(f.finishes.at(-1)?.content).toContain('resolved or replaced');
    expect(f.finishes.at(-1)?.components).toEqual([]);
  });
  it('keeps unverifiable permission dialogs in the terminal', async () => {
    const f = await fixture();
    f.setQuestion({
      id: 'q1',
      revision: 'r',
      kind: 'permission',
      text: 'Execute command?',
      options: [{ n: 1, label: 'Approve' }],
      terminalOnly: true,
    });
    await f.ui.poll();
    const q = await f.click(f.findCard(), 'Question');
    expect(q.components).toHaveLength(0);
    expect(q.content).toContain('cannot be answered safely');
  });
  it('edits/removes queued work and dispatches only with exact completion and ready state', async () => {
    const f = await fixture();
    await f.ui.poll();
    await f.ui.store.enqueue({
      session: 's1',
      conversation: 'conversation-one',
      inputRevision: 'input-one',
      scope: 'scope-a',
      channel,
      actor,
      source: 'queued-1',
      text: 'Review diff',
    });
    f.sessions[0].pending = true;
    f.sessions[0].working = false;
    await f.ui.poll();
    expect(f.host.submit).not.toHaveBeenCalled();
    f.sessions[0].pending = false;
    f.sessions[0].ready = false;
    await f.ui.poll();
    expect(f.host.submit).not.toHaveBeenCalled();
    f.sessions[0].ready = true;
    await f.ui.poll();
    expect(f.host.submit).toHaveBeenCalledWith(
      's1',
      channel,
      actor,
      'queued-1',
      'Review diff',
      'conversation-one',
      true,
      'input-one'
    );
    expect((await f.ui.store.snapshot()).queue).toHaveLength(0);
  });
  it('pauses queued work after manual input even before the new native conversation ID is observed', async () => {
    const f = await fixture();
    await f.ui.store.enqueue({
      session: 's1',
      conversation: 'conversation-one',
      inputRevision: 'input-one',
      scope: 'scope-a',
      channel,
      actor,
      source: 'q',
      text: 'Follow-up',
    });
    f.sessions[0].working = false;
    f.sessions[0].inputRevision = 'changed-by-clear';
    await f.ui.poll();
    expect(f.host.submit).not.toHaveBeenCalled();
    expect((await f.ui.store.snapshot()).queue[0].state).toBe('queued');
  });
  it('never replays an ambiguous queue submission after restart', async () => {
    const f = await fixture();
    await f.ui.store.enqueue({
      session: 's1',
      conversation: 'conversation-one',
      inputRevision: 'input-one',
      scope: 'scope-a',
      channel,
      actor,
      source: 'q',
      text: 'Deploy after review',
    });
    await f.ui.store.edit((s) => {
      s.queue[0].state = 'submitting';
    });
    const restored = new DiscordNativeUi(f.host);
    f.sessions[0].working = false;
    await restored.poll();
    expect((await restored.store.snapshot()).queue[0].state).toBe('uncertain');
    expect(f.host.submit).not.toHaveBeenCalled();
  });
  it('pauses expired, foreign-conversation and revoked-actor queues', async () => {
    const f = await fixture();
    await f.ui.store.enqueue({
      session: 's1',
      conversation: 'old-conversation',
      scope: 'scope-a',
      channel,
      actor,
      source: 'q',
      text: 'Old follow-up',
    });
    f.sessions[0].working = false;
    await f.ui.poll();
    expect(f.host.submit).not.toHaveBeenCalled();
    await f.ui.store.edit((s) => {
      s.queue[0].conversation = 'conversation-one';
      s.queue[0].actor = '999999999999999999';
    });
    await f.ui.poll();
    expect(f.host.submit).not.toHaveBeenCalled();
    await f.ui.store.edit((s) => {
      s.queue[0].actor = actor;
    });
    f.advance(86400001);
    await f.ui.poll();
    expect(f.host.submit).not.toHaveBeenCalled();
  });
  it('exports guarded workspace results and observed receipts without inventing test success', async () => {
    const f = await fixture();
    await f.ui.poll();
    const result = await f.click(f.findCard(), 'Results & files');
    expect(result.content).not.toContain('not inferred');
    await f.click(result, 'View changes');
    expect(f.finishes.at(-1)?.content).toContain('other sessions');
    const more = await f.click(result, 'More');
    expect(more.content).toContain('not inferred');
    await f.click(more, 'Download execution receipt');
    expect(f.host.postFile).toHaveBeenCalledWith(
      channel,
      expect.objectContaining({ name: 'execution-receipt.json' }),
      expect.any(String)
    );
  });
  it('registers a dashboard and message commands without replacing other application commands', async () => {
    const f = await fixture();
    await f.ui.poll();
    expect(f.commands.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        'codeman',
        'Codeman: Send to session',
        'Codeman: Queue follow-up',
        'Codeman: Start session',
      ])
    );
    const dashboard = await f.command('codeman');
    expect(
      discordUiNodes(dashboard.components)
        .map((n) => n.content)
        .join('\n')
    ).toContain('1 sessions');
    const filtered = await f.click(dashboard, 'Choose activity view', ['attention'], { channel_id: parent });
    expect(
      discordUiNodes(filtered.components)
        .map((n) => n.content)
        .join('\n')
    ).not.toContain('w1-Codeman');
    expect(f.host.request).not.toHaveBeenCalledWith('PUT', expect.stringContaining('/commands'), expect.anything());
  });
  it('creates a source-based session from another channel without posting a management reply there', async () => {
    const f = await fixture();
    await f.ui.poll();
    vi.mocked(f.host.control).mockResolvedValue({ text: 'Session created', locateSessionId: 's1' });
    const sourceId = snow();
    const source = {
      id: sourceId,
      channel_id: parent,
      channel: parent,
      author: { id: actor },
      content: 'Start from this idea',
      components: [],
    };
    f.messages.set(sourceId, source as unknown as ReturnType<typeof f.findCard>);
    const picker = await f.command('Codeman: Start session', {
      data: {
        name: 'Codeman: Start session',
        id: f.commands.find((c) => c.name === 'Codeman: Start session')!.id,
        target_id: sourceId,
        resolved: { messages: { [sourceId]: source as GatewayMessage } },
      },
    });
    await f.ui.interaction(f.event(picker.components![0].components[0], { channel_id: parent }, ['case-one']));
    const cli = f.finishes.at(-1)!;
    await f.ui.interaction(f.event(cli.components![0].components[0], { channel_id: parent }, ['codex']));
    const confirmation = f.finishes.at(-1)!;
    await f.click(confirmation, 'Confirm', undefined, { channel_id: parent });
    expect(f.host.locate).toHaveBeenCalledWith('s1');
    expect(f.host.postControl).not.toHaveBeenCalled();
    expect(f.host.submit).not.toHaveBeenCalled();
    expect(f.finishes.at(-1)?.content).toContain('has not been submitted');
  });
  it('routes a selected source through an explicit destination and reconfirms it before submission', async () => {
    const f = await fixture();
    await f.ui.poll();
    const id = snow();
    const message = {
      id,
      channel: parent,
      channel_id: parent,
      author: { id: actor },
      content: 'Please review this idea',
      components: [],
    } as unknown as ReturnType<typeof f.findCard>;
    f.messages.set(id, message);
    const picker = await f.command('Codeman: Send to session', {
      data: {
        name: 'Codeman: Send to session',
        id: f.commands.find((c) => c.name === 'Codeman: Send to session')!.id,
        target_id: id,
        resolved: { messages: { [id]: message as unknown as GatewayMessage } },
      },
    });
    const selected = picker.components![0].components[0];
    await f.ui.interaction(f.event(selected, { channel_id: parent }, ['s1']));
    const review = f.finishes.at(-1)!;
    expect(review.content).toContain('Review destination');
    expect(f.host.submit).not.toHaveBeenCalled();
    await f.click(review, 'Send now', undefined, { channel_id: parent });
    expect(f.host.submit).toHaveBeenCalledTimes(1);
    await f.click(review, 'Queue next', undefined, { channel_id: parent });
    expect((await f.ui.store.snapshot()).queue).toHaveLength(0);
  });
});
describe('private UI store', () => {
  it('writes mode 0600, limits queue size and refuses a symlink instead of losing ownership', async () => {
    const f = await fixture();
    for (let i = 0; i < 10; i++)
      await f.ui.store.enqueue({
        session: 's1',
        conversation: 'c',
        scope: 'scope-a',
        channel,
        actor,
        source: 's' + i,
        text: 'prompt',
      });
    await expect(
      f.ui.store.enqueue({
        session: 's1',
        conversation: 'c',
        scope: 'scope-a',
        channel,
        actor,
        source: 'extra',
        text: 'prompt',
      })
    ).rejects.toThrow('Queue full');
    expect((await stat(join(f.dir, 'discord-native-ui.json'))).mode & 0o777).toBe(0o600);
    const target = join(f.dir, 'other.json');
    await writeFile(target, await readFile(join(f.dir, 'discord-native-ui.json')));
    await rm(join(f.dir, 'discord-native-ui.json'));
    await symlink(target, join(f.dir, 'discord-native-ui.json'));
    await expect(new DiscordUiStore(f.dir).snapshot()).rejects.toThrow('unavailable');
  });
});

async function legacyDelivery(f: Awaited<ReturnType<typeof fixture>>, receipt = 'legacy') {
  const key = createHash('sha256')
    .update(f.host.scope() + ':' + channel + ':delivery:' + receipt)
    .digest('hex');
  const id = snow();
  f.messages.set(id, {
    id,
    channel,
    author: { id: bot },
    content: '**Prompt delivery**\nWorking · native execution\n-# Codeman · delivery · ' + key.slice(0, 10),
  });
  await f.ui.store.edit((state) => {
    state.cards[key] = {
      kind: 'delivery',
      channel,
      message: id,
      hash: 'legacy',
      phase: 'ready',
      updated: f.host.now(),
    };
  });
  return { key, id };
}
it('uses reactions/journal state without creating a delivery card at any normal prompt stage', async () => {
  const f = await fixture();
  for (const state of ['received', 'input_accepted', 'submitted', 'running', 'completed']) {
    f.host.receipts = async () => [{ id: 'input-one', state, updated: f.host.now() }];
    await f.ui.receipt('s1', 'input-one');
    await f.ui.poll();
  }
  expect([...f.messages.values()].some((m) => (m.content ?? '').includes('**Prompt delivery**'))).toBe(false);
  expect((await f.host.receipts('s1'))[0].state).toBe('completed');
  expect(f.host.submit).not.toHaveBeenCalled();
  expect(f.host.note).not.toHaveBeenCalled();
});
it('removes an owned legacy delivery card and its UI metadata while preserving queued prompts', async () => {
  const f = await fixture();
  const { key, id } = await legacyDelivery(f);
  await f.ui.store.enqueue({
    session: 's1',
    conversation: 'conversation-one',
    scope: 'scope-a',
    channel,
    actor,
    source: 'queued-source',
    text: 'follow-up',
  });
  const queue = (await f.ui.store.snapshot()).queue;
  await f.ui.receipt('s1', 'legacy');
  expect(f.messages.has(id)).toBe(false);
  const state = await f.ui.store.snapshot();
  expect(state.cards[key]).toBeUndefined();
  expect(state.queue).toEqual(queue);
  expect(f.host.request).toHaveBeenCalledWith(
    'DELETE',
    `/channels/${channel}/messages/${id}`,
    undefined,
    expect.any(Function)
  );
});
it.each(['foreign author', 'edited marker', 'archived thread', 'disabled scope'])(
  'leaves a legacy card alone for %s',
  async (reason) => {
    const f = await fixture();
    const { key, id } = await legacyDelivery(f);
    if (reason === 'foreign author') f.messages.get(id)!.author.id = actor;
    if (reason === 'edited marker') f.messages.get(id)!.content = 'A different bot message';
    if (reason === 'archived thread') vi.mocked(f.host.passive).mockResolvedValue(false);
    if (reason === 'disabled scope') f.setScope(undefined);
    await f.ui.receipt('s1', 'legacy');
    expect(f.messages.has(id)).toBe(true);
    expect((await f.ui.store.snapshot()).cards[key]).toBeDefined();
    expect(vi.mocked(f.host.request).mock.calls.some(([method]) => method === 'DELETE')).toBe(false);
  }
);
it('rechecks configuration after reading a legacy card and before deleting it', async () => {
  const f = await fixture();
  const { id } = await legacyDelivery(f);
  const request = f.host.request;
  f.host.request = vi.fn(async (method, path, body) => {
    const result = await request(method, path, body);
    if (method === 'GET' && path.endsWith('/' + id)) f.setScope('changed-scope');
    return result;
  });
  await f.ui.receipt('s1', 'legacy');
  expect(f.messages.has(id)).toBe(true);
  expect(vi.mocked(f.host.request).mock.calls.some(([method]) => method === 'DELETE')).toBe(false);
});
it('forgets metadata for an already-deleted delivery card without deleting another message', async () => {
  const f = await fixture();
  const { key, id } = await legacyDelivery(f);
  f.messages.delete(id);
  await f.ui.receipt('s1', 'legacy');
  expect((await f.ui.store.snapshot()).cards[key]).toBeUndefined();
  expect(vi.mocked(f.host.request).mock.calls.some(([method]) => method === 'DELETE')).toBe(false);
});
it('cleans up at most three legacy cards per poll and never recreates them after restart', async () => {
  const f = await fixture();
  for (let i = 0; i < 4; i++) await legacyDelivery(f, 'legacy' + i);
  f.host.receipts = async () => [{ id: 'legacy3', state: 'running', updated: f.host.now() }];
  await f.ui.poll();
  expect(vi.mocked(f.host.request).mock.calls.filter(([method]) => method === 'DELETE')).toHaveLength(3);
  await f.ui.poll();
  expect([...f.messages.values()].some((m) => (m.content ?? '').includes('**Prompt delivery**'))).toBe(false);
  const restored = new DiscordNativeUi(f.host);
  await restored.poll();
  expect([...f.messages.values()].some((m) => (m.content ?? '').includes('**Prompt delivery**'))).toBe(false);
});
it('offers stable read-only response controls with exact history and actor checks', async () => {
  const f = await fixture();
  f.host.history = async () => ({
    conversationId: 'conversation-one',
    partial: false,
    turns: [
      { cursor: 'u1', role: 'user', text: 'Build', timestamp: '' },
      { cursor: 'p1', role: 'assistant', text: 'Compiling', timestamp: '', phase: 'commentary' },
      { cursor: 'r1', role: 'assistant', text: 'Visible answer', timestamp: '', phase: 'final_answer' },
    ],
  });
  const controls = await f.ui.responseControls('s1', channel, 'u1', 'r1');
  const again = await f.ui.responseControls('s1', channel, 'u1', 'r1');
  expect(again).toEqual(controls);
  const payload = { content: '', components: controls } as DiscordUiPayload;
  const updates = await f.click(payload, 'Show updates');
  expect(updates.content).toContain('Compiling');
  expect(updates.content).not.toContain('Visible answer');
  await f.click(payload, 'Download response');
  expect(f.host.postFile).toHaveBeenCalledWith(
    channel,
    { name: 'response.txt', data: Buffer.from('Visible answer') },
    'Requested assistant response',
    expect.any(Function)
  );
  const fresh = new DiscordNativeUi(f.host);
  expect(await fresh.responseControls('s1', channel, 'u1', 'r1')).toEqual(controls);
  const button = f.component(payload, 'Download response');
  await fresh.interaction(f.event(button, { member: { user: { id: '999999999999999999' } } }));
  expect(f.host.postFile).toHaveBeenCalledTimes(1);
  f.sessions[0].conversation = 'different';
  await f.ui.interaction(f.event(button));
  expect(f.host.postFile).toHaveBeenCalledTimes(1);
  expect(f.finishes.at(-1)?.content).toContain('changed');
});
it.each(['expired', 'restart'] as const)(
  'recovers exact read-only response buttons after %s and acknowledges before reads',
  async (kind) => {
    const f = await fixture();
    f.host.history = vi.fn(async () => ({
      conversationId: 'conversation-one',
      partial: false,
      turns: [
        { cursor: 'u1', role: 'user' as const, text: 'First task', timestamp: '' },
        { cursor: 'p1', role: 'assistant' as const, text: 'Compiling', timestamp: '', phase: 'commentary' as const },
        {
          cursor: 'r1',
          role: 'assistant' as const,
          text: 'Original response',
          timestamp: '',
          phase: 'final_answer' as const,
        },
        { cursor: 'u2', role: 'user' as const, text: 'Second task', timestamp: '' },
        {
          cursor: 'r2',
          role: 'assistant' as const,
          text: 'Newer response',
          timestamp: '',
          phase: 'final_answer' as const,
        },
      ],
    }));
    const controls = await f.ui.responseControls('s1', channel, 'u1', 'r1');
    const id = snow();
    f.messages.set(id, {
      id,
      channel,
      channel_id: channel,
      author: { id: bot },
      content: 'Old response',
      components: controls,
    } as any);
    f.advance(7 * 60000);
    const ui = kind === 'restart' ? new DiscordNativeUi(f.host) : f.ui;
    const original = f.host.request;
    f.host.request = vi.fn(async (...args) => {
      expect(f.responses).toContainEqual({ type: 5, data: { flags: 64 } });
      return original(...args);
    });
    const view = { content: '', components: controls };
    for (const label of ['Download response', 'Show updates', 'Results & files'])
      await ui.interaction(f.event(f.component(view, label), { message: { id } }));
    expect(f.host.postFile).toHaveBeenCalledWith(
      channel,
      { name: 'response.txt', data: Buffer.from('Original response') },
      'Requested assistant response',
      expect.any(Function)
    );
    expect(f.finishes.some((v) => v.content.includes('Compiling'))).toBe(true);
    expect(f.finishes.at(-1)?.content).toContain('Original response');
    expect(f.finishes.at(-1)?.content).not.toContain('Newer response');
    expect(f.host.submit).not.toHaveBeenCalled();
  }
);

it.each([
  'foreign author',
  'missing button',
  'missing history',
  'changed scope',
  'changed conversation',
  'wrong channel',
  'unauthorized actor',
  'deleted message',
])('does not recover a response button with %s', async (kind) => {
  const f = await fixture();
  f.host.history = async () => ({
    conversationId: 'conversation-one',
    partial: false,
    turns: [
      { cursor: 'u1', role: 'user', text: 'Build', timestamp: '' },
      { cursor: 'r1', role: 'assistant', text: 'Answer', timestamp: '' },
    ],
  });
  const controls = await f.ui.responseControls('s1', channel, 'u1', 'r1'),
    id = snow();
  f.messages.set(id, {
    id,
    channel,
    channel_id: channel,
    author: { id: bot },
    content: 'Response',
    components: controls,
  } as any);
  const button = f.component({ content: '', components: controls }, 'Download response');
  if (kind === 'foreign author') f.messages.get(id)!.author.id = '999999999999999999';
  if (kind === 'missing button') f.messages.get(id)!.components = [];
  if (kind === 'deleted message') f.messages.delete(id);
  if (kind === 'missing history')
    f.host.history = async () => ({ conversationId: 'conversation-one', partial: false, turns: [] });
  if (kind === 'changed scope') f.setScope('another-scope');
  if (kind === 'changed conversation') f.sessions[0].conversation = 'another-conversation';
  const ui = new DiscordNativeUi(f.host);
  await ui.interaction(
    f.event(button, {
      message: { id },
      ...(kind === 'wrong channel' ? { channel_id: parent } : {}),
      ...(kind === 'unauthorized actor' ? { member: { user: { id: '999999999999999999' } } } : {}),
    })
  );
  expect(f.host.postFile).not.toHaveBeenCalled();
  expect(f.host.submit).not.toHaveBeenCalled();
  expect(f.host.services.answer).not.toHaveBeenCalled();
});

it('does not revive an expired cached response when its native history is gone', async () => {
  const f = await fixture();
  const controls = await f.ui.responseControls('s1', channel, 'u1', 'r1'),
    id = snow();
  f.messages.set(id, {
    id,
    channel,
    channel_id: channel,
    author: { id: bot },
    content: 'Response',
    components: controls,
  } as any);
  f.host.history = async () => ({ conversationId: 'conversation-one', partial: false, turns: [] });
  f.advance(7 * 60000);
  await f.ui.interaction(
    f.event(f.component({ content: '', components: controls }, 'Download response'), { message: { id } })
  );
  expect(f.host.postFile).not.toHaveBeenCalled();
  expect(f.finishes.at(-1)?.content).toContain('unavailable');
});
it('keeps state-changing session controls expired instead of recovering them', async () => {
  const f = await fixture();
  await f.ui.poll();
  const card = f.findCard()!;
  const button = f.component(card, 'Interrupt');
  expect(button).toBeDefined();
  const calls = vi.mocked(f.host.control).mock.calls.length;
  f.advance(7 * 60000);
  await f.ui.interaction(f.event(button, { message: { id: card.id } }));
  expect(f.host.control).toHaveBeenCalledTimes(calls);
  expect(JSON.stringify(f.responses.at(-1))).toContain('expired or changed');
});

it('abandons response recovery if configuration changes during the history read', async () => {
  const f = await fixture();
  const controls = await f.ui.responseControls('s1', channel, 'u1', 'r1'),
    id = snow();
  f.messages.set(id, {
    id,
    channel,
    channel_id: channel,
    author: { id: bot },
    content: 'Response',
    components: controls,
  } as any);
  f.advance(7 * 60000);
  f.host.history = async () => {
    f.setScope('changed-while-reading');
    return {
      conversationId: 'conversation-one',
      partial: false,
      turns: [
        { cursor: 'u1', role: 'user', text: 'Build', timestamp: '' },
        { cursor: 'r1', role: 'assistant', text: 'Answer', timestamp: '' },
      ],
    };
  };
  await f.ui.interaction(
    f.event(f.component({ content: '', components: controls }, 'Download response'), { message: { id } })
  );
  expect(f.host.postFile).not.toHaveBeenCalled();
});
it('does not upload a response when its conversation changes during the final history read', async () => {
  const f = await fixture();
  const controls = await f.ui.responseControls('s1', channel, 'u1', 'r1');
  f.host.history = async () => {
    f.sessions[0].conversation = 'replacement';
    return {
      conversationId: 'conversation-one',
      partial: false,
      turns: [{ cursor: 'r1', role: 'assistant', text: 'Old answer', timestamp: '' }],
    };
  };
  await f.click({ content: '', components: controls }, 'Download response');
  expect(f.host.postFile).not.toHaveBeenCalled();
  expect(f.finishes.at(-1)?.content).toContain('changed');
});

it.each(['send', 'edited', 'changed', 'busy', 'revision', 'conversation', 'unauthorized', 'duplicate'] as const)(
  'reviews a native Claude suggestion and guards %s submission',
  async (kind) => {
    const f = await fixture();
    Object.assign(f.sessions[0], { mode: 'claude', working: false, promptSuggestion: 'Run the focused tests' });
    await f.ui.poll();
    const card = f.findCard();
    expect(card.content).toContain('Claude suggests:');
    await f.click(card, 'Use suggestion');
    expect(f.host.submit).not.toHaveBeenCalled();
    const modal = f.responses.at(-1) as {
      type: number;
      data: { custom_id: string; components: Array<{ components: Array<{ value: string }> }> };
    };
    expect(modal.type).toBe(9);
    expect(modal.data.components[0].components[0].value).toBe('Run the focused tests');
    if (kind === 'changed') f.sessions[0].promptSuggestion = 'Different suggestion';
    if (kind === 'busy') f.sessions[0].working = true;
    if (kind === 'revision') f.sessions[0].inputRevision = 'new-input';
    if (kind === 'conversation') f.sessions[0].conversation = 'replacement';
    const text = kind === 'edited' ? 'Run tests and review the diff' : 'Run the focused tests';
    const event = f.event(
      { custom_id: modal.data.custom_id },
      {
        type: 5,
        data: {
          custom_id: modal.data.custom_id,
          components: [{ type: 1, components: [{ type: 4, custom_id: 'prompt', value: text }] }],
        },
        ...(kind === 'unauthorized' ? { member: { user: { id: '999999999999999999' } } } : {}),
      }
    );
    await f.ui.interaction(event);
    if (['send', 'edited', 'duplicate'].includes(kind)) {
      expect(f.host.submit).toHaveBeenCalledWith(
        's1',
        channel,
        actor,
        'suggestion:' + event.id,
        text,
        'conversation-one',
        true,
        'input-one'
      );
      if (kind === 'duplicate') await f.ui.interaction(event);
      expect(f.host.submit).toHaveBeenCalledTimes(1);
    } else expect(f.host.submit).not.toHaveBeenCalled();
  }
);
it.each([{ working: true }, { pending: true }, { ready: false }, { mode: 'codex' }])(
  'hides native suggestions when unavailable: %j',
  async (state) => {
    const f = await fixture();
    Object.assign(f.sessions[0], { mode: 'claude', working: false, promptSuggestion: 'Run the tests' }, state);
    await f.ui.poll();
    expect(f.findCard().content).not.toContain('Claude suggests:');
    expect(
      f
        .findCard()
        .components?.flatMap((r) => r.components)
        .some((c) => c.label === 'Use suggestion')
    ).toBe(false);
  }
);

it('pages and downloads full original-task updates after the recent history window moves', async () => {
  const f = await fixture();
  f.host.history = vi.fn(async (_id, options) =>
    options?.after === 'u1'
      ? {
          conversationId: 'conversation-one',
          partial: false,
          verifiedAfter: 'u1',
          turns: [
            ...Array.from({ length: 12 }, (_, i) => ({
              cursor: 'p' + i,
              role: 'assistant' as const,
              phase: 'commentary' as const,
              text: 'Progress ' + i + ' ' + 'z'.repeat(550),
              timestamp: '',
            })),
            { cursor: 'u2', role: 'user' as const, text: 'Later task', timestamp: '' },
            {
              cursor: 'p-other',
              role: 'assistant' as const,
              phase: 'commentary' as const,
              text: 'Exclude later progress',
              timestamp: '',
            },
          ],
        }
      : { conversationId: 'conversation-one', partial: true, turns: [] }
  );
  const controls = await f.ui.responseControls('s1', channel, 'u1', 'r1');
  const refState = await new DiscordUiStore(f.dir).snapshot();
  expect(JSON.stringify(refState.responses)).not.toContain('Progress');
  const first = await f.click({ content: '', components: controls }, 'Show updates');
  expect(first.content).toContain('12');
  expect(first.content).toContain('Progress 0');
  const second = await f.click(first, 'Next');
  expect(second.content).toContain('page 2/');
  expect((await f.click(second, 'Previous')).content).toContain('Progress 0');
  await f.click(second, 'Download updates');
  const call = vi.mocked(f.host.postFile).mock.calls.at(-1)!;
  expect(call[1].data.toString()).toContain('Progress 11 ' + 'z'.repeat(550));
  expect(call[1].data.toString()).not.toContain('Exclude later progress');
  expect(call[1].name).toBe('updates.txt');
});
it('recovers stored read-only task buttons after restart outside the recent history window', async () => {
  const f = await fixture();
  const controls = await f.ui.responseControls('s1', channel, 'u1', 'r1');
  const id = snow();
  f.messages.set(id, {
    id,
    channel,
    channel_id: channel,
    author: { id: bot },
    content: 'Old response',
    components: controls,
  } as any);
  f.host.history = vi.fn(async (_id, options) =>
    options?.after === 'u1'
      ? {
          conversationId: 'conversation-one',
          partial: false,
          verifiedAfter: 'u1',
          turns: [
            { cursor: 'p1', role: 'assistant', phase: 'commentary', text: 'Older task full progress', timestamp: '' },
            { cursor: 'r1', role: 'assistant', text: 'Older answer', timestamp: '' },
            { cursor: 'u2', role: 'user', text: 'Later task', timestamp: '' },
          ],
        }
      : { conversationId: 'conversation-one', partial: true, turns: [] }
  );
  const restored = new DiscordNativeUi(f.host);
  await restored.interaction(
    f.event(f.component({ content: '', components: controls }, 'Show updates'), { message: { id } })
  );
  expect(f.finishes.at(-1)?.content).toContain('Older task full progress');
  expect(f.host.submit).not.toHaveBeenCalled();
});

async function resultFixture(text = 'Created [report.pdf](/work/report.pdf).') {
  const f = await fixture();
  f.host.history = vi.fn(async () => ({
    conversationId: 'conversation-one',
    partial: false,
    turns: [
      { cursor: 'u1', role: 'user' as const, text: 'Create report', timestamp: '' },
      { cursor: 'r1', role: 'assistant' as const, text, timestamp: '', phase: 'final_answer' as const },
    ],
    executions: [{ userCursor: 'u1', promptHash: 'abc', state: 'completed' as const }],
  }));
  await f.ui.poll();
  const result = await f.click(f.findCard(), 'Results & files');
  return { ...f, result };
}
it('shows the answer, compact status and a named guarded file download with technical details hidden', async () => {
  const f = await resultFixture();
  expect(f.result.content).toContain('Created [report.pdf]');
  expect(f.result.content).toContain('✓ Completed');
  expect(f.result.content).not.toMatch(/Native execution|shared-worktree|receipt/);
  expect(f.host.file).not.toHaveBeenCalled();
  await f.click(f.result, 'Download report.pdf');
  expect(f.host.file).toHaveBeenCalledWith('s1', '/work/report.pdf');
  expect(f.host.postFile).toHaveBeenCalledWith(
    channel,
    expect.objectContaining({ name: 'report.html' }),
    expect.any(String),
    expect.any(Function)
  );
  expect(f.host.submit).not.toHaveBeenCalled();
});
it.each(['', 'No exportable tracked diff.\n'])('hides View changes for an empty workspace (%s)', async (diff) => {
  const f = await resultFixture();
  f.host.services.workspace = vi.fn(async () => ({ summary: 'No changes', diff }));
  const result = await f.click(f.findCard(), 'Results & files');
  expect(result.components?.flatMap((r) => r.components).map((c) => c.label)).not.toContain('View changes');
});
it('keeps results useful for non-Git workspaces', async () => {
  const f = await resultFixture();
  f.host.services.workspace = vi.fn(async () => {
    throw Error('Not a repository');
  });
  const result = await f.click(f.findCard(), 'Results & files');
  expect(result.content).toContain('Created [report.pdf]');
  expect(result.components?.flatMap((r) => r.components).map((c) => c.label)).toEqual(['Download report.pdf', 'More']);
});
it('does not read external URLs, code examples or secrets as generated files', async () => {
  const f = await resultFixture('See [video](https://example.org/movie.mp4)\n```\n[artifact: /work/secret.pdf]\n```');
  expect(f.result.components?.flatMap((r) => r.components).map((c) => c.label)).toEqual(['View changes', 'More']);
  expect(f.host.file).not.toHaveBeenCalled();
});
it('preserves file guards and stops a download after a conversation change', async () => {
  const f = await resultFixture();
  f.host.file = vi.fn(async () => {
    f.sessions[0].conversation = 'replacement';
    return { name: 'report.pdf', data: Buffer.from('PDF') };
  });
  await f.click(f.result, 'Download report.pdf');
  expect(f.host.postFile).not.toHaveBeenCalled();
  expect(f.finishes.at(-1)?.content).toContain('changed');
});
it('exports the complete long answer without breaking the preview fence or message size', async () => {
  const text = '```text\n' + 'long result line\n'.repeat(250) + '```';
  const f = await resultFixture(text);
  expect(f.result.content.length).toBeLessThan(1951);
  expect(f.result.content.match(/```/g)?.length).toBe(2);
  await f.click(f.result, 'Download answer');
  expect(f.host.postFile).toHaveBeenCalledWith(
    channel,
    { name: 'response.txt', data: Buffer.from(text) },
    'Full answer',
    expect.any(Function)
  );
});
it('does not label a missing answer as completed', async () => {
  const f = await fixture();
  await f.ui.poll();
  const result = await f.click(f.findCard(), 'Results & files');
  expect(result.content).toContain('No answer is available yet.');
  expect(result.content).not.toContain('Completed');
});
it.each([false, true])('retires old automatic results cards only with matching bot ownership (%s)', async (foreign) => {
  const f = await fixture(),
    key = createHash('sha256')
      .update(guild + ':' + channel + ':result:s1')
      .digest('hex'),
    id = snow();
  f.messages.set(id, {
    id,
    channel,
    author: { id: foreign ? '999999999999999999' : bot },
    content: '**Results & files · w1-Codeman**\nNative execution: completed\n-# Codeman · result · ' + key.slice(0, 10),
  });
  await f.ui.store.edit((s) => {
    s.cards[key] = { channel, message: id, hash: 'old', kind: 'result', phase: 'ready', updated: 1 };
  });
  await f.ui.poll();
  expect(f.messages.has(id)).toBe(foreign);
  expect(Boolean((await f.ui.store.snapshot()).cards[key])).toBe(foreign);
});

it('uses a names-only workspace check before showing View changes', async () => {
  const f = await resultFixture();
  f.host.services.workspaceHasChanges = vi.fn(async () => true);
  vi.mocked(f.host.services.workspace).mockClear();
  const result = await f.click(f.findCard(), 'Results & files');
  expect(f.host.services.workspace).not.toHaveBeenCalled();
  await f.click(result, 'View changes');
  expect(f.host.services.workspace).toHaveBeenCalledOnce();
});
it('never substitutes a newer response when selected historical output is missing', async () => {
  const f = await fixture();
  const controls = await f.ui.responseControls('s1', channel, 'u1', 'missing');
  f.host.history = vi.fn(async () => ({
    conversationId: 'conversation-one',
    partial: false,
    turns: [
      { cursor: 'u1', role: 'user', text: 'Old task', timestamp: '' },
      { cursor: 'u2', role: 'user', text: 'New task', timestamp: '' },
      { cursor: 'r2', role: 'assistant', text: 'Unrelated [new.pdf](/work/new.pdf)', timestamp: '' },
    ],
  }));
  await f.click({ content: '', components: controls }, 'Results & files');
  expect(f.finishes.at(-1)?.content).toContain('outside the available history');
  expect(f.host.file).not.toHaveBeenCalled();
});

const activityBody = (payload: DiscordUiPayload) =>
  discordUiNodes(payload.components)
    .filter((n) => n.type === 10)
    .map((n) => n.content)
    .join('\n');
it('replaces a legacy dashboard in place, pins it and always keeps its shared view Recent', async () => {
  const f = await fixture();
  const key = createHash('sha256')
    .update(guild + ':' + parent + ':dashboard:main')
    .digest('hex');
  const id = snow();
  f.messages.set(id, {
    id,
    channel: parent,
    author: { id: bot },
    content: '**Codeman workspace**\n-# Codeman · dashboard · ' + key.slice(0, 10),
    components: [],
  });
  await f.ui.store.edit((s) => {
    s.cards[key] = { kind: 'dashboard', phase: 'ready', channel: parent, message: id, hash: 'old', updated: 1 };
  });
  await f.ui.poll();
  const shared = f.messages.get(id)!;
  expect(shared.flags! & 32768).toBeTruthy();
  expect(shared.flags! & 4096).toBeTruthy();
  expect(shared.content).toBeNull();
  expect(activityBody(shared)).toContain('## Activity');
  expect(f.host.request).toHaveBeenCalledWith('PUT', `/channels/${parent}/messages/pins/${id}`);
  expect([...f.messages.values()].filter((m) => m.channel === parent)).toHaveLength(1);
  const menu = f.component(shared, 'Choose activity view');
  await f.ui.interaction(f.event(menu, { channel_id: parent, message: { id } }, ['finished']));
  expect(f.responses.at(-1)).toMatchObject({ type: 5, data: { flags: 64 } });
  expect(activityBody(f.finishes.at(-1)!)).toContain('**Finished**');
  expect(activityBody(f.messages.get(id)!)).toContain('**Recent activity**');
  expect(discordUiNodes(shared.components).length).toBeLessThanOrEqual(40);
  expect(JSON.stringify(shared.allowed_mentions)).toBe(JSON.stringify({ parse: [], users: [] }));
  f.advance(21000);
  await f.ui.poll();
  expect([...f.messages.values()].filter((m) => m.channel === parent)).toHaveLength(1);
  const restored = new DiscordNativeUi(f.host);
  await restored.poll();
  expect([...f.messages.values()].filter((m) => m.channel === parent)).toHaveLength(1);
});
it('orders durable native activity by event time, keeps completion proof and exact response links across restarts', async () => {
  const f = await fixture();
  f.sessions[0].working = false;
  f.host.responseMessage = async () => '777777777777777777';
  const history = {
    conversationId: 'conversation-one',
    partial: false,
    turns: [
      {
        role: 'user' as const,
        cursor: 'u',
        timestamp: new Date(800000).toISOString(),
        text: 'Private prompt must not be previewed',
      },
      {
        role: 'assistant' as const,
        cursor: 'r',
        phase: 'final_answer' as const,
        timestamp: new Date(900000).toISOString(),
        text: 'Deployment verified.',
      },
    ],
    executions: [
      {
        userCursor: 'u',
        promptHash: 'x',
        state: 'completed' as const,
        timestamp: new Date(910000).toISOString(),
        cursor: 'done',
      },
    ],
  };
  await f.ui.observeHistory('s1', history);
  await f.ui.poll();
  let dashboard = [...f.messages.values()].find((m) => m.channel === parent)!;
  expect(activityBody(dashboard)).toContain('Turn finished · <t:910:R>');
  expect(activityBody(dashboard)).toContain('Deployment verified.');
  expect(activityBody(dashboard)).not.toContain('Private prompt');
  expect(discordUiNodes(dashboard.components).find((n) => n.label === 'View reply')?.url).toBe(
    `https://discord.com/channels/${guild}/${channel}/777777777777777777`
  );
  const raw = await readFile(join(f.dir, 'discord-native-ui.json'), 'utf8');
  f.advance(21000);
  await f.ui.observeHistory('s1', history);
  expect(await readFile(join(f.dir, 'discord-native-ui.json'), 'utf8')).toBe(raw);
  const restarted = new DiscordNativeUi(f.host);
  await restarted.poll();
  dashboard = [...f.messages.values()].find((m) => m.channel === parent)!;
  expect(activityBody(dashboard)).toContain('Turn finished · <t:910:R>');
  f.advance(3600001);
  await restarted.poll();
  const privateView = await f.command('codeman');
  const finished = await f.click(privateView, 'Choose activity view', ['finished'], { channel_id: parent });
  expect(activityBody(finished)).not.toContain('w1-Codeman');
});
it('does not infer completion from idle or prose and clears old conversation activity', async () => {
  const f = await fixture();
  f.sessions[0].working = false;
  await f.ui.observeHistory('s1', {
    conversationId: 'conversation-one',
    partial: false,
    turns: [
      {
        role: 'assistant',
        cursor: 'r',
        phase: 'final_answer',
        timestamp: new Date(900000).toISOString(),
        text: 'Everything is complete.',
      },
    ],
  });
  const view = await f.command('codeman');
  expect(activityBody(view)).toContain('Response received');
  expect(activityBody(view)).not.toContain('Turn finished');
  f.sessions[0].conversation = 'new-conversation';
  const fresh = await f.command('codeman');
  expect(activityBody(fresh)).not.toContain('Everything is complete');
  f.setScope('different-scope');
  const scoped = await f.command('codeman');
  expect(activityBody(scoped)).not.toContain('Everything is complete');
});
it('retains event timestamps across refreshes and moves newly updated sessions to the top with private pagination', async () => {
  const f = await fixture();
  f.sessions.push(
    ...Array.from({ length: 6 }, (_, i) => ({
      ...f.sessions[0],
      id: 's' + (i + 2),
      name: 'Session ' + (i + 2),
      working: false,
      lastPromptAt: 800000 + i * 1000,
    }))
  );
  f.sessions[0].lastPromptAt = 700000;
  f.host.channelForSession = (id) => String(222222222222222222n + BigInt(Number(id.slice(1)) - 1));
  f.host.sessionForChannel = (c) => f.sessions.find((s) => f.host.channelForSession(s.id) === c)?.id;
  const first = await f.command('codeman');
  expect(discordUiNodes(first.components).find((n) => n.type === 9)?.components).toEqual(
    expect.arrayContaining([expect.objectContaining({ content: expect.stringContaining('Session 7') })])
  );
  const page = await f.click(first, 'Next', undefined, { channel_id: parent });
  expect(activityBody(page)).toContain('w1-Codeman');
  await f.ui.observeHistory('s1', {
    conversationId: 'conversation-one',
    partial: false,
    turns: [
      {
        role: 'assistant',
        cursor: 'new',
        phase: 'commentary',
        timestamp: new Date(990000).toISOString(),
        text: 'Fresh activity.',
      },
    ],
  });
  const newer = await f.command('codeman');
  expect(discordUiNodes(newer.components).find((n) => n.type === 9)?.components).toEqual(
    expect.arrayContaining([expect.objectContaining({ content: expect.stringContaining('w1-Codeman') })])
  );
  expect(discordUiNodes(newer.components).length).toBeLessThanOrEqual(40);
});

it('keeps the last observed rows and successful sync timestamp during a session-service outage', async () => {
  const f = await fixture();
  await f.ui.poll();
  const old = [...f.messages.values()].find((m) => m.channel === parent)!;
  const text = activityBody(old);
  f.advance(21000);
  f.host.services.sessions = async () => {
    throw new Error('offline');
  };
  await expect(f.ui.poll()).rejects.toThrow('offline');
  const stale = [...f.messages.values()].find((m) => m.channel === parent)!;
  expect(activityBody(stale)).toContain('Connection interrupted');
  expect(activityBody(stale)).toContain('w1-Codeman');
  const stamp = /<t:(\d+):R>/.exec(text)![1];
  expect(activityBody(stale)).toContain('Last synced <t:' + stamp + ':R>');
});
it('keeps a resolved question from looking pending and does not reorder it on reads', async () => {
  const f = await fixture();
  Object.assign(f.sessions[0], { pending: true, pendingAt: 900000, pendingRevision: 'question-1' });
  const question = await f.command('codeman');
  expect(activityBody(question)).toContain('Needs your answer');
  const recorded = (await f.ui.store.snapshot()).activities;
  f.sessions[0].pending = false;
  f.advance(1000);
  const resolved = await f.command('codeman');
  expect(activityBody(resolved)).toContain('Question resolved');
  expect((await f.ui.store.snapshot()).activities).toEqual(recorded);
});

it('keeps legacy question and launch panels valid when editing a V2 ephemeral message', () => {
  const converted = uiV2Payload({
    content: 'Which case?',
    components: [{ type: 1, components: [{ type: 2, style: 2, label: 'Choose', custom_id: 'cmui:test' }] }],
  });
  expect(converted.flags! & 32768).toBeTruthy();
  expect(activityBody(converted)).toBe('Which case?');
  expect(discordUiNodes(converted.components).find((n) => n.label === 'Choose')).toBeDefined();
  expect(uiWirePayload(converted, true)).toMatchObject({ content: null, embeds: [] });
  expect(uiWirePayload(converted)).not.toHaveProperty('content');
});

it('renders the approved five-row activity layout using actual session events', async () => {
  const f = await fixture();
  const names = ['w4-Codeman', 'w1-Plex', 'w2-brain', 'w3-home-mon', 'w1-Coffee', 'w2-Cards'];
  f.sessions.splice(
    0,
    f.sessions.length,
    ...names.map((name, i) => ({
      id: 's' + (i + 1),
      name,
      host: i === 2 || i === 4 ? 'remote' : 'beelink',
      caseName: ['Codeman', 'Plex previews', 'brain', 'home-mon', 'Third Culture Coffee', 'Card benefits'][i],
      mode: 'codex',
      conversation: 'c' + i,
      working: i === 1 || i >= 4,
      pending: i === 2,
      pendingAt: i === 2 ? Date.now() - 194000 : undefined,
      pendingRevision: i === 2 ? 'q1' : undefined,
      ready: true,
      exited: false,
      url: 'https://example.test/#session=s' + i,
    }))
  );
  f.host.channelForSession = (id) => String(222222222222222222n + BigInt(Number(id.slice(1)) - 1));
  f.host.sessionForChannel = (c) => f.sessions.find((s) => f.host.channelForSession(s.id) === c)?.id;
  f.advance(Date.now() - f.host.now());
  f.host.responseMessage = async (id) => String(777777777777777777n + BigInt(Number(id.slice(1))));
  const ages = [22, 76, 194, 357, 528, 741];
  const summaries = [
    'Reverted and deployed [176](https://github.com/johoja12/Codeman/pull/176). Titles are plain bold again.',
    'Checking preview generation across the library.',
    'Waiting for your approval to continue.',
    'Health checks passed. Services are responding.',
    'Validating the updated store ordering flow.',
    'Comparing the latest issuer benefit terms.',
  ];
  for (const [i, s] of f.sessions.entries())
    await f.ui.observeHistory(s.id, {
      conversationId: s.conversation!,
      partial: false,
      turns: [
        {
          role: 'user',
          cursor: 'u' + i,
          timestamp: new Date(f.host.now() - (ages[i] + 100) * 1000).toISOString(),
          text: 'Private task',
        },
        {
          role: 'assistant',
          cursor: 'a' + i,
          phase: i === 0 || i === 3 ? 'final_answer' : 'commentary',
          timestamp: new Date(f.host.now() - ages[i] * 1000).toISOString(),
          text: summaries[i],
        },
      ],
      executions: i === 0 || i === 3 ? [{ userCursor: 'u' + i, promptHash: 'proof', state: 'completed' }] : [],
    });
  await f.ui.poll();
  const actual = [...f.messages.values()].find((m) => m.channel === parent)!;
  expect(discordUiNodes(actual.components).filter((n) => n.type === 9)).toHaveLength(5);
  expect(discordUiNodes(actual.components).length).toBeLessThanOrEqual(40);
  expect(
    discordUiNodes(actual.components)
      .filter((n) => n.type === 10)
      .map((n) => String(n.content ?? ''))
      .join('').length
  ).toBeLessThan(4000);
  for (const node of discordUiNodes(actual.components)) {
    if (node.type === 17) expect((node.components as unknown[]).length).toBeLessThanOrEqual(10);
  }
  if (process.env.ACTIVITY_ARTIFACT_DIR) {
    const { id: _id, channel: _channel, author: _author, ...payload } = actual;
    await writeFile(join(process.env.ACTIVITY_ARTIFACT_DIR, 'payload.json'), JSON.stringify(payload, null, 2));
  }
});

it('does not bump an unchanged pending question when the hook registry is restored', async () => {
  const f = await fixture();
  Object.assign(f.sessions[0], { pending: true, pendingAt: 900000, pendingRevision: 'same-native-question' });
  await f.command('codeman');
  const initial = (await f.ui.store.snapshot()).activities;
  f.advance(30000);
  f.sessions[0].pendingAt = f.host.now();
  await f.command('codeman');
  expect((await f.ui.store.snapshot()).activities).toEqual(initial);
  f.sessions[0].pendingRevision = 'different-native-question';
  await f.command('codeman');
  expect(Object.values((await f.ui.store.snapshot()).activities)[0].at).toBe(f.host.now());
});

it('keeps a plain session heading and a clickable preview without making Review submit input', async () => {
  const f = await fixture();
  const view = await f.command('codeman');
  const section = discordUiNodes(view.components).find((n) => n.type === 9)!;
  const text = String((section.components as Array<{ content: string }>)[0].content);
  const target = `https://discord.com/channels/${guild}/${channel}`;
  expect(text).toContain('**🟡 w1-Codeman**');
  expect(text).not.toContain(`[🟡 w1-Codeman](${target})`);
  expect(text).toContain(`[Work is in progress.](${target})`);
  expect(f.host.submit).not.toHaveBeenCalled();
});

it('renders saved URL-bearing previews as one valid thread link while keeping titles plain', async () => {
  const f = await fixture();
  f.sessions[0].working = false;
  await f.ui.observeHistory('s1', {
    conversationId: 'conversation-one',
    partial: false,
    turns: [
      {
        role: 'assistant',
        cursor: 'a',
        timestamp: new Date(900000).toISOString(),
        text: 'Reverted and deployed [176](https://github.com/johoja12/Codeman/pull/176). Titles are plain bold again.',
      },
    ],
  });
  const stored = (await f.ui.store.snapshot()).activities;
  expect(Object.values(stored)[0].summary).toContain('https://github.com/');
  const view = await f.command('codeman');
  const section = discordUiNodes(view.components).find((n) => n.type === 9)!;
  const text = String((section.components as Array<{ content: string }>)[0].content);
  const line = text.split('\n').find((l) => l.startsWith('-# ['))!;
  expect(text).toContain('**⚫ w1-Codeman**');
  expect(line).toBe(
    `-# [Reverted and deployed 176. Titles are plain bold again.](https://discord.com/channels/${guild}/${channel})`
  );
  expect((await f.ui.store.snapshot()).activities).toEqual(stored);
  expect(f.host.submit).not.toHaveBeenCalled();
});
