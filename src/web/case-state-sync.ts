/**
 * @fileoverview Pure helpers for the opt-in shared per-case run options (`caseSettings` in
 * settings.json, written while `syncCaseState` is on). They run inside `mutateSettingsFile()`, so
 * every change is serialised with the file's other writers: two devices saving different cases
 * both land, where a replacement map would let the second discard the first.
 */

export interface CaseRunOptions {
  agentTeams: boolean;
  opusContext1m: boolean;
}

/** Most cases the shared map holds, counted after a merge (the schema bounds one request, not the file). */
export const MAX_SHARED_CASES = 500;

export class SharedCaseLimitError extends Error {
  constructor() {
    super(`Shared case options are limited to ${MAX_SHARED_CASES} cases`);
    this.name = 'SharedCaseLimitError';
  }
}

function asMap(value: unknown): Record<string, CaseRunOptions> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, CaseRunOptions>) : {};
}

/** The stored map with `incoming` merged in per case. Throws SharedCaseLimitError past the limit. */
export function mergeCaseSettings(current: unknown, incoming: Record<string, CaseRunOptions>) {
  const merged = { ...asMap(current), ...incoming };
  if (Object.keys(merged).length > MAX_SHARED_CASES) throw new SharedCaseLimitError();
  return merged;
}

/** The map with `from` moved to `to`, or null when there is nothing to move. */
export function renameCaseSettings(current: unknown, from: string, to: string) {
  const map = asMap(current);
  if (!Object.hasOwn(map, from)) return null;
  const { [from]: moved, ...rest } = map;
  return { ...rest, [to]: moved };
}

/** The map without `name`, or null when it has no entry for it. */
export function dropCaseSettings(current: unknown, name: string) {
  const map = asMap(current);
  if (!Object.hasOwn(map, name)) return null;
  const { [name]: _gone, ...rest } = map;
  return rest;
}
