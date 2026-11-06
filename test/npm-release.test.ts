/**
 * @fileoverview `npm run release` moves README.zh-CN.md aside for the publish, so npmjs.com
 * renders README.md, and always puts it back (scripts/npm-release.mjs).
 *
 * Port: N/A (no server).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ASIDE_NAME, HIDDEN_README, publishWithReadmeAside } from '../scripts/npm-release.mjs';

const roots: string[] = [];
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'npm-release-'));
  roots.push(root);
  writeFileSync(join(root, 'README.md'), 'english\n');
  writeFileSync(join(root, HIDDEN_README), 'chinese\n');
  return root;
}
const quiet = () => {};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('publishWithReadmeAside', () => {
  it('hides the Chinese README during the publish and restores it after a success', () => {
    const root = fixture();
    let seen: { zh: boolean; en: boolean } | null = null;
    const code = publishWithReadmeAside({
      root,
      log: quiet,
      publish: () => {
        seen = { zh: existsSync(join(root, HIDDEN_README)), en: existsSync(join(root, 'README.md')) };
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(seen).toEqual({ zh: false, en: true });
    expect(readFileSync(join(root, HIDDEN_README), 'utf8')).toBe('chinese\n');
    expect(existsSync(join(root, ASIDE_NAME))).toBe(false);
  });

  it('the aside name is not one npm treats as a readme', () => {
    // npm-packlist keeps every root /readme{,.*}/i and normalize globs {README,README.*}.
    expect(/^readme/i.test(ASIDE_NAME)).toBe(false);
  });

  it('restores it and passes the exit code through when the publish fails', () => {
    const root = fixture();
    const code = publishWithReadmeAside({ root, log: quiet, publish: () => 1 });
    expect(code).toBe(1);
    expect(readFileSync(join(root, HIDDEN_README), 'utf8')).toBe('chinese\n');
    expect(existsSync(join(root, ASIDE_NAME))).toBe(false);
  });

  it('restores it when the publish throws', () => {
    const root = fixture();
    expect(() =>
      publishWithReadmeAside({
        root,
        log: quiet,
        publish: () => {
          throw new Error('boom');
        },
      })
    ).toThrow('boom');
    expect(readFileSync(join(root, HIDDEN_README), 'utf8')).toBe('chinese\n');
    expect(existsSync(join(root, ASIDE_NAME))).toBe(false);
  });

  it('first puts back a copy an interrupted earlier run left aside', () => {
    const root = fixture();
    rmSync(join(root, HIDDEN_README));
    writeFileSync(join(root, ASIDE_NAME), 'chinese\n');
    let zhDuring = true;
    publishWithReadmeAside({
      root,
      log: quiet,
      publish: () => {
        zhDuring = existsSync(join(root, HIDDEN_README));
        return 0;
      },
    });
    expect(zhDuring).toBe(false);
    expect(readFileSync(join(root, HIDDEN_README), 'utf8')).toBe('chinese\n');
    expect(existsSync(join(root, ASIDE_NAME))).toBe(false);
  });

  it('publishes normally when there is no Chinese README', () => {
    const root = fixture();
    rmSync(join(root, HIDDEN_README));
    const code = publishWithReadmeAside({ root, log: quiet, publish: () => 0 });
    expect(code).toBe(0);
    expect(existsSync(join(root, HIDDEN_README))).toBe(false);
  });

  it('package.json routes npm run release through the wrapper', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'));
    expect(pkg.scripts.release).toBe('node scripts/npm-release.mjs');
  });
});
