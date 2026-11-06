/**
 * @fileoverview Tests for html-view-routes: rendering a local HTML file as a page.
 *
 * Real files in a temp dir (no fs mocks): the point of the route is its path
 * policy, and a mocked realpath would make every containment check pass.
 * Port: N/A (app.inject doesn't open ports)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import Fastify from 'fastify';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { HTML_VIEW_CSP, isBroadHtmlViewRoot, registerHtmlViewRoutes } from '../../src/web/routes/html-view-routes.js';
import { registerSecurityHeaders } from '../../src/web/middleware/auth.js';
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

  it('expands a ~/ path against this host home, as the attachment route does', async () => {
    // test/setup.ts points HOME at a temp dir, so this never touches the real home.
    // The terminal passes a `~/` link through unchanged; only the server knows the home.
    const site = join(homedir(), 'html-view-tilde', 'site');
    mkdirSync(site, { recursive: true });
    writeFileSync(join(site, 'page.html'), '<h1>home</h1>');
    try {
      const res = await open('~/html-view-tilde/site/page.html');
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).data.url).toMatch(/^\/html-view\/[A-Za-z0-9_-]{16,}\/page\.html$/);
      // A Docker case's `~` is the container's home, never this host's.
      (harness.ctx.sessions.get(sid) as { docker?: unknown }).docker = { caseName: 'c' };
      expect((await open('~/html-view-tilde/site/page.html')).statusCode).toBe(400);
    } finally {
      rmSync(join(homedir(), 'html-view-tilde'), { recursive: true, force: true });
    }
  });

  it('validates the body', async () => {
    const post = (payload: unknown) =>
      harness.app.inject({ method: 'POST', url: `/api/sessions/${sid}/html-view`, payload: payload as object });
    for (const payload of [{}, { path: '' }, { path: 42 }, { path: 'a\nb.html' }, { path: 'index.html', extra: 1 }]) {
      const res = await post(payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(JSON.parse(res.body).success).toBe(false);
    }
    expect(JSON.parse((await post({})).body).error).toBe('Missing path parameter');
  });

  it('refuses non-HTML files and missing files', async () => {
    expect((await open(join(workspace, 'data.json'))).statusCode).toBe(400);
    expect((await open(join(workspace, 'missing.html'))).statusCode).toBe(404);
    // An .html name that links to something else is judged by its target.
    symlinkSync(join(workspace, 'data.json'), join(workspace, 'data.html'));
    expect((await open(join(workspace, 'data.html'))).statusCode).toBe(400);
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

  it("serves exactly the sandbox CSP with open network, replacing Codeman's own policy (owner decision)", async () => {
    // Owner decision 2026-10-13 (#547): a rendered page reaches the network like a
    // file opened from disk, so the policy is the `sandbox` directive alone. Built
    // with Codeman's own security headers registered first, as in production, to
    // prove their `default-src 'self'` policy does not survive onto the page.
    const app = Fastify({ logger: false });
    registerSecurityHeaders(app, false);
    registerHtmlViewRoutes(app, harness.ctx as unknown as Parameters<typeof registerHtmlViewRoutes>[1]);
    await app.ready();
    try {
      const cap = htmlViewCapabilities.mint(realpathSync(workspace));
      for (const file of ['index.html', 'data.json']) {
        const res = await app.inject({ method: 'GET', url: `/html-view/${cap}/${file}` });
        expect(res.statusCode, file).toBe(200);
        const csp = res.headers['content-security-policy'];
        // One header, this exact value.
        expect(csp, file).toBe(HTML_VIEW_CSP);
        expect(HTML_VIEW_CSP).toBe('sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads');
        const directives = String(csp)
          .split(';')
          .map((d) => d.trim().split(/\s+/)[0])
          .filter(Boolean);
        // Sandboxed, never same-origin...
        expect(directives).toEqual(['sandbox']);
        expect(String(csp)).not.toContain('allow-same-origin');
        // ...and no fetch directive anywhere: the network is not restricted.
        expect(String(csp)).not.toMatch(/-src\b/);
      }
    } finally {
      await app.close();
    }
  });

  it('answers Range requests, so a page can seek its own media', async () => {
    writeFileSync(join(workspace, 'clip.mp4'), '0123456789');
    const base = (await openUrl()).replace(/index\.html$/, '');
    const full = await harness.app.inject({ method: 'GET', url: `${base}clip.mp4` });
    expect(full.statusCode).toBe(200);
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(full.headers['content-length']).toBe('10');

    const part = await harness.app.inject({ method: 'GET', url: `${base}clip.mp4`, headers: { range: 'bytes=2-5' } });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 2-5/10');
    expect(part.body).toBe('2345');
    // Every header the route sets survives the hijacked body sender.
    expect(part.headers['content-type']).toBe('video/mp4');
    expect(String(part.headers['content-security-policy'])).toMatch(/^sandbox /);
    expect(part.headers['access-control-allow-origin']).toBe('*');
    expect(part.headers['cache-control']).toBe('no-store');

    const beyond = await harness.app.inject({ method: 'GET', url: `${base}clip.mp4`, headers: { range: 'bytes=50-' } });
    expect(beyond.statusCode).toBe(416);
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

  it('applies the dot and extension rules to where a symlink lands, not only to its name', async () => {
    mkdirSync(join(workspace, '.git'));
    writeFileSync(join(workspace, '.git', 'config'), '[remote "origin"]');
    symlinkSync(join(workspace, '.git', 'config'), join(workspace, 'cfg.json'));
    symlinkSync(join(workspace, 'notes.sh'), join(workspace, 'notes.css'));
    // A link that stays inside the folder and lands on an asset still works.
    symlinkSync(join(workspace, 'data.json'), join(workspace, 'latest.json'));
    const base = (await openUrl()).replace(/index\.html$/, '');
    expect((await harness.app.inject({ method: 'GET', url: `${base}cfg.json` })).statusCode).toBe(404);
    expect((await harness.app.inject({ method: 'GET', url: `${base}notes.css` })).statusCode).toBe(404);
    const ok = await harness.app.inject({ method: 'GET', url: `${base}latest.json` });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toContain('application/json');
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

    it('stops serving an out-of-workspace page once confinement is switched on', async () => {
      const res = await open(join(outsideDir, 'report.html'));
      expect(res.statusCode).toBe(200);
      const url = JSON.parse(res.body).data.url as string;
      expect((await harness.app.inject({ method: 'GET', url })).statusCode).toBe(200);
      const inside = await openUrl();

      process.env.CODEMAN_ATTACHMENT_CONFINE = '1';
      expect((await harness.app.inject({ method: 'GET', url })).statusCode).toBe(404);
      // A page minted from inside the workspace is not affected.
      expect((await harness.app.inject({ method: 'GET', url: inside })).statusCode).toBe(200);
    });

    it('never reuses an in-workspace capability for the same folder minted from outside', () => {
      const inside = htmlViewCapabilities.mint(outsideDir, undefined, false);
      const outside = htmlViewCapabilities.mint(outsideDir, undefined, true);
      expect(outside).not.toBe(inside);
      expect(htmlViewCapabilities.resolve(outside)?.outsideWorkspace).toBe(true);
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

  it('renders a page in a workspace that itself lives under a hidden folder', async () => {
    const hiddenWorkspace = join(root, '.local', 'src', 'app');
    mkdirSync(join(hiddenWorkspace, 'report'), { recursive: true });
    writeFileSync(join(hiddenWorkspace, 'report', 'index.html'), '<p>r</p>');
    mkdirSync(join(hiddenWorkspace, '.cache'));
    writeFileSync(join(hiddenWorkspace, '.cache', 'r.html'), '<p>r</p>');
    (harness.ctx.sessions.get(sid) as { workingDir: string }).workingDir = hiddenWorkspace;

    const res = await open(join(hiddenWorkspace, 'report', 'index.html'));
    expect(res.statusCode).toBe(200);
    expect((await harness.app.inject({ method: 'GET', url: JSON.parse(res.body).data.url })).statusCode).toBe(200);
    // A hidden directory BELOW the workspace root is still refused.
    expect((await open(join(hiddenWorkspace, '.cache', 'r.html'))).statusCode).toBe(403);
  });

  it('treats the filesystem root, home and the temp dir as too broad to serve', () => {
    expect(isBroadHtmlViewRoot('/')).toBe(true);
    expect(isBroadHtmlViewRoot(homedir())).toBe(true);
    expect(isBroadHtmlViewRoot(tmpdir())).toBe(true);
    expect(isBroadHtmlViewRoot(workspace)).toBe(false);
  });

  it('treats /tmp, /var/tmp and every directory above a broad root as broad, whatever TMPDIR says', async () => {
    // macOS sets TMPDIR to a per-user /var/folders dir in every terminal, which
    // os.tmpdir() returns, so the literal shared temp dirs must not depend on it.
    const savedTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = join(root, 'private-tmp');
    mkdirSync(process.env.TMPDIR);
    const page = join('/tmp', `html-view-broad-literal-${process.pid}.html`);
    writeFileSync(page, '<p>broad</p>');
    try {
      expect(tmpdir()).toBe(process.env.TMPDIR);
      expect(isBroadHtmlViewRoot('/tmp')).toBe(true);
      expect(isBroadHtmlViewRoot('/var/tmp')).toBe(true);
      expect((await open(page)).statusCode).toBe(403);
    } finally {
      rmSync(page, { force: true });
      if (savedTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = savedTmpdir;
    }
    // Above the home directory (`/home`, `/Users`): serving it would serve home too.
    expect(isBroadHtmlViewRoot(join(homedir(), '..'))).toBe(true);
    // A drive's mount point and the mount parent itself.
    expect(isBroadHtmlViewRoot('/mnt')).toBe(true);
    expect(isBroadHtmlViewRoot('/mnt/d')).toBe(true);
    expect(isBroadHtmlViewRoot('/mnt/d/projects/report')).toBe(false);
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
