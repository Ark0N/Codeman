# Approvals Inbox (design)

One cross-session inbox for every prompt that is waiting on a human: permission dialogs, questions (AskUserQuestion / elicitation), and idle prompts. Cards are answerable in place (option digits, Esc, or a typed prompt) from desktop, phone overview, and push notification action buttons. Inspired by Cloudflare OS's Gatekeeper approval queue (https://github.com/cloudflare/cloudflare-os, asynchronous human-in-the-loop approvals): with a fleet of sessions the human is the bottleneck, and today answering means finding the right tab.

## Problems this fixes (all real today)

1. **No cross-session surface.** Pending prompts exist only as per-tab alert colors (`tab-alert-action`/`tab-alert-idle`) and NEEDS YOU rows on the phone overview. Answering means switching to the session and typing.
2. **Alerts die on reload.** `pendingHooks` lives only in `app.js` memory, fed by transient SSE `hook:*` events. A page reload (or a phone browser evicting the tab) silently loses every pending alert. There is no server-side record.
3. **Push Approve/Deny buttons are dead.** `PUSH_EVENT_MAP` already attaches `approve`/`deny` actions to permission pushes, and `sw.js` forwards `event.action` to the page, but the `notification-click` handler in settings-ui.js ignores it (and when no tab is open, the action is dropped entirely). The buttons render on the lock screen and do nothing.
4. **Card context is missing.** The frontend handlers read `data.question` / `data.message` / `data.tool`, but `sanitizeHookData` never forwards `message`, so notifications show generic fallback text.

## Scope

- Claude mode only (hooks fire only for `claude`; external CLIs keep their output-stabilization heuristics and get no inbox items). This mirrors the wait-primitive `stop`/`blocked` gating. Since then, DeepSeek Harness (through its status bridge) and Codex (through dialogs read off its screen) open alert-only items; answerable items are still Claude's alone (see `src/web/approval-inbox.ts`).
- Permission prompts occur for sessions running `ClaudeMode` `normal` / `auto` / `allowedTools` (and the trust-folder dialog even under skip-permissions). Question and idle prompts occur in every mode including `dangerously-skip-permissions`.
- In-memory store (plus the frontend seeding from it on load). Server restart drops items; hooks re-fire on the next prompt. No new state file in v1.

## Data model

At most **one active item per session**: the Claude TUI shows one dialog at a time, so a new prompt event supersedes the session's previous item (resolution `superseded`).

```ts
interface ApprovalItem {
  id: string;                 // `${sessionId}:${seq}`
  sessionId: string;
  sessionName: string;
  kind: 'permission' | 'question' | 'idle';
  createdAt: number;
  toolName?: string;          // from sanitized hook data
  toolSummary?: string;       // command / file_path / description, already bounded
  message?: string;           // Notification hook `message` (newly allowlisted)
  cwd?: string;
  context?: string;           // ANSI-stripped visible pane frame tail, ≤ 4000 chars
  options?: { n: number; label: string }[]; // parsed from context when confident
}
```

Resolutions (server-emitted, item removed from pending): `answered` (via inbox), `resolved_in_terminal` (stop / elicitation_complete / elicitation_response / session went working), `superseded`, `session_ended`, `dismissed`, `expired` (12h TTL sweep).

## Backend

### Store: `src/approval-inbox.ts`

Module-level singleton in the style of `session-wait-registry.ts` (pure, no `Session` import, injected emit callback so there is no import cycle with the server):

- `notePrompt(info)` creates/supersedes the session's item; schedules ONE re-capture ~600ms later (the Notification hook can fire before the dialog finishes painting) which updates `context`/`options` and emits `approval:updated`.
- `resolveForSession(sessionId, reason)`, `dismiss(id)`, `answerable(id)`, `listPending()`, `stop()` (clears timers; tests).
- Option parsing (pure, unit-tested): consecutive `❯? N. label` lines, 2..6 options, labels ≤ 120 chars. Parsed options gate which digits the answer endpoint accepts; when parsing fails the card falls back to Approve(1)/Deny(Esc) only.
- TTL: items expire after 12h (checked on read + a lazy sweep; no standing interval).

### Wiring

- `hook-event-routes.ts`: on `permission_prompt` / `elicitation_dialog` / `idle_prompt`, call `notePrompt` with sanitized data + a pane capture callback (`mux.capturePaneBuffer(muxName)` visible frame, ANSI-stripped via existing utils; fall back to `session.terminalBuffer` tail). On `stop` / `elicitation_complete` / `elicitation_response`, `resolveForSession(id, 'resolved_in_terminal')`.
- `session-listener-wiring.ts`: `working` listener resolves **idle items only** (`working` is heuristic and can flap mid-turn, so it must never clear a pending permission/question dialog); `exit` resolves with `session_ended`. Same singleton-import pattern as `sessionWaits`.
- Session delete route: resolve with `session_ended`.
- **New hook matchers** `elicitation_complete` + `elicitation_response` added to `generateHooksConfig()`, `HookEventType`, `HookEventSchema`, and both SSE registries. `refreshStaleCodemanHooks` gets a staleness probe for them (`hooksJson.includes('elicitation_complete')`) so existing cases heal on next Claude spawn, exactly like the `-k`/secret/marker probes.
- `sanitizeHookData`: allowlist `message` (bounded 500 chars). This also un-deadens the existing notification text paths.

### Routes: `src/web/routes/approval-routes.ts`

Normal authed API (NOT the hook-secret bypass), `ApiResponse` envelope, Zod schemas in `schemas.ts`:

- `GET /api/approvals` → pending items, multi-user filtered by `canAccessOwned` (same policy as session lists). Also sweeps the caller's own items for staleness through `verifyStillAnswerable()`: Claude Code fires no "permission answered" hook, so a dialog answered in the terminal used to sit pending until `stop` and re-arm a red tab alert on the next page load. Only items whose original frame parsed options can be dropped this way, so an unreadable capture keeps the alert.
- `POST /api/approvals/:id/answer` body `{ action: 'approve' | 'deny' | 'option' | 'text', option?, text? }`:
  - `approve` → `writeViaMux('1')` (option 1 is always plain Yes; no Enter, menus react to the digit).
  - `deny` → `writeViaMux('\x1b')` (Esc is the official No/cancel; precedent: auto-resume sends Esc the same way).
  - `option` → digit `String(n)`; accepted only when `n` is within the item's parsed options (prevents blind digit-poking at an unparsed dialog).
  - `text` → `idle` items only: single line, embedded newlines stripped, sent as `text\r` (the `\r` discipline from CLAUDE.md).
  - Guards: item still pending (404 otherwise), session exists + ownership via `findSessionOrFail`, session mode installs hooks. **Answer-time re-capture**: for items whose frame parsed options, the pane is re-captured before sending; if the dialog no longer parses, the item resolves and the answer is refused with 409 (the keystroke would land in whatever now has focus). Marks `answered` BEFORE the write so a double-tap cannot double-send; rolls back to pending if the write fails.
- `POST /api/approvals/:id/dismiss` → remove without keystrokes.
- `POST /api/approvals/session/:sessionId/viewed` → acknowledge the session's pending **idle** item (`acknowledgedAt`, emitted as `approval:updated`). Added after the owner reported that a yellow tab clicked and checked went yellow again on reload: the view-clears-idle rule lived in one browser's memory, so the seed re-armed it and other devices never saw the clear. Acknowledgement is deliberately **not** resolution (the prompt is still unanswered, so it stays in the inbox and stays available as Read My Mind context), and deliberately **idle-only** (looking at a permission/question dialog does not answer it, so the red alert survives being viewed).

### SSE

`approval:pending`, `approval:updated`, `approval:resolved` in `sse-events.ts` + `SSE_EVENTS` in constants.js (the parity test pins the sync). Broadcasts carry `sessionId`, so multi-user SSE scoping applies unchanged.

### Push

- `sendPushNotifications` payload gains `approvalId` for the three hook events. Both `approvalId` and the Approve/Deny `actions` are **gated on the opt-in setting**: with it off, permission pushes carry no buttons at all (pre-inbox they rendered and did nothing, so stripping them is the honest shape).
- `sw.js` `notificationclick`: when `event.action` is `approve`/`deny`, POST `/api/approvals/:id/answer` directly from the worker (same-origin, cookie credentials) so the buttons work **with no tab open**; on failure fall back to focusing/opening a tab. Non-action clicks keep today's behavior.
- Page-side `notification-click` handler: honor `action` instead of dropping it (also setting-gated, for stale notifications sent before the toggle flipped).
- Question/idle pushes keep no action buttons (options vary per dialog); tapping opens the inbox.

## Frontend

New module `approvals-ui.js` (@loadorder 11.2, after panels-ui.js), prettier-formatted (not added to `.prettierignore`).

- **Seed on connect**: `GET /api/approvals` on init and SSE reconnect; each pending item re-feeds `setPendingHook(...)` so tab alerts and the phone overview survive reload (fixes problem 2 with zero changes to the alert state machine). Items carrying `acknowledgedAt` are skipped, and `markIdleAlertSeen()` (app.js) is what sets it: viewing a session clears its yellow locally and POSTs `.../viewed`, so "I checked it" survives the reload and reaches the user's other devices through `approval:updated`.
- **Desktop**: header bell `btn-approvals` with count badge. Ships default-hidden via marker class `btn-approvals--hidden` (same policy as the attachments button, so `test/mobile-header-buttons-policy.test.ts` excludes it from the default-visible enumeration); JS shows it only while count > 0. Click toggles a drawer of cards: session name + kind, tool/message summary, mono context block, buttons rendered from parsed options (else Approve/Deny), plus Dismiss and Open session. Esc closes; existing z-index layers respected.
- **Phone**: header button stays hidden (`mobile.css`); the phone surface is the overview's NEEDS YOU section, whose rows gain inline ✓/✗ buttons for permission items (tap-through to the session remains the row's main action). Toolbar classes/status language rules from the mobile-overview section of CLAUDE.md apply.
- **i18n**: new strings registered in i18n.js (en + zh-CN); status words carry `data-i18n-skip` where they would collide (mirroring the overview pills).
- **Setting**: `approvalsInboxEnabled`, synced (in `SettingsUpdateSchema`), **default OFF** (owner decision: the entire feature is opt-in, meaning no bell, no drawer, no overview strips, no seeding, and no push action buttons until enabled in App Settings → Panels). Only the store and answer endpoints keep running regardless, so flipping the toggle ON surfaces anything already pending immediately, with no restart.

## Race honesty

The prompt can be answered in the terminal a moment before an inbox answer lands; then the keystroke would hit whatever now has focus (worst case: a digit typed into the composer, not submitted, since no `\r` is ever sent for menu answers). Mitigations, in order: answer-time re-capture (the dialog must still parse on screen or the answer is refused), answered-before-write marking, digit-only/Esc-only writes for menus, and the card's context block showing what the pane looked like when captured. This is the same class of risk `writeViaMux` automation (auto-resume, respawn) already accepts.

## Tests

- `test/approval-inbox.test.ts`: supersede per session, every resolution path, TTL, option parsing fixtures (2-option, 3-option with ❯, unparseable frame), re-capture update.
- `test/routes/approval-routes.test.ts` (`app.inject`, no port): list; hook event creates item; answer approve/deny/option writes the exact bytes (test-PTY echo asserts them); text answers restricted to idle; 404 unknown id; 409 answered twice; option out of range rejected; multi-user scoping.
- Existing suites extended: hook-event schema accepts the two new events; `sanitizeHookData` forwards bounded `message`; SSE parity + mobile-header policy pass as-is by construction.

## Docs

- CLAUDE.md: Key Patterns entry + SSE/route counts + frontend load order.
- `docs/api-reference.md`: the two endpoints + three SSE events (additive, fine under the 0.9.x contract).
