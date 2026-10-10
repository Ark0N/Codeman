# Cron Jobs — User & Operator Guide

Codeman's **Cron** feature lets you save named, recurring jobs that automatically
spin up a Claude (or shell / OpenCode / Codex / Antigravity / Gemini / Pi) session on a schedule and
feed it a prompt. Think "cron for agent sessions": _"every weekday at 3am, open a
Claude session in `~/proj` and tell it to update dependencies and open a PR."_

- **UI**: the **⏰ Cron** button in the bottom toolbar → the Cron Jobs modal (`#cronModal`).
- **API**: `/api/cron/jobs*` and `/api/cron/runs`.
- **Code**: `src/cron/cron-service.ts`, `src/cron/cron-time.ts`, `src/cron/cron-input.ts`,
  types in `src/types/cron.ts`, routes in `src/web/routes/cron-routes.ts`,
  frontend in `src/web/public/cron-ui.js`.

> **Not to be confused with `ScheduledRun` (`/api/scheduled`).** That older,
> deliberately-separate concept is a _run-now, duration-bounded autonomous loop_
> (`{prompt, workingDir, durationMinutes}` → spawn/kill throwaway sessions until
> the duration elapses). It has no recurrence, no saved jobs, and no next-run
> calculation. The two systems never interact. This guide is only about **Cron
> jobs** (`Cron*`). See `docs/cron-discovery.md` §0.

---

## 1. Quick start

### In the browser

1. Click **⏰ Cron** in the bottom toolbar.
2. Click **+ New Job**.
3. Fill in a **name**, pick an **agent type** and **working directory**, choose a
   **prompt** (inline text or a file path), pick a **schedule**, and leave
   **Enabled** on.
4. **Save**. The job appears in the list with its computed **next run**.
5. Use **Run Now** to fire it immediately without waiting for the schedule.

### With curl

```bash
API=http://localhost:3000

# Create a daily job (03:00 server-local time)
curl -s -X POST "$API/api/cron/jobs" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "nightly-deps",
    "agentType": "claude",
    "workingDir": "/home/me/proj",
    "promptMode": "inline_text",
    "promptText": "Update dependencies and open a PR",
    "inputMode": "typed",
    "scheduleType": "daily",
    "dailyTime": "03:00",
    "enabled": true,
    "concurrencyPolicy": "warn_only"
  }' | jq

# List jobs
curl -s "$API/api/cron/jobs" | jq

# Run one immediately
curl -s -X POST "$API/api/cron/jobs/<jobId>/run" | jq

# See a job's run history
curl -s "$API/api/cron/jobs/<jobId>/runs" | jq
```

---

## 2. Concepts

| Term                       | Meaning                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| **Cron job** (`CronJob`)   | A saved, named definition: what agent to launch, where, with what prompt, on what schedule.      |
| **Run** (`CronJobRun`)     | One execution of a job — a history record with a status and a link to the session it created.    |
| **Schedule type**          | How fire times are computed: `once`, `interval`, `daily`, or `weekly`.                           |
| **Next run** (`nextRunAt`) | Server-computed epoch-ms of the next fire. `null` when the job is disabled or has no future run. |
| **Due tick**               | A background loop (every 30s) that launches any enabled job whose `nextRunAt` has passed.        |

A job is essentially a **trigger + persistence + history layer on top of the
existing session primitives**. When a job fires, the cron service does exactly
what the "quick start" route does — `new Session(...)` → `addSession` →
`setupSessionListeners` → `startInteractive()`/`startShell()` → deliver the
prompt. It does **not** reimplement any tmux/PTY logic.

---

## 3. The job form — every field

These map 1:1 to `CronJobSchema` (`src/web/schemas.ts`) and the `CronJob` type
(`src/types/cron.ts`).

| Field                      | Required    | Values / limits                                          | Notes                                                                                                                                                                                      |
| -------------------------- | ----------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`                     | ✅          | 1–200 chars                                              | Display name; also used as the created session's name.                                                                                                                                     |
| `agentType`                | ✅          | `claude` \| `shell` \| `opencode` \| `codex` \| `gemini` \| `antigravity` \| `pi` \| `grok` | Reuses Codeman's `SessionMode`. `shell` = a plain terminal. ⚠️ A `pi` or `grok` job's readiness poll looks for `❯`/a token count, which neither CLI prints, so it burns the poll budget and then sends the prompt anyway (slower start, still works). |
| `workingDir`               | ✅          | valid path (allowlist-validated)                         | Validated at **create/update** (must exist, be a directory, and not resolve into a blocked tree — `/etc`, `/root`, `/proc`, `/sys`, `/dev`, or `/` itself) and again **at fire time**.     |
| `launchCommand`            | —           | ≤ 2000 chars, single line                                | `shell` mode only: sent as the **first input line** once the shell is up, before the prompt. Ignored for other agent types.                                                                |
| `promptMode`               | ✅          | `inline_text` \| `prompt_file_path`                      | See §5.                                                                                                                                                                                    |
| `promptText`               | conditional | ≤ 100000 chars, **single line**                          | Required when `promptMode = inline_text`. Newlines are rejected (see §6).                                                                                                                  |
| `promptFilePath`           | conditional | valid path                                               | Required when `promptMode = prompt_file_path`. Confined to `workingDir` (see §5).                                                                                                          |
| `inputMode`                | ✅          | `paste` \| `typed`                                       | How the prompt is delivered. See §6.                                                                                                                                                       |
| `scheduleType`             | ✅          | `once` \| `interval` \| `daily` \| `weekly`              | See §4.                                                                                                                                                                                    |
| `runAt`                    | conditional | epoch-ms (positive int)                                  | Required for `once`.                                                                                                                                                                       |
| `intervalMinutes`          | conditional | 1–525600 (≤ 1 year)                                      | Required for `interval`.                                                                                                                                                                   |
| `dailyTime`                | conditional | `HH:MM` (24h)                                            | Required for `daily`. Server-local time.                                                                                                                                                   |
| `weeklyDays`               | conditional | array of 1–7 ints, each 0–6 (0 = Sunday)                 | Required for `weekly`.                                                                                                                                                                     |
| `weeklyTime`               | conditional | `HH:MM` (24h)                                            | Required for `weekly`. Server-local time.                                                                                                                                                  |
| `enabled`                  | ✅          | boolean                                                  | Disabled jobs never auto-fire (but **Run Now** still works).                                                                                                                               |
| `notes`                    | —           | ≤ 2000 chars                                             | Free-form.                                                                                                                                                                                 |
| `concurrencyPolicy`        | ✅          | `warn_only` \| `skip_if_same_agent_running`              | Applies to **automatic** runs only. See §7.                                                                                                                                                |
| `autoClosePreviousSession` | —           | boolean (default **true**)                               | Recurring schedules only (ignored for `once`): when the next run fires, the still-open session created by this job's **previous** run is closed first via the normal cleanup path. See §8. |

**Cross-field validation** (`refineCronJob` in `schemas.ts`): the conditional
fields above are enforced by a Zod `superRefine` on create. A missing dependent
field (e.g. `scheduleType: "once"` with no `runAt`) is rejected with
`INVALID_INPUT` and a field-specific message.

> ⚠️ **Update caveat.** `PUT /api/cron/jobs/:id` uses a `.partial()` schema that
> does **not** re-run the cross-field `superRefine`. To keep partial edits safe,
> `updateJob()` re-validates the **merged** job against the full `CronJobSchema`
> and throws `400` if the result is inconsistent (e.g. switching to `once`
> without a `runAt`). So the store is never left with a half-valid job.

---

## 4. Schedule types

Next-run math lives in `src/cron/cron-time.ts` (pure, unit-tested in
`test/cron-time.test.ts`). **All wall-clock times use the server's local
timezone** (v0.1 decision).

### `once`

- Fires a single time at the absolute `runAt` epoch-ms.
- A **missed** one-time job (server was down at `runAt`) **still fires once** on
  the next tick — `computeNextRunAt` returns `runAt` even if it's in the past,
  until the job has fired.
- After firing, the job **self-disables**: `completedOnce = true`, `enabled =
false`, `nextRunAt = null`.

### `interval`

- Fires every `intervalMinutes`, computed as `fireTime + intervalMinutes`.
- ⚠️ **Drift**: the next run re-anchors to the actual fire time, not to an ideal
  cadence — a slow tick or restart shifts subsequent runs slightly later. This is
  an accepted limitation.

### `daily`

- Fires at `dailyTime` (`HH:MM`) every day, server-local.
- If today's time has already passed, the next run is tomorrow at that time.

### `weekly`

- Fires at `weeklyTime` on each weekday in `weeklyDays` (0 = Sunday … 6 =
  Saturday), server-local.
- The next run is the soonest upcoming matching weekday/time within the next 7
  days.

---

## 5. Prompt source (`promptMode`)

### `inline_text`

The prompt is the literal `promptText`. Simplest option.

### `prompt_file_path`

The prompt is read from a file at fire time. **This path is security-hardened**
because a job config is attacker-controllable and the file's contents are
injected into an agent session (an exfiltration sink over SSE/terminal).
`resolveSafePromptPath()` enforces, in order:

1. **`realpath` resolution** — symlinks are resolved to their true target, for
   the prompt file **and for `workingDir` itself**.
2. **`workingDir` is not a trust boundary** — because it is user-supplied, the
   resolved `workingDir` is itself rejected if it is `/` or resolves into a
   blocked tree (`/etc`, `/root`, operator extras) or a pseudo-filesystem
   (`/proc`, `/sys`, `/dev`). This closes the `workingDir: '/proc'` +
   `promptFilePath: '/proc/self/environ'` env-exfil trick. The same rule is
   enforced earlier, at job create/update.
3. **Blocklist** (defense-in-depth) — sensitive trees (`/etc`, `/root`,
   `/proc`, `/sys`, `/dev`, known secret locations) are rejected for the
   resolved prompt file.
4. **Allowlist (primary gate)** — the resolved path **must live inside the job's
   (resolved) `workingDir`** (`validateSessionFilePath`). A symlink escaping the
   workspace fails here.
5. **Regular-file check** — directories, FIFOs, and `/dev/*` character devices
   are rejected (they would hang or OOM an unbounded read).
6. **Size cap** — files larger than **1 MiB** (`MAX_PROMPT_FILE_BYTES`) are
   rejected.
7. **Single-line check** — after trailing newlines are stripped, the file
   content must be a single line (see §6).

If any check fails, the run is recorded as **`failed`** with the reason; no
session is created.

---

## 6. Prompt delivery (`inputMode`)

Once the CLI is ready (see §8), the prompt is written to the session with a
trailing carriage return:

| Mode    | Mechanism                                                       | Use when                                         |
| ------- | --------------------------------------------------------------- | ------------------------------------------------ |
| `typed` | `session.writeViaMux()` — tmux `send-keys -l` (literal) + Enter | Default; behaves like a human typing the prompt. |
| `paste` | `session.write()` — writes directly to the PTY/mux              | Bulk paste-style delivery.                       |

> ⚠️ **Single-line only — enforced.** Like all programmatic input in Codeman,
> multi-line delivery would be silently corrupted (Ink-based TUIs treat a
> newline as submit; typed mode fuses lines). So newlines are **rejected**: the
> schema and the form refuse a multi-line `promptText`, and at fire time a
> prompt file whose content is multi-line (after stripping trailing newlines)
> fails the run with a clear `errorMessage`. Put multi-line instructions in a
> file the agent is told to read itself (e.g. "read TASKS.md and do it").

---

## 7. Concurrency policy (automatic runs)

`concurrencyPolicy` governs what happens when a **scheduled** run is due and
sessions of the same `agentType` already exist:

| Policy                       | Behavior                                                                                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `warn_only`                  | Always launch. (The count is surfaced but not blocking.)                                                                                                                 |
| `skip_if_same_agent_running` | If ≥ 1 **other, live** session of that mode is active, **skip** this fire — record a `skipped` run and (for recurring schedules) advance the schedule without launching. |

Notes on `skip_if_same_agent_running`:

- Only **live** sessions block: a tab whose CLI already exited (status
  `stopped`/`error`) does not count.
- Sessions created by **this job's own previous runs never block it** —
  otherwise a recurring job would deadlock on the session it created last time
  and fire exactly once.
- A skipped **`once`** job is **not consumed**: it stays armed and retries on
  the next tick until the blocking session goes away, then fires its single run.
- A skip is **not** a run: it sets `lastStatus = 'skipped'` but does **not**
  advance `lastRunAt`.
- Consecutive skips are **coalesced** — a perpetually-skipped interval job writes
  **one** skip record per streak, not one every tick, so it can't bloat
  `state.json`.

**Run Now ignores this policy on the server.** The browser shows a `confirm()`
warning if same-type sessions are active, but if you proceed (or call the API
directly), the job launches unconditionally.

---

## 8. What happens when a job fires

Sequence in `CronService.launch()`:

1. A `CronJobRun` is created with status **`created`** and broadcast
   (`cron:runCreated`).
2. The prompt is resolved (inline or file, single-line enforced). Failure →
   **`failed`**.
3. `workingDir` is checked (`statSync().isDirectory()`). Missing/not-a-dir →
   **`failed`**.
4. **Auto-close previous session** (recurring schedules, unless
   `autoClosePreviousSession: false`): any still-open session created by this
   job's previous runs is closed via the normal session-cleanup path.
5. The global session cap is checked (`MAX_CONCURRENT_SESSIONS = 50`). At cap →
   **`failed`**.
6. A `Session` is created **with `useMux: true`** (so it runs inside tmux),
   registered, listeners attached, and started via `startInteractive()`
   (`startShell()` for `shell` mode). Model/claudeMode come from global config.
   Run status → **`session_started`**.
7. **Readiness wait** (async, non-blocking): for non-shell agents the service
   polls the terminal buffer up to **60 × 500ms** for a `❯` prompt or the string
   `tokens`, then settles **2000ms** (`CRON_READY_SETTLE_MS`). Shell mode waits
   1000ms, then sends the optional `launchCommand` as the first input line
   (+1000ms settle).
8. The prompt is delivered (`typed`/`paste`, trailing `\r`). Run status →
   **`prompt_sent`**; `finishedAt` stamped. Delivery failure (e.g. the mux
   session is gone) → **`failed`**.

The created session is a **normal, persistent interactive session** — it appears
as its own tab and keeps running after the prompt is sent. The run's
`createdSessionUrl` is a deep link (`/?session=<id>`); the UI focuses it
automatically after **Run Now**.

> ⚠️ **Session-cap math if you disable auto-close.** With
> `autoClosePreviousSession: false`, nothing ever closes the sessions a
> recurring job creates — an interval job every 30 min creates 48 tabs/day and
> hits the global 50-session cap in ~25 hours (sooner with existing tabs), after
> which **every** fire of **every** job fails with "Maximum concurrent sessions
> reached" until you delete tabs by hand. Leave auto-close on for unattended
> recurring jobs, or clean up sessions yourself.

### The background tick

`tickDueJobs()` runs every **30s** (`CRON_TICK_INTERVAL`, registered in
`server.ts`). For each enabled job whose `nextRunAt ≤ now`:

- **Duplicate-launch guard**: `lastDueKey = jobId:fireTime`. If this due time was
  already consumed (overlap/restart), the job is just advanced, not relaunched.
- The schedule is **advanced _before_ launching** so a slow launch can't be
  re-triggered by the next tick.
- On boot, `init()` recomputes `nextRunAt` for loaded jobs (dead `once` jobs stay
  dead).

---

## 9. Run history & statuses

Each job keeps a history of `CronJobRun` records. Statuses (`CronJobRunStatus`):

| Status            | Meaning                                                       |
| ----------------- | ------------------------------------------------------------- |
| `created`         | Run record created; prompt/session not yet started.           |
| `session_started` | Session launched successfully.                                |
| `prompt_sent`     | Prompt delivered — the happy-path terminal state.             |
| `failed`          | Something went wrong (see `errorMessage`).                    |
| `skipped`         | A scheduled fire was skipped by `skip_if_same_agent_running`. |

Each run also records `triggerType` (`scheduled` or `manual_run_now`),
`sessionId`/`sessionName`, timestamps, and `createdSessionUrl`.

**History is capped globally** at **500 records** (`MAX_CRON_RUN_HISTORY`); the
oldest are pruned first. Deleting a job also deletes its run records.

---

## 10. API reference

All responses use the standard `ApiResponse<T>` envelope (`{success, data}` /
`{success, error, errorCode}`). `/api/v1/*` is a stable alias.

| Method   | Endpoint                     | Body                   | Returns                           |
| -------- | ---------------------------- | ---------------------- | --------------------------------- |
| `GET`    | `/api/cron/jobs`             | —                      | `CronJob[]`                       |
| `POST`   | `/api/cron/jobs`             | `CronJobSchema`        | `{ job }`                         |
| `GET`    | `/api/cron/jobs/:id`         | —                      | `CronJob` (404 if missing)        |
| `PUT`    | `/api/cron/jobs/:id`         | partial `CronJob`      | `{ job }` (400 if merge invalid)  |
| `DELETE` | `/api/cron/jobs/:id`         | —                      | `{}`                              |
| `PUT`    | `/api/cron/jobs/:id/enabled` | `{ enabled: boolean }` | `{ job }`                         |
| `POST`   | `/api/cron/jobs/:id/run`     | —                      | `{ run, activeAgents }`           |
| `GET`    | `/api/cron/jobs/:id/runs`    | —                      | `CronJobRun[]` (newest first)     |
| `GET`    | `/api/cron/runs`             | —                      | all `CronJobRun[]` (newest first) |

---

## 11. SSE events

Emitted on `/api/events`, mirrored in `SSE_EVENTS` (`constants.js`):

| Event              | Payload      | When                                                                 |
| ------------------ | ------------ | -------------------------------------------------------------------- |
| `cron:jobsChanged` | `{ jobs }`   | Any job created / updated / enabled / status change.                 |
| `cron:jobDeleted`  | `{ id }`     | A job was deleted.                                                   |
| `cron:runCreated`  | `CronJobRun` | A run (incl. skips) started.                                         |
| `cron:runUpdated`  | `CronJobRun` | A run advanced state (`session_started` / `prompt_sent` / `failed`). |

---

## 12. State & persistence

Persisted in `~/.codeman/state.json` via `StateStore`:

- `AppState.cronJobs` — map of `id → CronJob`.
- `AppState.cronJobRuns` — map of `id → CronJobRun`.

Jobs and their schedules survive restarts; `init()` recomputes `nextRunAt` on
boot. Sessions the jobs create persist through the normal session-recovery path.

---

## 13. Limits & constants

| Constant                 | Value                 | Source                                           |
| ------------------------ | --------------------- | ------------------------------------------------ |
| Due-tick interval        | 30s                   | `CRON_TICK_INTERVAL` (`config/server-timing.ts`) |
| Readiness poll           | 60 × 500ms            | `CRON_READY_MAX_ATTEMPTS`                        |
| Readiness settle         | 2000ms                | `CRON_READY_SETTLE_MS`                           |
| Run-history cap (global) | 500                   | `MAX_CRON_RUN_HISTORY` (`config/map-limits.ts`)  |
| Saved-jobs cap           | 100                   | `MAX_CRON_JOBS` (`config/map-limits.ts`)         |
| Concurrent-session cap   | 50                    | `MAX_CONCURRENT_SESSIONS`                        |
| Prompt-file size cap     | 1 MiB                 | `MAX_PROMPT_FILE_BYTES` (`cron-service.ts`)      |
| `name` length            | 1–200                 | `CronJobSchema`                                  |
| `promptText` length      | ≤ 100000              | `CronJobSchema`                                  |
| `intervalMinutes`        | 1–525600              | `CronJobSchema`                                  |
| `weeklyDays`             | 1–7 entries, each 0–6 | `CronJobSchema`                                  |

---

## 14. Known limitations

- **Server-local timezone only** — `daily`/`weekly` times are interpreted in the
  host's local time; there is no per-job timezone.
- **Interval drift** — `interval` re-anchors to the actual fire time; long-running
  intervals slowly shift.
- **Single-line prompts** — multi-line prompts are rejected (schema, form, and
  at fire time for prompt files); tell the agent to read a file itself for
  multi-line instructions.
- **`runNow` / tick race** — a manual Run Now firing at the same instant as a
  scheduled tick is theoretically possible; benign (you may get two sessions).
- **`{enabled:true}` on a dead `once` job** — re-enabling a fired one-time job
  without changing its schedule leaves it enabled-but-dead (won't fire); change
  the schedule to re-arm.

---

## 15. Troubleshooting

| Symptom                        | Likely cause                                                                                                      | Fix                                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Job never fires                | Disabled, or `nextRunAt: null`                                                                                    | Check **Enabled**; verify the schedule fields are complete.                                          |
| Run shows `failed` immediately | Bad `workingDir`, prompt-file rejected, or session cap hit                                                        | Read `errorMessage` on the run; confirm the dir exists and the prompt file is inside it and < 1 MiB. |
| Run shows `skipped`            | `skip_if_same_agent_running` + another live same-type session (this job's own sessions and dead tabs don't count) | Switch to `warn_only`, or wait for the other session to end.                                         |
| Run fails with "single line"   | Multi-line prompt text / prompt file                                                                              | Keep the prompt to one line; point the agent at a file to read for long instructions.                |
| Sessions pile up between runs  | `autoClosePreviousSession: false`                                                                                 | Re-enable auto-close, or delete old tabs before the 50-session cap bites (see §8).                   |
| Wrong fire time                | Timezone assumption                                                                                               | Times are **server-local** — check the host clock/TZ.                                                |
| One-time job won't re-fire     | `completedOnce` set                                                                                               | Edit the schedule (any real schedule change re-arms it).                                             |

---

## 16. Related docs

- `docs/cron-discovery.md` — architecture / integration-point analysis (why the
  feature reuses the session layer and stays distinct from `ScheduledRun`).
- `docs/cron-build-brief.md` — the original build brief / requirements.
- `CLAUDE.md` → **Key Patterns → Cron** — the one-paragraph engineering summary.
- Tests: `test/cron-time.test.ts` (schedule math), `test/cron-service.test.ts`
  (CRUD, tick, concurrency, security).
