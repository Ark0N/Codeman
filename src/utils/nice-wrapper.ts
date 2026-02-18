/**
 * @fileoverview Shared utility for wrapping commands with `nice` priority.
 *
 * Extracted as a shared utility for tmux-manager and other consumers.
 *
 * @module utils/nice-wrapper
 */

import type { NiceConfig } from '../types.js';

/**
 * Wraps a command with `nice` for priority adjustment.
 */
export function wrapWithNice(cmd: string, config: NiceConfig): string {
  if (!config.enabled) return cmd;
  const niceValue = Math.max(-20, Math.min(19, config.niceValue));
  return `nice -n ${niceValue} ${cmd}`;
}
