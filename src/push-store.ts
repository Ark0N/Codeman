/**
 * @fileoverview VAPID key auto-generation and push subscription CRUD.
 *
 * Persists VAPID keys to ~/.codeman/push-keys.json and subscriptions
 * to ~/.codeman/push-subscriptions.json. Debounced saves prevent
 * excessive disk I/O during rapid subscription updates.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import webpush from 'web-push';
import type { VapidKeys, PushSubscriptionRecord } from './types.js';

const DATA_DIR = join(homedir(), '.codeman');
const KEYS_FILE = join(DATA_DIR, 'push-keys.json');
const SUBS_FILE = join(DATA_DIR, 'push-subscriptions.json');
const SAVE_DEBOUNCE_MS = 500;

export class PushSubscriptionStore {
  private vapidKeys: VapidKeys | null = null;
  private subscriptions: Map<string, PushSubscriptionRecord> = new Map();
  private saveTimer: NodeJS.Timeout | null = null;
  private _disposed = false;

  constructor() {
    this.loadSubscriptions();
  }

  get isDisposed(): boolean {
    return this._disposed;
  }

  /** Get or generate VAPID keys */
  getVapidKeys(): VapidKeys {
    if (this.vapidKeys) return this.vapidKeys;

    // Try loading from disk
    if (existsSync(KEYS_FILE)) {
      try {
        const raw = readFileSync(KEYS_FILE, 'utf-8');
        this.vapidKeys = JSON.parse(raw) as VapidKeys;
        return this.vapidKeys;
      } catch {
        // Regenerate on parse error
      }
    }

    // Generate new keys
    const keys = webpush.generateVAPIDKeys();
    this.vapidKeys = {
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      generatedAt: Date.now(),
    };

    // Persist
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(KEYS_FILE, JSON.stringify(this.vapidKeys, null, 2));
    return this.vapidKeys;
  }

  /** Get the public VAPID key for client subscription */
  getPublicKey(): string {
    return this.getVapidKeys().publicKey;
  }

  /** Register or update a push subscription (deduplicates by endpoint) */
  addSubscription(sub: Omit<PushSubscriptionRecord, 'lastUsedAt'>): PushSubscriptionRecord {
    // Check for existing subscription with same endpoint
    for (const [existingId, existing] of this.subscriptions) {
      if (existing.endpoint === sub.endpoint) {
        // Update existing
        const updated: PushSubscriptionRecord = {
          ...existing,
          keys: sub.keys,
          userAgent: sub.userAgent,
          lastUsedAt: Date.now(),
          pushPreferences: sub.pushPreferences,
        };
        this.subscriptions.set(existingId, updated);
        this.scheduleSave();
        return updated;
      }
    }

    // New subscription
    const record: PushSubscriptionRecord = {
      ...sub,
      lastUsedAt: Date.now(),
    };
    this.subscriptions.set(record.id, record);
    this.scheduleSave();
    return record;
  }

  /** Update push preferences for a subscription */
  updatePreferences(
    id: string,
    preferences: Record<string, boolean>
  ): PushSubscriptionRecord | null {
    const sub = this.subscriptions.get(id);
    if (!sub) return null;
    sub.pushPreferences = preferences;
    sub.lastUsedAt = Date.now();
    this.scheduleSave();
    return sub;
  }

  /** Remove a subscription */
  removeSubscription(id: string): boolean {
    const deleted = this.subscriptions.delete(id);
    if (deleted) this.scheduleSave();
    return deleted;
  }

  /** Remove subscription by endpoint (used for auto-cleanup of expired subs) */
  removeByEndpoint(endpoint: string): void {
    for (const [id, sub] of this.subscriptions) {
      if (sub.endpoint === endpoint) {
        this.subscriptions.delete(id);
        this.scheduleSave();
        return;
      }
    }
  }

  /** Get all subscriptions */
  getAll(): PushSubscriptionRecord[] {
    return Array.from(this.subscriptions.values());
  }

  /** Get a single subscription by ID */
  get(id: string): PushSubscriptionRecord | null {
    return this.subscriptions.get(id) ?? null;
  }

  /** Load subscriptions from disk */
  private loadSubscriptions(): void {
    if (!existsSync(SUBS_FILE)) return;
    try {
      const raw = readFileSync(SUBS_FILE, 'utf-8');
      const arr = JSON.parse(raw) as PushSubscriptionRecord[];
      for (const sub of arr) {
        this.subscriptions.set(sub.id, sub);
      }
    } catch {
      // Start fresh on parse error
    }
  }

  /** Schedule a debounced save */
  private scheduleSave(): void {
    if (this._disposed) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.flushSave();
    }, SAVE_DEBOUNCE_MS);
  }

  /** Immediately persist subscriptions to disk */
  private flushSave(): void {
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(SUBS_FILE, JSON.stringify(Array.from(this.subscriptions.values()), null, 2));
    } catch {
      // Ignore write errors
    }
  }

  /** Clean shutdown */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    // Final flush
    this.flushSave();
  }
}
