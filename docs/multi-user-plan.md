# Multi-User Mode: Design Plan

Status: **IMPLEMENTED on `feat/multiuser-mode`** (phases 1-5; opt-in, off by default). Target: opt-in multi-user support behind a `--multiuser` flag, with per-user case spaces and an admin panel for user management.

Shipped by phase:

- **Phase 1** (user store + mode plumbing + CLI): `src/user-store.ts` (scrypt, atomic 0600 writes, last-admin invariants, serialized read-modify-write), `src/config/multiuser.ts`, `codeman users add|passwd|list|rm`, `--multiuser` flag, bootstrap-on-first-boot. Tests: `test/user-store.test.ts`.
- **Phase 2** (multi-user auth): parallel async auth branch (`src/web/middleware/auth.ts`), `req.authUser`, per-username rate bucket, `mustChangePassword` lockbox, `GET /api/me` + `POST /api/me/password`, QR identity-bound minting, network-bind + tunnel exemptions, new error codes. Tests: `test/multiuser-auth.test.ts`.
- **Phase 3** (ownership threading): `Session.owner` at every create path + recovery mirror; `findSessionOrFail` owner check + list filtering; §6.3 permission policy (`resolveClaudeModeForUser` at all spawn sites incl. one-shots via `buildPromptArgs`; shell/launchCommand grant); per-user case spaces (`resolveCasesDir`) + owner-scoped case list + admin-only host CRUD; `workingDir` confinement; `sessionCapacityState` per-user cap. Tests: `test/ownership-scoping.test.ts`.
- **Phase 4** (event fan-out): WS owner gate; SSE per-client identity + `broadcast`/terminal-batch routing (`deriveSseHint`, fail-closed); `getLightState` per-identity filtering; file-route preview/thumbnail/history + `GET /api/search` scoping.
- **Phase 5** (admin API + frontend): `src/web/routes/admin-routes.ts` (user CRUD, one-time passwords, last-admin guards, session revoke/kill) + `src/web/admin-audit.ts`; `public/admin-ui.js` (identity boot, change-password modal + interceptor, admin Users tab). Tests: `test/admin-routes.test.ts`, `test/admin-ui.test.ts`.

Deferred follow-ups (documented, non-blocking): away-digest + subagent/workflow REST-list scoping, push-subscription identity/routing, per-user screenshot subdirs, `linked-cases.json` v2 owner field, `ScheduledRun.owner`, plan-orchestrator internal one-shot mode resolution, and a Playwright browser pass. Phase 6 (login form replacing Basic) remains out of scope.

## 1. Summary

Today Codeman is strictly single-user: one optional credential pair (`CODEMAN_USERNAME`/`CODEMAN_PASSWORD`), one shared `~/codeman-cases` folder, one global session list, and a global SSE/WS fan-out. This plan adds an opt-in **multi-user mode**:

- **Off by default.** Without the flag, behavior stays byte-identical to today (same auth path, same paths, same payloads). All new code is gated behind `isMultiUserMode()`.
- **`codeman web --multiuser`** (or `CODEMAN_MULTIUSER=1`) enables named users with individually hashed passwords stored in `~/.codeman/users.json`.
- **Each user gets their own space**: `~/codeman-users/<username>/cases/<case>` replaces the shared `~/codeman-cases` for that user. Sessions, cases, attachments, search, digests, and SSE events are scoped to their owner.
- **Admin panel** (App Settings, admin-only "Users" tab): create/delete users, change/reset passwords, enable/disable accounts, delete a user's space, see per-user live sessions and disk usage, force logout.

## 2. Threat Model (read first, be honest about this)

Multi-user mode is **workspace separation for a trusted team, NOT security isolation between mutually distrusting users**:

- Every session still runs as the **same OS account** with `claude --dangerously-skip-permissions`. Any user can ask their agent to `cat /home/<host>/codeman-users/otheruser/...`. The web layer enforces scoping; the agent layer cannot.
- **Shell sessions and custom launch commands are the bluntest holes**: `SessionMode = 'shell'` hands out a raw shell as the host account, and a cron job's `launchCommand` runs an arbitrary command; no Claude permission classifier is involved in either. These must be gated behind the same grant as bypass (section 6.3), otherwise the `auto`-mode mitigation below is theater.
- All sessions share one tmux socket (`-L codeman`), one `~/.claude` (transcripts, credentials, plan usage), one Claude subscription.
- Mitigation for stronger isolation: pair a user's cases with **Docker cases** (container per case, `docs/docker-cases.md`), or run separate Codeman instances per user (`CODEMAN_INSTANCE`, separate OS accounts). True per-user OS isolation is explicitly **out of scope** for this feature.
- Partial mitigation at the agent layer: non-admin users default to Claude's `auto` permission mode (section 6.3), whose safety classifier blocks destructive actions and credential exfiltration. That reduces, but does not eliminate, cross-user snooping; the `canBypassPermissions` grant reopens it and should be given deliberately.

This must be stated loudly in `docs/security-architecture.md`, the README section, and the admin panel UI ("Users share the host account; this separates workspaces, it does not sandbox users from each other").

Also note the flip side: multi-user mode strictly _improves_ today's network posture, because it removes the single shared password and gives every person their own revocable credential.

## 3. Activation and Mode Rules

| Condition                                                     | Behavior                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No flag (default)                                             | Exactly today's behavior. `users.json` is never read. Single-user auth via `CODEMAN_PASSWORD` if set.                                                                                                                                                                      |
| `--multiuser` / `CODEMAN_MULTIUSER=1`, `users.json` has users | Multi-user auth active. `CODEMAN_PASSWORD` is ignored for login (warn if set).                                                                                                                                                                                             |
| `--multiuser`, no `users.json` (first boot)                   | Bootstrap: if `CODEMAN_USERNAME`/`CODEMAN_PASSWORD` are set, create that user as the initial admin and continue. Otherwise refuse to start with instructions to run `codeman users add <name> --admin`. Never start multi-user with zero users (there would be no way in). |
| `--multiuser` on a non-loopback bind                          | Allowed without `CODEMAN_PASSWORD`: `server.ts start()` treats "multi-user with >= 1 enabled user" as satisfying the auth requirement in the loud-warning check (wire into the existing `isLoopbackBindHost()` branch).                                                    |
| Flag later removed                                            | Single-user mode again. Sessions/state that carry `owner` fields keep working (owner is simply ignored); user spaces remain on disk untouched.                                                                                                                             |

Plumbing: flag in `src/cli.ts` (web command), env in a new `src/config/multiuser.ts` exporting `isMultiUserMode()`. Per-instance like everything else: a beta instance (`CODEMAN_INSTANCE=beta`) has its own `users.json` via `dataPath()`.

## 4. Data Model and Disk Layout

### 4.1 `~/.codeman/users.json` (via `dataPath('users.json')`, mode 0600, atomic write: tmp + rename)

```jsonc
{
  "version": 1,
  "users": [
    {
      "username": "alice", // canonical lowercase slug
      "role": "admin", // "admin" | "user"
      "password": {
        "algo": "scrypt", // node:crypto scrypt, no new deps
        "N": 16384,
        "r": 8,
        "p": 1,
        "salt": "<hex 32B>",
        "hash": "<hex 64B>",
      },
      "disabled": false,
      "mustChangePassword": false, // set by admin reset; gates all API access until changed
      "canBypassPermissions": false, // permission-mode grant, see section 6.3; false for new users
      "createdAt": 1752900000000,
      "lastLoginAt": 1752900000000,
    },
  ],
}
```

- **Username rules**: `^[a-z0-9][a-z0-9_-]{1,31}$` (it becomes a folder name), stored lowercase, unique case-insensitively. Reserve `admin`? No: any name can be admin; role is a field, not a name.
- **Hashing**: `scrypt` from `node:crypto` with per-user salt, compared via `timingSafeEqual`. Params stored per record so they can be raised later; verify tolerates old params and rehashes on next successful login.
- New module `src/user-store.ts` (mirrors the `remote-hosts.ts` / `docker-hosts.ts` pattern): `readUsers()`, `writeUsers()`, `verifyPassword()`, `createUser()`, `setPassword()`, `deleteUser()`, plus pure helpers (`isValidUsername`, `hashPassword`) that are unit-testable without IO. In-process cache with short TTL like `readSettings`, invalidated on every write; the short TTL also covers the CLI (section 10) editing `users.json` while the server runs (cross-process changes picked up within the TTL).

### 4.2 User spaces

```
~/codeman-users/
  alice/
    cases/
      my-project/          <- same layout as today's ~/codeman-cases/<case>
  bob/
    cases/
```

- New helper in `route-helpers.ts`:
  `resolveCasesDir(user?: AuthUser): string`
  single-user mode: returns `CASES_DIR` (today's `~/codeman-cases`); multi-user: returns `join(USER_SPACES_DIR, user.username, 'cases')`, creating it lazily on first use.
- `CASES_DIR` stays exported for single-user code paths, but every route usage (see 6) switches to the resolver.
- The **user folder** (`~/codeman-users/<username>/`) is the deletion unit for "delete user + space" and leaves room for future per-user extras (uploads, exports) beside `cases/`.
- Legacy `~/codeman-cases` in multi-user mode: surfaces to admins only, as a read-only "Unassigned (legacy)" group in the case list, with an admin action `POST /api/admin/cases/assign { case, username }` that `fs.rename`s the folder into a user's space (same-filesystem move, cheap). No automatic migration.

## 5. Auth Pipeline Changes (`src/web/middleware/auth.ts`)

Keep the existing single-user branch untouched. Add a parallel multi-user branch selected once at registration time:

1. **Credential check**: Basic header parsed into `username:password`, verified against the user store (scrypt + `timingSafeEqual`). Disabled users fail closed.
2. **Cookie sessions**: same `codeman_session` cookie and `StaleExpirationMap`, but `AuthSessionRecord` gains `username` and `role`. All existing TTL/sliding/eviction logic reused. Eviction cap becomes per-user aware (evict oldest _of that user_ first) so one user cannot flush everyone's sessions by logging in 100 times.
3. **Request identity**: decorate `req.authUser = { username, role }` (Fastify decorateRequest). In single-user mode `req.authUser` is `{ username: 'admin', role: 'admin' }` when auth is on, and a synthetic admin when auth is off, so downstream code has ONE code path.
4. **Rate limiting**: keep the per-IP bucket; add a per-username failure bucket (same `StaleExpirationMap` pattern) so a botnet cannot brute-force one account across IPs, and one flaky user behind a NAT cannot lock out the rest.
5. **`mustChangePassword` gate**: when set, every API request except `GET /api/me`, `POST /api/me/password`, and static assets returns 403 with `errorCode: 'PASSWORD_CHANGE_REQUIRED'`; the frontend intercepts that code and shows the change-password modal.
6. **Password change vs Basic-auth caching**: browsers cache Basic credentials. After a password change we revoke all of that user's cookie sessions; the next request falls to Basic with stale creds, gets 401, and the browser re-prompts. Acceptable for v1; a proper login form is Phase 6 (see 15).
7. **Unchanged**: hook-secret loopback bypass (hooks authenticate the _instance_, not a user; the event maps to a session which has an owner), host guard, Origin/CSRF guard, security headers.
8. **WS upgrade identity** (`ws-routes.ts`): the global auth `onRequest` hook does run on the upgrade request (`@fastify/websocket` v11 runs hooks before the handshake; browsers send the session cookie), but the route handler itself only checks Host/Origin and never learns WHO authenticated. Multi-user: the handler reads the decorated `req.authUser` and closes 4003 unless owner or admin (section 6.4; identity plumbing lands in Phase 2, the owner check in Phase 4 once sessions have owners). Add a regression test that an upgrade with no credentials is rejected while auth is active: the handler-level Host/Origin gate alone must never be mistaken for auth.
9. **QR auth** (`/q/:code` redemption in `system-routes.ts`, minting in `tunnel-manager.ts`): today there is ONE global token, auto-rotated every 60s with a 90s grace window. A globally-rotating token cannot carry an identity (every logged-in user sees the same code), so multi-user mode replaces rotation with **on-demand minting**: an authenticated `POST /api/tunnel/qr` mints a single-use, short-TTL token bound to `req.authUser.username` (field on `QrTokenRecord`); redemption creates a cookie session for that user. Existing rate-limit buckets (`qrAuthFailures`, global `QR_RATE_LIMIT_MAX`) apply unchanged. Single-user mode keeps the rotating token.

New error codes in `src/types/api.ts`: `FORBIDDEN`, `PASSWORD_CHANGE_REQUIRED`, `USER_EXISTS`, `USER_NOT_FOUND`, `LAST_ADMIN`.

Role guard helper in `route-helpers.ts`: `requireAdmin(req, reply): boolean` used as the first line of every admin handler (403 `FORBIDDEN`), plus `requireOwnerOrAdmin(req, session)`.

## 6. Ownership Threading (the big refactor)

### 6.1 Sessions

- `Session` gains `owner?: string` (constructor option), persisted in `SessionState.owner`, included in `toState()`, round-tripped through recovery (`mux-sessions.json` entries carry it, `restoreMuxSessions` passes it back, exactly like `remote`/`docker`).
- Every session-creating path stamps the owner from `req.authUser`. Verified inventory of `new Session(...)` call sites: `POST /api/sessions` (session-routes.ts:444), `POST /api/quick-start` (:1956), `POST /api/run` one-shot (:1652), Ralph start (ralph-routes.ts:327), **cron** (cron-service.ts:352; `CronJob` gains `owner`, stamped at job create, launched as the job's owner), legacy `ScheduledRun` loop (server.ts:1603), plan generation + plan-orchestrator agents (plan-routes.ts:128, plan-orchestrator.ts:422/578; owner = requesting user), and recovery (server.ts:2225, next bullet). Two non-paths, also verified: **respawn never constructs a new Session** (it re-spawns the PTY on the same object, so `owner` survives automatically; no inheritance logic needed), and **orchestrator-loop creates no sessions** (it schedules work onto existing idle sessions via the task queue; its scoping requirement is different: it must only pick idle sessions owned by the goal's creator).
- Recovery: `owner` must ALSO be mirrored on `MuxSession` (mux-sessions.json) and read back mux-first like `remote`/`docker` (`muxSession.owner ?? savedState?.owner`, the server.ts:2246-2250 pattern), or a reboot erases ownership on the next persist.
- Every session-reading/mutating route filters: non-admin users only see and act on `session.owner === req.authUser.username`. Centralize in `findSessionOrFail` (route-helpers.ts:87; the owner check there covers the 6 route files that use it: system/session/respawn/ralph/file/plan-routes) and in the list endpoints (`GET /api/sessions`, `GET /api/sessions/unified`, `GET /api/status`). The Phase 3 audit must grep for BOTH `sessionManager.getSession` AND direct map access (`ctx.sessions.get(` / `.has(`): ws-routes and hook-event-routes reach sessions that way and bypass `findSessionOrFail`.
- Admins see everything; every session row carries `owner` so the UI can badge it.

### 6.2 Cases

- All `CASES_DIR` call sites switch to `resolveCasesDir(req.authUser)`: `case-routes.ts` (list/create/delete/CLAUDE.md scaffolding, name-collision checks, docker quickcreate), `session-routes.ts` (quick-start case resolution, the workingDir-inside-cases env-strip check), `ralph-routes.ts` (case path resolution), and `plan-routes.ts:231` (easy to miss). Case-name-to-path resolution is currently DUPLICATED (`resolveCasePath` in case-routes.ts:82 and an inline copy in quick-start, session-routes.ts:1846-1863); consolidate into one owner-aware resolver as part of this refactor instead of patching both copies.
- Registries that map case names to metadata become owner-scoped. `remote-cases.json`/`docker-cases.json` are arrays of objects, so entries simply gain `owner?: string` (absent = legacy: admin-only). `linked-cases.json` is a flat `Record<caseName, path>` with no room for a field: it needs a v2 shape (`{ "version": 2, "cases": { "<name>": { "path": "...", "owner": "..." } } }`) with read-time migration of the v1 form; it is read in two places (case-routes AND inline in quick-start), both must move to the new reader. Case names only need to be unique per user.
- **Remote hosts and Docker hosts are machine-level resources**: CRUD on `/api/docker-hosts` and remote-host endpoints becomes admin-only in multi-user mode; regular users can _use_ hosts on their own cases but not define them. (Docker containers exec as the host account; letting any user define arbitrary `docker run` args is admin-equivalent.)
- Case deletion, exports (`docker-exports/`), and imports check ownership; export filenames get an owner prefix to avoid collisions (fits the existing `^[a-zA-Z0-9._-]+\.tgz$` download guard).
- **Workspace confinement for non-admins (the linchpin, do not skip)**: today `POST /api/sessions` accepts ANY host directory as `workingDir` (the only check is `statSync().isDirectory()`, session-routes.ts:305-318), and file-routes/attachments confine reads to `session.workingDir`. Without a new rule the whole scoping story is circular: a user points a session at `~/codeman-users/bob` (or `/home`) and the web layer itself serves that subtree, no agent needed. Rule: in multi-user mode a non-admin's `workingDir` must realpath-resolve inside their own space, enforced at `POST /api/sessions`, `POST /api/run`, cron job create AND fire time (the dir can change owners between the two), and Ralph auto-configure. Admins are unrestricted. This one rule is what makes the section 6.4 file-route line ("own space or own sessions' workingDirs") meaningful.

### 6.3 Per-user Claude permission-mode policy

Codeman now ships a global **Startup Mode** picker (App Settings, Claude CLI tab: `settings.claudeMode`, values `dangerously-skip-permissions` (default) | `auto` | `normal` | `allowedTools`; `auto` emits `--permission-mode auto`, Anthropic's classifier-guarded low-prompt mode). Multi-user mode layers a per-user policy on top of it:

- **Default for regular users: `auto` only.** A non-admin's Claude sessions are forced to `--permission-mode auto` regardless of the global `claudeMode` setting. `normal` and `allowedTools` are also permitted (they are strictly more restrictive than auto), but `dangerously-skip-permissions` is NOT.
- **Bypass is an explicit admin grant**: `canBypassPermissions: true` on the user record (default `false`, section 4.1). Only with that grant does the global skip-permissions default (or a future per-user choice) apply to their sessions.
- **Admins** are unrestricted; the global setting applies to them as-is.
- **Single enforcement point**: a pure `resolveClaudeModeForUser(globalMode, user)` in `user-store.ts`, applied server-side at option-resolution time, BEFORE the Session constructor, so both downstream arg builders inherit it for free (`buildPermissionArgs` in session-cli-builder.ts for the direct-PTY path AND `buildClaudePermissionFlags` in tmux-manager.ts for tmux panes; there are two builders, not one). Call sites where `getClaudeModeConfig()` feeds a spawn: session-routes.ts:452/1964, ralph-routes.ts:334, cron-service.ts:360, and recovery (server.ts:2214/2233). Recovery re-reads the GLOBAL setting on reboot, so the resolver must run there with the RECOVERED owner, or a restart silently un-downgrades every restored session. Never resolved in the frontend, so it cannot be bypassed via payload.
- **Downgrade, don't error**: a non-granted user whose effective mode would be bypass gets `auto` silently (logged + surfaced as a badge on the session), so shared presets keep working.
- **Other CLIs' bypass equivalents** follow the same grant: Codex `--dangerously-bypass-approvals-and-sandbox` (`codexDangerouslyBypassApprovals`) and Gemini `--approval-mode yolo` are refused for non-granted users (Gemini falls back to `auto_edit`, Codex to its default sandbox). Whether this stays one grant or splits per-CLI is an open question (section 15).
- **Shell mode and custom launch commands follow the grant too**: `mode: 'shell'` sessions and cron `launchCommand` are arbitrary command execution as the host account, strictly stronger than any bypass flag, and no permission-mode downgrade applies to them. Non-granted users get 403 `FORBIDDEN` on shell session/quick-start creation and on cron jobs carrying `launchCommand` (checked at create AND at fire time). Folding them under `canBypassPermissions` keeps the model one-bit; section 15 asks whether it should split.
- **Admin UI**: a "Can skip permissions" toggle per user in the Users tab (PATCH field, section 8), with a warning echoing the section 2 threat model.
- Revoking the grant takes effect on the user's NEXT session start; live sessions are listed so the admin can restart them.

### 6.4 Everything else that lists or streams

| Surface                                                                    | Scoping rule                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SSE `/api/events`                                                          | Per-connection filter (see 7)                                                                                                                                                                                                                                                                                                                                                                                                                             |
| WS terminal (`ws-routes.ts`)                                               | Handler reads `req.authUser` (section 5.8) and closes 4003 unless owner or admin; today it checks Host/Origin only and has no identity                                                                                                                                                                                                                                                                                                                    |
| `GET /api/search`                                                          | `harvestSources()` only over owned sessions                                                                                                                                                                                                                                                                                                                                                                                                               |
| `GET /api/away-digest`                                                     | Aggregate only owned sessions/events                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `GET /api/subagents`, workflow runs                                        | Filter by owning session (`claudeSessionId -> session -> owner`); agents not attributable to any session: admin-only                                                                                                                                                                                                                                                                                                                                      |
| Push (`push-routes.ts`)                                                    | Subscription records currently carry NO identity (keyed by endpoint only): `subscribe` stamps `username`. All 8 `PUSH_EVENT_MAP` events are session-scoped, so routing = resolve owner from `data.sessionId`, deliver to that owner's (plus admins') subscriptions. Legacy identity-less subscriptions: admin-only delivery                                                                                                                               |
| Screenshots `/api/screenshots` (deprecated)                                | Deprecated: removed in a later MAJOR, so no per-user subdir is planned; the replacement `POST /api/sessions/:id/paste-image` is already session-scoped. Former plan: per-user subdir `~/.codeman/screenshots/<username>/` in multi-user mode. Note: `GET /:name` deliberately rejects `/` in names as traversal, so derive the subdir server-side from `req.authUser` and keep client-visible names flat                                                  |
| Attachments                                                                | Already session-scoped; inherits the session owner check. `attachmentConfineToWorkspace` is a global, default-OFF setting today: in multi-user mode it is FORCED ON for non-admins regardless of the setting (their attachments must resolve inside their own space); the setting keeps meaning what it means for admins                                                                                                                                  |
| File routes (browse/preview)                                               | Path allowlist adds: non-admin paths must resolve (realpath) inside their own space or their own sessions' workingDirs                                                                                                                                                                                                                                                                                                                                    |
| Settings (`settings.json`)                                                 | Global, admin-only writes in multi-user mode; reads allowed (per-device display keys stay in localStorage as today). Per-user server settings: out of scope v1                                                                                                                                                                                                                                                                                            |
| System ops (self-update, tunnel toggle, span-displays, docker image build) | Admin-only                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `getLightState` init snapshot                                              | Filtered per connection. Actual contents to filter (verified): `sessions`, `scheduledRuns`, `respawnStatus`, `subagents`, `workflowRuns`, `planUsage` (host-plan telemetry: admin-only); `globalStats` stays coarse-global. Cron jobs are NOT in the snapshot (they have their own REST route; filter there). The snapshot is cached process-wide (`LIGHT_STATE_CACHE_TTL_MS`): either key the cache per role/user or filter AFTER the cache on each send |

## 7. SSE Event Filtering

`/api/events` currently broadcasts everything to everyone. Ground truth first (verified): `broadcast()` lives in `SseStreamManager` (`sse-stream-manager.ts`), not server.ts; clients are keyed by the raw Fastify reply (`sseClients: Map<FastifyReply, Set<string> | null>`, plus `sseClientsById` for live filter updates); the existing `?sessions=` filter is a bandwidth optimization applied ONLY to `session:terminal` batches in `flushSessionTerminalBatch()`, while `broadcast()` itself loops ALL clients unconditionally. The single-client delivery primitive already exists (`sendSSE`, used for the per-connection init snapshot). Plan:

- At connection time, resolve `req.authUser` and store `{ username, role }` with the client. Concretely: extend `addClient(reply, sessionFilter, isRemote, clientId)` to take the identity and change the `sseClients` map value to `{ filter, identity }` (or add a parallel `Map<reply, identity>`); there is no per-client record object today to hang it on.
- `broadcast()` gains an optional routing hint: `broadcast(event, data, { sessionId?, adminOnly?, username? })`. Resolution order per client: admin sees all; `username` targets one user; `sessionId` resolves owner via SessionManager; `adminOnly` for machine-level events (docker image builds, tunnel, self-update); no hint = broadcast to all (connection status etc.).
- **Enforce the identity check in BOTH `broadcast()` AND `flushSessionTerminalBatch()`**: the terminal batch path does not go through `broadcast()`, and it carries the highest-value payload (raw terminal bytes).
- Sweep of the ~120 backend event constants in `sse-events.ts`: mechanically, everything `session:*`, `ralph:*`, `respawn:*`, `subagent:*`, `workflow:*`, `attachment:*`, `cron:*` (job owner) carries or can resolve a sessionId/owner; `docker:*`, `system:*`, tunnel and update events are adminOnly; a short tail needs case-by-case decisions during implementation.
- The existing `?sessions=` filter and `/api/events/subscribe` compose with (never override) the ownership filter: the subscription filter can only narrow within what the identity allows.

## 8. Admin API (`src/web/routes/admin-routes.ts`, new module + `AdminPort`)

All handlers: multi-user mode only (404 otherwise), `requireAdmin`, Zod schemas in `schemas.ts`, `ApiResponse` envelope, audit-logged.

| Endpoint                                         | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/admin/users`                           | List users + stats: role, disabled, createdAt, lastLoginAt, live session count, case count, space disk usage (best-effort async walk, cached 60s), active cookie-session count                                                                                                                                                                                                                                          |
| `POST /api/admin/users`                          | Create: `{ username, role, password? }`. No password given: generate a one-time password, return it ONCE in the response, set `mustChangePassword`                                                                                                                                                                                                                                                                      |
| `PATCH /api/admin/users/:username`               | `{ role?, disabled?, canBypassPermissions? }`. Demoting/disabling the last enabled admin: 409 `LAST_ADMIN`. Disable also revokes cookie sessions. `canBypassPermissions` is the section 6.3 grant (default false)                                                                                                                                                                                                       |
| `POST /api/admin/users/:username/reset-password` | Generates one-time password (returned once), sets `mustChangePassword`, revokes cookie sessions                                                                                                                                                                                                                                                                                                                         |
| `POST /api/admin/users/:username/logout`         | Revoke all cookie sessions for that user. Honest limit under Basic auth: the browser silently re-sends cached credentials and gets a fresh cookie on the next request, so logout only truly ends QR-issued sessions; to actually lock someone out, disable the account or reset the password. Say so in the panel tooltip until Phase 6                                                                                 |
| `DELETE /api/admin/users/:username`              | `{ deleteSpace?: boolean }` (default false). Refuses last admin. Kills the user's live sessions first (normal kill flow, incl. docker/remote teardown per case), revokes cookies, removes from store. With `deleteSpace`: guarded recursive delete of `~/codeman-users/<username>` (realpath must be inside `USER_SPACES_DIR`, top-level dir must not be a symlink), plus their registry entries and push subscriptions |
| `POST /api/admin/cases/assign`                   | Move a legacy `~/codeman-cases/<case>` into a user's space (`fs.rename`)                                                                                                                                                                                                                                                                                                                                                |
| Self-service `GET /api/me`                       | `{ username, role, mustChangePassword }` (works in single-user mode too: synthetic admin; the frontend uses it to decide whether to render admin UI)                                                                                                                                                                                                                                                                    |
| Self-service `POST /api/me/password`             | `{ currentPassword, newPassword }`, verifies current, min length 8, revokes other sessions, clears `mustChangePassword`                                                                                                                                                                                                                                                                                                 |

**Audit log**: append-only `~/.codeman/admin-audit.jsonl` (same idiom as `session-lifecycle.jsonl`): timestamp, acting admin, action, target, request IP. User management without an audit trail is not acceptable even for a homelab tool.

SSE additions (both `sse-events.ts` and `constants.js`): `admin:usersChanged` (adminOnly; the panel re-fetches) and `auth:passwordChangeRequired` (targeted to the user).

## 9. Frontend

- **`GET /api/me` on boot** (app.js init): stores `window.__codemanUser`; everything below keys off it. Single-user mode returns the synthetic admin, so the UI needs no mode awareness beyond "am I admin".
- **Admin panel**: new tab "Users" in the App Settings modal (settings-ui.js), rendered only for admins in multi-user mode. Table of users with actions (create, reset password showing the one-time password in a copy-to-clipboard reveal, enable/disable, role toggle, logout, delete with a typed-username confirm for the delete-space variant). No new header button (mobile header policy test stays green; the settings modal is already reachable everywhere).
- **Change-password modal**: shown on `PASSWORD_CHANGE_REQUIRED` (fetch interceptor in api-client.js) and reachable from settings for self-service.
- **Owner badges**: admin's session tabs and the session palette/manager show `owner` on foreign sessions; regular users see no change.
- New module `admin-ui.js` if the settings-ui.js addition gets large (load order after settings-ui, before session-ui), else keep inside settings-ui.js. Follow the `@fileoverview` + `@loadorder` convention either way.

## 10. CLI Additions (`src/cli.ts`)

Headless bootstrap and recovery must not require the web UI:

```
codeman users add <name> [--admin]     # prompts for password (hidden input), or --password-stdin
codeman users passwd <name>            # reset password
codeman users list
codeman users rm <name> [--delete-space]
```

These operate directly on `users.json` via `user-store.ts` (no server needed), honoring `CODEMAN_INSTANCE`. This is also the answer to "locked out: last admin forgot password".

## 11. Limits and Config

- New `src/config/multiuser.ts`: `isMultiUserMode()`, `USER_SPACES_DIR` (`~/codeman-users`, overridable via `CODEMAN_USER_SPACES_DIR` for tests), `MAX_USERS` (default 25), per-user session cap (default: global cap / 2, env `CODEMAN_MAX_SESSIONS_PER_USER`).
- Cap enforcement is currently COPY-PASTED: the global `MAX_CONCURRENT_SESSIONS` (50, `config/map-limits.ts:25`) check appears at 6 independent sites (session-routes.ts:298/1622/1683, ralph-routes.ts:275, cron-service.ts:340, server.ts:1595). Do not add a 7th copy per site: extract one `assertSessionCapacity(ctx, owner?)` helper doing the global + per-user checks and use it everywhere, or the per-user cap WILL miss a path.
- Global limits (50 sessions, SSE clients 100, terminal buffers) are unchanged and shared; the per-user session cap is the fairness lever.

## 12. Compatibility Matrix

| Concern            | Guarantee                                                                                                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default (no flag)  | No behavior change. No new file reads on the hot path. All new fields optional in state                                                                                                                     |
| State round-trip   | `SessionState.owner`, `MuxSession.owner`, `CronJob.owner`, registry `owner` fields are optional; old state loads clean; new state loaded by an old build ignores unknown fields (existing tolerant parsing) |
| Instance isolation | `users.json` and the audit log via `dataPath()`; user spaces dir is shared across instances like `~/codeman-cases` is today (documented)                                                                    |
| API versioning     | HTTP API is internal per `docs/versioning-policy.md`; still, all changes are additive. Ship as a **minor** version                                                                                          |
| Hooks              | Unchanged (instance-level hook secret; owner resolved from the session)                                                                                                                                     |

## 13. Implementation Phases

Each phase is independently shippable behind the flag and ends with its tests green.

**Phase 1: user store + mode plumbing** (no behavior change yet)
`src/user-store.ts`, `src/config/multiuser.ts`, CLI `users` subcommands, bootstrap-on-first-boot logic, `users.json` schema + atomic writes.
Tests: `test/user-store.test.ts` (hashing, verify, params upgrade, username validation, atomic write, last-admin invariants; pure, no server).

**Phase 2: multi-user auth**
Auth middleware branch, `req.authUser` decoration, cookie records with username/role, per-username rate bucket, `mustChangePassword` gate, WS upgrade identity plumbing + unauthenticated-upgrade regression test (section 5.8), QR on-demand minting + identity binding (section 5.9), `GET /api/me`, `POST /api/me/password`, error codes, network-bind check integration.
Tests: `test/multiuser-auth.test.ts` (live server, unique port 3170+; wrong password, disabled user, cookie carries identity, per-user rate limit isolation, mustChangePassword lockbox, QR redemption identity). Reuse the `delete process.env.CODEMAN_PASSWORD` idiom from `test/setup.ts`.

**Phase 3: ownership threading**
Session `owner` + persistence + `MuxSession` mirror + recovery; `resolveCasesDir()` refactor across case/session/ralph/plan routes (consolidating the duplicated case-path resolution); registry owner fields incl. the linked-cases v2 shape; `findSessionOrFail` owner check + the direct-`sessions.get` audit; list filtering; owner stamping across ALL create paths from 6.1; **non-admin workingDir confinement** (6.2); permission-mode/shell/launchCommand policy (6.3); `assertSessionCapacity` helper + per-user cap.
Tests: `test/routes/ownership-scoping.test.ts` (inject-based: user A cannot read/kill/input user B's session, case lists are disjoint, admin sees both), extend `test/cron-service.test.ts` for owner stamping, recovery round-trip in the existing mux-recovery tests.

**Phase 4: event fan-out + remaining surfaces**
SSE routing hints + client identity (enforced in BOTH `broadcast()` and the terminal-batch flush), WS owner gate (identity landed in Phase 2), search/digest/subagent/workflow scoping, push subscription identity + owner routing, screenshot subdirs, file-route scoping, `getLightState` filtering + per-identity caching, admin-only system ops.
Tests: `test/sse-ownership.test.ts` (two SSE clients, event for A's session reaches only A + admin), WS upgrade rejection test, search/digest scoping tests.

**Phase 5: admin API + frontend**
`admin-routes.ts` + `AdminPort` + schemas + audit log + `admin:usersChanged`; settings-ui Users tab, change-password modal, owner badges, api-client interceptor.
Tests: `test/routes/admin-routes.test.ts` (CRUD, last-admin 409, one-time password flow, delete-space guard rails incl. symlink refusal), frontend vm-sandbox test following `test/run-mode-ui.test.ts` pattern, Playwright pass per the always-end-to-end rule before calling it done.

**Phase 6 (optional, later): login page**
Replace Basic with a form + `POST /api/login` in multi-user mode only (fixes browser credential caching UX, enables logout button). Explicitly deferred; Basic works for v1.

**Docs**: update `docs/security-architecture.md` (new section: multi-user model + threat model from section 2), `README.md` (short opt-in section), `CLAUDE.md` (Key Patterns entry + State Files + route/SSE counts), this file gets a "shipped" status stamp per phase.

## 14. Key Risks / Decisions Made

1. **Not a security boundary at the agent layer** (section 2). Decided: ship with loud documentation; Docker cases are the isolation story.
2. **`findSessionOrFail` as the single enforcement point** for ~30 session routes: any route that fetches sessions another way must be audited in Phase 3 (grep for `sessionManager.getSession` outside route-helpers).
3. **SSE sweep is the riskiest surface**: a missed event leaks metadata (not terminal content, which is session-scoped, but names/paths). Phase 4 includes a checklist pass over all ~138 events with the default flipped to "owner-scoped unless explicitly global": fail closed.
4. **Basic-auth password-change UX** is mediocre (browser re-prompt). Accepted for v1; Phase 6 fixes it properly.
5. **Legacy case migration** is manual (admin assigns). No silent moves of user data.
6. **Case-name uniqueness becomes per-user**; tmux session names already include the session id so no collision, but the `w<n>-<case>` tab naming and lifecycle-log rows should include the owner for disambiguation in admin views.
7. **`workingDir` confinement (6.2) is the single most load-bearing rule**: every file-serving and agent-spawning surface downstream trusts `session.workingDir`. Review and test it as carefully as the auth branch (foreign-space path, symlink into a foreign space, `..` traversal, cron fire-time re-check).
8. **The WS handler never sees identity today** (auth happens only in the global hook): the 5.8 wiring is new code on a security-sensitive path; cover unauthenticated, foreign-user, and admin upgrades with tests.

## 15. Open Questions (answer before Phase 3)

1. Should admins' own cases live in `~/codeman-users/<admin>/cases` (symmetric, proposed) or keep using legacy `~/codeman-cases`? Proposed: symmetric; legacy dir is a migration source only.
2. Per-user settings (respawn presets, notification prefs): global-only in v1. Worth a `users/<name>/settings.json` overlay later?
3. Should regular users be allowed to create Docker cases on admin-defined hosts (proposed: yes) or is Docker entirely admin-only?
4. Session handoff: does an admin need "reassign session/case to another user"? (Cheap to add next to `cases/assign`; not in v1 scope.)
5. Permission-mode grants (section 6.3): one `canBypassPermissions` flag covering Claude/Codex/Gemini bypass equivalents PLUS shell mode and cron `launchCommand` (proposed: one flag, keep it one-bit), or split into `canBypassPermissions` + `canRunArbitraryCommands`? And should admins be able to set a per-user DEFAULT mode (for example force `normal` for an intern) rather than just gating bypass?
6. OpenCode has no single bypass flag (its permission config rides `OPENCODE_CONFIG_CONTENT`): decide what the grant means there before Phase 3, or exclude OpenCode mode for non-granted users in v1.
