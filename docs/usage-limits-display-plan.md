# Plan Usage Limits Display — Design & As-Built

> **Status: SHIPPED — deployed to prod + pushed to master, not yet released (2026-06-14).** App Settings → Display → **Plan Usage Limits** (`showPlanUsageLimits`). **Default changed in 1.9.3: desktop now defaults ON, handhelds stay OFF, resolved via `planUsageChipEnabled()`.** The per-device notes further down describing it as opt-in/synced record the original 2026-06-14 shape, not current behavior. Commits `c82f6c8` (feature) → `4d9d93d` (end-to-end fixes) → `eae225b` (per-user reconcile) → `95fb5fc` (init-snapshot replay). Full suite green (2869), CI green. No changeset/version bump yet.
>
> **2026-09-07 rework — the "Injection lifecycle" section below (disk-write reconcile via `applyStatusLineConfig`) is SUPERSEDED and describes the OLD mechanism, kept for history.** That disk write let a Codeman-marked `statusLine.command` in `.claude/settings.local.json` take precedence over the user's own global/project statusline for ANY `claude` run in that directory — including entirely outside Codeman — with no disclosure and no way to undo it (real bug, found 2026-08-31). The exporter is now injected as an EPHEMERAL `claude --settings` CLI flag at spawn (`resolveStatusLineCliCommand`/`ensureStatusLineExporterScript`, hooks-config.ts) — never written to disk — and it WRAPS the user's own real statusline (`findEffectiveUserStatusLineCommand`) rather than replacing it. `showPlanUsageLimits` now doubles as the telemetry COLLECTION switch too: `readPlanUsageTelemetryEnabled()` reads it fresh from `settings.json` at every claude session create/respawn (`TmuxManager.createSession`/`respawnPane`), so it applies uniformly across every claude-creation path — interactive Run, cron, the Ralph Loop API, quick-start — with no per-session state (a Codeman restart cannot silently kill it) and no per-request field on the wire at all.
>
> Two surfaces from one `statusLine` callback:
> - **Header chip** (top-right) — account-wide **plan limits**: `5h 35% · 7d 38%`, per-window green/yellow/red.
> - **In-terminal statusline footer** — the **current session's** status: `Opus 4.8 (1M context)  in:562,411 out:1,188  ctx:56%`.
>
> The `rate_limits` JSON schema below was **empirically confirmed** against Claude Code 2.1.177 on a Claude Max account; see the Verification appendix to reproduce.

## Problem

Codeman had no proactive view of how much of the Claude subscription is left. It only learned about limits **reactively**: `usage-limit-patterns.ts` regex-scrapes ANSI-stripped terminal output for footer strings like `5-hour limit reached ∙ resets 8pm`, extracting only the **reset time**, and only *after* Claude has already stalled. There was no "73% of your 5-hour limit used" anywhere.

We wanted a live, always-visible gauge so the operator can see a wall coming and pace overnight/autonomous runs — without hijacking the in-terminal statusline, which should keep showing the current session's status.

## Data source: the statusline `rate_limits` JSON

Claude Code (**v2.1.80+**; prod box runs **2.1.177**) pipes a JSON blob to a configured `statusLine.command` on stdin after each render. On Pro/Max subscriptions that blob includes `rate_limits`. **This is the only channel that exposes plan-limit data** (see rejected alternatives) — so the feature *must* set a statusLine command, which is why the footer is also reconstructed by it (below).

### Confirmed schema (real captured payload)

```jsonc
"rate_limits": {
  "five_hour": { "used_percentage": 15, "resets_at": 1781409000 },  // → 2026-06-14T03:50:00Z
  "seven_day": { "used_percentage": 34, "resets_at": 1781827200 }   // → 2026-06-19T00:00:00Z
}
```

| Field | Type | Notes |
|-------|------|-------|
| `rate_limits.five_hour.used_percentage` | `number` 0–100 | Integer-valued in practice; treat as `number`, don't assume decimals. |
| `rate_limits.five_hour.resets_at` | `number` | **Epoch SECONDS** (10 digits). `×1000` for a JS `Date`. |
| `rate_limits.seven_day.{used_percentage,resets_at}` | same | |

**Confirmed facts & gotchas:**

- **Only two windows exist: `five_hour` and `seven_day`.** There is **no separate Opus-weekly field**, even on a Max/Opus account.
- `rate_limits` is **absent on the first render**, **present after the first API response**. UI degrades to "no chip yet."
- statusLine fires **only in interactive TUI mode**, never `--print`. Fine — Codeman sessions are interactive TUIs (and so are Codeman-spawned ones in tmux).
- **Subscriber-gated.** Absent for API-key / non-subscriber auth.

### Bonus telemetry in the same payload — used for the footer

The same stdin object also carries `model.display_name`, `context_window.{used_percentage, total_input_tokens, total_output_tokens, …}`, `cost.total_cost_usd`, `effort.level`, etc. The shipped feature uses **model + token totals + context %** to build the in-terminal footer (so the statusline stays useful even though we own it). The endpoint also broadcasts `contextUsedPercentage`/`costUsd`/`modelDisplayName` alongside the limits for future chip tooltips.

### Alternatives considered & rejected

| Source | Why not |
|--------|---------|
| OAuth endpoint `api.anthropic.com/api/oauth/usage` | Undocumented, aggressively rate-limited, needs the **encrypted** OAuth token. Only worth it for *dollar spend*. |
| `/usage` slash command | Interactive-only, no programmatic output. |
| On-disk `~/.claude/` files | No usage state persisted (only `daemon.status.json` = auto-updater supervisor). |
| CLI flag (`claude usage` / `--check-usage`) | Does not exist. |
| `StopFailure` hook | Carries only an `error_type` on *failure* — no live percentages. |

## As-built architecture

```
Claude TUI (any Claude session, incl. linked-case/real-repo sessions)
  │  renders statusline after each assistant msg (+ /compact, mode change)
  ▼
statusLine.command (settings.local.json)  ──reads stdin JSON──▶
  curl -sk POST $CODEMAN_API_URL/api/status-telemetry  {sessionId, data}
  (X-Codeman-Hook-Secret: $(cat $CODEMAN_HOOK_SECRET_FILE))
  │  ◀── HTTP 200 text/plain = current-SESSION status string ──┘
  ▼
printf '%s' "$body"  →  in-terminal footer: "Opus 4.8 (1M context)  in:… out:…  ctx:…%"

server (status-telemetry-routes.ts):
  parse rate_limits  → (if changed) store last-known + broadcast SSE session:statusTelemetry  → header chip
  parse model/tokens/ctx → return the session-status footer string
  ▼
app.js: _onSessionStatusTelemetry → chip (per-window colors) + localStorage save
        handleInit → chip from init-snapshot planUsage (fresh-load replay)
```

### 1. The exporter — `generateStatusLineCommand()` in `hooks-config.ts`

Mirrors the hook `curlCmd()`. Reads the stdin JSON, POSTs `{sessionId, data}` to a **fixed** loopback path, and prints the response body back to stdout (print-through, so the footer stays useful). The managed-session env carries `$CODEMAN_SESSION_ID` / `$CODEMAN_API_URL` / `$CODEMAN_HOOK_SECRET_FILE` (from `tmux-manager.buildEnvExports()`).

```bash
INPUT=$(cat 2>/dev/null || echo '{}'); \
printf '{"sessionId":"%s","data":%s}' "$CODEMAN_SESSION_ID" "$INPUT" | \
curl -sk -X POST "$CODEMAN_API_URL/api/status-telemetry" \
  -H 'Content-Type: application/json' \
  -H "X-Codeman-Hook-Secret: $(cat "$CODEMAN_HOOK_SECRET_FILE" 2>/dev/null)" \
  --data @- 2>/dev/null || echo codeman
```

⚠️ **`curl -sk`, not `curl -s`.** Prod is loopback **HTTPS with a self-signed cert**; without `-k`, curl returns `000` and the statusline silently shows nothing. `-k` is safe (loopback only). *(The existing hook curls use `-s` without `-k` and have the same latent issue on HTTPS installs — a known, separate follow-up.)*

### 2. Endpoint — `POST /api/status-telemetry` (`status-telemetry-routes.ts`)

Fixed path (sessionId in the **body**, not the URL) so the auth exemption is an exact-match like `/api/hook-event` (`middleware/auth.ts`: loopback-only; `X-Codeman-Hook-Secret`-gated while a tunnel runs). Schema `StatusTelemetrySchema` in `schemas.ts` validates the subset; unknown keys are stripped. Pure parsing/formatting in `usage-telemetry.ts`:

- `parseStatusTelemetry(data)` → `{ fiveHour, sevenDay, … }` or `null`. On change (signature dedup; statusline fires often), store last-known (`plan-usage-latest.ts`) and `broadcast('session:statusTelemetry', { sessionId, …telemetry })`.
- `parseSessionStatus(data)` + `formatSessionStatusText()` → the **footer** string `Opus 4.8 (1M context)  in:562,411 out:1,188  ctx:56%` (returned as `text/plain`). Available from the first render, even before `rate_limits` appears.

### 3. SSE + frontend chip

`session:statusTelemetry` registered in `sse-events.ts` + `constants.js`. `app.js`:
- `_onSessionStatusTelemetry` → `updatePlanUsageChip(data)` + save to `localStorage['codeman:planUsage']`.
- `updatePlanUsageChip` renders two `5h`/`7d` windows; **per-window color by usage** — green `<60%`, yellow `60–84%`, red `≥85%` (`pu-green/pu-yellow/pu-red`); bold labels/values; reset times in the tooltip. `resets_at*1000 → Date`.
- Chip element ships hidden (`header-plan-usage--hidden`); `applyHeaderVisibilitySettings()` reveals it client-side when the setting is on (response-viewer pattern — **no `renderIndexHtml` strip**, which kept the "title-only" render contract intact).

### 4. Chip data robustness — three layers

1. **Live:** `session:statusTelemetry` SSE on every distinct render.
2. **Fresh load / reconnect:** server stores the latest in `plan-usage-latest.ts`; `getLightState()` includes it as `planUsage`; the per-connection **init snapshot** replays it; `handleInit` paints the chip immediately (authoritative over localStorage). Null until the first telemetry of the process.
3. **Offline / cross-restart:** `restorePlanUsageChip()` reads `localStorage` on load (12h freshness guard).

### 5. Injection lifecycle (SUPERSEDED 2026-09-07 — see header note; kept for history)

The setting `showPlanUsageLimits` is **synced** (in `settings.json`, not a per-device `displayKey`).

- ~~**On toggle** (`PUT /api/settings`, `system-routes.ts`): reconcile the exporter across **all active Claude sessions' working dirs** — inject on enable, remove on disable.~~ There is nothing to (re)inject into an already-running session under the new CLI-flag mechanism — the NEXT respawn (a Ralph cycle, `/clear`, a PTY-exit restart) already reads the setting fresh.
- ~~**On session create** (`session-routes.ts`): **ADD-ONLY** — inject when `statusLineTelemetry` is true; **never remove**.~~ There is no `statusLineTelemetry` request field anymore. `TmuxManager.createSession`/`respawnPane` read `readPlanUsageTelemetryEnabled()` fresh at spawn instead, uniformly across every claude-creation path.
- ~~`applyStatusLineConfig()` is **`isOurs`-guarded**~~ — `applyStatusLineConfig` still exists but only for the SELF-HEAL path now (`resolveStatusLineCliCommand` strips a legacy disk-written exporter the first time a session starts in a workspace an older Codeman build touched).

## Codeman-specific considerations

1. **Account-global limits.** The 5h/7d pools are shared across all sessions on the account → one shared header chip (freshest sample wins), not a per-tab bar.
2. **The footer is owned, by necessity.** A statusLine command always replaces Claude's default footer. Since `rate_limits` *only* arrives via statusLine, we reconstruct a useful **session-status** footer (model · tokens · ctx %) from the same payload rather than showing the limits there.
3. **Never overwrites, now WRAPS.** The exporter composes with a user's own real statusline (`findEffectiveUserStatusLineCommand`) rather than replacing it; `applyStatusLineConfig`'s `isOurs`-guard now only backs the legacy self-heal removal path.
4. **Security envelope unchanged.** The exporter runs arbitrary shell every render — same trust model as the hook curls (localhost + `$CODEMAN_HOOK_SECRET_FILE`); reuses the hook-secret gate.
5. **Claude-only, registry-gated.** Injection is gated on `getCli(mode)?.capabilities.statusLineTelemetry` (currently `true` only for claude) rather than a hardcoded `mode === 'claude'` string.
6. **Future — auto-resume synergy.** Live percentages would let `SessionAutoOps` pre-arm *before* the wall instead of reacting to the stall footer. Not built.

## Files shipped

- `src/usage-telemetry.ts` — pure parse/format (`parseStatusTelemetry`, `parseSessionStatus`, `formatSessionStatusText`, `telemetrySignature`) + `test/usage-telemetry.test.ts`.
- `src/hooks-config.ts` — `resolveStatusLineCliCommand()`/`ensureStatusLineExporterScript()` (ephemeral CLI-flag injection, never disk), `findEffectiveUserStatusLineCommand()` (wrap the user's real statusline), `readPlanUsageTelemetryEnabled()` (fresh global-setting read), `applyStatusLineConfig()` (legacy self-heal removal only now).
- `src/session-cli-registry-bridge.ts` — merges the exporter path into the SAME `--settings` JSON object as effort/ultracode (Claude Code accepts only one `--settings` flag per invocation).
- `src/web/routes/status-telemetry-routes.ts` — `POST /api/status-telemetry`.
- `src/web/plan-usage-latest.ts` — process-wide last-known store for init replay.
- `src/web/schemas.ts` — `StatusTelemetrySchema` + `showPlanUsageLimits` (no separate create-payload or action field anymore).
- `src/web/middleware/auth.ts` — exemption extended to `/api/status-telemetry`.
- `src/tmux-manager.ts` — `createSession`/`respawnPane` read `readPlanUsageTelemetryEnabled()` fresh at spawn.
- `src/web/server.ts` — `getLightState().planUsage` (init snapshot).
- `src/web/sse-events.ts` + `constants.js` — `session:statusTelemetry`.
- Frontend: `app.js` (`_onSessionStatusTelemetry`, `updatePlanUsageChip`, `restorePlanUsageChip`, `handleInit`), `settings-ui.js` (toggle + `applyHeaderVisibilitySettings`), `index.html` (chip + toggle row), `styles.css` (chip + colors), `session-ui.js` (create payload).

## Bugs E2E testing caught (that unit tests didn't)

The first "shipped" build passed every test and was broken in practice. End-to-end testing on the real install (the lesson: drive a REAL session, observe the REAL output) surfaced:

1. **`CASES_DIR` injection gate** excluded the user's whole workflow — sessions run in linked cases / real repos, not under `~/codeman-cases`. → dropped the gate.
2. **`curl -s` → `000`** on the loopback self-signed HTTPS cert; statusline silently empty. → `curl -sk`.
3. **Remove-on-create-false + shared `settings.local.json`** let a single stale client yank the statusLine out from under all sessions in a repo. → add-only on create; removal only via the toggle reconcile.
4. **Chip blank after reload** (localStorage-only, lost on restart/fresh browser). → server-side last-known in the init snapshot.

## Open questions / future

- **Schema stability.** `rate_limits` is officially shipped but undocumented in exact shape; the parser is tolerant (renders whatever windows exist, ignores unknown).
- **Hook `curl -s` parity.** Hooks share the no-`-k` issue on HTTPS installs — worth fixing the hook curl too (separate change; covered by `cod54` tests).
- **Disable cleanliness.** Disabling removes the statusLine from active sessions; a brand-new session created by a *stale* client could re-add it (chip still hidden, footer benign). Fully server-authoritative create-time injection (read the setting server-side instead of the payload flag) would close this — deferred.

## Verification appendix — how the schema was captured (reproducible)

Captured without touching global settings or any real session:

1. Throwaway dir `/tmp/sl-capture` with an exporter `dump.sh` that appends stdin to `payloads.jsonl` and prints `cap`; a `settings.json` pointing `statusLine.command` at it.
2. `--print` mode does **not** render a statusline → no capture (confirms TUI-only). Must use interactive.
3. Launch interactive Claude in an **isolated tmux socket** (`tmux -L slcap`, never `-L codeman`) inside the temp dir, `--settings /tmp/sl-capture/settings.json` (no global mutation). Confirm the workspace-trust dialog (appears even with `--dangerously-skip-permissions`), then send a one-line prompt (literal text + Enter separately, Ink-style).
4. After the first response, `rate_limits` appears in the **second** captured record (absent in the first). Inspect with `jq '.rate_limits'`.
5. Tear down: `tmux -L slcap kill-server` + `rm -rf /tmp/sl-capture`; verify the `codeman` socket is untouched.

Related: `docs/claude-code-hooks-reference.md` (hook callback pattern), `src/usage-limit-patterns.ts` (reactive fallback), `docs/respawn-state-machine.md` (auto-resume interplay).
