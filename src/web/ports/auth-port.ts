/**
 * @fileoverview Auth port — capabilities for authentication state.
 * Route modules that need access to auth sessions or QR rate limiting depend on this port.
 */

import type { StaleExpirationMap } from '../../utils/index.js';

/** Enhanced session record with device context for audit logging */
export interface AuthSessionRecord {
  ip: string;
  ua: string;
  createdAt: number;
  method: 'qr' | 'basic';
}

export interface AuthPort {
  readonly authSessions: StaleExpirationMap<string, AuthSessionRecord> | null;
  readonly qrAuthFailures: StaleExpirationMap<string, number> | null;
  readonly https: boolean;
}
