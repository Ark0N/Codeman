/**
 * @fileoverview Config port — capabilities for app configuration and settings.
 * Route modules that read or modify configuration depend on this port.
 */

import type { ClaudeMode, NiceConfig } from '../../types.js';
import type { StateStore } from '../../state-store.js';
import type { TerminalHistoryConfig } from '../../config/terminal-history.js';

export interface ConfigPort {
  readonly store: StateStore;
  readonly port: number;
  readonly https: boolean;
  readonly testMode: boolean;
  readonly serverStartTime: number;
  getGlobalNiceConfig(): Promise<NiceConfig | undefined>;
  getModelConfig(): Promise<{ defaultModel?: string; agentTypeOverrides?: Record<string, string> } | null>;
  getClaudeModeConfig(): Promise<{ claudeMode?: ClaudeMode; allowedTools?: string }>;
  getTerminalHistoryConfig(): Promise<TerminalHistoryConfig>;
  /** Synced `agentSkillEnabled` app setting (default OFF); gates per-case agent-skill injection. */
  getAgentSkillEnabled(): Promise<boolean>;
  /** Synced `workspaceHooksEnabled` app setting (default ON); gates INSTALLING hooks into a session's workspace. */
  getWorkspaceHooksEnabled(): Promise<boolean>;
  /** Synced `claudeVoiceEnabled` app setting (default OFF); gates the Claude voice dictation relay. */
  getClaudeVoiceEnabled(): Promise<boolean>;
  getDefaultClaudeMdPath(): Promise<string | undefined>;
  getLightState(identity?: { username: string; role: 'admin' | 'user' }): unknown;
  getLightSessionsState(): unknown[];
  startTranscriptWatcher(sessionId: string, transcriptPath: string): void;
  stopTranscriptWatcher(sessionId: string): void;
  /**
   * Transcript JSONL path from the session's live watcher, or null (no hook
   * has fired yet / not a claude-mode session). Read My Mind's transcript
   * collector tail-reads this file for prediction context.
   */
  getTranscriptPath(sessionId: string): string | null;
  /** Read My Mind predictor model: the `readMyMindModel` setting, defaulting to AI_CHECK_MODEL. */
  getReadMyMindModel(): Promise<string>;
}
