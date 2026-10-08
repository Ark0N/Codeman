/**
 * @fileoverview Tests for html-view-routes: rendering a local HTML file as a page.
 *
 * Real files in a temp dir (no fs mocks): the point of the route is its path
 * policy, and a mocked realpath would make every containment check pass.
 * Port: N/A (app.inject doesn't open ports)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { isBroadHtmlViewRoot, registerHtmlViewRoutes } from '../../src/web/routes/html-view-routes.js';
import { capabilityFromHtmlViewPath, htmlViewCapabilities } from '../../src/html-view-capabilities.js';

describe('html-view routes', () => {
  let harness: RouteTestHarness;
  let sid: string;
  let root: string;
  let workspace: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'html-view-'));
    workspace = join(root, 'ws');
    mkdirSync(join(workspace, 'assets'), { recursive: true });
    writeFileSync(join(workspace, 'index.html'), '<h1>hi</h1>');
    writeFileSync(join(workspace, 'assets', 'app.css'), 'h1{}');
    writeFileSync(join(workspace, 'data.json'), '{}');
    writeFileSync(join(workspace, '.env'), 'SECRET=1');
    writeFileSync(join(workspace, 'notes.sh'), 'echo');
    writeFileSync(join(root, 'outside.txt'), 'outside');
    symlinkSync(join(root, 'outside.txt'), join(workspace, 'escape.txt'));

    harness = await createRouteTestHarness(registerHtmlViewRoutes);
    sid = harness.ctx._sessionId as string;
    (harness.ctx.sessions.get(sid) as { workingDir: string }).workingDir = workspace;
  });

  afterEach(async () => {
    await harness.app.close();
    htmlViewCapabilities.revokeOwner(undefined);
    rmSync(root, { recursive: true, force: true });
  });

  async function open(path: string) {
    return harness.app.inject({ method: 'POST', url: `/api/sessions/${sid}/html-view`, payload: { path } });
  }

  async function openUrl(): Promise<string> {
    const res = await open(join(workspace, 'index.html'));
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body).data.url as string;
  }

  it('mints a capability URL for an HTML file in the workspace', async () => {
    const url = await openUrl();
    expect(url).toMatch(/^\/html-view\/[A-Za-z0-9_-]{16,}\/index\.html$/);
    expect(capabilityFromHtmlViewPath(url)).not.toBeNull();
  });

  it('accepts a workspace-relative path', async () => {
    const res = await open('index.html');
    expect(res.statusCode).toBe(200);
  });

  it('refuses non-HTML files and missing files', async () => {
    expect((await open(join(workspace, 'data.json'))).statusCode).toBe(400);
    expect((await open(join(workspace, 'missing.html'))).statusCode).toBe(404);
  });

  it('serves the page sandboxed, never same-origin', async () => {
    const url = await openUrl();
    const res = await harness.app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toMatch(/^sandbox /);
    expect(csp).not.toContain('allow-same-origin');
    expect(res.body).toBe('<h1>hi</h1>');
  });

  it('serves sibling assets, including subdirectories', async () => {
    const base = (await openUrl()).replace(/index\.html$/, '');
    expect((await harness.app.inject({ method: 'GET', url: `${base}assets/app.css` })).statusCode).toBe(200);
    expect((await harness.app.inject({ method: 'GET', url: `${base}data.json` })).statusCode).toBe(200);
  });

  it('never serves dotfiles, non-asset types, escapes or symlinks out of the directory', async () => {
    const base = (await openUrl()).replace(/index\.html$/, '');
    for (const p of ['.env', 'assets/../.env', '%2e%2e/outside.txt', '..%2foutside.txt', 'notes.sh', 'escape.txt']) {
      const res = await harness.app.inject({ method: 'GET', url: `${base}${p}` });
      expect(res.statusCode, p).toBe(404);
    }
  });

  it('refuses an unknown or revoked capability', async () => {
    const url = await openUrl();
    expect(
      (await harness.app.inject({ method: 'GET', url: '/html-view/AAAAAAAAAAAAAAAAAAAAAAAA/index.html' })).statusCode
    ).toBe(404);
    htmlViewCapabilities.revokeOwner(undefined);
    expect((await harness.app.inject({ method: 'GET', url })).statusCode).toBe(404);
  });

  it('reuses one capability per directory', async () => {
    expect(await openUrl()).toBe(await openUrl());
  });
  describe('outside the workspace', () => {
    let outsideDir: string;
    const saved = {
      confine: process.env.CODEMAN_ATTACHMENT_CONFINE,
      blocked: process.env.CODEMAN_ATTACHMENT_BLOCKED_PATHS,
    };

    beforeEach(() => {
      outsideDir = join(root, 'reports');
      mkdirSync(outsideDir);
      writeFileSync(join(outsideDir, 'report.html'), '<p>report</p>');
    });

    afterEach(() => {
      for (const [key, value] of [
        ['CODEMAN_ATTACHMENT_CONFINE', saved.confine],
        ['CODEMAN_ATTACHMENT_BLOCKED_PATHS', saved.blocked],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    it('mints for a page under the attachment guard', async () => {
      expect((await open(join(outsideDir, 'report.html'))).statusCode).toBe(200);
    });

    it('refuses a page in a blocked tree', async () => {
      process.env.CODEMAN_ATTACHMENT_BLOCKED_PATHS = outsideDir;
      expect((await open(join(outsideDir, 'report.html'))).statusCode).toBe(403);
    });

    it('refuses every out-of-workspace page when attachments are confined to the workspace', async () => {
      process.env.CODEMAN_ATTACHMENT_CONFINE = '1';
      expect((await open(join(outsideDir, 'report.html'))).statusCode).toBe(403);
      // The workspace itself is still fine.
      expect((await open(join(workspace, 'index.html'))).statusCode).toBe(200);
    });
  });

  it('refuses an HTML file inside a hidden directory, in or out of the workspace', async () => {
    mkdirSync(join(workspace, '.cache'));
    writeFileSync(join(workspace, '.cache', 'r.html'), '<p>r</p>');
    writeFileSync(join(workspace, '.cache', 'token.json'), '{}');
    expect((await open(join(workspace, '.cache', 'r.html'))).statusCode).toBe(403);
    mkdirSync(join(root, '.hidden'));
    writeFileSync(join(root, '.hidden', 'r.html'), '<p>r</p>');
    expect((await open(join(root, '.hidden', 'r.html'))).statusCode).toBe(403);
  });

  it('treats the filesystem root, home and the temp dir as too broad to serve', () => {
    expect(isBroadHtmlViewRoot('/')).toBe(true);
    expect(isBroadHtmlViewRoot(homedir())).toBe(true);
    expect(isBroadHtmlViewRoot(tmpdir())).toBe(true);
    expect(isBroadHtmlViewRoot(workspace)).toBe(false);
  });

  it('refuses a page sitting directly in the temp dir', async () => {
    const page = join(tmpdir(), `html-view-broad-${process.pid}.html`);
    writeFileSync(page, '<p>broad</p>');
    try {
      expect((await open(page)).statusCode).toBe(403);
    } finally {
      rmSync(page, { force: true });
    }
  });
});
