/**
 * @fileoverview Opt-in agent inbox snapshot (src/web/agent-inbox-persistence.ts).
 *
 * Off writes nothing, switching off deletes the file and keeps memory, on writes 0600
 * through tmp + rename, and a boot with the setting on restores what was pending.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentInbox } from '../src/web/agent-inbox.js';
import { AgentInboxPersistence } from '../src/web/agent-inbox-persistence.js';

describe('AgentInboxPersistence', () => {
  let dir: string;
  let file: string;
  let inbox: AgentInbox;
  let persistence: AgentInboxPersistence;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codeman-inbox-'));
    file = join(dir, 'agent-inbox.json');
    inbox = new AgentInbox();
    // Debounce 0 so a test can wait one macrotask instead of sleeping.
    persistence = new AgentInboxPersistence(inbox, () => file, 0);
  });

  afterEach(() => {
    persistence.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  const tick = () => new Promise((r) => setTimeout(r, 5));

  it('writes nothing while off (the default)', async () => {
    persistence.load(false);
    inbox.post('s', null, 'hello');
    await tick();
    expect(existsSync(file)).toBe(false);
  });

  it('writes a 0600 snapshot when on, and no tmp file is left behind', async () => {
    persistence.load(true);
    inbox.post('s', null, 'hello');
    await tick();
    expect(JSON.parse(readFileSync(file, 'utf-8')).inboxes.s[0].text).toBe('hello');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  it('switching on writes the current inboxes at once', () => {
    persistence.load(false);
    inbox.post('s', null, 'posted while off');
    persistence.setEnabled(true);
    expect(JSON.parse(readFileSync(file, 'utf-8')).inboxes.s).toHaveLength(1);
  });

  it('switching off deletes the snapshot and keeps the in-memory inboxes', async () => {
    persistence.load(true);
    inbox.post('s', null, 'hello');
    await tick();
    expect(existsSync(file)).toBe(true);
    persistence.setEnabled(false);
    expect(existsSync(file)).toBe(false);
    expect(inbox.pendingCount('s')).toBe(1);
    inbox.post('s', null, 'after off');
    await tick();
    expect(existsSync(file)).toBe(false);
  });

  it('a boot with the setting on restores pending mail', async () => {
    persistence.load(true);
    inbox.post('s', 'sender', 'survives');
    await tick();
    persistence.dispose();

    const next = new AgentInbox();
    const nextPersistence = new AgentInboxPersistence(next, () => file, 0);
    expect(nextPersistence.load(true)).toBe(1);
    expect(next.read('s', { receiver: false }).messages[0]).toMatchObject({ from: 'sender', text: 'survives' });
    nextPersistence.dispose();
  });

  it('a boot with the setting off removes a file left from earlier and restores nothing', () => {
    writeFileSync(file, JSON.stringify({ version: 1, inboxes: { s: [] } }));
    expect(persistence.load(false)).toBe(0);
    expect(existsSync(file)).toBe(false);
  });

  it('an unreadable file is an empty inbox, not a failed boot', () => {
    writeFileSync(file, '{not json');
    expect(persistence.load(true)).toBe(0);
  });

  it('flush writes a pending change before shutdown', () => {
    const slow = new AgentInboxPersistence(inbox, () => file, 60_000);
    slow.load(true);
    inbox.post('s', null, 'just before shutdown');
    expect(existsSync(file)).toBe(false);
    slow.flush();
    expect(JSON.parse(readFileSync(file, 'utf-8')).inboxes.s).toHaveLength(1);
    slow.dispose();
  });
});
