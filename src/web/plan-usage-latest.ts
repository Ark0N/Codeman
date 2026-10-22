/**
 * @fileoverview Process-wide last-known plan-usage telemetry (account-global).
 *
 * The Claude status-telemetry route and the host Codex and Copilot polls merge their latest
 * values here. The SSE init snapshot (`getLightState`) replays the combined
 * value so the header "Plan Usage Limits" chip shows immediately on a fresh
 * page load / SSE reconnect — before either source emits another sample, and
 * without relying on per-browser localStorage.
 *
 * Null until the first telemetry of the process; cleared naturally on restart.
 *
 * @module plan-usage-latest
 */

let latest: Record<string, unknown> | null = null;

export function setLatestPlanUsage(value: Record<string, unknown>): Record<string, unknown> {
  // The Claude status route replaces the Claude part; the host-polled providers ride along.
  const codex = latest?.codex;
  const copilot = latest?.copilot;
  latest = {
    ...value,
    ...(codex !== undefined ? { codex } : {}),
    ...(copilot !== undefined ? { copilot } : {}),
  };
  return latest;
}

export function setLatestCodexPlanUsage(value: object | null): Record<string, unknown> {
  latest = { ...(latest ?? {}), codex: value };
  return latest;
}

export function setLatestCopilotPlanUsage(value: object | null): Record<string, unknown> {
  latest = { ...(latest ?? {}), copilot: value };
  return latest;
}

export function getLatestPlanUsage(): Record<string, unknown> | null {
  return latest;
}
