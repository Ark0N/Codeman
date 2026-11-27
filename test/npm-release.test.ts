/**
 * @fileoverview `npm run release` moves the translated READMEs (README.zh-CN.md, README.ja.md)
 * aside for the publish, so npmjs.com renders README.md, and always puts them back
 * (scripts/npm-release.mjs).
 *
 * Port: N/A (no server).
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ASIDE_NAME,
  HIDDEN_README,
  HIDDEN_READMES,
  asideName,
  publishWithReadmeAside,
} from '../scripts/npm-release.mjs';

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

  it('hides the Japanese README too and restores every translation after the publish', () => {
    const root = fixture();
    writeFileSync(join(root, 'README.ja.md'), 'japanese\n');
    let present: string[] = [];
    const code = publishWithReadmeAside({
      root,
      log: quiet,
      publish: () => {
        present = ['README.md', ...HIDDEN_READMES].filter((name) => existsSync(join(root, name)));
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(HIDDEN_READMES).toContain('README.ja.md');
    expect(present).toEqual(['README.md']);
    expect(readFileSync(join(root, HIDDEN_README), 'utf8')).toBe('chinese\n');
    expect(readFileSync(join(root, 'README.ja.md'), 'utf8')).toBe('japanese\n');
    for (const name of HIDDEN_READMES) expect(existsSync(join(root, asideName(name)))).toBe(false);
  });

  it('no aside name is one npm treats as a readme', () => {
    for (const name of HIDDEN_READMES) expect(/^readme/i.test(asideName(name))).toBe(false);
  });

  it('every translated root README is moved aside for the publish', () => {
    const root = join(import.meta.dirname, '..');
    const translated = readdirSync(root).filter((name) => /^readme\./i.test(name) && name !== 'README.md');
    expect([...translated].sort()).toEqual([...HIDDEN_READMES].sort());
  });

  it('package.json routes npm run release through the wrapper', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'));
    expect(pkg.scripts.release).toBe('node scripts/npm-release.mjs');
  });
});
