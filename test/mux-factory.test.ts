/**
 * @fileoverview Unit tests for mux-factory
 *
 * Tests detection logic with mocked `which` commands.
 * Tests CLAUDEMAN_MUX env var override.
 * Tests error when neither multiplexer is available.
 *
 * Port: N/A (no server needed)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMultiplexer } from '../src/mux-factory.js';
import { ScreenManager } from '../src/screen-manager.js';
import { TmuxManager } from '../src/tmux-manager.js';

// Spy on static availability methods
const tmuxAvailableSpy = vi.spyOn(TmuxManager, 'isTmuxAvailable');
const screenAvailableSpy = vi.spyOn(ScreenManager, 'isScreenAvailable');

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
      if (typeof cmd === 'string' && cmd.includes('which screen')) {
        return '/usr/bin/screen\n';
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
  let originalEnv: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalEnv = process.env.CLAUDEMAN_MUX;
    delete process.env.CLAUDEMAN_MUX;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.CLAUDEMAN_MUX = originalEnv;
    } else {
      delete process.env.CLAUDEMAN_MUX;
    }
  });

  describe('auto-detection', () => {
    it('should prefer tmux when both are available', () => {
      tmuxAvailableSpy.mockReturnValue(true);
      screenAvailableSpy.mockReturnValue(true);

      const mux = createMultiplexer();
      expect(mux.backend).toBe('tmux');
      mux.destroy();
    });

    it('should fall back to screen when tmux is not available', () => {
      tmuxAvailableSpy.mockReturnValue(false);
      screenAvailableSpy.mockReturnValue(true);

      const mux = createMultiplexer();
      expect(mux.backend).toBe('screen');
      mux.destroy();
    });

    it('should throw when neither is available', () => {
      tmuxAvailableSpy.mockReturnValue(false);
      screenAvailableSpy.mockReturnValue(false);

      expect(() => createMultiplexer()).toThrow('No terminal multiplexer found');
    });
  });

  describe('forced parameter', () => {
    it('should use tmux when forced', () => {
      tmuxAvailableSpy.mockReturnValue(true);
      screenAvailableSpy.mockReturnValue(true);

      const mux = createMultiplexer('tmux');
      expect(mux.backend).toBe('tmux');
      mux.destroy();
    });

    it('should use screen when forced', () => {
      tmuxAvailableSpy.mockReturnValue(true);
      screenAvailableSpy.mockReturnValue(true);

      const mux = createMultiplexer('screen');
      expect(mux.backend).toBe('screen');
      mux.destroy();
    });

    it('should throw when forced tmux is not available', () => {
      tmuxAvailableSpy.mockReturnValue(false);

      expect(() => createMultiplexer('tmux')).toThrow('tmux requested');
    });

    it('should throw when forced screen is not available', () => {
      screenAvailableSpy.mockReturnValue(false);

      expect(() => createMultiplexer('screen')).toThrow('Screen requested');
    });
  });

  describe('CLAUDEMAN_MUX env var', () => {
    it('should respect CLAUDEMAN_MUX=screen', () => {
      process.env.CLAUDEMAN_MUX = 'screen';
      tmuxAvailableSpy.mockReturnValue(true);
      screenAvailableSpy.mockReturnValue(true);

      const mux = createMultiplexer();
      expect(mux.backend).toBe('screen');
      mux.destroy();
    });

    it('should respect CLAUDEMAN_MUX=tmux', () => {
      process.env.CLAUDEMAN_MUX = 'tmux';
      tmuxAvailableSpy.mockReturnValue(true);
      screenAvailableSpy.mockReturnValue(true);

      const mux = createMultiplexer();
      expect(mux.backend).toBe('tmux');
      mux.destroy();
    });

    it('should throw when CLAUDEMAN_MUX=screen but screen unavailable', () => {
      process.env.CLAUDEMAN_MUX = 'screen';
      screenAvailableSpy.mockReturnValue(false);

      expect(() => createMultiplexer()).toThrow('Screen requested');
    });
  });
});
