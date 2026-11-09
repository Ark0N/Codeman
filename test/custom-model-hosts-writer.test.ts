/**
 * @fileoverview The serialized writer of `custom-model-hosts.json`
 * (src/custom-model-hosts-writer.ts) and the rule that every writer in src/ goes through it.
 *
 * What is pinned:
 *  - two mutations started at the same moment both land (the fault the writer ends: the
 *    endpoint routes and the discovery sweep used to read, change and write on their own);
 *  - the check a caller makes runs in the same step as its write;
 *  - a file that does not parse is refused and left byte for byte, and the refusal never
 *    repeats the file's text (it can hold an API key);
 *  - the file is written 0600 through a temp file that is gone afterwards;
 *  - no module of src/ calls `writeCustomModelHosts()` any more.
 *
 * Port: N/A (no server; files in a temp folder).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CustomModelHostsWriteRefusedError,
  customModelHostsWriteErrorResponse,
  mutateCustomModelHosts,
} from '../src/custom-model-hosts-writer.js';
import { customModelHostsPath, readCustomModelHosts, type CustomModelHost } from '../src/custom-model-hosts.js';

const host = (id: string, extra: Partial<CustomModelHost> = {}): CustomModelHost => ({
  id,
  label: id,
  baseUrl: `http://${id}.example:8080`,
  ...extra,
});

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codeman-hosts-writer-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('mutateCustomModelHosts', () => {
  it('starts from an empty list when the file is missing, and writes what the mutation returns', async () => {
    const result = await mutateCustomModelHosts((hosts) => {
      expect(hosts).toEqual([]);
      return { hosts: [host('a')], result: 'added' };
    }, dir);
    expect(result).toBe('added');
    expect(await readCustomModelHosts(dir)).toEqual([host('a')]);
  });

  it('an empty file is an empty list too: it holds no endpoint to lose', async () => {
    writeFileSync(customModelHostsPath(dir), '  \n');
    await mutateCustomModelHosts((hosts) => ({ hosts: [...hosts, host('a')], result: undefined }), dir);
    expect(await readCustomModelHosts(dir)).toEqual([host('a')]);
  });

  it('writes nothing when the mutation returns no list', async () => {
    writeFileSync(customModelHostsPath(dir), JSON.stringify([host('a')]));
    const before = statSync(customModelHostsPath(dir)).mtimeMs;
    const result = await mutateCustomModelHosts((hosts) => ({ result: hosts.length }), dir);
    expect(result).toBe(1);
    expect(statSync(customModelHostsPath(dir)).mtimeMs).toBe(before);
    expect(readFileSync(customModelHostsPath(dir), 'utf8')).toBe(JSON.stringify([host('a')]));
  });

  it('two mutations started together both land: the second sees what the first wrote', async () => {
    const seen: string[][] = [];
    const add = (id: string) =>
      mutateCustomModelHosts((hosts) => {
        seen.push(hosts.map((item) => item.id));
        return { hosts: [...hosts, host(id)], result: id };
      }, dir);
    const results = await Promise.all([add('first'), add('second')]);
    expect(results).toEqual(['first', 'second']);
    expect(seen).toEqual([[], ['first']]);
    expect((await readCustomModelHosts(dir)).map((item) => item.id)).toEqual(['first', 'second']);
  });

  it('twenty mutations at once keep every record (unserialized writers lost all but the last)', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `ep${i}`);
    await Promise.all(
      ids.map((id) => mutateCustomModelHosts((hosts) => ({ hosts: [...hosts, host(id)], result: undefined }), dir))
    );
    expect((await readCustomModelHosts(dir)).map((item) => item.id)).toEqual(ids);
    // Every temp file was renamed over the target: only the one file is left.
    expect(readdirSync(dir)).toEqual(['custom-model-hosts.json']);
  });

  it('a check made inside the mutation is made on the list as it is then: two creates of one id, one wins', async () => {
    const create = (label: string) =>
      mutateCustomModelHosts<'created' | 'exists'>((hosts) => {
        if (hosts.some((item) => item.id === 'same')) return { result: 'exists' };
        return { hosts: [...hosts, host('same', { label })], result: 'created' };
      }, dir);
    expect(await Promise.all([create('one'), create('two')])).toEqual(['created', 'exists']);
    expect(await readCustomModelHosts(dir)).toEqual([host('same', { label: 'one' })]);
  });

  it('hands the mutation a list it may change in place', async () => {
    writeFileSync(customModelHostsPath(dir), JSON.stringify([host('a'), host('b')]));
    await mutateCustomModelHosts((hosts) => {
      hosts[1] = { ...hosts[1], label: 'changed' };
      return { hosts, result: undefined };
    }, dir);
    expect((await readCustomModelHosts(dir)).map((item) => item.label)).toEqual(['a', 'changed']);
  });

  it('writes the file 0600 (it holds API keys), also over a file that was world-readable', async () => {
    writeFileSync(customModelHostsPath(dir), '[]', { mode: 0o644 });
    await mutateCustomModelHosts(() => ({ hosts: [host('a', { apiKey: 'sk-secret' })], result: undefined }), dir);
    expect(statSync(customModelHostsPath(dir)).mode & 0o777).toBe(0o600);
  });

  it('writes through a symlink: the real file changes and the link stays a link', async () => {
    const real = join(dir, 'real-hosts.json');
    writeFileSync(real, '[]');
    symlinkSync(real, customModelHostsPath(dir));
    await mutateCustomModelHosts(() => ({ hosts: [host('a')], result: undefined }), dir);
    expect(JSON.parse(readFileSync(real, 'utf8'))).toEqual([host('a')]);
    expect(await readCustomModelHosts(dir)).toEqual([host('a')]);
  });

  describe('a file that must not be overwritten', () => {
    const broken = '[{"id":"keep","apiKey":"sk-do-not-leak"},';

    it.each([
      ['text that does not parse', broken],
      ['a JSON object instead of a list', '{"id":"keep","apiKey":"sk-do-not-leak"}'],
      ['a JSON string', '"sk-do-not-leak"'],
    ])('refuses %s, leaves it byte for byte and never calls the mutation', async (_label, content) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      writeFileSync(customModelHostsPath(dir), content);
      const fn = vi.fn(() => ({ hosts: [host('new')], result: undefined }));
      await expect(mutateCustomModelHosts(fn, dir)).rejects.toBeInstanceOf(CustomModelHostsWriteRefusedError);
      expect(fn).not.toHaveBeenCalled();
      expect(readFileSync(customModelHostsPath(dir), 'utf8')).toBe(content);
      expect(readdirSync(dir)).toEqual(['custom-model-hosts.json']);
      // Neither the error nor the log repeats the file, which holds a key.
      const error = await mutateCustomModelHosts(fn, dir).catch((err: Error) => err);
      expect((error as Error).message).not.toContain('sk-do-not-leak');
      expect((error as Error).message).toContain('custom-model-hosts.json');
      expect(warn.mock.calls.flat().join(' ')).not.toContain('sk-do-not-leak');
    });

    it('the plain reader calls such a file an empty list, which is why a writer must not start from it', async () => {
      writeFileSync(customModelHostsPath(dir), broken);
      expect(await readCustomModelHosts(dir)).toEqual([]);
    });

    it('a refused mutation does not stop the ones after it', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      writeFileSync(customModelHostsPath(dir), broken);
      const refused = mutateCustomModelHosts(() => ({ hosts: [], result: undefined }), dir);
      const other = mkdtempSync(join(tmpdir(), 'codeman-hosts-writer-other-'));
      try {
        const next = mutateCustomModelHosts(() => ({ hosts: [host('a')], result: 'ok' }), other);
        await expect(refused).rejects.toBeInstanceOf(CustomModelHostsWriteRefusedError);
        expect(await next).toBe('ok');
        expect(await readCustomModelHosts(other)).toEqual([host('a')]);
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    });
  });

  it('a mutation that throws rejects its own caller, writes nothing, and the chain goes on', async () => {
    writeFileSync(customModelHostsPath(dir), JSON.stringify([host('a')]));
    const thrown = mutateCustomModelHosts(() => {
      throw new Error('boom');
    }, dir);
    const next = mutateCustomModelHosts((hosts) => ({ hosts: [...hosts, host('b')], result: undefined }), dir);
    await expect(thrown).rejects.toThrow('boom');
    await next;
    expect((await readCustomModelHosts(dir)).map((item) => item.id)).toEqual(['a', 'b']);
  });
});

describe('customModelHostsWriteErrorResponse', () => {
  it('a refused write is 409 CONFLICT with the fix', () => {
    const response = customModelHostsWriteErrorResponse(
      new CustomModelHostsWriteRefusedError('the file is not a valid JSON list')
    );
    expect(response).toEqual({
      success: false,
      error: 'the file is not a valid JSON list',
      errorCode: 'CONFLICT',
    });
  });

  it('any other failure stays OPERATION_FAILED', () => {
    expect(customModelHostsWriteErrorResponse(new Error('EACCES'))).toMatchObject({
      success: false,
      errorCode: 'OPERATION_FAILED',
      error: 'EACCES',
    });
  });
});

describe('every writer goes through the serialized writer', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));

  function sourceFiles(folder: string, out: string[] = []): string[] {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      if (statSync(path).isDirectory()) {
        if (name !== 'public' && name !== 'node_modules') sourceFiles(path, out);
      } else if (name.endsWith('.ts')) {
        out.push(path);
      }
    }
    return out;
  }

  /** The file without its comment lines: a comment may name the function it explains. */
  const code = (path: string): string =>
    readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');

  it('no module of src/ calls writeCustomModelHosts(): the store itself only defines it', () => {
    const callers = sourceFiles(join(root, 'src'))
      .filter((path) => /\bwriteCustomModelHosts\s*\(/.test(code(path)))
      .map((path) => path.slice(root.length));
    expect(callers).toEqual(['src/custom-model-hosts.ts']);
  });

  it('the endpoint routes and the sweep name the writer, five times', () => {
    const routes = code(join(root, 'src/web/routes/custom-model-routes.ts'));
    // create, update, delete, discover-models and the re-discovery sweep.
    expect(routes.match(/await mutateCustomModelHosts</g)).toHaveLength(5);
    expect(routes).not.toContain('writeCustomModelHosts');
  });
});
