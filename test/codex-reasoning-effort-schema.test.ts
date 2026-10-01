/**
 * @fileoverview `codexConfig.reasoningEffort` on the create routes.
 *
 * The level becomes part of a `--config model_reasoning_effort=<level>` launch token, so the
 * schema admits only the words codex knows; anything else fails the request rather than
 * reaching the argv.
 */

import { describe, it, expect } from 'vitest';
import { CreateSessionSchema, QuickStartSchema } from '../src/web/schemas.js';
import { CODEX_REASONING_EFFORTS } from '../src/types/session.js';

describe('codexConfig.reasoningEffort', () => {
  it('accepts every level codex knows on both create routes', () => {
    for (const level of CODEX_REASONING_EFFORTS) {
      const created = CreateSessionSchema.parse({
        workingDir: '/tmp',
        mode: 'codex',
        codexConfig: { reasoningEffort: level },
      });
      expect(created.codexConfig?.reasoningEffort).toBe(level);
      const quick = QuickStartSchema.parse({
        caseName: 'work',
        mode: 'codex',
        codexConfig: { reasoningEffort: level },
      });
      expect(quick.codexConfig?.reasoningEffort).toBe(level);
    }
  });

  it('rejects a level codex does not know, and anything shaped like shell', () => {
    for (const reasoningEffort of ['bogus', 'HIGH', 'high; rm -rf /', '']) {
      expect(() =>
        CreateSessionSchema.parse({ workingDir: '/tmp', mode: 'codex', codexConfig: { reasoningEffort } })
      ).toThrow();
    }
  });
});
