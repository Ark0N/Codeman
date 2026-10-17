/**
 * @fileoverview Path picker file transfer: `GET /api/filesystem/download` and
 * `POST /api/filesystem/upload`. Both ride the picker's own confinement, so the
 * tests pin that they reach what a browse can list and nothing more: the folder
 * on screen, never outside the allowed roots, never a blocked/sensitive name, and
 * an upload never overwrites or follows a planted symlink.
 *
 * Runs against a real temp directory (the session's workingDir is the "Current
 * Folder" root); uses app.inject(), so no port is needed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockRouteContext } from '../mocks/index.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { registerFileRoutes, sanitizePickerUploadName } from '../../src/web/routes/file-routes.js';

const BOUNDARY = 'codemanboundary';

function multipartBody(fieldName: string, fileName: string, content: string | Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\n` +
        'Content-Type: application/octet-stream\r\n\r\n'
    ),
    Buffer.isBuffer(content) ? content : Buffer.from(content),
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
}

describe('path picker file transfer', () => {
  let app: FastifyInstance;
  let ctx: ReturnType<typeof createMockRouteContext>;
  let workspace: string;
  let outside: string;

  beforeEach(async () => {
    workspace = await realpath(await mkdtemp(join(tmpdir(), 'codeman-picker-transfer-')));
    outside = await realpath(await mkdtemp(join(tmpdir(), 'codeman-picker-outside-')));
    app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    await app.register(fastifyMultipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 4 } });
    ctx = createMockRouteContext();
    ctx._session.workingDir = workspace;
    registerFileRoutes(app, ctx as never);
    installRouteErrorHandler(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  const upload = (folder: string, fileName: string, content: string | Buffer, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: `/api/filesystem/upload?sessionId=${ctx._sessionId}&path=${encodeURIComponent(folder)}`,
      headers: { 'x-codeman-csrf': '1', 'content-type': `multipart/form-data; boundary=${BOUNDARY}`, ...headers },
      payload: multipartBody('file', fileName, content),
    });

  describe('GET /api/filesystem/download', () => {
    it('serves any regular file in an allowed root as an attachment', async () => {
      await writeFile(join(workspace, 'build.tar.gz'), 'archive-bytes');
      const res = await app.inject({
        method: 'GET',
        url: `/api/filesystem/download?sessionId=${ctx._sessionId}&path=${encodeURIComponent(join(workspace, 'build.tar.gz'))}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('archive-bytes');
      expect(res.headers['content-disposition']).toMatch(/^attachment; filename="build\.tar\.gz"/);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('refuses a path outside the allowed roots', async () => {
      await writeFile(join(outside, 'secret.txt'), 'nope');
      const res = await app.inject({
        method: 'GET',
        url: `/api/filesystem/download?sessionId=${ctx._sessionId}&path=${encodeURIComponent(join(outside, 'secret.txt'))}`,
      });
      expect(res.statusCode).toBe(403);
    });

    it('refuses a symlink that escapes the roots', async () => {
      await writeFile(join(outside, 'secret.txt'), 'nope');
      await symlink(join(outside, 'secret.txt'), join(workspace, 'link.txt'));
      const res = await app.inject({
        method: 'GET',
        url: `/api/filesystem/download?sessionId=${ctx._sessionId}&path=${encodeURIComponent(join(workspace, 'link.txt'))}`,
      });
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toContain('nope');
    });

    it('refuses a sensitive file', async () => {
      await writeFile(join(workspace, '.env'), 'TOKEN=x');
      const res = await app.inject({
        method: 'GET',
        url: `/api/filesystem/download?sessionId=${ctx._sessionId}&path=${encodeURIComponent(join(workspace, '.env'))}&showHidden=true`,
      });
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toContain('TOKEN');
    });

    it('refuses a folder', async () => {
      await mkdir(join(workspace, 'sub'));
      const res = await app.inject({
        method: 'GET',
        url: `/api/filesystem/download?sessionId=${ctx._sessionId}&path=${encodeURIComponent(join(workspace, 'sub'))}`,
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /api/filesystem/upload', () => {
    it('writes the file into the requested folder and returns its path', async () => {
      await mkdir(join(workspace, 'docs'));
      const res = await upload(join(workspace, 'docs'), 'report.pdf', 'pdf-bytes');
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toEqual({
        success: true,
        data: { path: join(workspace, 'docs', 'report.pdf'), name: 'report.pdf', size: 9 },
      });
      expect(await readFile(join(workspace, 'docs', 'report.pdf'), 'utf8')).toBe('pdf-bytes');
    });

    it('never overwrites: a taken name gets a numbered suffix', async () => {
      await writeFile(join(workspace, 'notes.txt'), 'original');
      const first = JSON.parse((await upload(workspace, 'notes.txt', 'second')).body);
      const second = JSON.parse((await upload(workspace, 'notes.txt', 'third')).body);
      expect(first.data.name).toBe('notes (1).txt');
      expect(second.data.name).toBe('notes (2).txt');
      expect(await readFile(join(workspace, 'notes.txt'), 'utf8')).toBe('original');
      expect(await readFile(join(workspace, 'notes (1).txt'), 'utf8')).toBe('second');
    });

    it('does not follow a symlink planted under the target name', async () => {
      await writeFile(join(outside, 'victim.txt'), 'untouched');
      await symlink(join(outside, 'victim.txt'), join(workspace, 'victim.txt'));
      const body = JSON.parse((await upload(workspace, 'victim.txt', 'payload')).body);
      expect(body.data.name).toBe('victim (1).txt');
      expect(await readFile(join(outside, 'victim.txt'), 'utf8')).toBe('untouched');
    });

    it('strips path components from the client file name', async () => {
      const body = JSON.parse((await upload(workspace, '../../escape.sh', 'x')).body);
      expect(body.data.path).toBe(join(workspace, 'escape.sh'));
      expect(await readdir(outside)).toEqual([]);
    });

    it('refuses a folder outside the allowed roots', async () => {
      const res = await upload(outside, 'a.txt', 'x');
      expect(res.statusCode).toBe(403);
      expect(await readdir(outside)).toEqual([]);
    });

    it('refuses a sensitive file name', async () => {
      const res = await upload(workspace, 'credentials.json', '{}');
      expect(res.statusCode).toBe(403);
      expect(await readdir(workspace)).toEqual([]);
    });

    it('refuses a cross-site request', async () => {
      const res = await upload(workspace, 'a.txt', 'x', { origin: 'https://evil.example', 'x-codeman-csrf': '' });
      expect(res.statusCode).toBe(403);
      expect(await readdir(workspace)).toEqual([]);
    });

    it('refuses an unknown session (ownership boundary)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/filesystem/upload?sessionId=missing&path=${encodeURIComponent(workspace)}`,
        headers: { 'x-codeman-csrf': '1', 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
        payload: multipartBody('file', 'a.txt', 'x'),
      });
      expect(res.statusCode).toBe(404);
    });

    it('refuses the wrong multipart field', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/filesystem/upload?sessionId=${ctx._sessionId}&path=${encodeURIComponent(workspace)}`,
        headers: { 'x-codeman-csrf': '1', 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
        payload: multipartBody('image', 'a.txt', 'x'),
      });
      expect(res.statusCode).toBe(400);
      expect(await readdir(workspace)).toEqual([]);
    });
  });

  describe('sanitizePickerUploadName', () => {
    it.each([
      ['report.pdf', 'report.pdf'],
      ['a/b/c.txt', 'c.txt'],
      ['C:\\Users\\me\\photo.jpg', 'photo.jpg'],
      ['..', 'upload'],
      ['.bashrc', 'bashrc'],
      ['  spaced.txt ', 'spaced.txt'],
      ['bad\u0000name\n.txt', 'badname.txt'],
      ['', 'upload'],
      [undefined, 'upload'],
    ])('%j -> %j', (raw, expected) => {
      expect(sanitizePickerUploadName(raw)).toBe(expected);
    });

    it('keeps the extension when cutting a long name', () => {
      const name = sanitizePickerUploadName(`${'x'.repeat(300)}.docx`);
      expect(name.length).toBeLessThanOrEqual(120);
      expect(name.endsWith('.docx')).toBe(true);
    });
  });
});
