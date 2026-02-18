/**
 * @fileoverview Unit tests for mux-factory
 *
 * Tests that createMultiplexer returns a TmuxManager when tmux is available,
 * and throws when tmux is not available.
 *
 * Port: N/A (no server needed)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMultiplexer } from '../src/mux-factory.js';
import { TmuxManager } from '../src/tmux-manager.js';

// Spy on static availability method
const tmuxAvailableSpy = vi.spyOn(TmuxManager, 'isTmuxAvailable');

// Mock child_process for TmuxManager constructor (it calls execSync for 'which claude')
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return {
    ...actual,
    execSync: vi.fn((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('which claude')) {
        return '/usr/local/bin/claude\n';
      }
      if (typeof cmd === 'string' && cmd.includes('which tmux')) {
        return '/usr/bin/tmux\n';
      }
      return '';
    }),
    spawn: vi.fn(() => ({
      unref: vi.fn(),
      on: vi.fn(),
      pid: 12345,
    })),
  };
});

// Mock fs to avoid file I/O
vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFile: vi.fn((_path: string, _data: string, cb: (err: Error | null) => void) => cb(null)),
    writeFileSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([]),
    unlinkSync: vi.fn(),
  };
});

describe('createMultiplexer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return a TmuxManager when tmux is available', () => {
    tmuxAvailableSpy.mockReturnValue(true);

    const mux = createMultiplexer();
    expect(mux.backend).toBe('tmux');
    mux.destroy();
  });

  it('should throw when tmux is not available', () => {
    tmuxAvailableSpy.mockReturnValue(false);

    expect(() => createMultiplexer()).toThrow('tmux not found');
  });
});
