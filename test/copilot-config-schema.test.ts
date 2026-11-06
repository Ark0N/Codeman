/**
 * @fileoverview copilotConfig on the session create body: `model` and `resumeSessionId` follow a flag
 * (`--model`, `--resume`), so a value that starts with `-` would be read as its own flag and get
 * around the allowAll clamp. Both need a leading letter or digit.
 */

import { describe, it, expect } from 'vitest';
import { CreateSessionSchema } from '../src/web/schemas.js';

const parse = (copilotConfig: unknown) =>
  CreateSessionSchema.safeParse({ workingDir: '/tmp', mode: 'copilot', copilotConfig });

describe('copilotConfig schema', () => {
  it.each(['--yolo', '-n', '--allow-all-tools', '.hidden', '/etc/passwd'])('rejects model %s', (model) => {
    expect(parse({ model }).success).toBe(false);
  });

  it.each(['--yolo', '-n', '--allow-all-tools'])('rejects resumeSessionId %s', (resumeSessionId) => {
    expect(parse({ resumeSessionId }).success).toBe(false);
  });

  it.each(['auto', 'claude-sonnet-5.5', 'openai/gpt-5'])('accepts model %s', (model) => {
    expect(parse({ model }).success).toBe(true);
  });
});
