# Repository Guidelines

Canonical agent/contributor guidance for this repository lives in [CLAUDE.md](CLAUDE.md) —
project structure, build/test/lint commands, code style, testing safety rules
(`npm test` is the CI gate and is safe to run bare; the three excluded suites
have their own runners), security notes, and
the deployment workflow are all maintained there. Please read it before making
changes, and keep it the single source of truth rather than duplicating
sections here.

Quick pointers:

- Type check: `tsc --noEmit` · Lint: `npm run lint` · Format: `npm run format:check`
- Tests: `npm test` (the CI gate, safe to run bare) or `npm test -- test/<file>.test.ts` for one file
- Route tests use `app.inject()`; new tests needing a socket bind port 0 (`new WebServer(0, …)` + `boundPort`); mobile tests use `createTestServer()` and read `server.boundPort`
- Branch off `master` for all work; Conventional Commit-style messages (`fix(mobile): ...`)
- Never commit secrets or local state from `~/.codeman/`
