/** @fileoverview Explicit session lifecycle choices using shared web/backend services. No blank recovery or task replay. */
import { configuredDiscordCaseKey } from './discord-case-identity.js';
import { randomUUID, createHash } from 'node:crypto';
import type { CaseInfo, SessionMode } from './types.js';
/** Connector-facing recovery metadata; hosts without a saved recovery queue expose none. */
export interface DiscordRecoveryRecord {
  id: string;
  sourceSessionId: string;
  name?: string;
  status: string;
  transport: string;
  launch: { kind: string };
  nativeResumeId?: string;
  claudeResumeId?: string;
  recoveredSessionId?: string;
  [key: string]: unknown;
}
import type { DiscordControlReply } from './discord-bridge.js';
export interface DiscordManagedSession {
  id: string;
  name?: string;
  host: string;
  caseName: string;
  group: string;
  mode: string;
  state: string;
}
export interface DiscordSessionManagementDeps {
  allowed(): boolean;
  sessions(): Promise<DiscordManagedSession[]>;
  cases(): Promise<CaseInfo[]>;
  groups(): Promise<Array<{ id: string; name: string }>>;
  modes(): string[];
  create(body: { caseName: string; mode: SessionMode; tabGroupId?: string }): Promise<string>;
  recoveries?(): DiscordRecoveryRecord[];
  recoveryUnavailableReason?: string;
  recover?(id: string, action: 'reconnect' | 'resume'): Promise<string>;
  reconnect(id: string): Promise<boolean>;
  now?: () => number;
}
interface Confirmation {
  scope: string;
  expiresAt: number;
  run: () => Promise<DiscordControlReply>;
}
export class DiscordSessionManagement {
  private confirmations = new Map<string, Confirmation>();
  private busy = new Set<string>();
  constructor(private readonly deps: DiscordSessionManagementDeps) {}
  current(scope: string, validity: string): boolean {
    const c = this.confirmations.get(validity);
    return this.deps.allowed() && !!c && c.scope === scope && c.expiresAt > (this.deps.now?.() ?? Date.now());
  }
  private review(
    scope: string,
    key: string,
    text: string,
    run: () => Promise<DiscordControlReply>
  ): DiscordControlReply {
    const now = this.deps.now?.() ?? Date.now();
    for (const [token, c] of this.confirmations) if (c.expiresAt <= now) this.confirmations.delete(token);
    if (this.confirmations.size >= 128)
      return { text: 'Too many pending confirmations. Wait a minute and request again.' };
    const token = 'confirm:' + randomUUID();
    this.confirmations.set(token, {
      scope,
      expiresAt: now + 60000,
      run: async () => {
        if (this.busy.has(key)) return { text: 'That session operation is already in progress.' };
        this.busy.add(key);
        try {
          return await run();
        } finally {
          this.busy.delete(key);
        }
      },
    });
    return {
      text: text + `\nText fallback: !codeman confirm ${token}`,
      actions: [{ label: 'Confirm', command: 'confirm ' + token, validity: token }],
    };
  }
  /** Resolve an owned channel's root, never a display-name prefix or arbitrary supplied path. */
  async launch(scope: string, caseKey: string, mode: string): Promise<DiscordControlReply> {
    if (!this.deps.allowed() || !this.deps.modes().includes(mode))
      return { text: 'This CLI launch is unavailable. No session was created.' };
    const cases = await this.deps.cases();
    const matches = cases.filter((c) => configuredDiscordCaseKey(c) === caseKey && !c.unreachable);
    // The shared create endpoint selects by name. Reject aliases/collisions rather than risk another host.
    if (matches.length !== 1 || cases.filter((c) => c.name === matches[0].name).length !== 1)
      return {
        text: 'This channel has no unique available configured case. Link it in the web UI first. No session was created.',
      };
    const c = matches[0];
    return (await this.control(scope, `create ${c.name} ${c.remote?.hostId || 'local'} ${mode} default`))!;
  }
  async control(scope: string, command: string): Promise<DiscordControlReply | undefined> {
    if (!/^(sessions|open|cases|groups|recoveries|create|recover|reconnect|confirm|help)(?:\s|$)/.test(command))
      return undefined;
    if (!this.deps.allowed())
      return {
        text: 'Discord session management requires single-user mode. Multi-user identities must be explicitly mapped before lifecycle controls can be enabled; use the web UI.',
      };
    const confirm = /^confirm (confirm:[A-Za-z0-9-]+)$/.exec(command);
    if (confirm) {
      const c = this.confirmations.get(confirm[1]);
      if (!this.current(scope, confirm[1]) || !c)
        return { text: 'Confirmation expired, changed or was already used. Request the operation again.' };
      this.confirmations.delete(confirm[1]);
      return c.run();
    }
    const list = /^sessions(?: (\d+))?$/.exec(command);
    if (list) {
      const sessions = await this.deps.sessions();
      const offset = Math.min(Number(list[1] ?? 0), sessions.length);
      const page = sessions.slice(offset, offset + 10);
      return {
        text:
          page
            .map(
              (s) =>
                `**${s.name || s.id}** · ${s.id}\n${s.host} · case ${s.caseName} · group ${s.group} · ${s.mode} · ${s.state}\n!codeman open ${s.id}`
            )
            .join('\n\n') + (offset + 10 < sessions.length ? '\n!codeman sessions ' + (offset + 10) : '') ||
          'No active sessions. Use cases/groups to choose a new one.',
      };
    }
    const open = /^open ([A-Za-z0-9._-]+)$/.exec(command);
    if (open) {
      const session = (await this.deps.sessions()).find((s) => s.id === open[1]);
      return session
        ? { text: 'Session destination', locateSessionId: session.id }
        : { text: 'Session not found. Use !codeman sessions.' };
    }
    if (command === 'cases') {
      const cases = await this.deps.cases();
      return {
        text:
          cases
            .slice(0, 50)
            .map(
              (c) =>
                `${c.name} · host ${c.remote?.hostId || 'local'}${c.location === 'docker' ? ' · Docker (use web UI)' : ''}`
            )
            .join('\n') +
          '\nCLIs: ' +
          this.deps.modes().join(', '),
      };
    }
    if (command === 'groups') {
      const groups = await this.deps.groups();
      return {
        text: groups.map((g) => `${g.name} · ${g.id}`).join('\n') + '\nUse default to inherit the case default group.',
      };
    }
    if (command === 'recoveries') {
      if (this.deps.recoveryUnavailableReason) return { text: this.deps.recoveryUnavailableReason };
      if (!this.deps.recoveries || !this.deps.recover)
        return {
          text:
            this.deps.recoveryUnavailableReason ??
            'Saved-conversation recovery is unavailable in this build; use the web UI.',
        };
      const records = this.deps.recoveries().filter((r) => r.status !== 'recovered');
      return {
        text:
          records
            .slice(0, 30)
            .map(
              (r) =>
                `${r.name || r.sourceSessionId} · ${r.id}\n${r.transport} · ${r.mode} · ${r.status}\n!codeman recover ${r.id} <reconnect|resume>`
            )
            .join('\n\n') || 'No saved recovery records.',
      };
    }
    const create = /^create ([A-Za-z0-9_-]+) ([A-Za-z0-9_-]+) ([A-Za-z0-9_-]+) ([A-Za-z0-9_-]+)$/.exec(command);
    if (create) {
      const [, name, host, mode, group] = create;
      const cases = await this.deps.cases();
      const selected = cases.find(
        (c) => c.name === name && (c.remote?.hostId || 'local') === host && !c.docker && !c.unreachable
      );
      const groups = await this.deps.groups();
      if (
        !selected ||
        !this.deps.modes().includes(mode) ||
        (group !== 'default' && !groups.some((g) => g.id === group))
      )
        return {
          text: 'Choose an available case/host, supported CLI and group from !codeman cases and !codeman groups. No session was created.',
        };
      const fingerprint = createHash('sha256').update(JSON.stringify(selected)).digest('hex');
      return this.review(
        scope,
        'create:' + create.slice(1).join(':'),
        `Create ${mode} in ${name} on ${host}, group ${group}? No prompt will be submitted.`,
        async () => {
          const current = (await this.deps.cases()).find(
            (c) => c.name === name && (c.remote?.hostId || 'local') === host
          );
          if (
            !this.deps.allowed() ||
            !current ||
            createHash('sha256').update(JSON.stringify(current)).digest('hex') !== fingerprint ||
            (group !== 'default' && !(await this.deps.groups()).some((g) => g.id === group))
          )
            return { text: 'Case/host/group configuration changed. Request creation again.' };
          const id = await this.deps.create({
            caseName: name,
            mode: mode as SessionMode,
            tabGroupId: group === 'default' ? undefined : group,
          });
          return { text: 'Session created; no task was submitted.', locateSessionId: id };
        }
      );
    }
    const recovery = /^recover ([A-Za-z0-9._-]+) (reconnect|resume)$/.exec(command);
    if (recovery) {
      if (this.deps.recoveryUnavailableReason) return { text: this.deps.recoveryUnavailableReason };
      if (!this.deps.recoveries || !this.deps.recover)
        return {
          text:
            this.deps.recoveryUnavailableReason ??
            'Saved-conversation recovery is unavailable in this build; use the web UI.',
        };
      const record = this.deps.recoveries().find((r) => r.id === recovery[1]);
      const action = recovery[2] as 'reconnect' | 'resume';
      if (
        !record ||
        record.recoveredSessionId ||
        record.status === 'recovered' ||
        (action === 'resume' &&
          (record.status !== 'resumable' ||
            record.launch.kind !== 'built-in' ||
            (!record.nativeResumeId && !record.claudeResumeId))) ||
        (action === 'reconnect' &&
          (record.transport !== 'remote' || !['reattachable', 'manual_required'].includes(record.status)))
      )
        return {
          text: 'That exact recovery is not currently safe/available for this action. Refresh the Recovery Queue in the web UI; no blank conversation will be launched.',
        };
      const fingerprint = JSON.stringify(record);
      return this.review(
        scope,
        'recovery:' + record.id,
        `${action === 'resume' ? 'Resume the exact saved conversation' : 'Reconnect to the existing remote agent'} for ${record.name || record.sourceSessionId}? The interrupted task is not replayed.`,
        async () => {
          if (
            !this.deps.allowed() ||
            JSON.stringify(this.deps.recoveries?.().find((r) => r.id === record.id)) !== fingerprint
          )
            return { text: 'Recovery changed. Request it again.' };
          const id = await this.deps.recover!(record.id, action);
          return {
            text: 'Recovery launch/attachment returned; native readiness remains unconfirmed until observed.',
            locateSessionId: id,
          };
        }
      );
    }
    const reconnect = /^reconnect ([A-Za-z0-9._-]+)$/.exec(command);
    if (reconnect) {
      const id = reconnect[1];
      const session = (await this.deps.sessions()).find((s) => s.id === id);
      if (!session) return { text: 'Session not found. Use !codeman sessions or !codeman recoveries.' };
      const fingerprint = JSON.stringify(session);
      return this.review(
        scope,
        'reconnect:' + id,
        `Reconnect to the existing remote agent for ${session.name || id}? No new agent will be created.`,
        async () => {
          if (
            !this.deps.allowed() ||
            JSON.stringify((await this.deps.sessions()).find((s) => s.id === id)) !== fingerprint
          )
            return { text: 'Session changed. Request reconnect again.' };
          const ok = await this.deps.reconnect(id);
          return {
            text: ok
              ? 'Transport connected. Use !codeman status to check native activity.'
              : 'Reconnect is unavailable. Inspect the Recovery Queue; a blank conversation was not launched.',
            ...(ok ? { locateSessionId: id } : {}),
          };
        }
      );
    }
    return {
      text: 'Commands: sessions [offset] · open <session-id> · cases · groups · create <case> <host-id|local> <CLI> <group-id|default> · recoveries · recover <record-id> <reconnect|resume> · reconnect <session-id> · model [model-id] · effort [level] · status · history · transcript · pending · interrupt. Prefix commands with !codeman.',
    };
  }
}
