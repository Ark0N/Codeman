/**
 * @fileoverview Every writer of the linked-cases registry is serialized, atomic, and refuses to
 * overwrite a file that does not parse (`mutateLinkedCases()`, src/web/linked-cases-writer.ts). Real
 * filesystem under test/setup.ts's temp HOME. Port: N/A (app.inject()).
 *
 * The CI flake this fixes was "a name linked while the clone ran is a 409" in
 * test/routes/case-clone-custom-folder.test.ts: two clones claiming one name both re-read the
 * registry before either wrote it, so both answered success and the later write replaced the
 * earlier entry. Writes to the registry (and its temp files) are slowed down here, so two writers
 * that both read before either writes lose an entry every time instead of once in a while.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createRouteTestHarness } from './routes/_route-test-utils.js';
import { registerCaseRoutes } from '../src/web/routes/case-routes.js';
import { LinkedCasesWriteRefusedError, linkedCasesPath, mutateLinkedCases } from '../src/web/linked-cases-writer.js';
import { isSandboxedHome, safeRmHomeTree } from './mocks/index.js';

const LINKED = () => linkedCasesPath();
const linked = (): Record<string, string> => JSON.parse(readFileSync(LINKED(), 'utf8'));
/** Temp files the writer left beside the registry (there must never be any). */
const leftovers = () =>
  readdirSync(dirname(LINKED())).filter((n) => n.startsWith(`${basename(LINKED())}.`) && n.endsWith('.tmp'));
/** The bytes of a registry torn by two overlapping truncate-then-write calls. */
const TORN = '{\n  "kept": "/srv/kept"\n}' + 'ept-2"\n}';

/** How long every write to the registry (or a temp file beside it) is held before it starts. */
const SLOW_WRITE_MS = 60;
const realWriteFile = fs.writeFile.bind(fs);

let workDir = '';

beforeEach(() => {
  if (!isSandboxedHome()) {
    throw new Error('linked-cases-writer.test.ts rewrites the linked-cases registry: run it via npm test');
  }
  safeRmHomeTree(LINKED());
  mkdirSync(dirname(LINKED()), { recursive: true });
  workDir = realpathSync(mkdtempSync(join(homedir(), 'linked-cases-writer-')));
  vi.spyOn(fs, 'writeFile').mockImplementation((async (file: unknown, data: unknown, options?: unknown) => {
    if (typeof file === 'string' && file.startsWith(LINKED())) {
      await new Promise((resolve) => setTimeout(resolve, SLOW_WRITE_MS));
    }
    return realWriteFile(file as string, data as string, options as undefined);
  }) as typeof fs.writeFile);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (workDir) safeRmHomeTree(workDir);
  workDir = '';
  if (isSandboxedHome()) safeRmHomeTree(LINKED());
});

describe('mutateLinkedCases()', () => {
  it('runs concurrent mutations one at a time, so none loses another one’s entry', async () => {
    writeFileSync(LINKED(), JSON.stringify({ kept: '/srv/kept' }));
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => mutateLinkedCases((current) => ({ ...current, [`c${i}`]: `/srv/c${i}` })))
    );
    expect(Object.keys(linked()).sort()).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'kept']);
    expect(leftovers()).toEqual([]);
  });

  it('a check that throws inside the mutation rejects that caller only and writes nothing', async () => {
    const claim = (name: string, path: string) =>
      mutateLinkedCases((current) => {
        if (current[name]) throw Object.assign(new Error(`${name} is taken`), { conflict: true });
        return { ...current, [name]: path };
      });
    const results = await Promise.allSettled([
      claim('twin', '/srv/a'),
      claim('twin', '/srv/b'),
      claim('solo', '/srv/s'),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect((results[1] as PromiseRejectedResult).reason.message).toBe('twin is taken');
    expect(linked()).toEqual({ twin: '/srv/a', solo: '/srv/s' });
  });

  it('starts from an empty registry when the file is missing or empty, and writes nothing for undefined', async () => {
    const { before, after } = await mutateLinkedCases((current) => ({ ...current, a: '/srv/a' }));
    expect(before).toEqual({});
    expect(after).toEqual({ a: '/srv/a' });
    writeFileSync(LINKED(), '  \n');
    await mutateLinkedCases((current) => ({ ...current, b: '/srv/b' }));
    expect(linked()).toEqual({ b: '/srv/b' });
    const untouched = readFileSync(LINKED(), 'utf8');
    expect((await mutateLinkedCases(() => undefined)).after).toBeUndefined();
    expect(readFileSync(LINKED(), 'utf8')).toBe(untouched);
  });

  it('refuses a registry that is not a JSON object and leaves it byte for byte', async () => {
    for (const content of [TORN, '[]', 'null', '"text"']) {
      writeFileSync(LINKED(), content);
      const fn = vi.fn((current: Record<string, string>) => ({ ...current, a: '/srv/a' }));
      await expect(mutateLinkedCases(fn)).rejects.toBeInstanceOf(LinkedCasesWriteRefusedError);
      expect(fn).not.toHaveBeenCalled();
      expect(readFileSync(LINKED(), 'utf8')).toBe(content);
    }
    // The chain keeps going after a refusal.
    writeFileSync(LINKED(), '{}');
    await mutateLinkedCases((current) => ({ ...current, a: '/srv/a' }));
    expect(linked()).toEqual({ a: '/srv/a' });
  });

  it('leaves the previous registry and no temp file when the write fails', async () => {
    writeFileSync(LINKED(), JSON.stringify({ kept: '/srv/kept' }));
    const realRename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === LINKED()) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
      return realRename(from, to);
    });
    await expect(mutateLinkedCases((current) => ({ ...current, a: '/srv/a' }))).rejects.toThrow('no space left');
    expect(linked()).toEqual({ kept: '/srv/kept' });
    expect(leftovers()).toEqual([]);
  });

  it('writes through a symlinked registry onto its target and keeps the file’s permissions', async () => {
    const real = join(workDir, 'linked-cases.json');
    writeFileSync(real, JSON.stringify({ kept: '/srv/kept' }), { mode: 0o600 });
    safeRmHomeTree(LINKED());
    symlinkSync(real, LINKED());
    await mutateLinkedCases((current) => ({ ...current, a: '/srv/a' }));
    expect(lstatSync(LINKED()).isSymbolicLink()).toBe(true);
    expect(readlinkSync(LINKED())).toBe(real);
    expect(JSON.parse(readFileSync(real, 'utf8'))).toEqual({ kept: '/srv/kept', a: '/srv/a' });
    expect(statSync(real).mode & 0o777).toBe(0o600);
    expect(readdirSync(workDir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
});

describe('the case routes share the writer', () => {
  const folder = (name: string) => {
    const dir = join(workDir, name);
    mkdirSync(dir);
    return dir;
  };

  it('two links of different names at once both survive', async () => {
    const { app } = await createRouteTestHarness(registerCaseRoutes);
    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: '/api/cases/link', payload: { name: 'one', path: folder('one') } }),
      app.inject({ method: 'POST', url: '/api/cases/link', payload: { name: 'two', path: folder('two') } }),
    ]);
    expect([a.json().success, b.json().success]).toEqual([true, true]);
    expect(linked()).toEqual({ one: join(workDir, 'one'), two: join(workDir, 'two') });
  });

  it('two links of one name at once: exactly one wins and the other is told the name is taken', async () => {
    const { app } = await createRouteTestHarness(registerCaseRoutes);
    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: '/api/cases/link', payload: { name: 'twin', path: folder('twin-a') } }),
      app.inject({ method: 'POST', url: '/api/cases/link', payload: { name: 'twin', path: folder('twin-b') } }),
    ]);
    expect([a.json().success, b.json().success].filter(Boolean)).toHaveLength(1);
    const loser = a.json().success ? b : a;
    expect(loser.json().errorCode).toBe('ALREADY_EXISTS');
    expect(Object.keys(linked())).toEqual(['twin']);
  });

  it('an unlink at the same time as a link keeps the new link', async () => {
    writeFileSync(LINKED(), JSON.stringify({ old: folder('old') }));
    const { app } = await createRouteTestHarness(registerCaseRoutes);
    const [unlink, link] = await Promise.all([
      app.inject({ method: 'DELETE', url: '/api/cases/old' }),
      app.inject({ method: 'POST', url: '/api/cases/link', payload: { name: 'fresh', path: folder('fresh') } }),
    ]);
    expect([unlink.json().success, link.json().success]).toEqual([true, true]);
    expect(linked()).toEqual({ fresh: join(workDir, 'fresh') });
    expect(existsSync(join(workDir, 'old'))).toBe(true);
  });

  it('a link refuses a registry that does not parse instead of replacing it', async () => {
    writeFileSync(LINKED(), TORN);
    const { app } = await createRouteTestHarness(registerCaseRoutes);
    const res = await app.inject({ method: 'POST', url: '/api/cases/link', payload: { name: 'n', path: folder('n') } });
    expect(res.json()).toMatchObject({ success: false, errorCode: 'CONFLICT' });
    expect(res.json().error).toContain('is not a valid JSON object');
    expect(readFileSync(LINKED(), 'utf8')).toBe(TORN);
  });
});
