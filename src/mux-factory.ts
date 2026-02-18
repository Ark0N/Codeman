/**
 * @fileoverview Factory for creating the terminal multiplexer (tmux).
 *
 * @module mux-factory
 */

import type { TerminalMultiplexer } from './mux-interface.js';
import { TmuxManager } from './tmux-manager.js';

/**
 * Create a TerminalMultiplexer instance.
 *
 * Requires tmux to be installed. Throws with install instructions if not found.
 */
export function createMultiplexer(): TerminalMultiplexer {
  if (!TmuxManager.isTmuxAvailable()) {
    throw new Error('tmux not found. Install: sudo apt install tmux');
  }

  console.log('[MuxFactory] Using tmux backend');
  return new TmuxManager();
}
