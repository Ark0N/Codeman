/**
 * @fileoverview File Viewer edit mode — read-for-edit (`edit=1`) and
 * `PUT /api/sessions/:id/file-content` (issue #212).
 *
 * Deliberately does NOT mock node:fs — every case runs against a real temp
 * workspace so the confinement (realpath + workspace boundary), the symlink
 * behavior, the atomic temp+rename write, and mode preservation are exercised
 * for real, not against a mock's assumptions.
 *
 * Uses app.inject() — no real HTTP ports needed.
 * Port: N/A (app.inject doesn't open ports)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  chmodSync,
  chownSync,
  statSync,
  lstatSync,
  readlinkSync,
  realpathSync,
  readdirSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerFileRoutes } from '../../src/web/routes/file-routes.js';
import { MAX_EDITABLE_BYTES } from '../../src/config/file-editing.js';

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

describe('file viewer edit mode (real fs)', () => {
  let harness: RouteTestHarness;
  let workDir: string;
  let outsideDir: string;
  const sessionId = 'test-session-1';

  const putFile = (path: string, body: Record<string, unknown>) =>
    harness.app.inject({
      method: 'PUT',
      url: `/api/sessions/${sessionId}/file-content`,
      payload: { path, ...body },
    });

  const getEdit = (path: string) =>
    harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/file-content?path=${encodeURIComponent(path)}&edit=1`,
    });

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerFileRoutes);
    // realpath: on some hosts tmpdir() contains a symlinked component, which
    // would make validateSessionFilePath's relative() check misfire.
    workDir = realpathSync(mkdtempSync(join(tmpdir(), 'codeman-edit-ws-')));
    outsideDir = realpathSync(mkdtempSync(join(tmpdir(), 'codeman-edit-out-')));
    harness.ctx._session.workingDir = workDir;
  });

  afterEach(async () => {
    await harness.app.close();
    rmSync(workDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  // ========== GET ?edit=1 ==========

  describe('GET /api/sessions/:id/file-content?edit=1', () => {
    it('returns the FULL content (never truncated) with hash and eol', async () => {
      const content = Array.from({ length: 800 }, (_, i) => `line ${i + 1}`).join('\n');
      writeFileSync(join(workDir, 'long.md'), content);

      const res = await getEdit('long.md');
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data.content).toBe(content);
      expect(body.data.truncated).toBe(false);
      expect(body.data.totalLines).toBe(800);
      expect(body.data.editable).toBe(true);
      expect(body.data.hash).toBe(sha256(content));
      expect(body.data.eol).toBe('lf');
    });

    it('reports crlf for a CRLF file', async () => {
      writeFileSync(join(workDir, 'dos.txt'), 'a\r\nb\r\nc');
      const res = await getEdit('dos.txt');
      expect(res.json().data.eol).toBe('crlf');
    });

    it('413s above MAX_EDITABLE_BYTES instead of truncating', async () => {
      writeFileSync(join(workDir, 'big.log'), 'x'.repeat(MAX_EDITABLE_BYTES + 1));
      const res = await getEdit('big.log');
      expect(res.statusCode).toBe(413);
      expect(res.json().success).toBe(false);
    });

    it('400s for a non-allowlisted extension', async () => {
      writeFileSync(join(workDir, 'data.xyz'), 'text');
      const res = await getEdit('data.xyz');
      expect(res.statusCode).toBe(400);
    });

    it('400s for binary content even with a text extension', async () => {
      writeFileSync(join(workDir, 'fake.txt'), Buffer.from([0x68, 0x00, 0x69]));
      const res = await getEdit('fake.txt');
      expect(res.statusCode).toBe(400);
    });
  });

  describe('plain read editable flag', () => {
    it('advertises editable:true for an editable text file', async () => {
      writeFileSync(join(workDir, 'notes.md'), 'hello');
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/file-content?path=notes.md`,
      });
      expect(res.json().data.editable).toBe(true);
    });

    it('advertises editable:false for a non-allowlisted extension', async () => {
      writeFileSync(join(workDir, 'schema.xsd'), '<xml/>');
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/file-content?path=schema.xsd`,
      });
      const data = res.json().data;
      expect(data.content).toBeDefined();
      expect(data.editable).toBe(false);
    });
  });

  // ========== PUT ==========

  describe('PUT /api/sessions/:id/file-content', () => {
    it('happy path: writes the bytes, returns new hash, leaves no temp files', async () => {
      const original = 'line one\nline two\n';
      writeFileSync(join(workDir, 'notes.md'), original);

      const updated = 'line one EDITED\nline two\n';
      const res = await putFile('notes.md', { content: updated, baseHash: sha256(original) });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data.hash).toBe(sha256(updated));
      expect(body.data.eol).toBe('lf');
      expect(body.data.size).toBe(Buffer.byteLength(updated));

      expect(readFileSync(join(workDir, 'notes.md'), 'utf8')).toBe(updated);
      const leftovers = readdirSync(workDir).filter((n) => n.includes('codeman-tmp'));
      expect(leftovers).toEqual([]);
    });

    it('404s on ../ traversal without touching the outside file', async () => {
      const target = join(outsideDir, 'victim.md');
      writeFileSync(target, 'safe');
      // Build a relative path that resolves outside the workspace.
      const traversal = `..${target.startsWith('/') ? target : `/${target}`}`;
      const res = await putFile(traversal, { content: 'pwned', baseHash: sha256('safe') });
      expect(res.statusCode).toBe(404);
      expect(readFileSync(target, 'utf8')).toBe('safe');
    });

    it('404s on an absolute path outside the workspace', async () => {
      const target = join(outsideDir, 'victim2.md');
      writeFileSync(target, 'safe');
      const res = await putFile(target, { content: 'pwned', baseHash: sha256('safe') });
      expect(res.statusCode).toBe(404);
      expect(readFileSync(target, 'utf8')).toBe('safe');
    });

    it('404s a symlink pointing outside the workspace and never follows it', async () => {
      const target = join(outsideDir, 'secret.md');
      writeFileSync(target, 'outside');
      symlinkSync(target, join(workDir, 'sneaky.md'));

      const res = await putFile('sneaky.md', { content: 'pwned', baseHash: sha256('outside') });
      expect(res.statusCode).toBe(404);
      expect(readFileSync(target, 'utf8')).toBe('outside');
    });

    it('writes THROUGH a symlink whose target is inside the workspace', async () => {
      writeFileSync(join(workDir, 'real.md'), 'original');
      symlinkSync(join(workDir, 'real.md'), join(workDir, 'alias.md'));

      const res = await putFile('alias.md', { content: 'via alias', baseHash: sha256('original') });
      expect(res.statusCode).toBe(200);
      expect(readFileSync(join(workDir, 'real.md'), 'utf8')).toBe('via alias');
    });

    it('400s a non-allowlisted extension', async () => {
      writeFileSync(join(workDir, 'blob.xyz'), 'text');
      const res = await putFile('blob.xyz', { content: 'nope', baseHash: sha256('text') });
      expect(res.statusCode).toBe(400);
      expect(readFileSync(join(workDir, 'blob.xyz'), 'utf8')).toBe('text');
    });

    it('403s inside .git even for an allowlisted-looking name', async () => {
      mkdirSync(join(workDir, '.git'));
      writeFileSync(join(workDir, '.git', 'config.ini'), '[core]');
      const res = await putFile('.git/config.ini', { content: 'x', baseHash: sha256('[core]') });
      expect(res.statusCode).toBe(403);
    });

    it('400s when the current file contains a NUL byte', async () => {
      writeFileSync(join(workDir, 'weird.txt'), Buffer.from([0x61, 0x00, 0x62]));
      const res = await putFile('weird.txt', { content: 'ab', baseHash: sha256(Buffer.from([0x61, 0x00, 0x62])) });
      expect(res.statusCode).toBe(400);
    });

    it('400s when the current file is not valid UTF-8 (latin-1)', async () => {
      const latin1 = Buffer.from('caf\xe9 au lait', 'latin1');
      writeFileSync(join(workDir, 'legacy.txt'), latin1);
      const res = await putFile('legacy.txt', { content: 'cafe au lait', baseHash: sha256(latin1) });
      expect(res.statusCode).toBe(400);
      expect(readFileSync(join(workDir, 'legacy.txt'))).toEqual(latin1);
    });

    it('409s on a stale baseHash and succeeds with force:true', async () => {
      writeFileSync(join(workDir, 'contested.md'), 'agent version');

      const res = await putFile('contested.md', { content: 'my version', baseHash: sha256('older version') });
      expect(res.statusCode).toBe(409);
      expect(res.json().errorCode).toBe('CONFLICT');
      expect(readFileSync(join(workDir, 'contested.md'), 'utf8')).toBe('agent version');

      const forced = await putFile('contested.md', {
        content: 'my version',
        baseHash: sha256('older version'),
        force: true,
      });
      expect(forced.statusCode).toBe(200);
      expect(readFileSync(join(workDir, 'contested.md'), 'utf8')).toBe('my version');
    });

    it('rejects oversized ASCII content at the schema pre-filter (400)', async () => {
      writeFileSync(join(workDir, 'small.md'), 'ok');
      const res = await putFile('small.md', {
        content: 'x'.repeat(MAX_EDITABLE_BYTES + 1),
        baseHash: sha256('ok'),
      });
      expect(res.statusCode).toBe(400);
      expect(readFileSync(join(workDir, 'small.md'), 'utf8')).toBe('ok');
    });

    it('413s multibyte content that passes the code-unit pre-filter but exceeds the byte cap', async () => {
      writeFileSync(join(workDir, 'small.md'), 'ok');
      // '€' is 1 UTF-16 code unit but 3 UTF-8 bytes: 200k units (< 512Ki cap)
      // becomes ~586KB on disk, so only the handler's byteLength check catches it.
      const res = await putFile('small.md', {
        content: '€'.repeat(200_000),
        baseHash: sha256('ok'),
      });
      expect(res.statusCode).toBe(413);
      expect(readFileSync(join(workDir, 'small.md'), 'utf8')).toBe('ok');
    });

    it('404s a missing file and creates nothing (edit-in-place only)', async () => {
      const res = await putFile('brand-new.md', { content: 'hello', baseHash: sha256('hello') });
      expect(res.statusCode).toBe(404);
      expect(existsSync(join(workDir, 'brand-new.md'))).toBe(false);
    });

    it('400s a malformed baseHash at the schema layer', async () => {
      writeFileSync(join(workDir, 'a.md'), 'x');
      const res = await putFile('a.md', { content: 'y', baseHash: 'not-a-hash' });
      expect(res.statusCode).toBe(400);
      expect(res.json().errorCode).toBe('INVALID_INPUT');
    });

    it('preserves CRLF line endings across a textarea-normalized save', async () => {
      const original = 'first\r\nsecond\r\nthird';
      writeFileSync(join(workDir, 'dos.txt'), original);

      // Client sends LF-normalized content + the eol it was told at load time.
      const res = await putFile('dos.txt', {
        content: 'first\nsecond EDITED\nthird',
        baseHash: sha256(original),
        eol: 'crlf',
      });
      expect(res.statusCode).toBe(200);
      expect(readFileSync(join(workDir, 'dos.txt'), 'utf8')).toBe('first\r\nsecond EDITED\r\nthird');
    });

    it('re-applies the original EOL even when the client omits eol', async () => {
      const original = 'a\r\nb';
      writeFileSync(join(workDir, 'implicit.txt'), original);
      const res = await putFile('implicit.txt', { content: 'a\nb\nc', baseHash: sha256(original) });
      expect(res.statusCode).toBe(200);
      expect(readFileSync(join(workDir, 'implicit.txt'), 'utf8')).toBe('a\r\nb\r\nc');
    });

    it('preserves the file mode across the temp+rename', async () => {
      const p = join(workDir, 'script.sh');
      writeFileSync(p, '#!/bin/sh\necho hi\n');
      chmodSync(p, 0o750);

      const res = await putFile('script.sh', {
        content: '#!/bin/sh\necho bye\n',
        baseHash: sha256('#!/bin/sh\necho hi\n'),
      });
      expect(res.statusCode).toBe(200);
      expect(statSync(p).mode & 0o777).toBe(0o750);
    });

    it('rejects unknown body keys (.strict() schema)', async () => {
      writeFileSync(join(workDir, 'a.md'), 'x');
      const res = await putFile('a.md', { content: 'y', baseHash: sha256('x'), evil: true });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('dotenv files', () => {
    const original = 'TEST_VALUE=original\nTEST_LABEL=café';
    const updated = 'TEST_VALUE=updated\nTEST_LABEL=été';
    const editablePaths = ['.env', '.env.local', '.env.example', 'config.env', 'app/.env'];
    const forbiddenPaths = [
      '.ssh/.env',
      '.codeman/.env',
      '.codeman-dev/.env',
      // Spelled in capitals: the same login file on a case-insensitive filesystem.
      '.codeman/.ENV',
      '.CODEMAN/.env',
      '.npmrc',
      'credentials.json',
    ];

    const getPreview = (path: string) =>
      harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/file-content?path=${encodeURIComponent(path)}`,
      });

    describe.each(editablePaths)('%s', (path) => {
      beforeEach(() => {
        mkdirSync(dirname(join(workDir, path)), { recursive: true });
        writeFileSync(join(workDir, path), original);
      });

      it('plain preview returns exact content and advertises editable:true', async () => {
        const res = await getPreview(path);
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.success).toBe(true);
        expect(body.data.content).toBe(original);
        expect(body.data.editable).toBe(true);
      });

      it('edit=1 returns full content and the SHA-256 of the file bytes', async () => {
        const res = await getEdit(path);
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.success).toBe(true);
        expect(body.data.content).toBe(original);
        expect(body.data.hash).toBe(sha256(Buffer.from(original, 'utf8')));
        expect(body.data.editable).toBe(true);
        expect(body.data.truncated).toBe(false);
        expect(body.data.totalLines).toBe(2);
        expect(body.data.eol).toBe('lf');
      });

      it('PUT saves exact bytes and leaves no temp files', async () => {
        const directory = dirname(join(workDir, path));
        const before = readdirSync(directory).sort();
        const res = await putFile(path, { content: updated, baseHash: sha256(original) });
        expect.soft(res.statusCode).toBe(200);
        const body = res.json();
        expect.soft(body.success).toBe(true);
        expect.soft(body.data?.hash).toBe(sha256(updated));
        expect.soft(body.data?.eol).toBe('lf');
        expect.soft(body.data?.size).toBe(Buffer.byteLength(updated));
        expect.soft(readFileSync(join(workDir, path))).toEqual(Buffer.from(updated));
        expect(readdirSync(directory).sort()).toEqual(before);
      });
    });

    it.each([
      ['0600', 0o600],
      ['0640', 0o640],
    ])('preserves dotenv mode %s across a save', async (_label, mode) => {
      const path = join(workDir, '.env');
      writeFileSync(path, original);
      chmodSync(path, mode);
      const res = await putFile('.env', { content: updated, baseHash: sha256(original) });
      expect.soft(res.statusCode).toBe(200);
      expect.soft(res.json().success).toBe(true);
      expect.soft(readFileSync(path)).toEqual(Buffer.from(updated));
      expect(statSync(path).mode & 0o777).toBe(mode);
    });

    // The save publishes a NEW file. Without help it takes this process's own group, so a
    // `.env` shared with a web server by group (you:www-data, 0640) came back you:you.
    const otherGroup = process.getgroups?.().find((gid) => gid !== process.getgid?.());
    it.skipIf(otherGroup === undefined)('keeps the group of a dotenv file across a save', async () => {
      const path = join(workDir, '.env');
      writeFileSync(path, original);
      chownSync(path, -1, otherGroup!);
      chmodSync(path, 0o640);
      const res = await putFile('.env', { content: updated, baseHash: sha256(original) });
      expect.soft(res.statusCode).toBe(200);
      expect.soft(readFileSync(path)).toEqual(Buffer.from(updated));
      expect.soft(statSync(path).mode & 0o777).toBe(0o640);
      expect(statSync(path).gid).toBe(otherGroup);
    });

    it('rejects a stale dotenv baseHash with 409 and leaves the bytes unchanged', async () => {
      writeFileSync(join(workDir, '.env'), original);
      const res = await putFile('.env', { content: updated, baseHash: sha256('TEST_VALUE=older') });
      expect.soft(res.statusCode).toBe(409);
      expect.soft(res.json().success).toBe(false);
      expect.soft(res.json().errorCode).toBe('CONFLICT');
      expect(readFileSync(join(workDir, '.env'))).toEqual(Buffer.from(original));
    });

    describe.each(forbiddenPaths)('protected %s', (path) => {
      beforeEach(() => {
        mkdirSync(dirname(join(workDir, path)), { recursive: true });
        writeFileSync(join(workDir, path), original);
      });

      it('plain preview advertises editable:false', async () => {
        const res = await getPreview(path);
        expect(res.statusCode).toBe(200);
        expect(res.json().success).toBe(true);
        expect(res.json().data.editable).toBe(false);
      });

      it('edit=1 refuses with 403', async () => {
        const res = await getEdit(path);
        expect(res.statusCode).toBe(403);
        expect(res.json().success).toBe(false);
        expect(res.json().errorCode).toBe('FORBIDDEN');
      });

      it('PUT refuses with FORBIDDEN and leaves the bytes unchanged', async () => {
        const res = await putFile(path, { content: updated, baseHash: sha256(original) });
        expect.soft(res.statusCode).toBe(403);
        expect.soft(res.json().success).toBe(false);
        expect.soft(res.json().errorCode).toBe('FORBIDDEN');
        expect(readFileSync(join(workDir, path))).toEqual(Buffer.from(original));
      });
    });

    it('refuses a dotenv symlink to credentials.json with 403 and preserves its target', async () => {
      const target = join(workDir, 'credentials.json');
      writeFileSync(target, original);
      symlinkSync(target, join(workDir, '.env'));
      const res = await putFile('.env', { content: updated, baseHash: sha256(original) });
      expect.soft(res.statusCode).toBe(403);
      expect.soft(res.json().success).toBe(false);
      expect.soft(res.json().errorCode).toBe('FORBIDDEN');
      expect(readFileSync(target)).toEqual(Buffer.from(original));
    });

    it('refuses a dotenv symlink outside the workspace with 404 and preserves its target', async () => {
      const target = join(outsideDir, 'outside.env');
      writeFileSync(target, original);
      symlinkSync(target, join(workDir, '.env'));
      const res = await putFile('.env', { content: updated, baseHash: sha256(original) });
      expect.soft(res.statusCode).toBe(404);
      expect.soft(res.json().success).toBe(false);
      expect(readFileSync(target)).toEqual(Buffer.from(original));
    });

    it('writes through a dotenv symlink to real.env and preserves the symlink', async () => {
      const target = join(workDir, 'real.env');
      const link = join(workDir, '.env');
      writeFileSync(target, original);
      symlinkSync(target, link);
      const before = readdirSync(workDir).sort();
      const res = await putFile('.env', { content: updated, baseHash: sha256(original) });
      expect.soft(res.statusCode).toBe(200);
      expect.soft(res.json().success).toBe(true);
      expect.soft(readFileSync(target)).toEqual(Buffer.from(updated));
      expect.soft(readFileSync(link)).toEqual(Buffer.from(updated));
      expect.soft(lstatSync(link).isSymbolicLink()).toBe(true);
      expect.soft(readlinkSync(link)).toBe(target);
      expect(readdirSync(workDir).sort()).toEqual(before);
    });
  });

  // ========== multi-user scoping ==========

  describe('multi-user ownership', () => {
    it("404s a non-admin writing to a session they don't own", async () => {
      const prev = process.env.CODEMAN_MULTIUSER;
      process.env.CODEMAN_MULTIUSER = '1';
      try {
        const scoped = await createRouteTestHarness(registerFileRoutes, {
          authUser: { username: 'mallory', role: 'user' },
        });
        scoped.ctx._session.workingDir = workDir;
        writeFileSync(join(workDir, 'owned.md'), 'admin file');

        const res = await scoped.app.inject({
          method: 'PUT',
          url: `/api/sessions/${sessionId}/file-content`,
          payload: { path: 'owned.md', content: 'stolen', baseHash: sha256('admin file') },
        });
        expect(res.statusCode).toBe(404);
        expect(readFileSync(join(workDir, 'owned.md'), 'utf8')).toBe('admin file');
        await scoped.app.close();
      } finally {
        if (prev === undefined) delete process.env.CODEMAN_MULTIUSER;
        else process.env.CODEMAN_MULTIUSER = prev;
      }
    });
  });
});
