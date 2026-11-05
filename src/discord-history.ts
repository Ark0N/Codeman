import { discordDisplayText } from './discord-display-text.js';
import { probeRemoteDiscordConversation } from './discord-remote-conversation.js';
import { getCli } from './config/cli-registry/registry.js';
import { nativeExecutions, type DiscordNativeExecution } from './discord-native-execution.js';
/** Read-only, exact-conversation history. No cwd guesses, model turns, tool results or reasoning. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { resolve, posix } from 'node:path';
import { codexMessageFromLine, isCodexInjectedContext } from './codex-rollout-format.js';
import { shellescape, withRemotePathBootstrap } from './remote-hosts.js';
import { runDiscordRemoteRead } from './discord-file-transfers.js';
import type { SessionRemote } from './types/session.js';
const exec = promisify(execFile);
interface NativeHistoryRow {
  type?: string;
  timestamp?: string;
  sessionId?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  message?: { content?: unknown };
  payload?: {
    type?: string;
    output?: unknown;
    role?: string;
    content?: unknown;
    message?: unknown;
    item?: { type?: string; content?: unknown };
  };
  attachment?: { type?: string; origin?: { kind?: string }; commandMode?: string; prompt?: string; timestamp?: string };
}
function textBlock(value: unknown): value is { type: 'text'; text: string } {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { type?: unknown }).type === 'text' &&
    typeof (value as { text?: unknown }).text === 'string'
  );
}
function codexVisibleRow(row: NativeHistoryRow): unknown {
  const p = row.payload;
  if (!p) return row;
  if (row.type === 'response_item' && p.type && p.type !== 'message') return undefined;
  const content = (value: unknown) =>
    typeof value === 'string'
      ? value
      : Array.isArray(value)
        ? value.filter(
            (v): v is { type: string; text: string } =>
              !!v &&
              typeof v === 'object' &&
              ['input_text', 'output_text', 'text'].includes(v.type) &&
              typeof v.text === 'string'
          )
        : value;
  return {
    ...row,
    payload: {
      ...p,
      content: content(p.content),
      message: content(p.message),
      item: p.item ? { ...p.item, content: content(p.item.content) } : undefined,
    },
  };
}
export interface DiscordHistoryTurn {
  cursor: string;
  role: 'user' | 'assistant' | 'tool';
  timestamp: string;
  text: string;
}
export interface DiscordHistory {
  conversationId: string;
  turns: DiscordHistoryTurn[];
  partial: boolean;
  executions?: DiscordNativeExecution[];
  notice?: string;
}
export interface DiscordHistorySource {
  mode: string;
  conversationId?: string | null;
  remote?: SessionRemote;
  configHome?: string;
  includeTools?: boolean;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Bounded inventory and bounded tail. Exact UUID only; ambiguous copies are unavailable. */
const HISTORY_SCRIPT = String.raw`
import os,sys,json,stat,base64
s=json.loads(sys.argv[1]);mode=s['format'];ident=s['id'];limit=2*1024*1024
root=os.path.expanduser(s.get('home') or os.environ.get('CLAUDE_CONFIG_DIR' if mode=='claude-jsonl' else 'CODEX_HOME') or ('~/.claude' if mode=='claude-jsonl' else '~/.codex'))
root=os.path.join(root,'projects' if mode=='claude-jsonl' else 'sessions');found=[];count=0
for parent,dirs,files in os.walk(root,followlinks=False):
 dirs[:]=[d for d in dirs if not os.path.islink(os.path.join(parent,d))]
 depth=os.path.relpath(parent,root).count(os.sep)
 if depth>5: dirs[:]=[];continue
 for name in files:
  count+=1
  if count>16384: raise Exception('inventory limit')
  match=(name==ident+'.jsonl') if mode=='claude-jsonl' else name.endswith('-'+ident+'.jsonl')
  if not match: continue
  path=os.path.join(parent,name)
  if os.path.islink(path) or not stat.S_ISREG(os.lstat(path).st_mode): continue
  found.append(path)
if len(found)!=1: raise Exception('missing or ambiguous transcript')
f=os.open(found[0],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
try:
 info=os.fstat(f)
 if not stat.S_ISREG(info.st_mode): raise Exception('not regular')
 head=os.read(f,65536).split(b'\n')[0]
 if mode=='codex-rollout':
  meta=json.loads(head)
  if meta.get('type')!='session_meta' or meta.get('payload',{}).get('id')!=ident: raise Exception('identity mismatch')
 offset=max(0,info.st_size-limit);os.lseek(f,offset,0);data=os.read(f,limit)
 if offset:
  end=data.find(b'\n')
  if end<0: raise Exception('oversize row')
  offset+=end+1;data=data[end+1:]
 # Ignore an incomplete final row; it will be included on the next read.
 end=data.rfind(b'\n');data=data[:end+1] if end>=0 else b''
 print(json.dumps({'offset':offset,'data':base64.b64encode(data).decode(),'partial':offset>0}))
finally: os.close(f)
`;
export function discordHistoryCommand(source: DiscordHistorySource): string {
  const format = getCli(source.mode)?.capabilities.transcript;
  if (
    !source.conversationId ||
    !UUID.test(source.conversationId) ||
    !['claude-jsonl', 'codex-rollout'].includes(format ?? '')
  )
    throw new Error('Exact Claude/Codex conversation identity is unavailable');
  return withRemotePathBootstrap(
    'python3 -c ' +
      shellescape(HISTORY_SCRIPT) +
      ' ' +
      shellescape(JSON.stringify({ format, id: source.conversationId, home: source.configHome }))
  );
}
export function parseDiscordHistory(source: DiscordHistorySource, raw: string): DiscordHistory {
  const format = getCli(source.mode)?.capabilities.transcript;
  const packet = JSON.parse(raw) as { offset: number; data: string; partial: boolean };
  if (
    !Number.isSafeInteger(packet.offset) ||
    packet.offset < 0 ||
    typeof packet.data !== 'string' ||
    packet.data.length > 3 * 1024 * 1024
  )
    throw new Error('Invalid history packet');
  const content = Buffer.from(packet.data, 'base64');
  let offset = packet.offset;
  const rows: Array<{ value: NativeHistoryRow; offset: number; raw: string }> = [];
  for (const line of content.toString('utf8').split('\n')) {
    if (line) {
      try {
        const value: unknown = JSON.parse(line);
        if (value && typeof value === 'object' && !Array.isArray(value))
          rows.push({ value: value as NativeHistoryRow, offset, raw: line });
      } catch {
        /* partial or malformed record */
      }
    }
    offset += Buffer.byteLength(line) + 1;
  }
  const turns: DiscordHistoryTurn[] = [];
  for (const { value: e, offset, raw } of rows) {
    let role: 'user' | 'assistant' | 'tool' | undefined,
      text = '',
      timestamp = typeof e.timestamp === 'string' ? e.timestamp : '';
    if (source.includeTools) {
      let output = '';
      if (
        format === 'codex-rollout' &&
        e.type === 'response_item' &&
        e.payload?.type === 'function_call_output' &&
        typeof e.payload.output === 'string'
      )
        output = e.payload.output;
      if (
        format === 'claude-jsonl' &&
        e.type === 'user' &&
        !e.isSidechain &&
        (!e.sessionId || e.sessionId === source.conversationId) &&
        Array.isArray(e.message?.content)
      ) {
        output = e.message.content
          .filter(
            (x): x is { type: string; content: unknown } => !!x && typeof x === 'object' && x.type === 'tool_result'
          )
          .map((x) =>
            typeof x.content === 'string'
              ? x.content
              : Array.isArray(x.content)
                ? x.content
                    .filter(textBlock)
                    .map((y) => y.text)
                    .join('\n')
                : ''
          )
          .join('\n');
      }
      if (output)
        turns.push({
          role: 'tool',
          text: output.slice(0, 2000),
          timestamp,
          cursor: `${source.conversationId}:${offset}:${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`,
        });
    }
    if (format === 'codex-rollout') {
      const msg = codexMessageFromLine(codexVisibleRow(e));
      if (!msg || (msg.injectionProne && isCodexInjectedContext(msg.text))) continue;
      role = msg.role;
      text = msg.text;
    } else {
      if (e.isSidechain || e.isMeta || e.isCompactSummary || (e.sessionId && e.sessionId !== source.conversationId))
        continue;
      let body = e.message?.content;
      if (
        e.type === 'attachment' &&
        e.attachment?.type === 'queued_command' &&
        e.attachment.origin?.kind === 'human' &&
        e.attachment.commandMode === 'prompt'
      ) {
        role = 'user';
        body = e.attachment.prompt;
        timestamp = e.attachment.timestamp || timestamp;
      } else if (e.type === 'user' || e.type === 'assistant') role = e.type;
      if (!role) continue;
      text =
        typeof body === 'string'
          ? body
          : Array.isArray(body)
            ? body
                .filter(textBlock)
                .map((x) => x.text)
                .join('\n')
            : '';
      if (
        role === 'user' &&
        /^(?:<local-command|<command-name>|<task-notification>|<system-reminder>|<teammate-message\b|Another Claude session sent a message:|Base directory for this skill:)/i.test(
          text.trim()
        )
      )
        continue;
    }
    if (!role || !text.trim()) continue;
    const prev = turns.at(-1);
    if (prev?.role === role && prev.text === text) continue;
    turns.push({
      role,
      text,
      timestamp,
      cursor: `${source.conversationId}:${offset}:${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`,
    });
  }
  const executions = nativeExecutions(
    format ?? 'none',
    source.conversationId!,
    rows.map((r) => ({
      value: r.value,
      cursor: `${source.conversationId}:${r.offset}:${createHash('sha256').update(r.raw).digest('hex').slice(0, 16)}`,
    })),
    turns
  );
  return { conversationId: source.conversationId!, turns, partial: packet.partial === true, executions };
}
export async function readDiscordHistory(source: DiscordHistorySource): Promise<DiscordHistory> {
  const command = discordHistoryCommand(source);
  const raw = source.remote
    ? await runDiscordRemoteRead(source.remote, command)
    : (await exec('sh', ['-c', command], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 })).stdout;
  return parseDiscordHistory(source, String(raw));
}
export function historyPage(
  history: DiscordHistory,
  before?: string,
  limit = 12
): { turns: DiscordHistoryTurn[]; older?: string } {
  const end = before ? history.turns.findIndex((t) => t.cursor === before) : history.turns.length;
  if (end < 0) throw new Error('History cursor expired or conversation changed; request history again');
  const start = Math.max(0, end - Math.min(20, Math.max(1, limit)));
  return { turns: history.turns.slice(start, end), older: start > 0 ? history.turns[start].cursor : undefined };
}

const adoptedNativeIds = new WeakMap<object, string>();
type DiscordHistorySession = import('./session.js').Session & {
  nativeResumeId?: string;
  setNativeResumeId?: (id: string) => void;
};

/** Adapts live Session metadata; never guesses by shared directory or falls back to terminal redraws. */
export async function readDiscordSessionHistory(
  session: DiscordHistorySession,
  options?: { includeTools?: boolean }
): Promise<DiscordHistory> {
  const format = getCli(session.mode)?.capabilities.transcript;
  let id =
    format === 'claude-jsonl'
      ? session.claudeSessionId
      : (session.nativeResumeId ?? adoptedNativeIds.get(session) ?? session.codexConfig?.resumeSessionId);
  const key = format === 'claude-jsonl' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
  let configHome = session.envOverrideValue(key) ?? (!session.remote ? process.env[key] : undefined);
  if (configHome && !configHome.startsWith('~/'))
    configHome = session.remote
      ? posix.isAbsolute(configHome)
        ? configHome
        : posix.resolve(session.remote.remotePath, configHome)
      : resolve(session.workingDir, configHome);
  if (format === 'codex-rollout' && !session.remote) {
    const { findOwnedCodexConversation, resolveEffectiveCodexHome } =
      await import('./checkpoint-conversation-identity.js');
    id =
      (
        await findOwnedCodexConversation({
          codexHome: resolveEffectiveCodexHome(configHome, session.workingDir),
          sessionId: session.id,
          nativeResumeId: id ?? undefined,
          lastSubmitAt: session.lastSubmitAt,
        })
      )?.id ?? id;
  }
  if (session.docker) throw new Error('Container history is not available through this reader');
  const remote = session.remote;
  const discovered =
    format === 'codex-rollout' && remote && !id
      ? await probeRemoteDiscordConversation(remote, session.id).catch(() => undefined)
      : undefined;
  id ??= discovered;
  const history = await readDiscordHistory({
    mode: session.mode,
    conversationId: id,
    remote: session.remote,
    configHome,
    includeTools: options?.includeTools,
  });
  // Publish only after the exact transcript header was verified, and never overwrite a concurrent adoption.
  if (discovered && (session.remote !== remote || (session.nativeResumeId && session.nativeResumeId !== discovered)))
    throw new Error('Native conversation changed during history discovery');
  if (discovered && !session.nativeResumeId) {
    adoptedNativeIds.set(session, discovered);
    session.setNativeResumeId?.(discovered);
  }
  return history;
}
export function renderHistory(turns: DiscordHistoryTurn[], options: { includeTimestamps?: boolean } = {}): string {
  return turns
    .filter((t) => t.role !== 'assistant' || !!discordDisplayText(t.text).trim())
    .map(
      (t) =>
        `**${t.role === 'user' ? 'You' : t.role === 'tool' ? 'Tool output' : 'Assistant'}**${options.includeTimestamps === false ? '' : ' ' + (t.timestamp || '(time unavailable)')}\n${t.role === 'assistant' ? discordDisplayText(t.text) : t.text}`
    )
    .join('\n\n');
}
export async function discordHistoryControl(
  session: import('./session.js').Session,
  command: string
): Promise<{ text: string; file?: { name: string; data: Uint8Array } }> {
  if (command === 'status') {
    const state = session.toState();
    return {
      text: `**${state.name || state.id}** · ${state.mode}\nHost: ${state.remote?.label || 'local'}\nState: ${state.paneExit ? 'agent exited' : session.isWorking ? 'working' : 'idle'}\n${session.isWorking ? 'Working' : 'No running task observed'}${state.remote ? ' · SSH transport' : ''}`,
    };
  }
  const match = /^history(?: (\S+))?$/.exec(command);
  if (!match && command !== 'transcript')
    return {
      text: 'Commands: !codeman status · !codeman history [cursor] · !codeman transcript · !codeman file /absolute/path',
    };
  try {
    const history = await readDiscordSessionHistory(session);
    const label = history.partial ? 'Partial history: bounded recent transcript.' : 'Conversation history';
    if (command === 'transcript')
      return {
        text: label + ' · user-visible messages only',
        file: { name: 'conversation.txt', data: Buffer.from(renderHistory(history.turns)) },
      };
    const page = historyPage(history, match?.[1]);
    return {
      text: `${label}\n${renderHistory(page.turns) || 'No user-visible turns yet.'}${page.older ? '\n\nLoad older: !codeman history ' + page.older : ''}`,
    };
  } catch {
    return {
      text: 'History unavailable: exact native conversation identity, Python 3, or its transcript is missing/unavailable. No terminal history was guessed. Try again after reconnecting; other CLIs require the web UI.',
    };
  }
}
