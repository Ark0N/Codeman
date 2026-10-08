/**
 * @fileoverview Static guard: a test builds `WebServer` on an ephemeral port.
 *
 * A fixed port is a red suite on any machine where something else holds it, and a
 * collision between two runs on one host (two worktrees, or CI plus a local run): the
 * suite runs files serially (`fileParallelism: false`), so the four port pairs #440
 * found never met inside one run, only across runs. `new WebServer(0, …)` binds
 * whatever the OS hands out and `boundPort` reads it back, so there is nothing left
 * to collide on.
 *
 * A WebServer built under test/ whose port argument is not the literal `0` fails —
 * `new WebServer(…)`, a class declared `extends WebServer`, or a destructured alias
 * (`{ WebServer: T }`) — unless the file is in LEGACY_FIXED_PORT_FILES, the files that
 * construct one with a non-zero port today (a few never call `start()`); the follow-up
 * sweep converts them. A converted file cannot stay listed: an entry whose file no
 * longer matches fails too.
 *
 * Not covered: a helper that takes the port as a parameter is checked at the helper,
 * not at its callers (test/mobile/helpers/server.ts is listed, so the mobile tests
 * calling `createTestServer(PORT)` are not checked), `import { WebServer as X }`, and
 * `new mod.WebServer(…)`. Raw `listen({ port: N })` and `new WebSocketServer({ port: N })`
 * belong to the sweep.
 *
 * Port: N/A (pure static analysis).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TEST_ROOT = fileURLToPath(new URL('.', import.meta.url));

/** Predates the guard; converted in the follow-up sweep. Shrink only. */
const LEGACY_FIXED_PORT_FILES = new Set(
  [
    'admin-routes.test.ts',
    'base-path-server.test.ts',
    'capture-geometry-retry.browser.test.ts',
    'capture-load-window.browser.test.ts',
    'case-custom-path.browser.test.ts',
    'doctor-settings.browser.test.ts',
    'edge-cases.test.ts',
    'file-link-click.test.ts',
    'git-status.browser.test.ts',
    'hooks-config.test.ts',
    'http-contract.test.ts',
    'inline-rename.test.ts',
    'integration-flows.test.ts',
    'key-tester.browser.test.ts',
    'mobile/helpers/server.ts',
    'opencode-resize.test.ts',
    'operation-lightspeed.test.ts',
    'ownership-scoping.test.ts',
    'pane-exit-sweep.test.ts',
    'paste-image-dir-shared.test.ts',
    'perf-browser.test.ts',
    'quick-start.test.ts',
    'ralph-integration.test.ts',
    'scheduled-runs.test.ts',
    'security-regression.test.ts',
    'session-cleanup.test.ts',
    'session-pane-exit.test.ts',
    'session.test.ts',
    'shift-enter-keypress.browser.test.ts',
    'split-pane-auto-collapse.browser.test.ts',
    'split-pane-orchestration.browser.test.ts',
    'split-pane-terminal.browser.test.ts',
    'sse-cors-headers.test.ts',
    'sse-events.test.ts',
    'sse-routing-remote.test.ts',
    'sse-subscription-filter.test.ts',
    'static-cache-headers.test.ts',
    'terminal-copy-shortcut.test.ts',
    'terminal-keycode229-recovery.browser.test.ts',
    'webgl-fallback.test.ts',
    'webhook-settings.browser.test.ts',
    'webview-lost-root-frame.test.ts',
    'webview-sse.test.ts',
  ].map((p) => p.split('/').join(sep))
);

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

const SELF = fileURLToPath(import.meta.url);
const scanned = testFiles(TEST_ROOT)
  .filter((f) => f !== SELF)
  .map((file) => ({ rel: relative(TEST_ROOT, file), args: webServerPortArgs(readFileSync(file, 'utf8')) }));
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

  it('no test outside the legacy list builds WebServer on a fixed port', () => {
    const offenders = scanned
      .filter((f) => fixed(f.args) && !LEGACY_FIXED_PORT_FILES.has(f.rel))
      .map(
        (f) =>
          `${f.rel}: new WebServer(${f.args.find((a) => a !== '0')}, …) — use new WebServer(0, …) and server.boundPort`
      );
    expect(offenders).toEqual([]);
  });

  it('the legacy list only names files that still need converting', () => {
    const stale = [...LEGACY_FIXED_PORT_FILES].filter((rel) => !scanned.some((f) => f.rel === rel && fixed(f.args)));
    expect(stale).toEqual([]);
  });
});
