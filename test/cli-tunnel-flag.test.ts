/**
 * @fileoverview Issue #706 tunnel flag plumbing through the real command parser into daemon, foreground and service launches. Launch boundaries are mocked, so the CLI's valid nonzero port never binds a socket or creates a service unit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const launches = vi.hoisted(() => ({
  startDaemon: vi.fn(),
  startWebServer: vi.fn(),
  installService: vi.fn(),
  stop: vi.fn(),
}));

vi.mock('../src/daemon-control.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/daemon-control.js')>()),
  startDaemon: launches.startDaemon,
}));
vi.mock('../src/service-installer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/service-installer.js')>()),
  installService: launches.installService,
}));
vi.mock('../src/web/server.js', () => ({ startWebServer: launches.startWebServer }));

const SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;
let originalListeners: Map<NodeJS.Signals, ReturnType<typeof process.listeners>>;
let exitSpy: ReturnType<typeof vi.spyOn<typeof process, 'exit'>>;

beforeEach(() => {
  // Commander retains parsed option values; use a fresh real program for each invocation.
  vi.resetModules();
  vi.clearAllMocks();
  originalListeners = new Map(SIGNALS.map((signal) => [signal, process.listeners(signal)]));
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`Unexpected process.exit(${code})`);
  });
  launches.startDaemon.mockResolvedValue({ ok: true, url: 'http://127.0.0.1:8080', pid: 123, logPath: 'web.log' });
  launches.stop.mockResolvedValue(undefined);
  launches.startWebServer.mockResolvedValue({ stop: launches.stop });
  launches.installService.mockResolvedValue({ ok: true, message: 'Installed', unitPath: 'codeman-web.service' });
});

afterEach(() => {
  for (const signal of SIGNALS) {
    for (const listener of process.listeners(signal)) {
      if (!originalListeners.get(signal)!.includes(listener)) process.removeListener(signal, listener);
    }
  }
  vi.restoreAllMocks();
});

const expectedOptions = (allowUnauthenticatedTunnel: boolean) => ({
  host: '127.0.0.1',
  port: 8080,
  https: false,
  basePath: '',
  titleHostname: undefined,
  allowUnauthenticatedNetwork: false,
  allowUnauthenticatedTunnel,
  multiuser: false,
});

async function parse(args: string[], enabled: boolean) {
  const { program } = await import('../src/cli.js');
  await program.parseAsync([
    'node',
    'codeman',
    ...args,
    '--port',
    '8080',
    '--host',
    '127.0.0.1',
    '--base-url',
    '/',
    ...(enabled ? ['--allow-unauthenticated-tunnel'] : []),
  ]);
  expect(exitSpy).not.toHaveBeenCalled();
}

describe('tunnel flag CLI plumbing', () => {
  it.each([true, false])('web -d passes allowUnauthenticatedTunnel=%s to startDaemon', async (enabled) => {
    await parse(['web', '-d'], enabled);
    expect(launches.startDaemon.mock.calls).toEqual([[expectedOptions(enabled)]]);
    expect(launches.startWebServer.mock.calls).toEqual([]);
    expect(launches.installService.mock.calls).toEqual([]);
  });

  it.each([true, false])('foreground web passes allowUnauthenticatedTunnel=%s as argument eight', async (enabled) => {
    await parse(['web'], enabled);
    expect(launches.startWebServer.mock.calls).toEqual([
      [8080, false, false, '127.0.0.1', undefined, false, '', enabled],
    ]);
    expect(launches.startDaemon.mock.calls).toEqual([]);
    expect(launches.installService.mock.calls).toEqual([]);
    expect(launches.stop.mock.calls).toEqual([]);
  });

  it.each([true, false])('service install passes allowUnauthenticatedTunnel=%s to installService', async (enabled) => {
    await parse(['service', 'install'], enabled);
    expect(launches.installService.mock.calls).toEqual([[expectedOptions(enabled)]]);
    expect(launches.startDaemon.mock.calls).toEqual([]);
    expect(launches.startWebServer.mock.calls).toEqual([]);
  });
});
