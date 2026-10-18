/**
 * @fileoverview Port for the prompt-cache keep-warm scheduler (`prompt-cache-keepwarm.ts`).
 * Routes only ever trigger a re-evaluation; the rulebook and the timers stay in the service.
 */

import type { KeepWarmScheduler } from '../../prompt-cache-keepwarm.js';

export interface KeepWarmPort {
  readonly keepWarm: KeepWarmScheduler;
}
