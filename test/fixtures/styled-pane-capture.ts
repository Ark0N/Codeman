import { vi } from 'vitest';

export const styledCapture = 'normal\n\x1b[30m\x1b[42m[session] 0:claude*\n';

// Exercise the real capture method without a constructor or any real tmux IO.
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
  exec: vi.fn(),
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

export async function createStyledPaneCapture() {
  vi.resetModules();
  vi.stubEnv('VITEST', undefined);
  try {
    const { TmuxManager } = await import('../../src/tmux-manager.js');
    const { execSync } = await import('node:child_process');
    const manager = Object.create(TmuxManager.prototype) as InstanceType<typeof TmuxManager>;
    Object.defineProperty(manager, 'tmux', { value: () => 'fake-tmux' });
    return (fullHistory: boolean, geometry = true, capture = styledCapture) => {
      vi.mocked(execSync).mockImplementation((command) => {
        if (String(command).includes('capture-pane')) return capture;
        if (String(command).includes('display-message')) {
          if (!geometry) throw new Error('cursor query failed');
          return '0 0 40 2 0 1';
        }
        throw new Error(`Unexpected tmux command: ${command}`);
      });
      return manager.capturePaneBuffer('codeman-629', undefined, { fullHistory });
    };
  } finally {
    vi.unstubAllEnvs();
  }
}
