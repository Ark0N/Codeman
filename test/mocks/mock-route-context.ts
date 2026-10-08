/**
 * Mock context for route handler testing.
 *
 * Satisfies ALL port interfaces (SessionPort, EventPort, RespawnPort,
 * ConfigPort, InfraPort, AuthPort) so any route module can be tested.
 * Override specific methods in individual tests as needed.
 *
 * Uses app.inject() — no real HTTP ports needed.
 */
import { vi } from 'vitest';
import { MockSession, createMockSession } from './mock-session.js';
import { resolveTerminalHistoryConfig } from '../../src/config/terminal-history.js';

/**
 * Creates a mock context that satisfies all port interfaces.
 * Pre-populated with one session for convenience.
 */
export function createMockRouteContext(options?: {
  sessionId?: string;
  agentSkillEnabled?: boolean;
  claudeVoiceEnabled?: boolean;
  workspaceHooksEnabled?: boolean;
}) {
  const sessionId = options?.sessionId ?? 'test-session-1';
  const session = createMockSession(sessionId);
  const sessions = new Map<string, MockSession>();
  sessions.set(sessionId, session);

  // Stateful backing for the global tab order (COD-131) so route tests can
  // assert that setSessionOrder() actually persists what the handler computed.
  let sessionOrder: string[] = [];

  return {
    // -- SessionPort --
    sessions,
    addSession: vi.fn(async (s: MockSession) => {
      sessions.set(s.id, s);
    }),
    tabLayouts: {
      get: vi.fn(),
      put: vi.fn(),
      putLegacyOrder: vi.fn(async (_actor: unknown, order: readonly string[]) => ({
        order: [...order],
        changedOwnerOrders: {},
        globalOrder: [...order],
        globalChanged: false,
      })),
      sessionCreated: vi.fn(),
      webviewCreated: vi.fn(),
      sessionsRemoved: vi.fn(async () => {}),
      webviewDeleted: vi.fn(async () => {}),
      markRestorationComplete: vi.fn(),
      markRestorationFailed: vi.fn(),
      markRestorationSkipped: vi.fn(),
      assertDeletionReady: vi.fn(),
      runSessionDeletion: vi.fn(async (_removed, action) => action()),
      runStaleSessionCleanup: vi.fn(async (_activeIds, action) => action(new Set())),
      reconcileAfterRestoration: vi.fn(async () => {}),
    },
    cleanupSession: vi.fn(async () => {}),
    setupSessionListeners: vi.fn(async () => {}),
    persistSessionState: vi.fn(),
    persistSessionStateNow: vi.fn(),
    reapplyPersistedSessionState: vi.fn(async () => {}),
    discardPartiallyBuiltSession: vi.fn(async (id: string) => {
      sessions.delete(id);
    }),
    getSessionStateWithRespawn: vi.fn((s: MockSession) => s.toState()),

    // -- EventPort --
    broadcast: vi.fn(),
    sendPushNotifications: vi.fn(),
    batchTerminalData: vi.fn(),
    broadcastSessionStateDebounced: vi.fn(),
    batchTaskUpdate: vi.fn(),
    getSseClientCount: vi.fn(() => 0),

    // -- RespawnPort --
    respawnControllers: new Map(),
    respawnTimers: new Map(),
    setupRespawnListeners: vi.fn(),
    setupTimedRespawn: vi.fn(),
    restoreRespawnController: vi.fn(),
    saveRespawnConfig: vi.fn(),

    // -- ConfigPort --
    store: {
      getConfig: vi.fn(() => ({ ralphEnabled: false, maxConcurrentSessions: 5 })),
      getSessions: vi.fn(() => ({})),
      getSession: vi.fn(),
      setSession: vi.fn(),
      removeSession: vi.fn(),
      demoteOrRemoveSession: vi.fn(() => 'removed' as const),
      getSettings: vi.fn(() => ({})),
      setSettings: vi.fn(),
      getRalphLoopState: vi.fn(() => ({})),
      setRalphLoopState: vi.fn(),
      getTasks: vi.fn(() => ({})),
      save: vi.fn(),
      load: vi.fn(),
      incrementSessionsCreated: vi.fn(),
      setConfig: vi.fn(),
      getSessionOrder: vi.fn(() => sessionOrder),
      setSessionOrder: vi.fn((order: string[]) => {
        sessionOrder = order;
      }),
      getAggregateStats: vi.fn(() => ({ totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0 })),
      getGlobalStats: vi.fn(() => ({ sessionsCreated: 0 })),
      getDailyStats: vi.fn(() => []),
      cleanupStaleSessions: vi.fn(() => ({ count: 0, cleaned: [] })),
      cleanupSessionsByIds: vi.fn(() => ({ count: 0, cleaned: [] })),
    },
    port: 3000,
    https: false,
    testMode: true,
    serverStartTime: Date.now(),
    getGlobalNiceConfig: vi.fn(async () => undefined),
    getModelConfig: vi.fn(async () => null),
    getClaudeModeConfig: vi.fn(async () => ({})),
    getTerminalHistoryConfig: vi.fn(async () => resolveTerminalHistoryConfig({})),
    // Default OFF mirrors the shipped setting, so existing tests never touch a
    // case's .claude/skills. Overridable per test because the create-time
    // injection call sites are otherwise unreachable from a route test.
    getAgentSkillEnabled: vi.fn(async () => options?.agentSkillEnabled ?? false),
    // Default OFF mirrors the shipped setting: no test opens a voice relay by accident.
    getClaudeVoiceEnabled: vi.fn(async () => options?.claudeVoiceEnabled ?? false),
    // Default ON mirrors the shipped setting, so a route test sees what a user sees.
    // Writes land in the test's temp working dir, never in a real repo.
    getWorkspaceHooksEnabled: vi.fn(async () => options?.workspaceHooksEnabled ?? true),
    getDefaultClaudeMdPath: vi.fn(async () => undefined),
    getLightState: vi.fn(() => ({ sessions: [], status: 'ok' })),
    getLightSessionsState: vi.fn(() => {
      const result: Record<string, unknown>[] = [];
      for (const s of sessions.values()) {
        result.push(s.toState());
      }
      return result;
    }),
    startTranscriptWatcher: vi.fn(),
    stopTranscriptWatcher: vi.fn(),
    getTranscriptPath: vi.fn(() => null),
    getRemoteClaudeSyncStatus: vi.fn(() => []),
    runRemoteClaudeSyncNow: vi.fn(async () => {}),
    getReadMyMindModel: vi.fn(async () => 'claude-opus-4-5-20251101'),

    // -- InfraPort --
    mux: {
      muxSocket: 'codeman',
      createSession: vi.fn(),
      killSession: vi.fn(),
      listSessions: vi.fn(() => []),
      getStats: vi.fn(() => ({})),
      updateSessionName: vi.fn(() => true),
      getSession: vi.fn(() => null),
      clearRespawnConfig: vi.fn(),
      updateRespawnConfig: vi.fn(),
      setHistoryLimit: vi.fn(async () => {}),
      startStatsCollection: vi.fn(),
    },
    runSummaryTrackers: new Map(),
    activePlanOrchestrators: new Map(),
    scheduledRuns: new Map(),
    teamWatcher: { getTeams: vi.fn(() => []), getTeamTasks: vi.fn(() => []), hasActiveTeammates: vi.fn(() => false) },
    tunnelManager: null,
    pushStore: null,
    startScheduledRun: vi.fn(),
    stopScheduledRun: vi.fn(),

    // -- AuthPort --
    authSessions: null,
    qrAuthFailures: null,
    // https already declared above in ConfigPort (shared property)

    // -- OrchestratorPort --
    orchestratorLoop: null,
    initOrchestratorLoop: vi.fn(),

    // Convenience accessors (not part of any port interface)
    _session: session,
    _sessionId: sessionId,
  };
}

export type MockRouteContext = ReturnType<typeof createMockRouteContext>;
