/** @fileoverview Merging Claude status-line usage with polled Codex usage. */

import { expect, it } from 'vitest';
import * as latestModule from '../src/web/plan-usage-latest.js';

it('preserves the Codex row when a later Claude status-line sample arrives', () => {
  const module = latestModule as Record<string, unknown>;
  expect(module.setLatestCodexPlanUsage).toBeTypeOf('function');
  const setCodex = module.setLatestCodexPlanUsage as (value: unknown) => unknown;
  const setClaude = module.setLatestPlanUsage as (value: Record<string, unknown>) => unknown;

  setCodex({ sevenDay: { usedPercentage: 40, resetAt: 3000 } });
  expect(setClaude({ sessionId: 's1', fiveHour: { usedPercentage: 97, resetAt: 1000 } })).toEqual({
    sessionId: 's1',
    fiveHour: { usedPercentage: 97, resetAt: 1000 },
    codex: { sevenDay: { usedPercentage: 40, resetAt: 3000 } },
  });
});

it('preserves the Copilot row when a later Claude status-line sample arrives', () => {
  const module = latestModule as Record<string, unknown>;
  const setCopilot = module.setLatestCopilotPlanUsage as (value: unknown) => unknown;
  const setClaude = module.setLatestPlanUsage as (value: Record<string, unknown>) => unknown;

  setCopilot({ monthly: { usedPercentage: 12, resetAt: 5000, used: 36, limit: 300 } });
  expect(setClaude({ sessionId: 's2', fiveHour: { usedPercentage: 50, resetAt: 2000 } })).toMatchObject({
    sessionId: 's2',
    fiveHour: { usedPercentage: 50, resetAt: 2000 },
    copilot: { monthly: { usedPercentage: 12, resetAt: 5000, used: 36, limit: 300 } },
  });
});
