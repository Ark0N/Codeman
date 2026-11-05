/** Cosmetic Discord activity, derived from live session state without reading terminal output. */
export interface DiscordActivitySession {
  id: string;
  name?: string;
  working?: boolean;
  waiting?: boolean;
  exited?: boolean;
}

export function discordActivityName(session: DiscordActivitySession): string {
  const label = session.exited
    ? '⚫ Offline'
    : session.waiting
      ? '🔴 Needs input'
      : session.working
        ? '🟡 Working'
        : '🟢 Idle';
  const name = (session.name ?? session.id.slice(0, 8)).replace(/[\r\n]/g, ' ').trim();
  return `${label} · ${name || session.id.slice(0, 8)}`.slice(0, 100);
}

interface ActivityDeps {
  scope(): string | undefined;
  sessions(): DiscordActivitySession[];
  destination(id: string): string | undefined;
  /** Check current ownership without reopening an archived or locked thread. */
  verify(id: string, destination: string): Promise<boolean | { name: string }>;
  rename(destination: string, name: string, current: () => boolean): Promise<unknown>;
  typing(destination: string, current: () => boolean): Promise<unknown>;
  now(): number;
}
interface Progress {
  key: string;
  name?: string;
  renamedAt?: number;
  typedAt?: number;
  verifiedAt?: number;
  idleSince?: number;
  verifyRetryAt?: number;
  renameRetryAt?: number;
  typingRetryAt?: number;
}

const RETRY_MS = 30_000;
function retryAfter(error: unknown): number {
  const delay = (error as { retryAfterMs?: unknown })?.retryAfterMs;
  return typeof delay === 'number' && Number.isFinite(delay) && delay > 0 ? delay : RETRY_MS;
}

const activityPrefix = (session: DiscordActivitySession) =>
  discordActivityName({ ...session, name: '' }).split(' · ')[0];

/** Coalesced sweeps, four sessions at a time. No messages, pings, agent input or new destinations. */
export class DiscordActivity {
  private progress = new Map<string, Progress>();
  private run?: Promise<void>;
  private generation = 0;
  constructor(private readonly deps: ActivityDeps) {}

  reset(): void {
    this.generation++;
    this.progress.clear();
  }
  forget(id: string): void {
    this.progress.delete(id);
  }
  /** Keep other bridge paths from undoing a coalesced activity rename. */
  name(session: DiscordActivitySession): string {
    const key = JSON.stringify([this.deps.scope(), this.deps.destination(session.id)]);
    const progress = this.progress.get(session.id);
    return progress?.key === key && progress.name ? progress.name : discordActivityName(session);
  }
  poll(): Promise<void> {
    if (this.run) return this.run;
    const generation = this.generation;
    const run = this.sweep(generation).finally(() => {
      if (this.run === run) this.run = undefined;
    });
    this.run = run;
    return run;
  }
  private async sweep(generation: number): Promise<void> {
    const scope = this.deps.scope();
    if (!scope) return;
    const sessions = this.deps.sessions();
    const live = new Set(sessions.map((s) => s.id));
    for (const id of this.progress.keys()) if (!live.has(id)) this.progress.delete(id);
    for (let i = 0; i < sessions.length; i += 4)
      await Promise.all(sessions.slice(i, i + 4).map((s) => this.update(s.id, scope, generation)));
  }
  private async update(id: string, scope: string, generation: number): Promise<void> {
    const destination = this.deps.destination(id);
    if (!destination) return;
    let progress = this.progress.get(id);
    const current = () => {
      if (
        generation !== this.generation ||
        scope !== this.deps.scope() ||
        destination !== this.deps.destination(id) ||
        (progress && this.progress.get(id) !== progress)
      )
        return undefined;
      return this.deps.sessions().find((s) => s.id === id);
    };
    const session = current();
    if (!session) return;
    const key = JSON.stringify([scope, destination]);
    if (progress?.key !== key) {
      progress = { key };
      this.progress.set(id, progress);
    }
    const now = this.deps.now();
    if (session.working || session.waiting || session.exited) progress.idleSince = undefined;
    else progress.idleSince ??= now;
    if ((progress.verifyRetryAt ?? 0) > now) return;
    const needsRename = () => {
      const s = current();
      if (!s || (progress.renameRetryAt ?? 0) > now || progress.name === discordActivityName(s)) return false;
      const active = s.working || s.waiting || s.exited;
      const stateChanged = !progress.name?.startsWith(activityPrefix(s) + ' · ');
      // Show a new active state promptly; only settling back to Idle is delayed. Short
      // gaps between turns must not spend the rename budget or hide the next short turn.
      if (active && stateChanged) return progress.renamedAt === undefined || now - progress.renamedAt >= 1_000;
      if (!active && /^(🟡 Working|🔴 Needs input|⚫ Offline) · /.test(progress.name ?? ''))
        return now - (progress.idleSince ?? now) >= 30_000;
      return progress.renamedAt === undefined || now - progress.renamedAt >= 30_000;
    };
    const needsTyping = () => {
      const s = current();
      return (
        s?.working &&
        !s.waiting &&
        !s.exited &&
        (progress.typingRetryAt ?? 0) <= now &&
        (progress.typedAt === undefined || now - progress.typedAt >= 8_000)
      );
    };
    if (!needsRename() && !needsTyping() && progress.verifiedAt !== undefined && now - progress.verifiedAt < 30_000)
      return;
    try {
      const verified = await this.deps.verify(id, destination);
      if (!verified || !current()) return;
      progress.verifiedAt = now;
      // Another in-flight bridge request (or a manual rename) may have written an
      // older title after our PATCH. Reconcile the real title, not just our cache.
      if (typeof verified === 'object') progress.name = verified.name;
    } catch (error) {
      progress.verifyRetryAt = this.deps.now() + retryAfter(error);
      return;
    }
    // Typing has its own endpoint/budget and must not wait behind a rename's 429.
    if (needsTyping()) {
      progress.typedAt = now;
      try {
        await this.deps.typing(destination, () => {
          const s = current();
          return !!s?.working && !s.waiting && !s.exited;
        });
      } catch (error) {
        progress.typingRetryAt = this.deps.now() + retryAfter(error);
      }
    }
    try {
      if (needsRename()) {
        const name = discordActivityName(current()!);
        // Record the attempt, including failures: never spend repeated rename requests on a flap.
        progress.renamedAt = now;
        await this.deps.rename(destination, name, () => !!current() && discordActivityName(current()!) === name);
        if (!current()) return;
        progress.name = name;
      }
    } catch (error) {
      // Cosmetic failures never block agent execution or response delivery.
      progress.renameRetryAt = this.deps.now() + retryAfter(error);
    }
  }
}
