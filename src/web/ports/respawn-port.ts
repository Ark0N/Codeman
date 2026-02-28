/**
 * @fileoverview Respawn port — capabilities for respawn controller management.
 * Route modules that control respawn cycling depend on this port.
 */

import type { Session } from '../../session.js';
import type { RespawnController, RespawnConfig } from '../../respawn-controller.js';
import type { PersistedRespawnConfig } from '../../types.js';

export interface RespawnPort {
  readonly respawnControllers: Map<string, RespawnController>;
  readonly respawnTimers: Map<string, { timer: NodeJS.Timeout; endAt: number; startedAt: number }>;
  setupRespawnListeners(sessionId: string, controller: RespawnController): void;
  setupTimedRespawn(sessionId: string, durationMinutes: number): void;
  restoreRespawnController(session: Session, config: PersistedRespawnConfig, source: string): void;
  saveRespawnConfig(sessionId: string, config: RespawnConfig, durationMinutes?: number): void;
}
