/** Native, verified, session-only model settings. No respawn or writes to CLI configuration files. */
import { getCli } from './config/cli-registry/registry.js';
import { randomUUID } from 'node:crypto';
import { nativeModelComposerReady } from './native-composer-ready.js';
import { stripAnsi } from './utils/regex-patterns.js';
import type { NativeModelSettingsLease } from './native-model-settings.js';
import type { DiscordControlReply } from './discord-bridge.js';

export interface NativeModelChoice {
  number: number;
  label: string;
  value?: string;
  selected: boolean;
  current: boolean;
}
export interface NativeModelMenu {
  choices: NativeModelChoice[];
  effort?: string;
}
const LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const normalize = (value: string) => value.toLowerCase().replace(/[ _-]/g, '');
const claudeAlias = (label: string): string | undefined => {
  const alias = /^(default|opus|sonnet|haiku|fable|best)\b/i.exec(label)?.[1].toLowerCase();
  return alias && /\b1m\b/i.test(label) ? alias + '[1m]' : alias;
};

export function readNativeModelMenu(mode: string, raw: string): NativeModelMenu | undefined {
  const profile = getCli(mode)?.capabilities.nativeSettingsProfile;
  if (!profile) return undefined;
  const text = stripAnsi(raw);
  const heading = profile === 'codex-tui' ? /(?:^|\n)\s*Select Model and Effort\s*\n/ : /(?:^|\n)\s*Select model\s*\n/;
  const at = [...text.matchAll(new RegExp(heading.source, 'gi'))].at(-1)?.index;
  if (at === undefined) return undefined;
  const body = text.slice(at);
  if (
    profile === 'claude-tui'
      ? !/Enter to set as default\s*·\s*s to use this session only\s*·\s*Esc to cancel/i.test(body)
      : !/enter select\s*·\s*esc back/i.test(body)
  )
    return undefined;
  const choices: NativeModelChoice[] = [];
  for (const row of body.split('\n')) {
    const match = /^\s*([›❯]?)\s*(\d{1,2})\.\s+(.+)$/.exec(row);
    if (!match) continue;
    const label = match[3]
      .split(/\s{2,}/)[0]
      .replace(/\s*\(current\)|\s*[✔✓]/gi, '')
      .trim();
    if (!label || label.length > 100 || choices.length >= 32) return undefined;
    choices.push({
      number: Number(match[2]),
      label,
      selected: !!match[1],
      current: /\(current\)|[✔✓]/i.test(match[3]),
      value: profile === 'claude-tui' ? claudeAlias(label) : undefined,
    });
  }
  if (
    !choices.length ||
    choices.filter((c) => c.selected).length !== 1 ||
    choices.filter((c) => c.current).length !== 1
  )
    return undefined;
  const effort = /\b(low|medium|high|xhigh|max|ultra) effort(?:\s*\(default\))?\s+[←→]/i.exec(body)?.[1].toLowerCase();
  return { choices, effort };
}

export { nativeModelComposerReady } from './native-composer-ready.js';

export function readCodexModelStatus(raw: string): { model: string; effort?: string; session: string } | undefined {
  const text = stripAnsi(raw);
  const commands = [...text.matchAll(/^\s*\/status\s*$/gm)];
  const last = commands.at(-1);
  if (!last) return undefined;
  const block = text.slice(last.index! + last[0].length);
  const model = /^\s*Model:\s+([^\n]+)\s*$/im.exec(block)?.[1].trim();
  const details = model && /^(.*?)\s+\(reasoning ([a-z]+)(?:,[^\n)]{1,120})?\)$/i.exec(model);
  const session = /^\s*Session:\s+([a-f0-9-]{36})\s*$/im.exec(block)?.[1];
  return model && session
    ? { model: details ? details[1].trim() : model, effort: details?.[2].toLowerCase(), session }
    : undefined;
}

/** Codex can repaint an identical /status page once its viewport is saturated.
 * Only the current empty-composer footer may corroborate an unchanged status block.
 */
export function codexStatusMatchesFooter(
  raw: string,
  status: { model: string; effort?: string },
  allowDefaultEffort = false
): boolean {
  if (!status.effort || !nativeModelComposerReady('codex', raw)) return false;
  const rows = stripAnsi(raw).split('\n');
  let composer = -1;
  for (let i = rows.length - 1; i >= 0; i--)
    if (/^\s*›(?:\s|$)/.test(rows[i])) {
      composer = i;
      break;
    }
  if (composer < 0) return false;
  return rows.slice(composer + 1).some((row) => {
    const footer = /^\s*(.+?)\s+(default|none|minimal|low|medium|high|xhigh|max|ultra)\s*·/.exec(row);
    return (
      !!footer &&
      normalize(footer[1]) === normalize(status.model) &&
      (footer[2] === status.effort || (allowDefaultEffort && footer[2] === 'default'))
    );
  });
}

export interface DiscordModelTarget {
  mode: string;
  generation: string;
  working: boolean;
  pending: boolean;
  exited: boolean;
  reportedModel?: string;
  operate<T>(operation: (lease: NativeModelSettingsLease) => Promise<T>, allowed: () => boolean): Promise<T>;
  /** Canonical IDs from the CLI's catalog, matched against its fresh native picker. */
  catalog?(): Promise<Array<{ id: string; label: string; efforts: string[] }>>;
}
interface ModelDeps {
  scope(): string | undefined;
  target(id: string): DiscordModelTarget | undefined;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
interface ChoiceReceipt {
  sessionId: string;
  generation: string;
  scope: string;
  expiresAt: number;
  kind: 'model' | 'effort';
  value: string;
}

export class DiscordModelControls {
  private receipts = new Map<string, ChoiceReceipt>();
  private verified = new Map<string, { scope: string; generation: string; model: string; effort?: string }>();
  observed(id: string): { model: string; effort?: string } | undefined {
    const v = this.verified.get(id);
    return v && v.scope === this.deps.scope() && v.generation === this.deps.target(id)?.generation ? v : undefined;
  }
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(private readonly deps: ModelDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }
  stop(): void {
    this.receipts.clear();
    this.verified.clear();
  }
  current(id: string, token: string): boolean {
    const r = this.receipts.get(token),
      target = this.deps.target(id);
    return (
      !!r &&
      !!target &&
      r.sessionId === id &&
      r.scope === this.deps.scope() &&
      r.generation === target.generation &&
      r.expiresAt > this.now() &&
      !target.pending &&
      !target.exited &&
      !target.working
    );
  }
  private action(id: string, target: DiscordModelTarget, kind: 'model' | 'effort', value: string, label: string) {
    for (const [key, r] of this.receipts) if (r.expiresAt <= this.now()) this.receipts.delete(key);
    if (this.receipts.size >= 256) return undefined;
    const token = 'model-setting:' + randomUUID();
    this.receipts.set(token, {
      sessionId: id,
      generation: target.generation,
      scope: this.deps.scope()!,
      expiresAt: this.now() + 60_000,
      kind,
      value,
    });
    return { label: label.slice(0, 80), command: kind + ' choose ' + token, validity: token };
  }
  async control(id: string, command: string): Promise<DiscordControlReply | undefined> {
    const match = /^(model|effort)(?:\s+(.*))?$/.exec(command);
    if (!match) return undefined;
    const kind = match[1] as 'model' | 'effort';
    let value = match[2]?.trim();
    const scope = this.deps.scope(),
      target = this.deps.target(id);
    if (!scope || !target) return { text: 'Use model/effort controls inside an available session thread.' };
    const profile = getCli(target.mode)?.capabilities.nativeSettingsProfile;
    if (!profile)
      return { text: 'Native model/effort controls currently support Claude and Codex. Use this CLI’s terminal.' };
    if (target.pending || target.exited)
      return { text: 'Resolve the pending dialog or reconnect the agent first. Nothing was changed.' };
    if (target.working)
      return {
        text: `Current reported model: ${target.reportedModel || 'not known'}. The agent is working; wait until it is idle before inspecting or changing native settings.`,
      };
    if (value?.startsWith('choose ')) {
      const token = value.slice(7),
        receipt = this.receipts.get(token);
      if (!receipt || receipt.kind !== kind || !this.current(id, token))
        return { text: 'That settings choice expired or the session changed. Request the choices again.' };
      this.receipts.delete(token);
      value = receipt.value;
    }
    if (value && (kind === 'effort' ? !LEVELS.includes(value) : !/^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,95}$/.test(value)))
      return {
        text: 'Use !codeman model <model-id> or !codeman effort <level>. Request either command without a value to inspect choices.',
      };
    const generation = target.generation;
    const allowed = () =>
      this.deps.scope() === scope &&
      this.deps.target(id)?.generation === generation &&
      !this.deps.target(id)?.pending &&
      !this.deps.target(id)?.exited &&
      !this.deps.target(id)?.working;
    try {
      let catalog: Array<{ id: string; label: string; efforts: string[] }> = [];
      if (profile === 'codex-tui' && !value && target.catalog) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          catalog = await Promise.race([
            target.catalog().catch(() => []),
            new Promise<typeof catalog>((resolve) => {
              timer = setTimeout(() => resolve([]), 2000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
      const result = await target.operate(async (lease) => {
        const initial = await lease.capture();
        if (!nativeModelComposerReady(target.mode, initial))
          throw new Error(
            'An empty native composer is required. Finish the draft or dialog in the web terminal first.'
          );
        return profile === 'codex-tui'
          ? this.codex(id, target, lease, kind, value, catalog)
          : this.claude(id, target, lease, kind, value);
      }, allowed);
      if (result.verifiedSettings && allowed())
        this.verified.set(id, { ...result.verifiedSettings, scope, generation });
      return result;
    } catch (error) {
      return {
        text:
          error instanceof Error
            ? error.message
            : 'Native settings could not be verified. Inspect the web terminal before retrying.',
      };
    }
  }
  private async wait<T>(lease: NativeModelSettingsLease, read: (screen: string) => T | undefined): Promise<T> {
    for (let i = 0; i < 30; i++) {
      const value = read(await lease.capture());
      if (value !== undefined) return value;
      await this.sleep(100);
    }
    throw new Error(
      'The CLI did not confirm the settings operation. Inspect the web terminal before retrying; no input will be replayed.'
    );
  }
  private async send(lease: NativeModelSettingsLease, input: string): Promise<void> {
    if (!lease.current() || !(await lease.write(input)))
      throw new Error(
        'The session or input changed. The settings operation stopped; inspect the terminal before retrying.'
      );
  }
  private async menu(lease: NativeModelSettingsLease, mode: string): Promise<NativeModelMenu> {
    await this.send(lease, '/model\r');
    return this.wait(lease, (s) => readNativeModelMenu(mode, s));
  }
  private async close(lease: NativeModelSettingsLease, mode: string): Promise<void> {
    await lease.cancelMenu();
    await this.wait(lease, (s) => (nativeModelComposerReady(mode, s) ? true : undefined));
  }
  private async status(
    lease: NativeModelSettingsLease,
    accept: (status: { model: string; effort?: string; session: string }) => boolean = () => true,
    allowDefaultEffort = false
  ) {
    const before = await lease.capture();
    await this.send(lease, '/status\r');
    return this.wait(lease, (s) => {
      if (!nativeModelComposerReady('codex', s)) return undefined;
      const status = readCodexModelStatus(s);
      return status && accept(status) && (s !== before || codexStatusMatchesFooter(s, status, allowDefaultEffort))
        ? status
        : undefined;
    });
  }
  private async codex(
    id: string,
    target: DiscordModelTarget,
    lease: NativeModelSettingsLease,
    kind: 'model' | 'effort',
    value?: string,
    catalog: Array<{ id: string; label: string; efforts: string[] }> = []
  ): Promise<DiscordControlReply> {
    // Initial inspection may show a native default effort label. Post-change
    // verification below still requires explicit model and effort agreement.
    const before = await this.status(lease, () => true, true);
    if (!value) {
      let opened = false;
      try {
        opened = true;
        const menu = await this.menu(lease, 'codex');
        const models = menu.choices.map((c) => ({
          ...c,
          value:
            catalog.filter((m) => normalize(m.label) === normalize(c.label)).length === 1
              ? catalog.find((m) => normalize(m.label) === normalize(c.label))!.id
              : undefined,
        }));
        const current = catalog.find((m) => normalize(m.label) === normalize(before.model));
        const options =
          kind === 'model'
            ? models.filter((m) => m.value).map((m) => ({ value: m.value!, label: m.label }))
            : (current?.efforts ?? []).map((effort) => ({ value: effort, label: effort }));
        const available = kind === 'model' ? models.map((m) => m.value || m.label) : (current?.efforts ?? []);
        return {
          verifiedSettings: { model: before.model, effort: before.effort },
          text:
            `Current model: ${before.model}\nCurrent effort: ${before.effort || 'not reported'}\n` +
            (available.length
              ? `Available ${kind === 'model' ? 'models' : 'efforts'}: ${available.join(', ')}\n`
              : 'The native catalog could not identify supported effort levels; use the CLI’s picker.\n') +
            `Change with !codeman ${kind} <${kind === 'model' ? 'model-id' : 'level'}>. Changes apply to this session only.`,
          actions: options
            .slice(0, 25)
            .map((o) => this.action(id, target, kind, o.value, o.label))
            .filter((a) => !!a),
        };
      } finally {
        if (opened) await this.close(lease, 'codex');
      }
    }
    if (
      (kind === 'effort' && before.effort === value) ||
      (kind === 'model' && normalize(before.model) === normalize(value))
    )
      return {
        verifiedSettings: { model: before.model, effort: before.effort },
        text: `${kind === 'model' ? 'Model' : 'Effort'} is already ${value} in this session.`,
      };
    const oldScreen = await lease.capture();
    await this.send(lease, kind === 'model' ? `/model ${value}\r` : `/model --reasoning=${value}\r`);
    await this.wait(lease, (s) =>
      s !== oldScreen &&
      nativeModelComposerReady('codex', s) &&
      /Model changed to [^\n]+ for this session only/.test(stripAnsi(s))
        ? true
        : undefined
    );
    // A native redraw may initially retain the previous /status block. Wait for
    // the requested state rather than treating that stale block as a fresh answer.
    const after = await this.status(
      lease,
      (status) =>
        status.session === before.session &&
        (kind === 'model' ? normalize(status.model) === normalize(value) : status.effort === value)
    );
    if (
      after.session !== before.session ||
      (kind === 'model' ? normalize(after.model) !== normalize(value) : after.effort !== value)
    )
      throw new Error(
        'The CLI’s current setting did not match the request. Inspect the terminal; the change is not confirmed.'
      );
    return {
      verifiedSettings: { model: after.model, effort: after.effort },
      text: `Verified: model ${after.model}, effort ${after.effort || 'not reported'}. Applied to the same Codex session only.`,
    };
  }
  private async claude(
    id: string,
    target: DiscordModelTarget,
    lease: NativeModelSettingsLease,
    kind: 'model' | 'effort',
    value?: string
  ): Promise<DiscordControlReply> {
    let opened = true;
    try {
      let menu = await this.menu(lease, 'claude');
      const identities = (m: NativeModelMenu) =>
        JSON.stringify(m.choices.map((c) => [c.number, c.label, c.value, c.current]));
      const originalChoices = identities(menu);
      const original = menu.choices.find((c) => c.current)!;
      if (!value) {
        const levels: string[] = [];
        if (kind === 'effort' && menu.effort) {
          for (let i = 0; i < 8 && menu.effort && !levels.includes(menu.effort); i++) {
            levels.push(menu.effort);
            const previous = menu.effort;
            await this.send(lease, '\x1b[C');
            menu = await this.wait(lease, (s) => {
              const m = readNativeModelMenu('claude', s);
              return m && m.effort !== previous ? m : undefined;
            });
          }
        }
        const options =
          kind === 'model'
            ? menu.choices.filter((c) => c.value).map((c) => ({ value: c.value!, label: c.label }))
            : levels.map((level) => ({ value: level, label: level }));
        return {
          verifiedSettings: { model: original.label, effort: menu.effort },
          text:
            `Current model: ${original.label}\nCurrent effort: ${kind === 'effort' ? levels[0] || 'not adjustable' : menu.effort || 'not reported'}\n` +
            `Available ${kind === 'model' ? 'models' : 'efforts'}: ${options.map((o) => o.value).join(', ') || 'not offered by this CLI/model'}\n` +
            `Use !codeman ${kind} <${kind === 'model' ? 'alias' : 'level'}>. Uses Claude’s session-only picker; future defaults are preserved.`,
          actions: options
            .slice(0, 25)
            .map((o) => this.action(id, target, kind, o.value, o.label))
            .filter((a) => !!a),
        };
      }
      const desired = kind === 'model' ? menu.choices.find((c) => c.value === value) : original;
      if (!desired) throw new Error('That model is not offered by this native picker. No defaults were changed.');
      for (let i = 0; i < 32 && menu.choices.find((c) => c.selected)?.number !== desired.number; i++) {
        const selected = menu.choices.find((c) => c.selected)!;
        await this.send(lease, selected.number < desired.number ? '\x1b[B' : '\x1b[A');
        menu = await this.wait(lease, (s) => {
          const m = readNativeModelMenu('claude', s);
          return m && m.choices.find((c) => c.selected)?.number !== selected.number ? m : undefined;
        });
      }
      if (menu.choices.find((c) => c.selected)?.number !== desired.number)
        throw new Error('The model picker changed. Nothing was applied.');
      if (kind === 'effort') {
        const seen = new Set<string>();
        while (menu.effort !== value && menu.effort && !seen.has(menu.effort) && seen.size < 8) {
          const previous = menu.effort;
          seen.add(previous);
          await this.send(lease, '\x1b[C');
          menu = await this.wait(lease, (s) => {
            const m = readNativeModelMenu('claude', s);
            return m && m.effort !== previous ? m : undefined;
          });
        }
        if (menu.effort !== value)
          throw new Error('That effort level is not offered by this model. Nothing was applied.');
      }
      // Never Enter: this exact native menu explicitly defines s as session-only.
      const confirmed = readNativeModelMenu('claude', await lease.capture());
      const selected = confirmed?.choices.find((c) => c.selected);
      if (
        !confirmed ||
        identities(confirmed) !== originalChoices ||
        selected?.number !== desired.number ||
        selected.value !== desired.value ||
        selected.label !== desired.label ||
        (kind === 'effort' && confirmed.effort !== value)
      )
        throw new Error('The native model picker changed before applying the setting. Nothing was applied.');
      await this.send(lease, 's');
      opened = false;
      await this.wait(lease, (s) =>
        nativeModelComposerReady('claude', s) && /Set model to [^\n]+ for this session only/.test(stripAnsi(s))
          ? true
          : undefined
      );
      opened = true;
      const after = await this.menu(lease, 'claude');
      if (
        after.choices.find((c) => c.current)?.value !== desired.value ||
        after.choices.find((c) => c.current)?.label !== desired.label ||
        (kind === 'effort' && after.effort !== value)
      )
        throw new Error(
          'The native picker did not confirm the requested setting. Inspect the terminal before retrying.'
        );
      return {
        verifiedSettings: { model: after.choices.find((c) => c.current)!.label, effort: after.effort },
        text: `Verified: model ${after.choices.find((c) => c.current)!.label}, effort ${after.effort || 'not reported'}. Applied to this Claude session only; future defaults are unchanged.`,
      };
    } finally {
      if (opened) await this.close(lease, 'claude');
    }
  }
}
