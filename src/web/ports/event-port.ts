/**
 * @fileoverview Event port — capabilities for broadcasting events to SSE clients.
 * Route modules that need to notify the frontend depend on this port.
 */

import type { BackgroundTask } from '../../session.js';

export interface EventPort {
  broadcast(event: string, data: unknown): void;
  sendPushNotifications(event: string, data: Record<string, unknown>): void;
  batchTerminalData(sessionId: string, data: string): void;
  broadcastSessionStateDebounced(sessionId: string): void;
  batchTaskUpdate(sessionId: string, task: BackgroundTask): void;
}
