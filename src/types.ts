/**
 * @fileoverview Convenience re-export of all type definitions.
 *
 * This root-level barrel allows shorter imports throughout the codebase:
 *   `import type { SessionState } from './types'`
 * instead of:
 *   `import type { SessionState } from './types/index.js'`
 *
 * All types are defined in `src/types/` domain modules — see `src/types/index.ts`
 * for the full module map and cross-domain relationship notes.
 */
export * from './types/index.js';
