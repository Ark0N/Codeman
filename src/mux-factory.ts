/**
 * @fileoverview Factory for creating the appropriate terminal multiplexer.
 *
 * Auto-detects tmux vs GNU Screen at startup. Prefers tmux.
 * Set `CLAUDEMAN_MUX=screen` to force GNU Screen backend.
 *
 * @module mux-factory
 */

import type { TerminalMultiplexer } from './mux-interface.js';
import { ScreenManager } from './screen-manager.js';
import { TmuxManager } from './tmux-manager.js';

/**
 * Create a TerminalMultiplexer instance based on availability and preference.
 *
 * Detection order:
 * 1. If `forced` parameter is set, use that backend
 * 2. If `CLAUDEMAN_MUX` env var is set, use that backend
 * 3. If tmux is available, use tmux (preferred)
 * 4. If screen is available, use screen (deprecated fallback)
 * 5. Throw error with install instructions
 */
export function createMultiplexer(forced?: 'tmux' | 'screen'): TerminalMultiplexer {
  const preference = forced || process.env.CLAUDEMAN_MUX;

  if (preference === 'screen') {
    if (!ScreenManager.isScreenAvailable()) {
      throw new Error('GNU Screen requested via CLAUDEMAN_MUX=screen but not found. Install: sudo apt install screen');
    }
    console.log('[MuxFactory] Using GNU Screen backend (forced via CLAUDEMAN_MUX)');
    return new ScreenManager();
  }

  if (preference === 'tmux') {
    if (!TmuxManager.isTmuxAvailable()) {
      throw new Error('tmux requested via CLAUDEMAN_MUX=tmux but not found. Install: sudo apt install tmux');
    }
    console.log('[MuxFactory] Using tmux backend (forced via CLAUDEMAN_MUX)');
    return new TmuxManager();
  }

  // Auto-detect: prefer tmux
  if (TmuxManager.isTmuxAvailable()) {
    console.log('[MuxFactory] Using tmux backend (auto-detected)');
    return new TmuxManager();
  }

  if (ScreenManager.isScreenAvailable()) {
    console.warn('[MuxFactory] Using GNU Screen backend (tmux not found). Consider installing tmux for better performance: sudo apt install tmux');
    return new ScreenManager();
  }

  throw new Error(
    'No terminal multiplexer found. Install one of:\n' +
    '  - tmux (recommended): sudo apt install tmux\n' +
    '  - GNU Screen (legacy): sudo apt install screen'
  );
}
