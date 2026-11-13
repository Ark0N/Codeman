/**
 * @fileoverview Infra port — capabilities for infrastructure services.
 * Route modules that interact with mux, push, teams, tunnel, etc. depend on this port.
 */

import type { TerminalMultiplexer } from '../../mux-interface.js';
import type { RunSummaryTracker } from '../../run-summary.js';
import type { PlanOrchestrator } from '../../plan-orchestrator.js';
import type { TeamWatcher } from '../../team-watcher.js';
import type { TunnelManager } from '../../tunnel-manager.js';
import type { PushSubscriptionStore } from '../../push-store.js';

/** A scheduled autonomous run with session lifecycle management */
export interface ScheduledRun {
  id: string;
  prompt: string;
  workingDir: string;
  durationMinutes: number;
  startedAt: number;
  endAt: number;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  sessionId: string | null;
  completedTasks: number;
  totalCost: number;
  logs: string[];
  /** Multi-user owner (username) — undefined in single-user mode. Used to scope
   * list/delete and to downgrade the spawned Session's permission mode. */
  owner?: string;
}

export interface InfraPort {
  readonly mux: TerminalMultiplexer;
  readonly runSummaryTrackers: Map<string, RunSummaryTracker>;
  readonly activePlanOrchestrators: Map<string, PlanOrchestrator>;
  readonly scheduledRuns: Map<string, ScheduledRun>;
  readonly teamWatcher: TeamWatcher;
  readonly tunnelManager: TunnelManager;
  /** `--allow-unauthenticated-tunnel` was passed to `codeman web` (the env var is read per request, #706). */
  readonly allowUnauthenticatedTunnel: boolean;
  readonly pushStore: PushSubscriptionStore;
  startScheduledRun(prompt: string, workingDir: string, durationMinutes: number, owner?: string): Promise<ScheduledRun>;
  stopScheduledRun(id: string): Promise<void>;
}
