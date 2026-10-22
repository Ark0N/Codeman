/**
 * @fileoverview The snapshot origin must survive a hostname change (a Docker container gets a new
 * hostname on every recreate) and still differ between data dirs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const host = vi.hoisted(() => ({ name: 'container-a' }));
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  hostname: () => host.name,
}));

import {
  configBackupOrigin,
  createConfigBackup,
  listConfigBackups,
  pruneConfigBackups,
  restoreConfigBackup,
} from '../src/config-backup.js';

let root: string;
let data: string;
let backups: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cfg-origin-'));
  data = join(root, 'data');
  backups = join(root, 'backups');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'settings.json'), '{"a":1}');
  host.name = 'container-a';
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('configBackupOrigin', () => {
  it('is made once, kept in the data dir, and differs between data dirs', () => {
    const a = configBackupOrigin(data);
    expect(configBackupOrigin(data)).toBe(a);
    expect(readFileSync(join(data, 'config-backup-id'), 'utf8').trim()).toBe(a);
    const other = join(root, 'other');
    expect(configBackupOrigin(other)).not.toBe(a);
  });

  it('keeps snapshots listed, restorable and prunable after the hostname changes', () => {
    const made = createConfigBackup({ dataDir: data, backupDir: backups, reason: 'auto', now: 1_000_000 }) as {
      id: string;
    };
    createConfigBackup({ dataDir: data, backupDir: backups, reason: 'manual', force: true, now: 2_000_000 });
    host.name = 'container-b'; // the container was recreated
    const origin = configBackupOrigin(data);
    expect(listConfigBackups(backups, origin)).toHaveLength(2);
    writeFileSync(join(data, 'settings.json'), '{"a":2}'); // a change, so the restore takes a pre-restore copy
    expect(() => restoreConfigBackup({ dataDir: data, backupDir: backups, id: made.id })).not.toThrow();
    const removed = pruneConfigBackups(backups, { keepCount: 1, keepDays: 0, origin });
    expect(removed).toHaveLength(2); // 3 now: the restore took a pre-restore copy
  });
});
