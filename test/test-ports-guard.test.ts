/**
 * @fileoverview Static guard: a test binds an ephemeral port.
 *
 * A fixed port is a red suite on any machine where something else holds it, and a
 * collision between two runs on one host (two worktrees, or CI plus a local run): the
 * suite runs files serially (`fileParallelism: false`), so the port pairs #440 found
 * never met inside one run, only across runs. Binding port 0 takes whatever the OS
 * hands out, so there is nothing left to collide on.
 *
 * Two rules, both over every file under test/:
 * - A `WebServer` is built with the literal `0` as its port — `new WebServer(…)`, a
 *   class declared `extends WebServer`, or a destructured alias (`{ WebServer: T }`).
 *   The test then reads `server.boundPort`, which this guard does not check.
 * - A raw server (`http`/`net`/Fastify `listen`, `new WebSocketServer`) never listens
 *   on a number or a `…PORT` constant: `listen(0, …)` / `{ port: 0 }`, then
 *   `address().port`.
 *
 * Not covered: a helper that takes the port as a parameter is checked at the helper,
 * not at its callers; `import { WebServer as X }`; `new mod.WebServer(…)`; a port held
 * in a variable that is not named `…PORT`.
 *
 * Port: N/A (pure static analysis).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TEST_ROOT = fileURLToPath(new URL('.', import.meta.url));

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== 'node_modules') out.push(...testFiles(full));
    } else if (name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * First argument of every `new WebServer(` in `source`, trimmed (may span lines) — and of
 * every `new X(` where the same file makes X a WebServer: `class X extends WebServer`, or
 * a destructured alias `{ WebServer: X }` (how `quick-start.test.ts` builds its server).
 */
function webServerPortArgs(source: string): string[] {
  const classes = [
    'WebServer',
    ...[...source.matchAll(/class\s+(\w+)\s+extends\s+WebServer\b/g)].map((m) => m[1]),
    ...[...source.matchAll(/\bWebServer\s*:\s*(\w+)/g)].map((m) => m[1]),
  ];
  return classes.flatMap((name) =>
    [...source.matchAll(new RegExp(`new ${name}\\(\\s*([^,)]*)`, 'g'))].map((m) => m[1].trim())
  );
}

/** A fixed port as a reader would see it: a non-zero number, or a constant named `…PORT`. */
const FIXED_PORT = /^(?:[1-9]\d*|[A-Z_]*PORT)$/;

/**
 * Fixed ports handed to a raw server in `source`: the first argument of `.listen(…)`,
 * and `port:` inside `.listen({ … })` or `new WebSocketServer({ … })`. A socket path or
 * `0` is fine; so is anything held in a lower-case variable (see the header).
 */
function rawListenerFixedPorts(source: string): string[] {
  const firstArgs = [...source.matchAll(/\.listen\(\s*([^,){\s]+)/g)].map((m) => m[1]);
  const options = [...source.matchAll(/(?:\.listen|new WebSocketServer)\(\s*\{[^}]*?\bport\s*:\s*([^,}\s]+)/g)].map(
    (m) => m[1]
  );
  return [...firstArgs, ...options].filter((arg) => FIXED_PORT.test(arg));
}

const SELF = fileURLToPath(import.meta.url);
const scanned = testFiles(TEST_ROOT)
  .filter((f) => f !== SELF)
  .map((file) => {
    const source = readFileSync(file, 'utf8');
    return { rel: relative(TEST_ROOT, file), args: webServerPortArgs(source), raw: rawListenerFixedPorts(source) };
  });
const fixed = (args: string[]) => args.some((a) => a !== '0');

describe('test servers bind an ephemeral port', () => {
  it('reads the first argument the way a reader would', () => {
    expect(webServerPortArgs('new WebServer(0, false, true)')).toEqual(['0']);
    expect(webServerPortArgs('new WebServer(\n    PORT,\n    false)')).toEqual(['PORT']);
    expect(webServerPortArgs('new WebServer(3162, false)')).toEqual(['3162']);
    expect(webServerPortArgs('new WebServer()')).toEqual(['']);
    expect(webServerPortArgs('class T extends WebServer {}\nconst s = new T(3299, false);')).toEqual(['3299']);
    expect(webServerPortArgs('const { WebServer: T } = mod;\nreturn new T(port, false);')).toEqual(['port']);
  });

  it('reads raw listeners the way a reader would', () => {
    expect(rawListenerFixedPorts("server.listen(0, '127.0.0.1', done)")).toEqual([]);
    expect(rawListenerFixedPorts("server.listen(PORT, '127.0.0.1', done)")).toEqual(['PORT']);
    expect(rawListenerFixedPorts('srv.listen(3216)')).toEqual(['3216']);
    expect(rawListenerFixedPorts("await app.listen({ port: TEST_PORT, host: '127.0.0.1' })")).toEqual(['TEST_PORT']);
    expect(rawListenerFixedPorts("await app.listen({ port: 0, host: '127.0.0.1' })")).toEqual([]);
    expect(rawListenerFixedPorts('new WebSocketServer({ port: 8081 })')).toEqual(['8081']);
    expect(rawListenerFixedPorts('net.createServer().listen(socketPath)')).toEqual([]);
  });

  it('no test builds WebServer on a fixed port', () => {
    const offenders = scanned
      .filter((f) => fixed(f.args))
      .map(
        (f) =>
          `${f.rel}: new WebServer(${f.args.find((a) => a !== '0')}, …) — use new WebServer(0, …) and server.boundPort`
      );
    expect(offenders).toEqual([]);
  });

  it('no test listens on a fixed port', () => {
    const offenders = scanned
      .filter((f) => f.raw.length > 0)
      .map((f) => `${f.rel}: listens on ${f.raw.join(', ')} — listen on 0 and read address().port`);
    expect(offenders).toEqual([]);
  });
});
