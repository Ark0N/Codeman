/**
 * @fileoverview Input shape for creating/updating a cron job. This is the
 * user-settable subset of `CronJob` (server-maintained bookkeeping fields
 * such as nextRunAt / lastStatus are excluded). Produced by the zod schema.
 */

import type { ConcurrencyPolicy, InputMode, PromptMode, ScheduleType } from '../types/cron.js';
import type { SessionMode } from '../types/session.js';

export interface CronJobInput {
  name: string;
  agentType: SessionMode;
  workingDir: string;
  launchCommand?: string;
  promptMode: PromptMode;
  promptText?: string;
  promptFilePath?: string;
  inputMode: InputMode;
  scheduleType: ScheduleType;
  runAt?: number;
  intervalMinutes?: number;
  dailyTime?: string;
  weeklyDays?: number[];
  weeklyTime?: string;
  enabled: boolean;
  notes?: string;
  concurrencyPolicy: ConcurrencyPolicy;
  /** Default true. Ignored for 'once' schedules. */
  autoClosePreviousSession?: boolean;
}
