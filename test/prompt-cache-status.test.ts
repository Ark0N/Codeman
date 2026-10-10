/**
 * The Session Options "Prompt cache" readout (`CodemanPromptCache.format`, constants.js):
 * the one sentence that tells the user whether the next turn re-reads the conversation
 * from cache or re-processes it cold. Loaded the way the other constants.js policies are.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

type Cache = {
  warm: boolean;
  ttl?: string;
  expiresAt?: number;
  recacheTokensIfCold?: number;
  hitRatio?: number;
  lastMissCauses?: string[];
  compactedAt?: number;
};

function loadFormat() {
  const context = vm.createContext({ window: {}, globalThis: {} });
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'constants.js' });
  return (context.window as { CodemanPromptCache: { format: (c: Cache | null | undefined, now: number) => string } })
    .CodemanPromptCache.format as (c: Cache | null | undefined, now: number, statusLine?: string) => string;
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const NOW = Date.UTC(2026, 9, 6, 22, 18, 0);

describe('Prompt cache readout', () => {
  it('says so when Claude has not reported the cache yet (older CLI or no response yet)', () => {
    const format = loadFormat();
    expect(format(null, NOW)).toMatch(/^Not reported yet/);
    expect(format(undefined, NOW)).toMatch(/^Not reported yet/);
  });

  it('says why when the launch carries no statusLine exporter, whatever report is stored', () => {
    const format = loadFormat();
    expect(format(null, NOW, 'collection-off')).toMatch(/^Not collected: Plan Usage was off when this session started/);
    expect(format({ warm: true, expiresAt: NOW + 60_000 }, NOW, 'collection-off')).toMatch(/^Not collected/);
    expect(format(null, NOW, 'workspace-statusline')).toMatch(/settings\.local\.json sets its own statusLine/);
    expect(format(null, NOW, 'remote')).toBe('Not collected for remote and Docker sessions.');
    expect(format(null, NOW, 'injected')).toMatch(/^Not reported yet/);
  });

  it('warm: a clock time, the lifetime and the tokens at stake', () => {
    const format = loadFormat();
    const expiresAt = NOW + 42 * 60_000;
    expect(format({ warm: true, ttl: '1h', expiresAt, recacheTokensIfCold: 109833 }, NOW)).toBe(
      `Warm until ${clock(expiresAt)} (1h cache). About 110k tokens would be re-read if it goes cold.`
    );
    expect(format({ warm: true, expiresAt }, NOW)).toBe(`Warm until ${clock(expiresAt)}.`);
  });

  it('cold once reported cold, past the expiry, or warm with no expiry to promise', () => {
    const format = loadFormat();
    expect(format({ warm: false, recacheTokensIfCold: 89882 }, NOW)).toBe(
      'Cold. The next turn re-reads about 90k tokens at the cache-write rate.'
    );
    expect(format({ warm: true, expiresAt: NOW - 1, recacheTokensIfCold: 500 }, NOW)).toBe(
      'Cold. The next turn re-reads about 500 tokens at the cache-write rate.'
    );
    expect(format({ warm: true }, NOW)).toBe('Cold.');
    expect(format({ warm: false }, NOW)).toBe('Cold.');
  });

  it('appends the hit rate and the last miss cause when Claude reports them', () => {
    const format = loadFormat();
    const expiresAt = NOW + 42 * 60_000;
    expect(format({ warm: true, ttl: '1h', expiresAt, recacheTokensIfCold: 50000, hitRatio: 0.91 }, NOW)).toBe(
      `Warm until ${clock(expiresAt)} (1h cache). About 50k tokens would be re-read if it goes cold. 91% cache hit rate.`
    );
    expect(
      format({ warm: false, recacheTokensIfCold: 90000, hitRatio: 0.6, lastMissCauses: ['ttl_expired_1h'] }, NOW)
    ).toBe(
      'Cold. The next turn re-reads about 90k tokens at the cache-write rate. 60% cache hit rate. Last miss: ttl_expired_1h.'
    );
  });

  it("names Claude Code's own idle compaction, with no re-read stake while the prefix is still warm", () => {
    const format = loadFormat();
    const expiresAt = NOW + 42 * 60_000;
    const compactedAt = NOW - 6 * 60_000;
    // recacheTokensIfCold is null right after a compaction, so no "would be re-read" clause.
    expect(format({ warm: true, ttl: '1h', expiresAt, compactedAt, hitRatio: 0.88 }, NOW)).toBe(
      `Warm until ${clock(expiresAt)} (1h cache). Compacted at ${clock(compactedAt)}. 88% cache hit rate.`
    );
  });
});
