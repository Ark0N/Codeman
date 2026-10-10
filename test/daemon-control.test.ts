/**
 * Unit tests for the pure halves of daemon-control (issue #231): argv rebuilding,
 * the readiness URL, pidfile parsing, the stale-pid identity check, and the
 * `/api/status` probe against a real socket.
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  buildBaseUrl,
  buildStatusUrl,
  buildWebArgs,
  isProcessAlive,
  looksLikeCodemanWeb,
  parsePidFileContents,
  probeServer,
} from '../src/daemon-control.js';

/**
 * A port nothing listens on: bind 0, read what the OS handed out, close. Free at the
 * moment of use, unlike "the server's port + 1", which anything may hold.
 */
async function closedPort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port: free } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return free;
}

describe('buildWebArgs', () => {
  it('always passes host and port through explicitly', () => {
    expect(buildWebArgs({ host: '127.0.0.1', port: 3000, https: false })).toEqual([
      'web',
      '--host',
      '127.0.0.1',
      '--port',
      '3000',
    ]);
  });

  it('forwards every optional flag it was given', () => {
    const args = buildWebArgs({
      host: '0.0.0.0',
      port: 8080,
      https: true,
      titleHostname: 'tower',
      allowUnauthenticatedNetwork: true,
      multiuser: true,
    });
    expect(args).toEqual([
      'web',
      '--host',
      '0.0.0.0',
      '--port',
      '8080',
      '--https',
      '--title-hostname',
      'tower',
      '--allow-unauthenticated-network',
      '--multiuser',
    ]);
  });

  it('forwards --base-url so a detached/service relaunch keeps the mount prefix', () => {
    const args = buildWebArgs({ host: '127.0.0.1', port: 3000, https: false, basePath: '/codeman' });
    expect(args).toContain('--base-url');
    expect(args[args.indexOf('--base-url') + 1]).toBe('/codeman');
  });

  it('omits --base-url at root (empty basePath)', () => {
    expect(buildWebArgs({ host: '127.0.0.1', port: 3000, https: false, basePath: '' })).not.toContain('--base-url');
  });

  it('never re-emits the daemon flags themselves (the child must not re-fork)', () => {
    const args = buildWebArgs({ host: '127.0.0.1', port: 3000, https: false });
    expect(args).not.toContain('--daemon');
    expect(args).not.toContain('-d');
  });
});

describe('buildBaseUrl', () => {
  it('is the address a browser can open, with no path on it', () => {
    expect(buildBaseUrl({ host: '127.0.0.1', port: 3000, https: false })).toBe('http://127.0.0.1:3000');
    expect(buildBaseUrl({ host: '0.0.0.0', port: 8443, https: true })).toBe('https://127.0.0.1:8443');
  });
});

describe('buildStatusUrl', () => {
  it('uses http by default and https when asked', () => {
    expect(buildStatusUrl({ host: '127.0.0.1', port: 3000, https: false })).toBe('http://127.0.0.1:3000/api/status');
    expect(buildStatusUrl({ host: '127.0.0.1', port: 3000, https: true })).toBe('https://127.0.0.1:3000/api/status');
  });

  it('rewrites wildcard binds to loopback, since they are not connectable', () => {
    expect(buildStatusUrl({ host: '0.0.0.0', port: 3000, https: false })).toBe('http://127.0.0.1:3000/api/status');
    expect(buildStatusUrl({ host: '::', port: 3000, https: false })).toBe('http://127.0.0.1:3000/api/status');
  });

  it('brackets a bare IPv6 literal', () => {
    expect(buildStatusUrl({ host: '::1', port: 3000, https: false })).toBe('http://[::1]:3000/api/status');
    expect(buildStatusUrl({ host: '[::1]', port: 3000, https: false })).toBe('http://[::1]:3000/api/status');
  });
});

describe('parsePidFileContents', () => {
  it('accepts a plain pid with surrounding whitespace', () => {
    expect(parsePidFileContents('4242\n')).toBe(4242);
    expect(parsePidFileContents('  4242  ')).toBe(4242);
  });

  it('rejects garbage, empties and floats', () => {
    expect(parsePidFileContents('')).toBeNull();
    expect(parsePidFileContents('not a pid')).toBeNull();
    expect(parsePidFileContents('42.5')).toBeNull();
    expect(parsePidFileContents('-42')).toBeNull();
  });

  it('rejects pid 0 and pid 1: neither is ever our server', () => {
    expect(parsePidFileContents('0')).toBeNull();
    expect(parsePidFileContents('1')).toBeNull();
  });
});

describe('looksLikeCodemanWeb', () => {
  it('matches the ways the server is actually launched', () => {
    expect(looksLikeCodemanWeb('/usr/bin/node /home/u/.codeman/app/dist/index.js web')).toBe(true);
    expect(looksLikeCodemanWeb('/usr/bin/node dist/index.js web --https')).toBe(true);
    expect(looksLikeCodemanWeb('node /repo/src/index.ts web --port 3000')).toBe(true);
    expect(looksLikeCodemanWeb('/opt/homebrew/bin/codeman web')).toBe(true);
    expect(looksLikeCodemanWeb('aicodeman web --host 0.0.0.0')).toBe(true);
  });

  it('rejects anything that inherited a recycled pid', () => {
    expect(looksLikeCodemanWeb(null)).toBe(false);
    expect(looksLikeCodemanWeb('')).toBe(false);
    expect(looksLikeCodemanWeb('/usr/bin/node dist/index.js session list')).toBe(false);
    expect(looksLikeCodemanWeb('vim web')).toBe(false);
    expect(looksLikeCodemanWeb('/usr/lib/systemd/systemd --user')).toBe(false);
  });
});

describe('isProcessAlive', () => {
  it('sees this very process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('does not see an unused high pid', () => {
    // 2^22 is above the default pid_max on Linux and macOS.
    expect(isProcessAlive(4_194_303)).toBe(false);
  });
});

describe('probeServer', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/unauthorized') {
        res.writeHead(401).end('Unauthorized');
        return;
      }
      if (req.url === '/foreign') {
        res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>some other app</html>');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: { version: '9.9.9' } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('reports up and reads the version back', async () => {
    const result = await probeServer(`http://127.0.0.1:${port}/api/status`);
    expect(result.up).toBe(true);
    expect(result.version).toBe('9.9.9');
  });

  it('counts a 401 as up, because auth being active proves a server is there', async () => {
    const result = await probeServer(`http://127.0.0.1:${port}/unauthorized`);
    expect(result.up).toBe(true);
  });

  it('does not mistake an unrelated service squatting on the port for Codeman', async () => {
    const result = await probeServer(`http://127.0.0.1:${port}/foreign`);
    expect(result.up).toBe(false);
  });

  it('reports down when nothing is listening', async () => {
    const result = await probeServer(`http://127.0.0.1:${await closedPort()}/api/status`, 1000);
    expect(result.up).toBe(false);
  });

  it('reports down for a malformed url instead of throwing', async () => {
    const result = await probeServer('not-a-url');
    expect(result.up).toBe(false);
  });
});
