/** Narrow ports: native Discord UI reuses existing session, input and file services. */
import type {
  DiscordControlReply,
  DiscordFile,
  GatewayMessage,
  DiscordInteraction,
  DiscordPost,
} from './discord-bridge.js';
import type { DiscordHistory } from './discord-history.js';
export interface DiscordUiSession {
  id: string;
  name: string;
  mode: string;
  host: string;
  caseName: string;
  conversation?: string;
  inputRevision?: string;
  working: boolean;
  pending: boolean;
  exited: boolean;
  ready: boolean;
  model?: string;
  effort?: string;
  approval?: string;
  promptSuggestion?: string;
  lastPromptAt?: number;
  pendingAt?: number;
  pendingRevision?: string;
  url?: string;
}
export interface DiscordUiQuestion {
  id: string;
  revision: string;
  kind: 'permission' | 'question' | 'idle';
  text: string;
  options: Array<{ n: number; label: string }>;
  terminalOnly: boolean;
}
export interface DiscordUiCase {
  key: string;
  name: string;
  host: string;
}
export interface DiscordNativeUiServices {
  enabled(): boolean;
  sessions(): Promise<DiscordUiSession[]>;
  submitQueued(
    id: string,
    text: string,
    conversation: string,
    allowed: () => boolean,
    inputRevision?: string
  ): Promise<'accepted' | 'blocked' | 'uncertain'>;
  cases(): Promise<DiscordUiCase[]>;
  defaults(): Promise<{ model: string; effort: string; approval: string }>;
  saveDefaults(values: { model: string; effort: string; approval: string }, current: () => boolean): Promise<void>;
  question(id: string): DiscordUiQuestion | undefined;
  answer(id: string, question: string, revision: string, value: string): Promise<string>;
  workspaceHasChanges?(id: string): Promise<boolean>;
  workspace(id: string): Promise<{ summary: string; diff: string }>;
}
export interface DiscordUiPayload {
  content: string;
  flags?: number;
  components?: DiscordPost['components'];
  allowed_mentions?: { parse: string[]; users: string[] };
}
export interface DiscordNativeUiHost {
  dir: string;
  scope(): string | undefined;
  config(): { guild: string; parent: string; allowed: string[] };
  sessionForChannel(channel: string): string | undefined;
  channelForSession(id: string): string | undefined;
  ownsChannel(channel: string): boolean;
  verify(id: string, channel: string): Promise<void>;
  passive(id: string, channel: string): Promise<boolean>;
  request(method: string, path: string, body?: unknown, current?: () => boolean): Promise<unknown>;
  respond(m: DiscordInteraction, body: unknown): Promise<void>;
  finish(m: DiscordInteraction, body: DiscordUiPayload): Promise<void>;
  control(id: string, command: string): Promise<DiscordControlReply>;
  current(id: string, validity: string): boolean;
  postControl(id: string, channel: string, result: DiscordControlReply, key: string): Promise<void>;
  history(id: string, options?: { after?: string; includeTools?: boolean }): Promise<DiscordHistory>;
  latestPrompt?(id: string, conversation?: string): string | undefined;
  prepare(id: string, message: GatewayMessage): Promise<string>;
  submit(
    id: string,
    channel: string,
    actor: string,
    source: string,
    text: string,
    conversation: string,
    idle?: boolean,
    inputRevision?: string
  ): Promise<'accepted' | 'uncertain' | 'blocked'>;
  note(source: string, state: 'queued' | 'cancelled'): Promise<void>;
  receipts(
    id: string
  ): Promise<Array<{ id: string; state: string; reason?: string; updated: number; message?: string }>>;
  claim(m: DiscordInteraction): Promise<boolean>;
  file(id: string, path: string): Promise<DiscordFile>;
  postFile(channel: string, file: DiscordFile, text: string, current?: () => boolean): Promise<void>;
  launch(scope: string, caseKey: string, mode: string): Promise<DiscordControlReply>;
  modes(): string[];
  locate(id: string): Promise<string | undefined>;
  responseMessage?(id: string, cursor: string): Promise<string | undefined>;
  botId(): Promise<string | undefined>;
  now(): number;
  services: DiscordNativeUiServices;
}
