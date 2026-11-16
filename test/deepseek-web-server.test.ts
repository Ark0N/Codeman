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
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { DeepSeekWebStartSchema } from '../src/web/schemas.js';
import {
  getDeepSeekWebCookie,
  getDeepSeekWebStatus,
  launchUrlTargetsServer,
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

  // dsh prints diagnostics under the same prefix before the banner. Taking the
  // FIRST match made the real URL invisible and boot gave up 4 seconds later.
  it('skips a diagnostic line and keeps scanning for the URL', () => {
    expect(parseLaunchUrl('dsh web: loading profiles\ndsh web: http://127.0.0.1:3080/?token=abc\n')).toBe(
      'http://127.0.0.1:3080/?token=abc'
    );
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

describe('launchUrlTargetsServer: the exchange must hit the spawned port', () => {
  it('accepts only 127.0.0.1 on the port that was just spawned', () => {
    expect(launchUrlTargetsServer('http://127.0.0.1:3080/?token=x', 3080)).toBe(true);
    expect(launchUrlTargetsServer('http://127.0.0.1:3081/?token=x', 3080)).toBe(false);
    expect(launchUrlTargetsServer('http://localhost:3080/?token=x', 3080)).toBe(false);
    expect(launchUrlTargetsServer('http://evil.example:3080/?token=x', 3080)).toBe(false);
    expect(launchUrlTargetsServer('not a url', 3080)).toBe(false);
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

  // A failed exchange leaves a server that answers 401 to everything. Reuse used
  // to hand that same server back on every POST, so the restart the warning asks
  // for could never happen. The next start request must perform it.
  it('restarts rather than reusing a server whose exchange failed', async () => {
    writeFileSync(
      join(dir, 'dsh'),
      `#!/usr/bin/env node
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const token = 'retry-token';
const cookie = 'dsh-auth-retry=v1.sig';
const marker = path.join(__dirname, '.exchange-failed');
const failedBefore = fs.existsSync(marker);
if (!failedBefore) fs.writeFileSync(marker, '1');
process.stdout.write('dsh web: http://127.0.0.1:' + port + '/?token=' + token + '\\n');
http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1:' + port);
    if (url.searchParams.get('token') === token) {
      if (!failedBefore) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('temporary failure');
        return;
      }
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
`,
      { mode: 0o755 }
    );

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const first = await startDeepSeekWeb(dir, 'localhost:3000');
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(getDeepSeekWebCookie(first.port)).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be exchanged'));
    } finally {
      warn.mockRestore();
    }

    const second = await startDeepSeekWeb(dir, 'localhost:3000');
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.reused).toBe(false);
    expect(getDeepSeekWebCookie(second.port)).toBe('dsh-auth-retry=v1.sig');

    // The recovered server is healthy again, so ordinary reuse resumes.
    const third = await startDeepSeekWeb(dir, 'localhost:3000');
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(third.reused).toBe(true);
  }, 20_000);

  // The exchange is a request made by the SERVER. A banner naming another local
  // port would let captured child output aim it, so the URL is judged before it
  // is fetched at all.
  it('does not fetch a banner naming another port', async () => {
    const hits: string[] = [];
    const target = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('should never be reached');
    });
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    const address = target.address();
    if (!address || typeof address === 'string') throw new Error('target has no address');

    try {
      writeFileSync(
        join(dir, 'dsh'),
        `#!/usr/bin/env node
const http = require('node:http');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
process.stdout.write('dsh web: http://127.0.0.1:${address.port}/?token=stolen\\n');
http
  .createServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('dsh web authentication required');
  })
  .listen(port, '127.0.0.1');
`,
        { mode: 0o755 }
      );

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const result = await startDeepSeekWeb(dir, 'localhost:3000');
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(getDeepSeekWebCookie(result.port)).toBeNull();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('not fetching it'));
      } finally {
        warn.mockRestore();
      }
      expect(hits).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => target.close(() => resolve()));
    }
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
  // The banner can arrive in two stdout writes: `capture()` sees two chunks and
  // neither is a complete line. Scanning the raw buffer either missed it or, with
  // a partial URL that happened to parse, exchanged a truncated token.
  it('waits for a banner split across two output chunks', async () => {
    writeFileSync(
      join(dir, 'dsh'),
      `#!/usr/bin/env node
const http = require('node:http');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const token = 'split-token';
const cookie = 'dsh-auth-split=v1.sig';
process.stdout.write('dsh web: loading profiles\\n');
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
  .listen(port, '127.0.0.1', () => {
    const line = 'dsh web: http://127.0.0.1:' + port + '/?token=' + token + '\\n';
    process.stdout.write(line.slice(0, 30));
    setTimeout(() => process.stdout.write(line.slice(30)), 150);
  });
`,
      { mode: 0o755 }
    );

    const result = await startDeepSeekWeb(dir, 'localhost:3000');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(getDeepSeekWebCookie(result.port)).toBe('dsh-auth-split=v1.sig');
  }, 20_000);

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
