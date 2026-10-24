/**
 * Bare `vitest` / `npx vitest run` (no `--config`) resolves THIS file. Without it there is no
 * config at all, so no `setupFiles`: `test/setup.ts` never runs, HOME is not redirected, and the
 * suite reads and writes the developer's real `~/.codeman` (settings, clis.json, users.json,
 * .env, ...). It points at the CI gate so the default invocation is always the isolated one;
 * `npm test`, `test:browser`, `test:mobile` and `test:perf` still pass their own `--config`.
 */
export { default } from './config/vitest.ci.config';
