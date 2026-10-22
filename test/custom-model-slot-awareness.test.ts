/**
 * @fileoverview Unit tests for the parallel-slot awareness of the custom-model context floor
 * (`perSlotContext` / `exceedsSafeContextFloor`, src/web/routes/custom-model-routes.ts).
 *
 * llama-server splits its context across `--parallel` slots (by default they share one
 * unified KV pool) and Claude Code sends concurrent requests, each carrying its own ~40k
 * tokens of system prompt and tools. Measured against a real llama-swap server: with 4 slots
 * sharing ~131k tokens, four simultaneous 40k-token requests all failed with HTTP 500
 * "Context size has been exceeded"; the same requests against one slot all succeeded.
 *
 * Port: N/A (pure functions, no server).
 */
import { describe, it, expect } from 'vitest';
import {
  CLAUDE_MIN_SAFE_CONTEXT_TOKENS,
  exceedsSafeContextFloor,
  perSlotContext,
} from '../src/web/routes/custom-model-routes.js';
import type { CliEntry } from '../src/config/cli-registry/types.js';

const withContextVar = {
  capabilities: { customModelInjection: { kind: 'env', contextLengthVar: 'CLAUDE_CODE_MAX_CONTEXT_TOKENS' } },
} as unknown as Pick<CliEntry, 'capabilities'>;
const withoutContextVar = {
  capabilities: { customModelInjection: { kind: 'env' } },
} as unknown as Pick<CliEntry, 'capabilities'>;

describe('perSlotContext', () => {
  it('divides the context across the slots', () => {
    expect(perSlotContext(131072, 4)).toBe(32768);
    expect(perSlotContext(262144, 4)).toBe(65536);
  });

  it('rounds down, since a fraction of a token is not usable', () => {
    expect(perSlotContext(100000, 3)).toBe(33333);
  });

  it.each([undefined, 0, 1, -2, Number.NaN, Number.POSITIVE_INFINITY])(
    'leaves the context whole for an unusable or single slot count (%s)',
    (slots) => {
      expect(perSlotContext(65536, slots as number | undefined)).toBe(65536);
    }
  );
});

describe('exceedsSafeContextFloor with a slot count', () => {
  it('divides only the context it is given, so a larger /props figure can never skip the warning', () => {
    // a --fit-ctx floor of 65,536 over 4 slots is 16,384 each, whatever /props might say about the server
    expect(exceedsSafeContextFloor(withContextVar, 65536, 4)).toBe(true);
    expect(exceedsSafeContextFloor(withContextVar, 65536, 1)).toBe(false);
    // the measured failure: ~131k over 4 slots is ~33k each
    expect(exceedsSafeContextFloor(withContextVar, 131072, 4)).toBe(true);
    expect(exceedsSafeContextFloor(withContextVar, 262144, 4)).toBe(false);
  });

  it('still warns when the context itself is below the minimum', () => {
    expect(exceedsSafeContextFloor(withContextVar, 16384, 4)).toBe(true);
    expect(exceedsSafeContextFloor(withContextVar, 16384, 1)).toBe(true);
  });

  it('keeps its existing behaviour when no slot count is given', () => {
    expect(exceedsSafeContextFloor(withContextVar, 16384)).toBe(true);
    expect(exceedsSafeContextFloor(withContextVar, CLAUDE_MIN_SAFE_CONTEXT_TOKENS)).toBe(false);
    expect(exceedsSafeContextFloor(withContextVar, undefined)).toBe(false);
  });

  it('flags a context that only clears the floor as a whole, not per slot', () => {
    expect(exceedsSafeContextFloor(withContextVar, 131072, 4)).toBe(true);
    expect(exceedsSafeContextFloor(withContextVar, 131072, 1)).toBe(false);
  });

  it('accepts exactly the floor per slot', () => {
    expect(exceedsSafeContextFloor(withContextVar, CLAUDE_MIN_SAFE_CONTEXT_TOKENS * 4, 4)).toBe(false);
    expect(exceedsSafeContextFloor(withContextVar, CLAUDE_MIN_SAFE_CONTEXT_TOKENS * 4 - 4, 4)).toBe(true);
  });

  it('never applies to a CLI that declares no context variable, whatever the slots', () => {
    expect(exceedsSafeContextFloor(withoutContextVar, 4096, 8)).toBe(false);
  });
});
