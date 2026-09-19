/**
 * Verifies that WebServer templates the `<title>` tag in the served
 * index.html with the hostname-aware `codeman:<host>` window title
 * (feature #82). The title must:
 *   - default to `codeman:<os.hostname()>` when no override is supplied
 *   - honor a custom `titleHostname` passed via the constructor (CLI flag
 *     `--title-hostname <host>` plumbs through to here)
 *   - HTML-escape the hostname so a value like `<script>foo</script>`
 *     can't break out of the title tag
 *   - replace the bare `<title>Codeman</title>` literal exactly once
 *   - leave the rest of the document byte-for-byte identical to the
 *     template on disk
 *
 * Strategy: construct WebServer with port 0 / testMode (no network
 * activity until start()) and call the private `renderIndexHtml()`
 * method directly. The Fastify `/` and `/index.html` route handlers
 * are one-liners that call exactly this method (server.ts:539-544),
 * so testing the render function covers both endpoints without
 * needing to listen on a port.
 *
 * Port: N/A (no server start)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname as osHostname, tmpdir } from 'node:os';
import { WebServer } from '../src/web/server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexHtmlPath = join(__dirname, '..', 'src', 'web', 'public', 'index.html');
const rawTemplate = readFileSync(indexHtmlPath, 'utf-8');

async function render(host?: string): Promise<string> {
  // 4th arg is the bind host; the title hostname is the 5th arg.
  const server = new WebServer(0, false, true, '127.0.0.1', host);
  // renderIndexHtml is async (it reads settings.json for the gesture bundle).
  return (server as unknown as { renderIndexHtml: () => Promise<string> }).renderIndexHtml();
}

describe('WebServer index.html <title> templating (#82)', () => {
  // renderIndexHtml reads the ambient settings.json (for the gesture bundle and
  // the header-toggle marker-class strips, e.g. showPlanUsageLimits /
  // showMultiMonitorButton). Point it at an empty data dir so this test is
  // deterministic regardless of the developer's real settings — otherwise an
  // enabled toggle would strip a marker class and break the byte-identical
  // assertion below. getDataDir() reads CODEMAN_DATA_DIR fresh per call.
  const _prevDataDir = process.env.CODEMAN_DATA_DIR;
  beforeAll(() => {
    process.env.CODEMAN_DATA_DIR = mkdtempSync(join(tmpdir(), 'codeman-title-test-'));
  });
  afterAll(() => {
    if (_prevDataDir === undefined) delete process.env.CODEMAN_DATA_DIR;
    else process.env.CODEMAN_DATA_DIR = _prevDataDir;
  });

  it('substitutes the bare <title>Codeman</title> with codeman:<host>', async () => {
    const html = await render('laptop');
    expect(html).toContain('<title>codeman:laptop</title>');
    expect(html).not.toContain('<title>Codeman</title>');
  });

  it('defaults to os.hostname() when no titleHostname is supplied', async () => {
    const html = await render();
    const expected = `<title>codeman:${osHostname()}</title>`;
    expect(html).toContain(expected);
  });

  it('treats an empty-string titleHostname as "not supplied" and falls back to os.hostname()', async () => {
    // CLI normally guarantees a non-empty string, but the constructor's
    // `titleHostname || getHostname()` guard makes empty fall through —
    // pin that behavior so a future refactor doesn't accidentally ship
    // a `<title>codeman:</title>` to users.
    const html = await render('');
    expect(html).toMatch(/<title>codeman:.+<\/title>/);
    expect(html).not.toContain('<title>codeman:</title>');
  });

  it('HTML-escapes < > & in the hostname so it cannot break out of the title tag', async () => {
    const html = await render('<script>alert(1)</script>');
    expect(html).toContain('<title>codeman:&lt;script&gt;alert(1)&lt;/script&gt;</title>');
    // The raw closing </title> from the injected payload must NOT appear
    // outside the actual title element — escape-then-substitute prevents
    // an attacker-controlled hostname from terminating the tag early.
    expect(html).not.toContain('<script>alert(1)</script></title>');
  });

  it('escapes an ampersand without double-encoding existing entities', async () => {
    // The escaper replaces & first, then < and >. A hostname that already
    // contains a literal `&` should render as `&amp;` once, not `&amp;amp;`.
    const html = await render('a&b');
    expect(html).toContain('<title>codeman:a&amp;b</title>');
    expect(html).not.toContain('&amp;amp;');
  });

  it('only substitutes the <title> tag — the rest of the template is identical (modulo asset cache-busting)', async () => {
    // renderIndexHtml also appends ?v=<mtime> cache-bust params to same-origin
    // .js/.css refs, and injects the CLI-availability flags, the custom-model
    // Run-menu picker's CLI list, and the general run-menu CLI catalogue (PR B2)
    // before </head>; strip all so the title remains the only other change.
    //
    // The flag strips are what keep this test environment-independent. The
    // CLI-availability one used to pass here by luck: that script was injected
    // only where a CLI resolved, so the assertion held on a machine with none
    // installed and would have failed on a developer's box that had them. The
    // custom-model list is injected unconditionally (a plain array, possibly
    // empty), so it needs stripping on every machine, not just where non-empty.
    const html = (await render('laptop'))
      .replace(/(\.(?:js|css))\?v=[^"]*/g, '$1')
      .replace(/<script>window\.__codemanCliAvailable=\{.*?\};<\/script>\n/, '')
      .replace(/<script>window\.__codemanCustomModelClis=\[.*?\];<\/script>\n/, '')
      .replace(/<script>window\.__codemanCliCatalog=\[.*?\];<\/script>\n/, '');
    const beforeTitle = rawTemplate.split('<title>Codeman</title>')[0];
    const afterTitle = rawTemplate.split('<title>Codeman</title>')[1];
    expect(html.startsWith(beforeTitle)).toBe(true);
    expect(html.endsWith(afterTitle)).toBe(true);
    // Sanity check: length differs only by the title swap.
    const expectedDelta = `<title>codeman:laptop</title>`.length - `<title>Codeman</title>`.length;
    expect(html.length - rawTemplate.length).toBe(expectedDelta);
  });

  it('replaces the <title> placeholder exactly once', async () => {
    const html = await render('laptop');
    // Defense against a future regression where the template gains a
    // second `<title>Codeman</title>` (e.g. inside a <noscript>) and only
    // the first gets templated — would leave a stale literal in the served
    // HTML that overrides the correct one in some renderers.
    const occurrencesOfNew = html.split('<title>codeman:laptop</title>').length - 1;
    const occurrencesOfOld = html.split('<title>Codeman</title>').length - 1;
    expect(occurrencesOfNew).toBe(1);
    expect(occurrencesOfOld).toBe(0);
  });

  it('two WebServer instances on different hostnames render distinct titles', async () => {
    const htmlA = await render('host-a');
    const htmlB = await render('host-b');
    expect(htmlA).toContain('<title>codeman:host-a</title>');
    expect(htmlB).toContain('<title>codeman:host-b</title>');
    expect(htmlA).not.toContain('host-b');
    expect(htmlB).not.toContain('host-a');
  });
});
