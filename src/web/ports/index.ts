/**
 * @fileoverview Barrel export for all port interfaces.
 *
 * Ports define the capabilities that route modules can depend on.
 * WebServer implements all ports; route modules declare only what they need
 * via TypeScript intersection types (e.g., SessionPort & EventPort).
 */

export type { SessionPort } from './session-port.js';
export type { EventPort } from './event-port.js';
export type { RespawnPort } from './respawn-port.js';
export type { ConfigPort } from './config-port.js';
export type { InfraPort, ScheduledRun } from './infra-port.js';
export type { AuthPort, AuthSessionRecord } from './auth-port.js';
