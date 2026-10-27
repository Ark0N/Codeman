/**
 * Unit tests for the unit-file builders behind `codeman service install`
 * (issue #231). These are the parts that must be right without launchctl or
 * systemctl in the loop: PATH construction, escaping, and the file contents.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveServicePlan,
  buildLaunchAgentPlist,
  buildServiceEnv,
  buildServicePath,
  buildSystemdUnit,
  detectServiceKind,
  systemdQuote,
  xmlEscape,
  type ServicePlan,
} from '../src/service-installer.js';

function plan(overrides: Partial<ServicePlan> = {}): ServicePlan {
  return {
    kind: 'systemd',
    name: 'codeman-web.service',
    nodePath: '/usr/bin/node',
    execArgv: [],
    scriptPath: '/home/u/.codeman/app/dist/index.js',
    args: ['web', '--host', '127.0.0.1', '--port', '3000'],
    env: { PATH: '/usr/bin:/bin', HOME: '/home/u', LANG: 'en_US.UTF-8' },
    logPath: '/home/u/.codeman/web.log',
    workingDir: '/home/u',
    ...overrides,
  };
}

describe('buildServicePath', () => {
  it("puts the running node's directory first so nvm/homebrew node wins", () => {
    const result = buildServicePath('/home/u/.nvm/versions/node/v22.0.0/bin', '/usr/bin:/bin', '/home/u');
    expect(result.split(':')[0]).toBe('/home/u/.nvm/versions/node/v22.0.0/bin');
  });

  it('keeps the installing shell PATH, which is the whole point of the fix', () => {
    const result = buildServicePath('/usr/bin', '/opt/homebrew/bin:/home/u/.bun/bin', '/home/u');
    expect(result.split(':')).toContain('/home/u/.bun/bin');
    expect(result.split(':')).toContain('/opt/homebrew/bin');
  });

  it('appends the fallbacks a bare launchd PATH would otherwise be missing', () => {
    const entries = buildServicePath('/usr/bin', '/usr/bin', '/home/u').split(':');
    expect(entries).toContain('/opt/homebrew/bin');
    expect(entries).toContain('/home/u/.local/bin');
    expect(entries).toContain('/usr/local/bin');
  });

  it('never repeats a directory', () => {
    const entries = buildServicePath('/usr/bin', '/usr/bin:/bin:/usr/bin', '/home/u').split(':');
    expect(new Set(entries).size).toBe(entries.length);
  });

  it('drops empty segments from a trailing-colon PATH', () => {
    expect(buildServicePath('/usr/bin', '/usr/bin::/bin:', '/home/u').split(':')).not.toContain('');
  });

  it('drops node_modules/.bin, which npx injects for one command only', () => {
    const entries = buildServicePath(
      '/usr/bin',
      '/repo/node_modules/.bin:/repo/node_modules/.bin/:/home/u/bin',
      '/home/u'
    ).split(':');
    expect(entries.filter((e) => e.includes('node_modules'))).toEqual([]);
    expect(entries).toContain('/home/u/bin');
  });
});

describe('buildServiceEnv', () => {
  it('carries PATH, HOME and a LANG default', () => {
    const env = buildServiceEnv('/usr/bin', '/usr/bin:/bin', '/home/u');
    expect(env.HOME).toBe('/home/u');
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.PATH).toContain('/usr/bin');
  });

  it('prefers the caller LANG when there is one', () => {
    expect(buildServiceEnv('/usr/bin', '/usr/bin', '/home/u', 'de_DE.UTF-8').LANG).toBe('de_DE.UTF-8');
  });

  it('does not carry a password into the unit file', () => {
    const env = buildServiceEnv('/usr/bin', '/usr/bin', '/home/u');
    expect(Object.keys(env)).not.toContain('CODEMAN_PASSWORD');
  });
});

describe('escaping', () => {
  it('escapes the five XML entities', () => {
    expect(xmlEscape(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f');
  });

  it('quotes systemd values and escapes quotes and backslashes', () => {
    expect(systemdQuote('plain')).toBe('"plain"');
    expect(systemdQuote('with "quotes"')).toBe('"with \\"quotes\\""');
    expect(systemdQuote('back\\slash')).toBe('"back\\\\slash"');
  });
});

describe('buildLaunchAgentPlist', () => {
  it('writes the label, the full command and the log paths', () => {
    const xml = buildLaunchAgentPlist(plan({ kind: 'launchd', name: 'com.codeman.web' }));
    expect(xml).toContain('<string>com.codeman.web</string>');
    expect(xml).toContain('<string>/usr/bin/node</string>');
    expect(xml).toContain('<string>/home/u/.codeman/app/dist/index.js</string>');
    expect(xml).toContain('<string>web</string>');
    expect(xml).toContain('<string>/home/u/.codeman/web.log</string>');
  });

  it('keeps the argument order: node, script, then the web args', () => {
    const xml = buildLaunchAgentPlist(plan({ kind: 'launchd', name: 'com.codeman.web' }));
    // Match whole <string> elements: the label itself contains the word "web".
    const order = [
      '<string>/usr/bin/node</string>',
      '<string>/home/u/.codeman/app/dist/index.js</string>',
      '<string>web</string>',
      '<string>--port</string>',
    ].map((s) => xml.indexOf(s));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((i) => i > -1)).toBe(true);
  });

  it('carries the runner flags so a tsx dev install still boots', () => {
    const xml = buildLaunchAgentPlist(plan({ kind: 'launchd', execArgv: ['--import', 'tsx'] }));
    expect(xml).toContain('<string>--import</string>');
    expect(xml).toContain('<string>tsx</string>');
  });

  it('restarts on crash and at login', () => {
    const xml = buildLaunchAgentPlist(plan({ kind: 'launchd' }));
    expect(xml).toContain('<key>KeepAlive</key>');
    expect(xml).toContain('<key>RunAtLoad</key>');
  });

  it('escapes a path with an ampersand instead of emitting broken XML', () => {
    const xml = buildLaunchAgentPlist(plan({ kind: 'launchd', workingDir: '/Users/a&b' }));
    expect(xml).toContain('<string>/Users/a&amp;b</string>');
    expect(xml).not.toContain('<string>/Users/a&b</string>');
  });
});

describe('buildSystemdUnit', () => {
  it('builds ExecStart from node, script and args', () => {
    expect(buildSystemdUnit(plan())).toContain(
      'ExecStart=/usr/bin/node /home/u/.codeman/app/dist/index.js web --host 127.0.0.1 --port 3000'
    );
  });

  it('quotes an argument containing spaces', () => {
    const unit = buildSystemdUnit(plan({ scriptPath: '/home/my user/app/dist/index.js' }));
    expect(unit).toContain('"/home/my user/app/dist/index.js"');
  });

  it('writes each env var as a quoted Environment line', () => {
    const unit = buildSystemdUnit(plan());
    expect(unit).toContain('Environment="PATH=/usr/bin:/bin"');
    expect(unit).toContain('Environment="HOME=/home/u"');
  });

  it('keeps KillMode=process so agents survive a server restart', () => {
    expect(buildSystemdUnit(plan())).toContain('KillMode=process');
  });

  it('is installable and restarts on failure', () => {
    const unit = buildSystemdUnit(plan());
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('WantedBy=default.target');
  });
});

describe('detectServiceKind', () => {
  it('maps the platform to its supervisor', () => {
    const expected = process.platform === 'darwin' ? 'launchd' : process.platform === 'linux' ? 'systemd' : null;
    expect(detectServiceKind()).toBe(expected);
  });
});

describe('resolveServicePlan tunnel opt-in', () => {
  it.each(['systemd', 'launchd'] as const)('carries the tunnel flag into %s args', (kind) => {
    const options = {
      host: '0.0.0.0',
      port: 8080,
      https: false,
      allowUnauthenticatedNetwork: true,
      allowUnauthenticatedTunnel: true,
      multiuser: true,
    };
    expect(resolveServicePlan(kind, options).args).toEqual([
      'web',
      '--host',
      '0.0.0.0',
      '--port',
      '8080',
      '--allow-unauthenticated-network',
      '--allow-unauthenticated-tunnel',
      '--multiuser',
    ]);
  });
});
