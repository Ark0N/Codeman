/**
 * @fileoverview COD-53 — attachment path-traversal / sensitive-file guard.
 *
 * Verifies the sensitive-path blocklist is enforced at:
 *  - attachment registration (POST /api/sessions/:id/attachments)
 *  - raw / preview / thumbnail serving (defense-in-depth against a record that
 *    was crafted or registered before the guard existed)
 * while still allowing legitimate cross-workspace attachment (codeman-publish
 * skill + the ~/.codeman review-card loop) to succeed.
 *
 * Uses app.inject() — no real HTTP ports needed.
 * Port: N/A (app.inject doesn't open ports)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import { homedir } from 'node:os';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerFileRoutes } from '../../src/web/routes/file-routes.js';

// Mock fs/promises for file operations
vi.mock('node:fs/promises', () => ({
  default: {
    readdir: vi.fn(async () => []),
    readFile: vi.fn(async () => 'file content'),
    writeFile: vi.fn(async () => undefined),
    stat: vi.fn(async () => ({ size: 100, isFile: () => true, mtimeMs: 1 })),
    mkdir: vi.fn(async () => undefined),
    mkdtemp: vi.fn(async () => '/tmp/codeman-preview-test'),
    rename: vi.fn(async () => undefined),
    rm: vi.fn(async () => undefined),
  },
}));

// Mock realpathSync for symlink resolution (identity by default)
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    realpathSync: vi.fn((p: string) => p),
    createReadStream: vi.fn(() => Readable.from([Buffer.from('file content')])),
  };
});

vi.mock('../../src/file-stream-manager.js', () => ({
  fileStreamManager: {
    createStream: vi.fn(async () => ({ success: true, streamId: 'stream-1' })),
    closeStream: vi.fn(() => true),
  },
}));

import fs from 'node:fs/promises';
import { createReadStream, realpathSync } from 'node:fs';
import {
  attachmentRegistry,
  registerExternalAttachment,
  type AttachmentRecord,
} from '../../src/attachment-registry.js';
import { SseEvent } from '../../src/web/sse-events.js';

const mockedStat = vi.mocked(fs.stat);
const mockedRealpathSync = vi.mocked(realpathSync);
const mockedCreateReadStream = vi.mocked(createReadStream);

describe('file-routes attachment path guard (COD-53)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerFileRoutes);
    vi.clearAllMocks();
    attachmentRegistry.clearSession('test-session-1');
    mockedRealpathSync.mockImplementation((p: string) => p as never);
    mockedStat.mockResolvedValue({ size: 100, isFile: () => true, mtimeMs: 1 } as never);
    mockedCreateReadStream.mockReturnValue(Readable.from([Buffer.from('file content')]) as never);
  });

  afterEach(async () => {
    await harness.app.close();
    attachmentRegistry.clearSession(harness.ctx._sessionId);
    // Reset attachment-guard env knobs so one test can't leak into the next.
    delete process.env.CODEMAN_ATTACHMENT_BLOCKED_PATHS;
    delete process.env.CODEMAN_ATTACHMENT_CONFINE;
  });

  // ===== BLOCK: registration rejects a sensitive path =====

  it('rejects registering a .env file that carries a supported extension', async () => {
    // A dotenv-style secret file named with a supported extension still leaks
    // secrets; the blocklist's /\.env\./ pattern catches `.env.<ext>`.
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
      payload: { path: '/home/someone/project/.env.txt' },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  it('rejects registering an SSH key path even with a supported extension', async () => {
    const sshTxt = `${homedir()}/.ssh/id_rsa.txt`;
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
      payload: { path: sshTxt },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  it('rejects registering a sensitive path that a symlink resolves to', async () => {
    // The requested path looks innocent (.md) but realpath resolves it to an SSH key dir.
    mockedRealpathSync.mockReturnValue(`${homedir()}/.ssh/known_hosts.md` as never);
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
      payload: { path: '/home/someone/project/innocent.md' },
    });

    expect(res.statusCode).toBe(403);
  });

  // ===== BLOCK (defense-in-depth): raw serving rejects a sensitive record =====

  it('refuses to serve raw bytes for a record whose path is sensitive', async () => {
    // Simulate a record that was registered before the guard existed (or crafted).
    const record: AttachmentRecord = {
      attachmentId: 'att_sensitive',
      sessionId: harness.ctx._sessionId,
      filePath: `${homedir()}/.ssh/id_rsa.txt`,
      fileName: 'id_rsa.txt',
      extension: 'txt',
      attachmentType: 'text',
      size: 100,
      mtimeMs: 1,
      timestamp: Date.now(),
      source: 'external',
    };
    attachmentRegistry.register(record);

    const res = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments/att_sensitive/raw`,
    });

    expect(res.statusCode).toBe(403);
    expect(mockedCreateReadStream).not.toHaveBeenCalled();
  });

  // ===== PRESERVE: legitimate cross-workspace attachment still works =====

  it('still registers a normal cross-workspace file (codeman-publish / loop review card)', async () => {
    mockedStat.mockResolvedValue({ size: 512, isFile: () => true, mtimeMs: 5 } as never);
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
      payload: { path: `${homedir()}/.codeman/jira-autoloop-questions.md` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.fileName).toBe('jira-autoloop-questions.md');
    expect(body.data.extension).toBe('md');
  });

  it('still registers an arbitrary project-dir file (WSL path)', async () => {
    mockedStat.mockResolvedValue({ size: 4096, isFile: () => true, mtimeMs: 5 } as never);
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
      payload: { path: '/mnt/c/decks/board-update.pdf' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.fileName).toBe('board-update.pdf');
  });

  it('still serves raw bytes for a legitimately registered cross-workspace file', async () => {
    const content = Buffer.from('# notes');
    mockedCreateReadStream.mockReturnValue(Readable.from([content]) as never);
    mockedStat.mockResolvedValue({ size: content.length, isFile: () => true, mtimeMs: 5 } as never);

    const registerRes = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
      payload: { path: `${homedir()}/.codeman/review-card.md` },
    });
    const attachmentId = JSON.parse(registerRes.body).data.attachmentId;

    const rawRes = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments/${attachmentId}/raw`,
    });

    expect(rawRes.statusCode).toBe(200);
    expect(rawRes.headers['content-type']).toBe('text/markdown');
  });

  // ===== BLOCK (broadened defaults): /root and /etc trees =====

  it('rejects registering a file anywhere under /root by default', async () => {
    // /root is the root account home — blocked as a whole tree by default,
    // even for an ordinary-looking note with a supported extension.
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
      payload: { path: '/root/secret-notes.md' },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  it('rejects registering a file anywhere under /etc by default', async () => {
    // The whole /etc tree is blocked by default (not just /etc/shadow).
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
      payload: { path: '/etc/codeman/config-dump.txt' },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  it('does not block a lookalike sibling dir like /etcetera (separator-aware)', async () => {
    // The /etc tree block must be path-separator-aware so an unrelated
    // /etcetera/... path is NOT caught by accident.
    mockedStat.mockResolvedValue({ size: 10, isFile: () => true, mtimeMs: 5 } as never);
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
      payload: { path: '/etcetera/notes.md' },
    });

    expect(res.statusCode).toBe(200);
  });

  // ===== CONFIG: extend the blocked set via env =====

  it('rejects a path added via the extra-blocked-paths config', async () => {
    process.env.CODEMAN_ATTACHMENT_BLOCKED_PATHS = '/srv/secrets,/data/private';
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
      payload: { path: '/srv/secrets/keys.pdf' },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  it('still allows a normal path NOT in the configured blocked set', async () => {
    process.env.CODEMAN_ATTACHMENT_BLOCKED_PATHS = '/srv/secrets,/data/private';
    mockedStat.mockResolvedValue({ size: 20, isFile: () => true, mtimeMs: 5 } as never);
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
      payload: { path: '/srv/public/report.pdf' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.fileName).toBe('report.pdf');
  });

  // ===== CONFINEMENT MODE ON (opt-in) =====

  it('confinement ON: rejects a file OUTSIDE the session workspace', async () => {
    process.env.CODEMAN_ATTACHMENT_CONFINE = '1';
    // Mock session workspace is /tmp/test-workdir; this file resolves elsewhere.
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
      payload: { path: '/home/someone/elsewhere/report.pdf' },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  it('confinement ON: allows a file INSIDE the session workspace', async () => {
    process.env.CODEMAN_ATTACHMENT_CONFINE = '1';
    // Mock session workspace is /tmp/test-workdir (see MockSession).
    const insidePath = '/tmp/test-workdir/docs/report.pdf';
    mockedRealpathSync.mockReturnValue(insidePath as never);
    mockedStat.mockResolvedValue({ size: 30, isFile: () => true, mtimeMs: 5 } as never);
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
      payload: { path: insidePath },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.fileName).toBe('report.pdf');
  });

  // ===== CONFINEMENT OFF (default) regression: legit cross-workspace attach =====

  it('confinement OFF (default): legit cross-workspace attach still succeeds', async () => {
    // No CODEMAN_ATTACHMENT_CONFINE set → default OFF. A ~/.codeman review-card
    // file lives OUTSIDE the /tmp/test-workdir session workspace and must still
    // attach (protects codeman-publish + the loop's review-card channel).
    mockedStat.mockResolvedValue({ size: 64, isFile: () => true, mtimeMs: 5 } as never);
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
      payload: { path: `${homedir()}/.codeman/jira-autoloop-questions.md` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.fileName).toBe('jira-autoloop-questions.md');
  });

  // ===== Magic-link scan path: FORCED workspace confinement =====
  // The terminal-output `codeman://attach` scanner registers with
  // forceWorkspaceConfinement: true so a prompt-injected session printing an
  // arbitrary path can't expose a host file, even though global confine is OFF.
  describe('forced workspace confinement (magic-link scan path)', () => {
    it('rejects an out-of-workspace path even when global confinement is OFF', async () => {
      mockedRealpathSync.mockImplementation((p: string) => p as never);
      mockedStat.mockResolvedValue({ size: 10, isFile: () => true, mtimeMs: 1 } as never);
      await expect(
        registerExternalAttachment('test-session-mlc', '/home/someone/secret/report.pdf', {
          sessionWorkingDir: '/tmp/test-workdir',
          forceWorkspaceConfinement: true,
        })
      ).rejects.toMatchObject({ statusCode: 403 });
      attachmentRegistry.clearSession('test-session-mlc');
    });

    it('allows an in-workspace path on the forced path', async () => {
      const inside = '/tmp/test-workdir/sub/report.pdf';
      mockedRealpathSync.mockReturnValue(inside as never);
      mockedStat.mockResolvedValue({ size: 10, isFile: () => true, mtimeMs: 1 } as never);
      const event = await registerExternalAttachment('test-session-mlc', inside, {
        sessionWorkingDir: '/tmp/test-workdir',
        forceWorkspaceConfinement: true,
      });
      expect(event.fileName).toBe('report.pdf');
      attachmentRegistry.clearSession('test-session-mlc');
    });
  });

  // ===== Media (click-to-preview parity with the workspace preview) =====
  // A video an agent writes inside the workspace plays with a working scrub
  // bar; the same file in /tmp used to be refused as an unsupported type. Both
  // now go through the same extension sets, and the raw route has to answer
  // with a real media Content-Type and a range, or the player renders and then
  // does nothing.
  describe('media attachments', () => {
    it('registers a video and serves it as seekable video/mp4', async () => {
      const content = Buffer.from('MP4DATA-0123456789');
      mockedStat.mockResolvedValue({ size: content.length, isFile: () => true, mtimeMs: 5 } as never);
      mockedCreateReadStream.mockReturnValue(Readable.from([content.subarray(4, 10)]) as never);

      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
        payload: { path: '/tmp/captures/demo.mp4', notify: false },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.attachmentType).toBe('video');

      const rawRes = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments/${body.data.attachmentId}/raw`,
        headers: { range: 'bytes=4-9' },
      });
      expect(rawRes.statusCode).toBe(206);
      expect(rawRes.headers['content-type']).toBe('video/mp4');
      expect(rawRes.headers['content-range']).toBe(`bytes 4-9/${content.length}`);
      expect(rawRes.headers['accept-ranges']).toBe('bytes');
    });

    it('registers audio with an audio type and its real MIME', async () => {
      const content = Buffer.from('ID3AUDIO');
      mockedStat.mockResolvedValue({ size: content.length, isFile: () => true, mtimeMs: 5 } as never);
      mockedCreateReadStream.mockReturnValue(Readable.from([content]) as never);

      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
        payload: { path: '/tmp/captures/take.mp3', notify: false },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.attachmentType).toBe('audio');

      const rawRes = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments/${body.data.attachmentId}/raw`,
      });
      expect(rawRes.statusCode).toBe(200);
      expect(rawRes.headers['content-type']).toBe('audio/mpeg');
    });

    it('answers no thumbnail for media instead of spawning a converter', async () => {
      // generateFirstPageThumbnail has no media branch; the card falls back to
      // its type label. This pins that the route reports that cleanly.
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
        payload: { path: '/tmp/captures/clip.webm', notify: false },
      });
      const { attachmentId } = JSON.parse(res.body).data;

      const thumbRes = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments/${attachmentId}/thumbnail`,
      });
      expect(thumbRes.statusCode).toBe(204);
    });

    it('still refuses media in a blocked tree', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
        payload: { path: '/root/private/recording.mp4', notify: false },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // ===== Text family (code, config and logs outside the workspace) =====
  // The agent in the session can already `cat` these, so refusing the click
  // bought no confidentiality. The gate that matters is the path guard, which
  // still runs, and markup must not become executable just because it is now
  // readable.
  describe('text attachments', () => {
    it.each([
      ['/tmp/run.log', 'log'],
      ['/tmp/data.json', 'json'],
      ['/tmp/conf/app.yaml', 'yaml'],
      ['/tmp/src/index.ts', 'ts'],
      ['/tmp/export.csv', 'csv'],
    ])('registers %s as a text attachment', async (path, extension) => {
      mockedStat.mockResolvedValue({ size: 40, isFile: () => true, mtimeMs: 5 } as never);
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
        payload: { path, notify: false },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.extension).toBe(extension);
      expect(body.data.attachmentType).toBe('text');
    });

    it('serves a text file with no dedicated MIME as inert text/plain', async () => {
      const content = Buffer.from('boot ok\nstarted\n');
      mockedStat.mockResolvedValue({ size: content.length, isFile: () => true, mtimeMs: 5 } as never);
      mockedCreateReadStream.mockReturnValue(Readable.from([content]) as never);

      const reg = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
        payload: { path: '/tmp/run.log', notify: false },
      });
      const rawRes = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments/${JSON.parse(reg.body).data.attachmentId}/raw`,
      });

      expect(rawRes.statusCode).toBe(200);
      expect(rawRes.headers['content-type']).toBe('text/plain; charset=utf-8');
      expect(rawRes.headers['x-content-type-options']).toBe('nosniff');
    });

    it('keeps HTML download-only so readable never means executable', async () => {
      // Serving markup with a renderable type on our own origin is stored XSS.
      // The preview reads it through fetch(), which ignores the disposition, so
      // a clicked .html still shows its source.
      const content = Buffer.from('<script>alert(1)</script>');
      mockedStat.mockResolvedValue({ size: content.length, isFile: () => true, mtimeMs: 5 } as never);
      mockedCreateReadStream.mockReturnValue(Readable.from([content]) as never);

      const reg = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
        payload: { path: '/tmp/report.html', notify: false },
      });
      const rawRes = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments/${JSON.parse(reg.body).data.attachmentId}/raw`,
      });

      expect(rawRes.headers['content-type']).toBe('application/octet-stream');
      expect(String(rawRes.headers['content-disposition'])).toContain('attachment');
    });

    it('answers a byte range for text so a huge log is a partial read', async () => {
      const content = Buffer.from('0123456789abcdef');
      mockedStat.mockResolvedValue({ size: content.length, isFile: () => true, mtimeMs: 5 } as never);
      mockedCreateReadStream.mockReturnValue(Readable.from([content.subarray(0, 8)]) as never);

      const reg = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
        payload: { path: '/tmp/big.log', notify: false },
      });
      const rawRes = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments/${JSON.parse(reg.body).data.attachmentId}/raw`,
        headers: { range: 'bytes=0-7' },
      });

      expect(rawRes.statusCode).toBe(206);
      expect(rawRes.headers['content-range']).toBe(`bytes 0-7/${content.length}`);
    });

    it.each([
      ['/home/someone/.config/gh/hosts.yml', 'forge token'],
      ['/home/someone/project/.env.json', 'dotenv'],
      ['/home/someone/.codeman/state.json', 'codeman state (can hold envOverrides secrets)'],
      ['/home/someone/deploy/credentials.yaml', 'generic credentials'],
      ['/etc/codeman/dump.log', 'blocked tree'],
    ])('still refuses %s (%s) now that text is servable', async (path) => {
      mockedStat.mockResolvedValue({ size: 40, isFile: () => true, mtimeMs: 5 } as never);
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
        payload: { path, notify: false },
      });

      expect(res.statusCode).toBe(403);
    });

    it('still refuses a type outside the family', async () => {
      mockedStat.mockResolvedValue({ size: 40, isFile: () => true, mtimeMs: 5 } as never);
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
        payload: { path: '/tmp/drawing.svg', notify: false },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/unsupported/i);
    });
  });

  // ===== XLSX: client-side preview, same guard and routes =====
  // xlsx joins the extension allowlist so the overlay can preview a workbook
  // outside the workspace by id. Nothing else about the pipeline changes; only
  // `?preview=true` adds a tighter size cap because the browser parses it.
  describe('xlsx attachments', () => {
    async function registerXlsx(size: number) {
      mockedStat.mockResolvedValue({ size, isFile: () => true, mtimeMs: 5 } as never);
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
        payload: { path: '/tmp/report.xlsx', notify: false },
      });
      expect(res.statusCode).toBe(200);
      return JSON.parse(res.body).data as { attachmentId: string; attachmentType: string };
    }

    it('registers an xlsx as a spreadsheet attachment', async () => {
      const data = await registerXlsx(2048);
      expect(data.attachmentType).toBe('spreadsheet');
    });

    it('still refuses xls and ods (download-only, no preview)', async () => {
      for (const path of ['/tmp/legacy.xls', '/tmp/open.ods']) {
        const res = await harness.app.inject({
          method: 'POST',
          url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
          payload: { path, notify: false },
        });
        expect(res.statusCode, path).toBe(400);
      }
    });

    it('caps a ?preview=true fetch at 10 MB but still serves a plain download', async () => {
      const { attachmentId } = await registerXlsx(11 * 1024 * 1024);
      const base = `/api/sessions/${harness.ctx._sessionId}/attachments/${attachmentId}/raw`;

      const preview = await harness.app.inject({ method: 'GET', url: `${base}?preview=true` });
      expect(preview.statusCode).toBe(413);
      expect(JSON.parse(preview.body).error).toMatch(/too large to preview/i);

      mockedCreateReadStream.mockReturnValue(Readable.from([Buffer.from('PK')]) as never);
      const download = await harness.app.inject({ method: 'GET', url: `${base}?preview=true&download=true` });
      expect(download.statusCode).toBe(200);
    });
  });

  // ===== Quiet registration (click-to-preview) =====
  // The file-preview overlay registers a clicked out-of-workspace path to mint
  // an id it can render by. It is already putting the file on screen, so the
  // usual attachment card + unread badge would announce what the user is
  // looking at. `notify: false` suppresses ONLY the broadcast — the guard, the
  // registry entry and the by-id routes are identical either way.
  describe('quiet registration', () => {
    const outside = '/tmp/claude-1000/scratchpad/probe-run-native.png';

    it('broadcasts by default, so the CLI and publish paths keep their card', async () => {
      mockedStat.mockResolvedValue({ size: 128, isFile: () => true, mtimeMs: 5 } as never);
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
        payload: { path: outside },
      });

      expect(res.statusCode).toBe(200);
      expect(harness.ctx.broadcast).toHaveBeenCalledWith(SseEvent.AttachmentDetected, expect.anything());
    });

    it('registers and serves a clicked path without broadcasting when notify is false', async () => {
      const content = Buffer.from('PNGDATA');
      mockedStat.mockResolvedValue({ size: content.length, isFile: () => true, mtimeMs: 5 } as never);
      mockedCreateReadStream.mockReturnValue(Readable.from([content]) as never);

      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
        payload: { path: outside, notify: false },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.fileName).toBe('probe-run-native.png');
      expect(harness.ctx.broadcast).not.toHaveBeenCalled();

      // The preview renders from this route, so the id has to be live.
      const rawRes = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments/${body.data.attachmentId}/raw`,
      });
      expect(rawRes.statusCode).toBe(200);
      expect(rawRes.headers['content-type']).toBe('image/png');
    });
  });
});
