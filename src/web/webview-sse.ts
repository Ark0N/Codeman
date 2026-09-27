/** @fileoverview Trusted owner routing metadata for saved-webview invalidations. */
import type { SseRoutingHint } from './sse-stream-manager.js';

export function deriveWebviewSseHint(data: unknown): SseRoutingHint {
  return { username: (data as { owner?: string }).owner, sessionScoped: true };
}
