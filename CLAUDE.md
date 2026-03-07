# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick Reference

| Task | Command |
|------|---------|
| Dev server | `npx tsx src/index.ts web` |
| Type check | `tsc --noEmit` |
| Lint | `npm run lint` (fix: `npm run lint:fix`) |
| Format | `npm run format` (check: `npm run format:check`) |
| Single test | `npx vitest run test/<file>.test.ts` |
| Production | `npm run build && systemctl --user restart codeman-web` |

## CRITICAL: Session Safety

**You may be running inside a Codeman-managed tmux session.** Before killing ANY tmux or Claude process:

1. Check: `echo $CODEMAN_MUX` - if `1`, you're in a managed session
2. **NEVER** run `tmux kill-session`, `pkill tmux`, or `pkill claude` without confirming
3. Use the web UI or `./scripts/tmux-manager.sh` instead of direct kill commands

## CRITICAL: Always Test Before Deploying

**NEVER COM without verifying your changes actually work.** For every fix:

1. **Backend changes**: Hit the API endpoint with `curl` and verify the response
2. **Frontend changes**: Use Playwright to load the page and assert the UI renders correctly. Use `waitUntil: 'domcontentloaded'` (not `networkidle` — SSE keeps the connection open). Wait 3-4s for polling/async data to populate, then check element visibility, text content, and CSS values
3. **Only after verification passes**, proceed with COM

The production server caches static files for 1 year (`maxAge: '1y'` in `server.ts`). After deploying frontend changes, users may need a hard refresh (Ctrl+Shift+R) to see updates.

## COM Shorthand (Deployment)

Uses [Semantic Versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`) via `@changesets/cli`.

When user says "COM":
1. **Determine bump type**: `COM` = patch (default), `COM minor` = minor, `COM major` = major
2. **Create a changeset file** (no interactive prompts). Write a `.md` file in `.changeset/` with a random filename:
   ```bash
   cat > .changeset/$(openssl rand -hex 4).md << 'CHANGESET'
   ---
   "aicodeman": patch
   ---

   Description of changes
   CHANGESET
   ```
   Replace `patch` with `minor` or `major` as needed. Include `"xterm-zerolag-input": patch` on a separate line if that package changed too.
3. **Consume the changeset**: `npm run version-packages` (bumps versions in `package.json` files and updates `CHANGELOG.md`)
4. **Sync CLAUDE.md version**: Update the `**Version**` line below to match the new version from `package.json`
5. **Commit and deploy**: `git add -A && git commit -m "chore: version packages" && git push && npm run build && systemctl --user restart codeman-web`

**Version**: 0.3.6 (must match `package.json`)

## Project Overview

Codeman is a Claude Code session manager with web interface and autonomous Ralph Loop. Spawns Claude CLI via PTY, streams via SSE, supports respawn cycling for 24+ hour autonomous runs.

**Tech Stack**: TypeScript (ES2022/NodeNext, strict mode), Node.js, Fastify, node-pty, xterm.js. Supports both Claude Code and OpenCode AI CLIs via pluggable CLI resolvers.

**TypeScript Strictness** (see `tsconfig.json`): `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `allowUnreachableCode: false`, `allowUnusedLabels: false`.

**Requirements**: Node.js 18+, Claude CLI, tmux

**Git**: Main branch is `master`. SSH session chooser: `sc` (interactive), `sc 2` (quick attach), `sc -l` (list).

## Additional Commands

`npm run dev` = dev server. Default port: `3000`. Commands not in Quick Reference:

| Task | Command |
|------|---------|
| Dev with TLS | `npx tsx src/index.ts web --https` |
| Continuous typecheck | `tsc --noEmit --watch` |
| Test coverage | `npm run test:coverage` |
| Production start | `npm run start` |
| Production logs | `journalctl --user -u codeman-web -f` |

**CI**: `.github/workflows/ci.yml` runs `typecheck`, `lint`, `format:check` on push to master (Node 22). Tests excluded (they spawn tmux).

**Code style**: Prettier (`singleQuote: true`, `printWidth: 120`, `trailingComma: "es5"`). ESLint flat config (`eslint.config.js`) allows `no-console`, warns on `@typescript-eslint/no-explicit-any`. Ignores: `app.js`, `scripts/**/*.mjs`, `src/web/public/vendor/**`, `tools/**`, `remotion/**`.

## Common Gotchas

- **Single-line prompts only** — `writeViaMux()` sends text+Enter separately; multi-line breaks Ink
- **ESM only** — Never `require()`, use `await import()`. `tsx` masks CJS/ESM issues in dev but production breaks
- **Package ≠ product name** — npm: `aicodeman`, product: **Codeman**. Release renames tags accordingly
- **Global regex `lastIndex`** — Use `createAnsiPatternFull/Simple()` factories, not shared `g`-flag patterns in loops

**Import conventions**: Utils from `./utils`, types from `./types` (barrel), config from specific `./config/*` files.

## Architecture

### Core Files (by domain)

| Domain | Key files | Notes |
|--------|-----------|-------|
| **Entry** | `src/index.ts`, `src/cli.ts` | |
| **Session** | `src/session.ts` ★, `src/session-manager.ts`, `src/session-auto-ops.ts`, `src/session-cli-builder.ts` | |
| **Mux** | `src/mux-interface.ts`, `src/mux-factory.ts`, `src/tmux-manager.ts` | |
| **Respawn** | `src/respawn-controller.ts` ★ + 4 helpers (`-adaptive-timing`, `-health`, `-metrics`, `-patterns`) | Read `docs/respawn-state-machine.md` first |
| **Ralph** | `src/ralph-tracker.ts` ★, `src/ralph-loop.ts` + 5 helpers (`-config`, `-fix-plan-watcher`, `-plan-tracker`, `-stall-detector`, `-status-parser`) | Read `docs/ralph-wiggum-guide.md` first |
| **Agents** | `src/subagent-watcher.ts` ★, `src/team-watcher.ts`, `src/bash-tool-parser.ts`, `src/transcript-watcher.ts` | |
| **AI** | `src/ai-checker-base.ts`, `src/ai-idle-checker.ts`, `src/ai-plan-checker.ts` | |
| **Tasks** | `src/task.ts`, `src/task-queue.ts`, `src/task-tracker.ts` | |
| **State** | `src/state-store.ts`, `src/run-summary.ts`, `src/session-lifecycle-log.ts` | |
| **Infra** | `src/hooks-config.ts`, `src/push-store.ts`, `src/tunnel-manager.ts`, `src/image-watcher.ts`, `src/file-stream-manager.ts` | |
| **Plan** | `src/plan-orchestrator.ts`, `src/prompts/*.ts`, `src/templates/claude-md.ts` | |
| **Web** | `src/web/server.ts`, `src/web/sse-events.ts`, `src/web/routes/*.ts` (12 route modules + barrel), `src/web/ports/*.ts`, `src/web/middleware/auth.ts`, `src/web/schemas.ts` | |
| **Frontend** | `src/web/public/app.js` ★ (~11.8K lines) + 10 JS modules (incl. `sw.js` service worker) | |
| **Types** | `src/types/index.ts` → 13 domain files | See `@fileoverview` in index.ts |

★ = Large file (>50KB). All files have `@fileoverview` JSDoc — read that before diving in.

**Local package**: `packages/xterm-zerolag-input/` — local echo overlay for xterm.js; copy embedded in `app.js`.

**Config**: `src/config/` — 9 files. Import from specific files, not barrel.

**Utilities**: `src/utils/` — re-exported via index. Key: `CleanupManager`, `LRUMap`, `StaleExpirationMap`, `BufferAccumulator`, `stripAnsi`, `Debouncer`.

### Data Flow

1. Session spawns `claude --dangerously-skip-permissions` via node-pty
2. PTY output buffered, ANSI stripped, parsed for JSON messages
3. WebServer broadcasts to SSE clients at `/api/events`
4. State persists to `~/.codeman/state.json` via StateStore

### Key Patterns

**Input**: `session.writeViaMux()` for programmatic input — tmux `send-keys -l` (literal) + `send-keys Enter`. Single-line only.

**Idle detection**: Multi-layer (completion message → AI check → output silence → token stability). See `docs/respawn-state-machine.md`.

**Hook events**: Claude Code hooks trigger via `/api/hook-event`. Key events: `permission_prompt`, `elicitation_dialog`, `idle_prompt`, `stop`, `teammate_idle`, `task_completed`. See `src/hooks-config.ts`.

**Agent Teams**: `TeamWatcher` polls `~/.claude/teams/`, matches to sessions via `leadSessionId`. Teammates are in-process threads appearing as subagents. Enable: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. See `agent-teams/`.

**Circuit breaker**: Prevents respawn thrashing. States: `CLOSED` → `HALF_OPEN` → `OPEN`. Reset: `/api/sessions/:id/ralph-circuit-breaker/reset`.

**Port interfaces**: Routes declare dependencies via port interfaces (`src/web/ports/`). Routes use intersection types (e.g., `SessionPort & EventPort`).

### Frontend

Frontend JS modules have `@fileoverview` with `@dependency`/`@loadorder` tags. Load order: `constants.js`(1) → `mobile-handlers.js`(2) → `voice-input.js`(3) → `notification-manager.js`(4) → `keyboard-accessory.js`(5) → `app.js`(6) → `ralph-wizard.js`(7) → `api-client.js`(8) → `subagent-windows.js`(9).

**Z-index layers**: subagent windows (1000), plan agents (1100), log viewers (2000), image popups (3000), local echo overlay (7).

**Respawn presets**: `solo-work` (3s/60min), `subagent-workflow` (45s/240min), `team-lead` (90s/480min), `ralph-todo` (8s/480min), `overnight-autonomous` (10s/480min).

**Keyboard shortcuts**: Escape (close), Ctrl+? (help), Ctrl+Enter (quick start), Ctrl+W (kill), Ctrl+Tab (next), Ctrl+K (kill all), Ctrl+L (clear), Ctrl+Shift+R (restore size), Ctrl/Cmd +/- (font).

### Security

| Layer | Details |
|-------|---------|
| **Auth** | Optional HTTP Basic via `CODEMAN_USERNAME`/`CODEMAN_PASSWORD` env vars |
| **QR Auth** | Single-use 6-char tokens (60s TTL) for tunnel login. See `docs/qr-auth-plan.md` |
| **Sessions** | 24h cookie (`codeman_session`), auto-extend, device context audit |
| **Rate limit** | 10 failed auth/IP → 429 (15min decay). QR has separate limiter |
| **Hook bypass** | `/api/hook-event` exempt from auth (localhost-only, schema-validated) |
| **Env vars** | `CODEMAN_MUX` (managed session), `CODEMAN_API_URL` (auto-set for hooks) |
| **Validation** | Zod schemas, path allowlist regex, `CLAUDE_CODE_*` env prefix allowlist |
| **Headers** | CORS localhost-only, CSP, X-Frame-Options, HSTS if HTTPS |

### SSE Event Registry

~100 event types in `src/web/sse-events.ts` (backend) and `SSE_EVENTS` in `constants.js` (frontend). Both must be kept in sync.

### API Routes

~111 handlers across 12 route files in `src/web/routes/`: system (35), sessions (24), ralph (9), plan (8), respawn (7), cases (7), files (5), mux (5), scheduled (4), push (4), teams (2), hooks (1). Each file has `@fileoverview` with endpoint details.

## Adding Features

- **API endpoint**: Types in `src/types/` domain file, route in `src/web/routes/*-routes.ts`, use `createErrorResponse()`. Validate with Zod schemas in `schemas.ts`.
- **SSE event**: Add to `src/web/sse-events.ts` + `SSE_EVENTS` in `constants.js`, emit via `broadcast()`, handle in `app.js` (`addListener(`)
- **Session setting**: Add to `SessionState`, include in `session.toState()`, call `persistSessionState()`
- **Hook event**: Add to `HookEventType`, add hook in `hooks-config.ts:generateHooksConfig()`, update `HookEventSchema`
- **Mobile feature**: Add to relevant singleton, guard with `MobileDetection.isMobile()`
- **New test**: Pick unique port (search `const PORT =`). Route tests use `app.inject()` (no port needed) — see `test/routes/_route-test-utils.ts`.

**Validation**: Zod v4 (different API from v3). Define schemas in `schemas.ts`, use `.parse()`/`.safeParse()`.

## State Files

All in `~/.codeman/`: `state.json` (sessions, settings, respawn), `mux-sessions.json` (tmux recovery), `settings.json` (user prefs), `push-keys.json` (VAPID), `push-subscriptions.json`, `session-lifecycle.jsonl` (audit log).

## Testing

**CRITICAL: You are running inside a Codeman-managed tmux session.** Never run `npx vitest run` (full suite) — it spawns/kills tmux sessions and will crash your own session. Only run individual files:

```bash
npx vitest run test/<specific-file>.test.ts     # Single file (SAFE)
npx vitest run -t "pattern"                      # By name (SAFE)
# npx vitest run                                 # DANGEROUS — DON'T DO THIS
```

**Config**: Vitest with `globals: true`, `fileParallelism: false`. Timeout 30s, teardown 60s.

**Safety**: `test/setup.ts` snapshots pre-existing tmux sessions and never kills them. Only `registerTestTmuxSession()` sessions get cleaned up.

**Ports**: Pick unique ports manually. Search `const PORT =` before adding new tests.

**Respawn tests**: Use `MockSession` from `test/respawn-test-utils.ts`. **Route tests**: `app.inject()` in `test/routes/`. **Mobile tests**: Playwright suite in `mobile-test/` (135 device profiles).

## Screenshots

Mobile screenshots in `~/.codeman/screenshots/`. API: `GET /api/screenshots`, `POST /api/screenshots`.

## Debugging

```bash
tmux list-sessions                                 # List tmux sessions
curl localhost:3000/api/sessions | jq              # Check sessions
curl localhost:3000/api/status | jq                # Full app state
curl localhost:3000/api/subagents | jq             # Background agents
cat ~/.codeman/state.json | jq                     # Persisted state
```

## Performance & Limits

Target: 20 sessions, 50 agent windows at 60fps. Limits in `src/config/`: terminal 2MB, text 1MB, messages 1000, max agents 500, max sessions 50, max SSE clients 100. Use `LRUMap` for bounded caches, `StaleExpirationMap` for TTL cleanup. Anti-flicker pipeline: `docs/terminal-anti-flicker.md`.

## References

Deep-dive docs in `docs/`: `respawn-state-machine.md`, `ralph-wiggum-guide.md`, `claude-code-hooks-reference.md`, `terminal-anti-flicker.md`, `opencode-integration.md`, `qr-auth-plan.md`. Agent Teams: `agent-teams/README.md`. SSE events: `src/web/sse-events.ts` + `constants.js`.

## Scripts

Key: `scripts/tmux-manager.sh` (safe tmux mgmt), `scripts/tunnel.sh` (tunnel start/stop/url). Production: `scripts/codeman-web.service`, `scripts/codeman-tunnel.service`.

## Memory Leak Prevention

24+ hour sessions: use `CleanupManager`, clear Maps in `stop()`, guard async with `if (this.cleanup.isStopped) return`. Frontend: store handler refs, clean in `close*()`. Verify: `npx vitest run test/memory-leak-prevention.test.ts`.

## Common Workflows

**Bug investigation**: Dev server → reproduce in browser → check terminal + `~/.codeman/state.json`.
**Respawn changes**: Read `docs/respawn-state-machine.md` first. Use `MockSession` from `test/respawn-test-utils.ts`.

## Tunnel

`./scripts/tunnel.sh start|stop|url`. **Always set `CODEMAN_PASSWORD`** before exposing via tunnel.
