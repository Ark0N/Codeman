/**
 * WebServer.renderIndexHtml — server-side gating of the index shell:
 *  - multi-monitor button reveal (stable class-marker, not brittle copy match)
 *  - solo (/session/:id) global injection + escaping, and settings skipped
 *  - gesture overlay availability vs. enablement (CODEMAN_GESTURE + setting)
 *  - settings read FRESH so a post-save reload doesn't render stale state
 *
 * WebServer's constructor only assigns fields (no port bind), so we construct it
 * directly, swap in a tiny indexHtmlTemplate, and stub readSettings to avoid disk.
 *
 * Port: N/A (no server start).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { WebServer, escapeScriptJson } from '../src/web/server.js';
import { isClaudeAvailable } from '../src/utils/claude-cli-resolver.js';
import { isOpenCodeAvailable } from '../src/utils/opencode-cli-resolver.js';
import { isCodexAvailable } from '../src/utils/codex-cli-resolver.js';
import { isGeminiAvailable } from '../src/utils/gemini-cli-resolver.js';
import { isAntigravityAvailable } from '../src/utils/antigravity-cli-resolver.js';
import { isPiAvailable } from '../src/utils/pi-cli-resolver.js';
import { isGrokAvailable } from '../src/utils/grok-cli-resolver.js';
import { isDeepSeekAvailable, isDeepSeekRunnable } from '../src/utils/deepseek-cli-resolver.js';
import { isOmpAvailable } from '../src/utils/omp-cli-resolver.js';
import { isCloudflaredAvailable } from '../src/utils/cloudflared-resolver.js';
import { isGitAvailable } from '../src/git-clone.js';

// renderIndexHtml probes the real PATH for every CLI, which would make the
// assertions below depend on whatever happens to be installed on the machine
// running the suite. Default them all to "not installed" and opt in per test.
vi.mock('../src/utils/claude-cli-resolver.js', () => ({
  isClaudeAvailable: vi.fn(() => false),
  findClaudeDir: vi.fn(() => null),
}));
vi.mock('../src/utils/opencode-cli-resolver.js', () => ({
  isOpenCodeAvailable: vi.fn(() => false),
  resolveOpenCodeDir: vi.fn(() => null),
}));
vi.mock('../src/utils/codex-cli-resolver.js', () => ({
  isCodexAvailable: vi.fn(() => false),
  resolveCodexDir: vi.fn(() => null),
}));
vi.mock('../src/utils/gemini-cli-resolver.js', () => ({
  isGeminiAvailable: vi.fn(() => false),
  resolveGeminiDir: vi.fn(() => null),
}));
vi.mock('../src/utils/antigravity-cli-resolver.js', () => ({
  isAntigravityAvailable: vi.fn(() => false),
  resolveAntigravityDir: vi.fn(() => null),
}));
vi.mock('../src/utils/pi-cli-resolver.js', () => ({
  isPiAvailable: vi.fn(() => false),
  resolvePiDir: vi.fn(() => null),
  getPiCliVersion: vi.fn(() => null),
}));
vi.mock('../src/utils/grok-cli-resolver.js', () => ({
  isGrokAvailable: vi.fn(() => false),
  resolveGrokDir: vi.fn(() => null),
  getGrokCliVersion: vi.fn(() => null),
}));
// DeepSeek is the one mode with a two-part availability answer (binary AND a
// pane-capable profile), so both probes are mocked independently.
vi.mock('../src/utils/deepseek-cli-resolver.js', () => ({
  isDeepSeekAvailable: vi.fn(() => false),
  isDeepSeekRunnable: vi.fn(() => false),
  resolveDeepSeekDir: vi.fn(() => null),
  getDeepSeekCliVersion: vi.fn(() => null),
  listDeepSeekProfiles: vi.fn(() => []),
  resolveDefaultDeepSeekProfile: vi.fn(() => null),
}));
vi.mock('../src/utils/omp-cli-resolver.js', () => ({
  isOmpAvailable: vi.fn(() => false),
  resolveOmpDir: vi.fn(() => null),
}));
vi.mock('../src/utils/cloudflared-resolver.js', () => ({
  isCloudflaredAvailable: vi.fn(() => false),
  resolveCloudflaredPath: vi.fn(() => null),
}));
// git gates the Add Case -> Clone Repo tab (#236), so it rides in the same object.
vi.mock('../src/git-clone.js', () => ({
  isGitAvailable: vi.fn(() => false),
}));

const TEMPLATE = [
  '<head>',
  '<title>Codeman</title>',
  '</head>',
  '<body>',
  '<button class="btn-icon-header btn-multimonitor btn-multimonitor--hidden" aria-label="Open Codeman across all displays"></button>',
  '</body>',
].join('\n');

function makeServer(settings: Record<string, unknown> = {}) {
  const server = new WebServer(0, false, true);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).indexHtmlTemplate = TEMPLATE;
  const readSettings = vi.fn(async () => settings);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).readSettings = readSettings;
  return { server, readSettings };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const render = (server: WebServer, solo?: string): Promise<string> => (server as any).renderIndexHtml(solo);

const ORIG_GESTURE = process.env.CODEMAN_GESTURE;
afterEach(() => {
  if (ORIG_GESTURE === undefined) delete process.env.CODEMAN_GESTURE;
  else process.env.CODEMAN_GESTURE = ORIG_GESTURE;
});

describe('WebServer.renderIndexHtml', () => {
  it('keeps the multi-monitor button hidden by default and reads settings FRESH', async () => {
    const { server, readSettings } = makeServer({});
    const html = await render(server);
    expect(html).toContain('btn-multimonitor--hidden');
    // forceFresh=true — fixes the post-save reload race against the 2s cache.
    expect(readSettings).toHaveBeenCalledWith(true);
  });

  it('reveals the multi-monitor button when showMultiMonitorButton is set', async () => {
    const { server } = makeServer({ showMultiMonitorButton: true });
    const html = await render(server);
    expect(html).not.toContain('btn-multimonitor--hidden');
    expect(html).toContain('btn-multimonitor"'); // class list still present, only the marker stripped
  });

  it('injects the solo global and skips settings for a /session/:id window', async () => {
    const { server, readSettings } = makeServer({ showMultiMonitorButton: true });
    const html = await render(server, 'sess-123');
    expect(html).toContain('window.__CODEMAN_SOLO__="sess-123"');
    expect(readSettings).not.toHaveBeenCalled();
    // Solo skips settings, so the button is NOT revealed even though the setting is on.
    expect(html).toContain('btn-multimonitor--hidden');
  });

  it('escapes the solo id so it cannot break out of the inline <script>', async () => {
    const { server } = makeServer({});
    const html = await render(server, 'a</script><b>');
    expect(html).not.toContain('</script><b>');
    expect(html).toContain('\\u003c');
  });

  it('exposes gesture availability but injects the bundle only when enabled', async () => {
    process.env.CODEMAN_GESTURE = '1';
    let { server } = makeServer({ gestureControlEnabled: false });
    let html = await render(server);
    expect(html).toContain('window.__codemanGestureAvailable=true');
    expect(html).not.toContain('gesture-codeman.js');

    ({ server } = makeServer({ gestureControlEnabled: true }));
    html = await render(server);
    expect(html).toContain('window.__codemanGestureAvailable=true');
    expect(html).toContain('gesture-codeman.js');
  });

  it('reports every tool the welcome buttons, run menu and Codex tab gate on', async () => {
    vi.mocked(isClaudeAvailable).mockReturnValue(true);
    vi.mocked(isOpenCodeAvailable).mockReturnValue(false);
    vi.mocked(isCodexAvailable).mockReturnValue(true);
    vi.mocked(isGeminiAvailable).mockReturnValue(false);
    vi.mocked(isAntigravityAvailable).mockReturnValue(false);
    vi.mocked(isPiAvailable).mockReturnValue(true);
    vi.mocked(isGrokAvailable).mockReturnValue(false);
    vi.mocked(isDeepSeekAvailable).mockReturnValue(false);
    vi.mocked(isDeepSeekRunnable).mockReturnValue(false);
    vi.mocked(isOmpAvailable).mockReturnValue(true);
    vi.mocked(isCloudflaredAvailable).mockReturnValue(true);
    vi.mocked(isGitAvailable).mockReturnValue(true);
    const { server } = makeServer({});
    const html = await render(server);
    const flags = JSON.parse(html.match(/window\.__codemanCliAvailable=(\{.*?\});/)![1]);
    // Every key must be PRESENT, not merely truthy where installed: the client
    // treats a missing key as available, so a dropped key silently un-gates.
    expect(flags).toEqual({
      claude: true,
      opencode: false,
      codex: true,
      gemini: false,
      antigravity: false,
      pi: true,
      grok: false,
      deepseek: false,
      deepseekBinary: false,
      omp: true,
      cloudflared: true,
      git: true,
    });
  });

  it('reports which run modes the custom-model Run-menu picker may generate an entry for', async () => {
    // Read generically off the CLI registry's own capabilities, not a hardcoded id
    // list — antigravity (`unsupported`) and shell (`kind !== 'agent'`) must be
    // absent, and any enabled agent CLI with a real injection recipe must be
    // present, with no mock needed since this reads the real stock registry.
    const { server } = makeServer({});
    const html = await render(server);
    expect(html).toContain('window.__codemanCustomModelClis=');
    const clis = JSON.parse(html.match(/window\.__codemanCustomModelClis=(\[.*?\]);/)![1]) as Array<{
      id: string;
      label: string;
    }>;
    const ids = clis.map((c) => c.id);
    expect(ids).toContain('claude');
    expect(ids).not.toContain('antigravity');
    expect(ids).not.toContain('shell');
    for (const cli of clis) {
      expect(typeof cli.id).toBe('string');
      expect(typeof cli.label).toBe('string');
    }
  });

  it('escapeScriptJson neutralizes a literal </script>, and still round-trips as a JS literal', () => {
    // CliEntry.label is a plain string a user's own clis.json can set (up to 60
    // chars), unlike __codemanCliAvailable's booleans-only payload, so this is
    // the one injection that needs it. Exported so this tests the pure
    // function directly rather than needing a real WebServer (which needs tmux).
    const dangerous = JSON.stringify([{ id: 'x', label: '</script><script>alert(1)</script>' }]);
    const escaped = escapeScriptJson(dangerous);
    expect(escaped).not.toContain('</script');
    // Proves it decodes back to the real value the way a browser's own JS
    // parser would, not just "the output contains no </script>".
    expect(eval(escaped)[0].label).toBe('</script><script>alert(1)</script>');
  });

  it('still emits the object when nothing at all is installed', async () => {
    // The all-false case is the one that matters most and the easiest to get
    // wrong by only injecting when something resolves.
    for (const probe of [
      isClaudeAvailable,
      isOpenCodeAvailable,
      isCodexAvailable,
      isGeminiAvailable,
      isAntigravityAvailable,
      isPiAvailable,
      isGrokAvailable,
      isDeepSeekAvailable,
      isDeepSeekRunnable,
      isOmpAvailable,
      isCloudflaredAvailable,
      isGitAvailable,
    ]) {
      vi.mocked(probe).mockReturnValue(false);
    }
    const { server } = makeServer({});
    const html = await render(server);
    expect(html).toContain('window.__codemanCliAvailable=');
    const flags = JSON.parse(html.match(/window\.__codemanCliAvailable=(\{.*?\});/)![1]);
    expect(Object.values(flags).every((v) => v === false)).toBe(true);
  });

  it('skips the probe for a solo window, which has no welcome screen or run menu', async () => {
    vi.mocked(isCodexAvailable).mockReturnValue(true);
    const { server } = makeServer({});
    const html = await render(server, 'sess-123');
    expect(html).not.toContain('__codemanCliAvailable');
    expect(html).not.toContain('__codemanCustomModelClis');
  });

  it('does not expose gesture at all when CODEMAN_GESTURE is unset', async () => {
    delete process.env.CODEMAN_GESTURE;
    const { server } = makeServer({ gestureControlEnabled: true });
    const html = await render(server);
    expect(html).not.toContain('__codemanGestureAvailable');
    expect(html).not.toContain('gesture-codeman.js');
  });
});

describe('WebServer.renderIndexHtml reverse-proxy base path', () => {
  const BASE_TEMPLATE = ['<head>', '<base href="/">', '<title>Codeman</title>', '</head>', '<body></body>'].join('\n');

  function makeBaseServer(basePath: string) {
    // constructor: (port, https, testMode, host, titleHostname, allowUnauth, basePath)
    const server = new WebServer(0, false, true, '127.0.0.1', undefined, false, basePath);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).indexHtmlTemplate = BASE_TEMPLATE;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).readSettings = vi.fn(async () => ({}));
    return server;
  }

  it('is inert at root — base tag unchanged and no base global injected', async () => {
    const server = makeBaseServer('');
    const html = await render(server);
    expect(html).toContain('<base href="/">');
    // At root the frontend reads a MISSING __CODEMAN_BASE__ as root, so nothing is
    // injected and the historical output is byte-identical.
    expect(html).not.toContain('__CODEMAN_BASE__');
  });

  it('points the base tag and the base global at a sub-path mount', async () => {
    const server = makeBaseServer('/codeman');
    const html = await render(server);
    expect(html).toContain('<base href="/codeman/">');
    expect(html).toContain('window.__CODEMAN_BASE__="/codeman"');
    // The global rides right after <base>, before any (deferred) script.
    expect(html.indexOf('window.__CODEMAN_BASE__')).toBeLessThan(html.indexOf('</head>'));
  });

  it('normalizes a raw operator prefix passed to the constructor', async () => {
    const server = makeBaseServer('codeman/');
    const html = await render(server);
    expect(html).toContain('<base href="/codeman/">');
    expect(html).toContain('window.__CODEMAN_BASE__="/codeman"');
  });
});
