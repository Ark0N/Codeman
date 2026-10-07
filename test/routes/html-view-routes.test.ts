/**
 * @fileoverview Tests for html-view-routes: rendering a local HTML file as a page.
 *
 * Real files in a temp dir (no fs mocks): the point of the route is its path
 * policy, and a mocked realpath would make every containment check pass.
 * Port: N/A (app.inject doesn't open ports)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerHtmlViewRoutes } from '../../src/web/routes/html-view-routes.js';
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
});
