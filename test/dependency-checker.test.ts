import { describe, it, expect, vi } from 'vitest';
import { dependencyRegistry } from '../src/config/dependency-registry.js';
import {
  detectEnvironment,
  extractVersion,
  compareVersions,
  checkTool,
  checkAll,
  createRealHost,
} from '../src/utils/dependency-checker.js';
import type { ProbeHost } from '../src/utils/dependency-checker.js';
import type { ProbeEnvironment, ToolDependency } from '../src/config/dependency-registry.js';
import { PI_VERSION_REGEX } from '../src/utils/pi-cli-resolver.js';
import { GROK_VERSION_REGEX } from '../src/utils/grok-cli-resolver.js';
import { DEEPSEEK_VERSION_REGEX } from '../src/utils/deepseek-cli-resolver.js';
import { enabledClis } from '../src/config/cli-registry/registry.js';

describe('dependencyRegistry()', () => {
  it('has unique ids', () => {
    const ids = dependencyRegistry().map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('hard-requires only node and tmux; agent CLIs and office are optional', () => {
    const required = dependencyRegistry()
      .filter((t) => t.required)
      .map((t) => t.id)
      .sort();
    expect(required).toEqual(['node', 'tmux']);
    // all agent CLIs are optional (Codeman runs any of them)
    const agentClis = ['claude', 'opencode', 'codex'];
    expect(
      dependencyRegistry()
        .filter((t) => agentClis.includes(t.id))
        .every((t) => t.required === false)
    ).toBe(true);
    const office = dependencyRegistry().filter((t) => t.category === 'office');
    expect(office.every((t) => t.required === false)).toBe(true);
  });

  it.each([
    ['pi', PI_VERSION_REGEX],
    ['grok', GROK_VERSION_REGEX],
    ['dsh', DEEPSEEK_VERSION_REGEX],
  ])('resolves %s through the SAME version rule the run mode uses', (id, expected) => {
    // These three have short, generic or squatted binary names, so their resolvers refuse a
    // binary that does not print the right shape of version. If the doctor did not apply the
    // identical rule it would report "Pi CLI ✓" on a box where Run Pi stays hidden, which
    // reads as a broken mode rather than a missing install.
    //
    // Both sides now read one registry entry, so they cannot drift — but the assertion
    // compares SOURCE rather than object identity, because the doctor compiles the entry's
    // serialized pattern through compileVersionRegex()'s ReDoS guard rather than importing
    // the resolver's own RegExp object.
    const tool = dependencyRegistry().find((t) => t.id === id);
    expect(tool).toBeDefined();
    const spec = tool!.resolvers.find((r) => r.resolver.kind === 'path');
    expect(spec).toBeDefined();
    const resolver = spec!.resolver as { versionRegex?: RegExp; requireVersionMatch?: boolean };
    expect(resolver.requireVersionMatch).toBe(true);
    expect(resolver.versionRegex?.source).toBe(expected.source);
  });

  it('keeps a doctor row for every CLI that has a binary to probe', () => {
    // An earlier draft of the registry refactor silently dropped the grok and dsh rows, so
    // `codeman doctor` stopped reporting two shipped CLIs entirely. Derive the expectation
    // from the registry so this cannot pass by being updated to match a shrunken table.
    const probeable = enabledClis().filter((c) => c.discovery.binaries.length > 0);
    expect(probeable.length).toBeGreaterThanOrEqual(8);
    for (const cli of probeable) {
      const bin = cli.discovery.binaries[0];
      const row = dependencyRegistry().find((t) =>
        t.resolvers.some((r) => r.resolver.kind === 'path' && r.resolver.bins.includes(bin))
      );
      expect(row, `no codeman doctor row probes ${bin} (for CLI "${cli.id as string}")`).toBeDefined();
    }
  });

  it('gives msoffice a windows-side resolver scoped to wsl + win32 only', () => {
    const ms = dependencyRegistry().find((t) => t.id === 'msoffice');
    expect(ms).toBeDefined();
    const spec = ms!.resolvers.find((r) => r.resolver.kind === 'windows-side');
    expect(spec).toBeDefined();
    expect([...spec!.match].sort()).toEqual(['win32', 'wsl']);
    expect(ms!.resolvers.some((r) => r.match.includes('linux'))).toBe(false);
  });
});

describe('detectEnvironment', () => {
  it('returns win32/darwin straight from platform', () => {
    expect(detectEnvironment({ platform: 'win32', procVersion: '', hasWindowsInterop: false })).toBe('win32');
    expect(detectEnvironment({ platform: 'darwin', procVersion: '', hasWindowsInterop: false })).toBe('darwin');
  });

  it('detects wsl from /proc/version + interop, else linux', () => {
    const wsl = detectEnvironment({
      platform: 'linux',
      procVersion: 'Linux version 6.6 (Microsoft@WSL2)',
      hasWindowsInterop: true,
    });
    expect(wsl).toBe('wsl');
    expect(detectEnvironment({ platform: 'linux', procVersion: 'Microsoft', hasWindowsInterop: false })).toBe('linux');
    expect(detectEnvironment({ platform: 'linux', procVersion: 'generic', hasWindowsInterop: true })).toBe('linux');
  });
});

describe('extractVersion', () => {
  it('pulls a dotted version from typical --version output', () => {
    expect(extractVersion('v22.22.1')).toBe('22.22.1');
    expect(extractVersion('tmux 3.4')).toBe('3.4');
    expect(extractVersion('no digits here')).toBeUndefined();
  });
  it('honors a custom regex', () => {
    expect(extractVersion('ProductVersion 16.0.19929.20172', /(\d+\.\d+\.\d+)/)).toBe('16.0.19929');
  });
});

describe('compareVersions', () => {
  it('orders by numeric components', () => {
    expect(compareVersions('18.0.0', '18.0.0')).toBe(0);
    expect(compareVersions('16.5.0', '18.0.0')).toBe(-1);
    expect(compareVersions('22.22.1', '18.0.0')).toBe(1);
    expect(compareVersions('3.4', '3.4.0')).toBe(0);
  });
});

function fakeHost(env: ProbeEnvironment, over: Partial<ProbeHost> = {}): ProbeHost {
  return {
    environment: env,
    which: () => null,
    fileExists: () => false,
    runVersion: () => null,
    windowsProgramRoots: () => [],
    windowsFileVersion: () => null,
    ...over,
  };
}

const tmuxTool: ToolDependency = {
  id: 'tmux',
  label: 'tmux',
  category: 'core',
  required: true,
  resolvers: [{ match: ['linux', 'wsl'], resolver: { kind: 'path', bins: ['tmux'], versionArg: '-V' } }],
};
const nodeTool: ToolDependency = {
  id: 'node',
  label: 'Node.js',
  category: 'core',
  required: true,
  minVersion: '18.0.0',
  resolvers: [{ match: ['linux'], resolver: { kind: 'path', bins: ['node'] } }],
};
const msTool: ToolDependency = {
  id: 'msoffice',
  label: 'MS Office',
  category: 'office',
  required: false,
  resolvers: [
    {
      match: ['wsl', 'win32'],
      resolver: { kind: 'windows-side', appDirs: ['Microsoft Office/root/Office16'], exes: ['WINWORD.EXE'] },
    },
  ],
};

describe('checkTool', () => {
  it('reports ok with path + version when found on PATH', () => {
    const host = fakeHost('linux', {
      which: (b) => (b === 'tmux' ? '/usr/bin/tmux' : null),
      runVersion: () => 'tmux 3.4',
    });
    expect(checkTool(tmuxTool, host)).toMatchObject({
      id: 'tmux',
      status: 'ok',
      version: '3.4',
      path: '/usr/bin/tmux',
    });
  });

  it('reports missing when no bin resolves', () => {
    expect(checkTool(tmuxTool, fakeHost('linux'))).toMatchObject({ id: 'tmux', status: 'missing' });
  });

  it('reports outdated when below minVersion', () => {
    const host = fakeHost('linux', { which: () => '/n', runVersion: () => 'v16.5.0' });
    expect(checkTool(nodeTool, host)).toMatchObject({ id: 'node', status: 'outdated', version: '16.5.0' });
  });

  it('reports error when minVersion set but version unparseable', () => {
    const host = fakeHost('linux', { which: () => '/n', runVersion: () => 'unknown' });
    expect(checkTool(nodeTool, host)).toMatchObject({ id: 'node', status: 'error' });
  });

  it('reports skipped when no resolver matches the environment', () => {
    expect(checkTool(msTool, fakeHost('linux'))).toMatchObject({ id: 'msoffice', status: 'skipped' });
  });

  it('finds windows-side apps under WSL', () => {
    const host = fakeHost('wsl', {
      windowsProgramRoots: () => ['/mnt/c/Program Files'],
      fileExists: (p) => p === '/mnt/c/Program Files/Microsoft Office/root/Office16/WINWORD.EXE',
      windowsFileVersion: () => '16.0.19929.20172',
    });
    expect(checkTool(msTool, host)).toMatchObject({
      id: 'msoffice',
      status: 'ok',
      version: '16.0.19929',
      path: '/mnt/c/Program Files/Microsoft Office/root/Office16/WINWORD.EXE',
    });
  });
});

describe('checkTool with requireVersionMatch (generic binary names)', () => {
  const piTool: ToolDependency = {
    id: 'pi',
    label: 'Pi CLI',
    category: 'core',
    required: false,
    resolvers: [
      {
        match: ['linux'],
        resolver: {
          kind: 'path',
          bins: ['pi'],
          versionArg: '--version',
          versionRegex: PI_VERSION_REGEX,
          requireVersionMatch: true,
        },
      },
    ],
  };

  it('accepts a binary that prints a semver version', () => {
    const host = fakeHost('linux', { which: () => '/home/u/.npm-global/bin/pi', runVersion: () => '0.84.1\n' });
    expect(checkTool(piTool, host)).toMatchObject({
      id: 'pi',
      status: 'ok',
      version: '0.84.1',
      path: '/home/u/.npm-global/bin/pi',
    });
  });

  it('reports MISSING for an unrelated `pi` on PATH instead of an installed tool', () => {
    // The whole point: a Raspberry Pi helper answers `--version` with prose, and calling
    // that "installed" contradicts resolvePiDir(), which rejects it.
    const host = fakeHost('linux', { which: () => '/usr/bin/pi', runVersion: () => 'Raspberry Pi utility\n' });
    expect(checkTool(piTool, host)).toMatchObject({ id: 'pi', status: 'missing' });
  });

  it('reports MISSING when the binary answers nothing at all', () => {
    const host = fakeHost('linux', { which: () => '/usr/bin/pi', runVersion: () => null });
    expect(checkTool(piTool, host)).toMatchObject({ id: 'pi', status: 'missing' });
  });

  it('leaves tools without the flag reporting ok on an unparsable version (unchanged)', () => {
    const host = fakeHost('linux', { which: () => '/usr/bin/tmux', runVersion: () => 'no version here' });
    expect(checkTool(tmuxTool, host)).toMatchObject({ id: 'tmux', status: 'ok', version: undefined });
  });
});

describe('checkTool with searchDirs (service PATH is minimal)', () => {
  const claudeLike: ToolDependency = {
    ...tmuxTool,
    id: 'claude',
    label: 'Claude CLI',
    resolvers: [
      {
        match: ['linux'],
        resolver: { kind: 'path', bins: ['claude'], searchDirs: ['/home/u/.local/bin', '/opt/npm/bin/'] },
      },
    ],
  };

  it('finds a CLI that only lives in a searchDirs entry and runs --version on the absolute path', () => {
    const runVersion = vi.fn(() => 'claude 2.1.0');
    const host = fakeHost('linux', { fileExists: (p) => p === '/opt/npm/bin/claude', runVersion });
    expect(checkTool(claudeLike, host)).toMatchObject({
      status: 'ok',
      path: '/opt/npm/bin/claude',
      version: '2.1.0',
    });
    expect(runVersion).toHaveBeenCalledWith('/opt/npm/bin/claude', ['--version']);
  });

  it('still reports missing when neither PATH nor any search dir has it', () => {
    expect(checkTool(claudeLike, fakeHost('linux'))).toMatchObject({ status: 'missing' });
  });

  it('prefers the PATH hit over a search dir', () => {
    const host = fakeHost('linux', {
      which: () => '/usr/bin/claude',
      fileExists: () => true,
      runVersion: () => '1.0.0',
    });
    expect(checkTool(claudeLike, host)).toMatchObject({ path: '/usr/bin/claude' });
  });

  it('carries each enabled CLI’s expanded discovery.searchDirs onto its registry row', () => {
    const rows = dependencyRegistry().flatMap((t) => t.resolvers.map((r) => r.resolver));
    const withDirs = rows.filter((r) => r.kind === 'path' && r.searchDirs?.length);
    expect(withDirs.length).toBeGreaterThan(0);
    for (const r of withDirs) {
      if (r.kind === 'path') for (const d of r.searchDirs ?? []) expect(d.startsWith('~')).toBe(false);
    }
  });
});

describe('checkAll', () => {
  it('maps every tool to a result', () => {
    const results = checkAll([tmuxTool, msTool], fakeHost('linux'));
    expect(results.map((r) => r.id)).toEqual(['tmux', 'msoffice']);
  });
});

describe('createRealHost', () => {
  it('returns a host with a valid detected environment and callable methods', () => {
    const host = createRealHost();
    expect(['linux', 'darwin', 'win32', 'wsl']).toContain(host.environment);
    expect(typeof host.which).toBe('function');
    expect(Array.isArray(host.windowsProgramRoots())).toBe(true);
  });
});
