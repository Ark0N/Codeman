/**
 * @fileoverview Config port — capabilities for app configuration and settings.
 * Route modules that read or modify configuration depend on this port.
 */

import type { ClaudeMode, NiceConfig } from '../../types.js';
import type { StateStore } from '../../state-store.js';

export interface ConfigPort {
  readonly store: StateStore;
  readonly port: number;
  readonly https: boolean;
  readonly testMode: boolean;
  readonly serverStartTime: number;
  getGlobalNiceConfig(): Promise<NiceConfig | undefined>;
  getModelConfig(): Promise<{ defaultModel?: string; agentTypeOverrides?: Record<string, string> } | null>;
  getClaudeModeConfig(): Promise<{ claudeMode?: ClaudeMode; allowedTools?: string }>;
  getDefaultClaudeMdPath(): Promise<string | undefined>;
  getLightState(): unknown;
  startTranscriptWatcher(sessionId: string, transcriptPath: string): void;
  stopTranscriptWatcher(sessionId: string): void;
}
