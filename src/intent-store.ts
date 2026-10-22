/**
 * @fileoverview Read My Mind intent store: per-case profiles of user intent.
 *
 * Feeds the Read My Mind predictor (`docs/readmymind-plan.md`). Each profile
 * pairs user/agent-stated `goals` with the user's recently captured prompts,
 * keyed by owner + realpath(workingDir) so the profile survives `/clear`,
 * respawns, and session churn, and so multi-user scoping is structural (two
 * owners of the same directory get distinct profiles).
 *
 * Capture rides the session transcript (`transcript:user_prompt`), not the
 * input paths: `POST /input` sees only programmatic prompts and the WS channel
 * delivers raw keystrokes, so neither yields clean submitted prompts.
 *
 * Prompts can contain secrets, so the state file is written 0600 (same posture
 * as `users.json`) and the store is never fed into `/api/search`.
 *
 * Pure helpers (`deriveIntentKey`, `sanitizePromptText`, `isCapturablePrompt`,
 * `appendPrompt`) are exported for unit tests; the `IntentStore` class adds the
 * IO. Writes are atomic (tmp + rename) and synchronous: mutations arrive at
 * human prompting pace, so there is nothing to debounce and no timer to leak.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dataPath } from './config/instance.js';
import { KEEP_WARM_NUDGE } from './prompt-cache-keepwarm.js';
import type { IntentProfile, IntentPromptEntry } from './types/index.js';

// ========== Limits ==========

/** Max stored profiles; lowest `updatedAt` is evicted first. */
export const MAX_INTENT_PROFILES = 200;

/** Max captured prompts per profile (FIFO). */
export const MAX_RECENT_PROMPTS = 50;

/** Max characters kept per captured prompt. */
export const MAX_PROMPT_CHARS = 500;

/** Max characters for the `goals` field. */
export const MAX_GOALS_CHARS = 8192;

/** Prompts shorter than this are menu digits / Esc artifacts, not intent. */
const MIN_PROMPT_CHARS = 3;

// ========== Pure helpers ==========

/** Stable per-case key: owner + resolved workingDir, hashed. */
export function deriveIntentKey(owner: string | undefined, workingDir: string): string {
  return createHash('sha256')
    .update(`${owner ?? ''}:${workingDir}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Transcript user entries that are not typed intent: local slash-command echo,
 * hook/system wrappers, and interrupt markers.
 */
export function isCapturablePrompt(text: string): boolean {
  if (text.includes('<command-name>') || text.includes('<local-command-stdout>')) return false;
  if (text.startsWith('<system-reminder>')) return false;
  if (text.startsWith('Caveat: The messages below')) return false;
  if (text.startsWith('[Request interrupted')) return false;
  // Codeman's own prompt-cache keep-alive turn is not something the user meant. The exact
  // text, so a prompt of the user's that merely mentions it is still captured.
  if (text.trim() === KEEP_WARM_NUDGE) return false;
  return true;
}

/**
 * Collapse a transcript prompt to a bounded single line, or null when it is
 * too short to mean anything (menu digits, Esc artifacts).
 */
export function sanitizePromptText(raw: string): string | null {
  const text = raw
    .replace(/[\r\n]+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .trim();
  if (text.length < MIN_PROMPT_CHARS) return null;
  return text.length > MAX_PROMPT_CHARS ? text.slice(0, MAX_PROMPT_CHARS) : text;
}

/**
 * Fold one prompt into a profile: consecutive duplicates collapse (auto-resume
 * "continue" spam), FIFO cap applies. Returns a new profile object.
 */
export function appendPrompt(profile: IntentProfile, entry: IntentPromptEntry): IntentProfile {
  const last = profile.recentPrompts[profile.recentPrompts.length - 1];
  if (last && last.text === entry.text) {
    return { ...profile, updatedAt: entry.ts };
  }
  const recentPrompts = [...profile.recentPrompts, entry].slice(-MAX_RECENT_PROMPTS);
  return { ...profile, recentPrompts, updatedAt: entry.ts };
}

// ========== Store ==========

interface IntentStoreFile {
  version: 1;
  profiles: IntentProfile[];
}

export class IntentStore {
  private profiles: Map<string, IntentProfile> | null = null;

  private get filePath(): string {
    return dataPath('intents.json');
  }

  // ----- Public API -----

  /** Drop the in-memory copy so the next call re-reads intents.json (after a config restore replaced it). */
  reload(): void {
    this.profiles = null;
  }

  /**
   * The profile for a session's case. Never persists on read: an absent
   * profile returns an empty transient one (`updatedAt: 0`).
   */
  getProfile(owner: string | undefined, workingDir: string): IntentProfile {
    const dir = this.resolveDir(workingDir);
    const key = deriveIntentKey(owner, dir);
    return this.load().get(key) ?? this.emptyProfile(key, dir);
  }

  /**
   * Capture one submitted prompt. Returns true when it was recorded (passed
   * the capturability filter and sanitization).
   */
  recordPrompt(
    owner: string | undefined,
    workingDir: string,
    sessionId: string,
    rawText: string,
    ts: number = Date.now()
  ): boolean {
    if (!isCapturablePrompt(rawText)) return false;
    const text = sanitizePromptText(rawText);
    if (text === null) return false;

    const dir = this.resolveDir(workingDir);
    const key = deriveIntentKey(owner, dir);
    const profiles = this.load();
    const profile = profiles.get(key) ?? this.emptyProfile(key, dir);
    profiles.set(key, appendPrompt(profile, { ts, sessionId, text }));
    this.evictOverflow(profiles);
    this.persist();
    return true;
  }

  /** Replace the goals text (bounded). Returns the updated profile. */
  setGoals(owner: string | undefined, workingDir: string, goals: string): IntentProfile {
    const dir = this.resolveDir(workingDir);
    const key = deriveIntentKey(owner, dir);
    const profiles = this.load();
    const profile = profiles.get(key) ?? this.emptyProfile(key, dir);
    const updated: IntentProfile = { ...profile, goals: goals.slice(0, MAX_GOALS_CHARS), updatedAt: Date.now() };
    profiles.set(key, updated);
    this.evictOverflow(profiles);
    this.persist();
    return updated;
  }

  /** Forget everything for a case. Returns true when a profile existed. */
  deleteProfile(owner: string | undefined, workingDir: string): boolean {
    const dir = this.resolveDir(workingDir);
    const key = deriveIntentKey(owner, dir);
    const profiles = this.load();
    const existed = profiles.delete(key);
    if (existed) this.persist();
    return existed;
  }

  // ----- Internals -----

  private emptyProfile(key: string, workingDir: string): IntentProfile {
    return { key, workingDir, updatedAt: 0, goals: '', recentPrompts: [] };
  }

  private resolveDir(workingDir: string): string {
    try {
      return realpathSync(workingDir);
    } catch {
      return workingDir;
    }
  }

  private load(): Map<string, IntentProfile> {
    if (this.profiles) return this.profiles;
    this.profiles = new Map();
    try {
      if (existsSync(this.filePath)) {
        const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8')) as IntentStoreFile;
        if (parsed && Array.isArray(parsed.profiles)) {
          for (const profile of parsed.profiles) {
            if (profile && typeof profile.key === 'string') this.profiles.set(profile.key, profile);
          }
        }
      }
    } catch (err) {
      console.warn(`[IntentStore] Failed to load ${this.filePath}, starting empty:`, err);
    }
    return this.profiles;
  }

  private evictOverflow(profiles: Map<string, IntentProfile>): void {
    while (profiles.size > MAX_INTENT_PROFILES) {
      let oldestKey: string | null = null;
      let oldestAt = Infinity;
      for (const [key, profile] of profiles) {
        if (profile.updatedAt < oldestAt) {
          oldestAt = profile.updatedAt;
          oldestKey = key;
        }
      }
      if (oldestKey === null) return;
      profiles.delete(oldestKey);
    }
  }

  private persist(): void {
    if (!this.profiles) return;
    const file: IntentStoreFile = { version: 1, profiles: [...this.profiles.values()] };
    const tmpPath = `${this.filePath}.tmp`;
    try {
      // dataPath()'s own mkdir is once-per-process; per-file test HOMEs need this.
      mkdirSync(dirname(this.filePath), { recursive: true });
      // 0600: captured prompts can contain secrets (same posture as users.json).
      writeFileSync(tmpPath, JSON.stringify(file, null, 2), { mode: 0o600 });
      renameSync(tmpPath, this.filePath);
    } catch (err) {
      console.warn(`[IntentStore] Failed to persist ${this.filePath}:`, err);
    }
  }
}

/** Module-level singleton, same pattern as `approvalInbox` (web/approval-inbox.ts). */
export const intentStore = new IntentStore();
