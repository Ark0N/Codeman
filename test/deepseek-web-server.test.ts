/**
 * The background `dsh web` supervisor and the authority boundary in front of it.
 *
 * Two things here are worth pinning and neither is obvious from reading the
 * module:
 *
 * 1. `authority` becomes an argv element of a spawned process (`--trusted-host
 *    <authority>`). The spawn is an argv ARRAY so a shell can never see it, but
 *    the schema is the layer that stops a value which is not a browser
 *    authority at all from reaching the command line, and a regex is easy to
 *    widen by accident.
 * 2. The supervisor tracks at most ONE server. The status accessor is what every
 *    caller reads to decide whether to start another, so "no server" must report
 *    as absent rather than as a half-populated record.
 * 3. `dsh web` now gates its index behind a launch token it prints on boot. The
 *    supervisor is the only party that can trade it, and the cookie it produces
 *    is authority-bound: getting that wrong is a blank tab, not a visible error.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeepSeekWebStartSchema } from '../src/web/schemas.js';
import {
  getDeepSeekWebCookie,
  getDeepSeekWebStatus,
  parseLaunchUrl,
  resetDeepSeekWebForTest,
  startDeepSeekWeb,
  stopDeepSeekWeb,
} from '../src/deepseek-web-server.js';

describe('DeepSeekWebStartSchema: the authority reaching --trusted-host', () => {
  it('accepts the authority shapes a browser can actually report', () => {
    for (const authority of [
      'localhost:3000',
      '127.0.0.1:5013',
      'tnode.tailf80371.ts.net:8444',
      'codeman.example.com',
      '[::1]:3000',
      'host-with-dashes.local:80',
    ]) {
      expect(DeepSeekWebStartSchema.safeParse({ authority }).success, authority).toBe(true);
    }
  });

  it('rejects values that are not an authority at all', () => {
    for (const authority of [
      '',
      'http://localhost:3000', // a URL, not an authority
      'localhost:3000 --trusted-host evil', // an embedded second argument
      '-oProxyCommand=evil', // leading dash, readable as a flag
      'localhost:3000/../path',
      'local host:3000',
      'user:pass@localhost:3000',
      'a'.repeat(256),
    ]) {
      expect(DeepSeekWebStartSchema.safeParse({ authority }).success, authority).toBe(false);
    }
  });

  it('is strict, so an unexpected field cannot ride along', () => {
    expect(DeepSeekWebStartSchema.safeParse({ authority: 'localhost:3000', port: 1 }).success).toBe(false);
  });

  it('requires the field rather than defaulting it', () => {
    // A guessed default would silently fence dsh's /api against the wrong
    // origin, which presents as a dashboard whose every call 403s.
    expect(DeepSeekWebStartSchema.safeParse({}).success).toBe(false);
  });
});

describe('DeepSeek web supervisor: status', () => {
  beforeEach(() => {
    resetDeepSeekWebForTest();
  });

  it('reports absent as fully null, not a half-filled record', () => {
    expect(getDeepSeekWebStatus()).toEqual({ running: false, port: null, url: null, authority: null });
  });

  it('stopping when nothing runs resolves rather than throwing', async () => {
    await expect(stopDeepSeekWeb()).resolves.toBeUndefined();
    expect(getDeepSeekWebStatus().running).toBe(false);
  });
});

describe('parseLaunchUrl: the one-time token dsh prints on boot', () => {
  it('pulls the URL out of the banner a real boot writes', () => {
    const output = ['dsh web: http://127.0.0.1:3080/?token=0Yb3sJk9Qm2xLd7Tf1Vc', 'ready'].join('\n');
    expect(parseLaunchUrl(output)).toBe('http://127.0.0.1:3080/?token=0Yb3sJk9Qm2xLd7Tf1Vc');
  });

  it('sees through SGR colouring, which would otherwise hide the token', () => {
    const output = '\u001b[36mdsh web:\u001b[0m \u001b[4mhttp://127.0.0.1:3080/?token=abc123\u001b[0m\n';
    expect(parseLaunchUrl(output)).toBe('http://127.0.0.1:3080/?token=abc123');
  });

  it('returns null for a token-less banner, which is the older dsh', () => {
    expect(parseLaunchUrl('dsh web: http://127.0.0.1:3080/\n')).toBeNull();
  });

  it('refuses anything that is not an http(s) URL carrying a token', () => {
    expect(parseLaunchUrl('')).toBeNull();
    expect(parseLaunchUrl('booting...')).toBeNull();
    expect(parseLaunchUrl('dsh web: javascript:alert(1)?token=x')).toBeNull();
    expect(parseLaunchUrl('dsh web: not a url?token=x')).toBeNull();
  });
});

describe('DeepSeek web supervisor: the launch-token cookie', () => {
  let dir: string;

  beforeEach(() => {
    resetDeepSeekWebForTest();
    dir = mkdtempSync(join(tmpdir(), 'codeman-dsh-web-'));
  });

  afterEach(async () => {
    await stopDeepSeekWeb();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A stand-in for `dsh web` with the browser-auth gate: prints the banner,
   * refuses `/` without a cookie, and trades the token for one 303.
   */
  const FAKE_DSH = `#!/usr/bin/env node
const http = require('node:http');
const portArg = process.argv.indexOf('--port');
const port = Number(process.argv[portArg + 1]);
const token = 'test-launch-token';
const cookie = 'dsh-auth-test=v1.payload.sig';
process.stdout.write('dsh web: http://127.0.0.1:' + port + '/?token=' + token + '\\n');
http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1:' + port);
    if (url.pathname === '/' && url.searchParams.get('token') === token) {
      res.writeHead(303, { location: './', 'set-cookie': cookie + '; Path=/; HttpOnly' });
      res.end();
      return;
    }
    if (req.headers.cookie === cookie) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>harness</title>');
      return;
    }
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('dsh web authentication required');
  })
  .listen(port, '127.0.0.1');
`;

  it('trades the boot token for the cookie, scoped to its own port', async () => {
    writeFileSync(join(dir, 'dsh'), FAKE_DSH, { mode: 0o755 });

    const result = await startDeepSeekWeb(dir, 'localhost:3000');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Before the exchange this page is exactly the blank tab being fixed: 401.
    expect((await fetch(`http://127.0.0.1:${result.port}/`)).status).toBe(401);

    expect(getDeepSeekWebCookie(result.port)).toBe('dsh-auth-test=v1.payload.sig');
    // A credential minted for this authority must never travel to another port.
    expect(getDeepSeekWebCookie(result.port + 1)).toBeNull();

    const authed = await fetch(`http://127.0.0.1:${result.port}/`, {
      headers: { cookie: getDeepSeekWebCookie(result.port) as string },
    });
    expect(authed.status).toBe(200);
  }, 20_000);

  // `managed` is a client-supplied field and the port is published by
  // GET /api/deepseek/web, so the supervisor additionally binds the cookie to the
  // identity whose request started the process: another user's tab must not be
  // handed it, and their POST must not reuse bob's server either.
  it('hands the cookie only to the identity that started the server', async () => {
    writeFileSync(join(dir, 'dsh'), FAKE_DSH, { mode: 0o755 });

    const bob = await startDeepSeekWeb(dir, 'localhost:3000', 'bob');
    expect(bob.ok).toBe(true);
    if (!bob.ok) return;
    expect(getDeepSeekWebCookie(bob.port, 'bob')).toBe('dsh-auth-test=v1.payload.sig');
    expect(getDeepSeekWebCookie(bob.port)).toBeNull();
    expect(getDeepSeekWebCookie(bob.port, 'alice')).toBeNull();

    // A different owner restarts rather than reusing bob's cookie.
    const alice = await startDeepSeekWeb(dir, 'localhost:3000', 'alice');
    expect(alice.ok).toBe(true);
    if (!alice.ok) return;
    expect(alice.reused).toBe(false);
    expect(getDeepSeekWebCookie(alice.port, 'alice')).toBe('dsh-auth-test=v1.payload.sig');
    expect(getDeepSeekWebCookie(alice.port, 'bob')).toBeNull();
  }, 20_000);

  it('leaves the old, ungated dsh working: no token means no cookie, not a failure', async () => {
    writeFileSync(
      join(dir, 'dsh'),
      '#!/usr/bin/env node\nconst http = require("node:http");\nconst port = Number(process.argv[process.argv.indexOf("--port") + 1]);\nprocess.stdout.write("dsh web: http://127.0.0.1:" + port + "/\\n");\nhttp.createServer((_q, s) => s.end("ok")).listen(port, "127.0.0.1");\n',
      { mode: 0o755 }
    );

    const result = await startDeepSeekWeb(dir, 'localhost:3000');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(getDeepSeekWebCookie(result.port)).toBeNull();
  }, 20_000);

  // The error-tail buffer is capped at 16 KB, and a chatty plugin tree can fill
  // it before dsh prints its banner. Scanning that buffer alone lost the token
  // and put the tab back on the 401 page, so the banner is matched on its own
  // (larger) budget.
  it('still finds a banner printed after more than the error-tail cap', async () => {
    writeFileSync(
      join(dir, 'dsh'),
      `#!/usr/bin/env node
const http = require('node:http');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const token = 'late-banner-token';
const cookie = 'dsh-auth-late=v1.sig';
process.stdout.write('warn: plugin noise '.repeat(1100) + '\\n');
http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1:' + port);
    if (url.searchParams.get('token') === token) {
      res.writeHead(303, { location: './', 'set-cookie': cookie + '; Path=/' });
      res.end();
      return;
    }
    if (req.headers.cookie === cookie) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>ok</html>');
      return;
    }
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('dsh web authentication required');
  })
  .listen(port, '127.0.0.1');
setTimeout(() => process.stdout.write('dsh web: http://127.0.0.1:' + port + '/?token=' + token + '\\n'), 300);
`,
      { mode: 0o755 }
    );

    const result = await startDeepSeekWeb(dir, 'localhost:3000');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(getDeepSeekWebCookie(result.port)).toBe('dsh-auth-late=v1.sig');
  }, 20_000);
});
