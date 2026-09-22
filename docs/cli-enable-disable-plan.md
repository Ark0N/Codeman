# CLI management Settings UI + write API — plan

> Tracked separately from `DEPLOYMENT_PLAN.md` (PR B2, merged) and `docs/copilot-integration-plan.md`
> (parked). This is "PR C" from the original #343 review: *"settings UI + write endpoints +
> auto-install, once we've settled the trust model... I want to make that call on its own, not
> inside a 100-file diff."*
>
> **Phase 0 is CLOSED as of 2026-09-21** — all three original pieces are IN SCOPE (expanded from
> this plan's first draft, which recommended #2/#3 as separate/out-of-scope; the user chose full
> scope instead, with the risk called out explicitly for #3 before confirming). See "Decisions"
> below for the full record.

## Status as of 2026-09-22

**Phases 1–6 are ALL IMPLEMENTED** (commits `da07b38c` "add cliManagementEnabled flag and GET
/api/clis" and `db4557d9` "Phases 3-6 - write API + custom entries + Settings UI", both on this
branch, `feat/cli-management`). Confirmed present in the tree: `cliManagementEnabled` in
`SettingsUpdateSchema`; `GET /api/clis`, `PUT /api/clis/:id`, `POST /api/clis/:id/install`,
`POST /api/clis`, `PUT /api/clis/custom/:id`, `DELETE /api/clis/:id` in
`src/web/routes/cli-registry-routes.ts`; the `shell`/`claude` `UNDISABLEABLE_IDS` backend guard;
`isAdmin(req)` gating on both the list and write routes; `appendAdminAudit` wired into the install
route; tmp+rename+`0o600` writes in `registry-writer.ts`; the full Settings UI (row list, toggle,
Install button, custom-entry create/edit/delete form) in `settings-ui.js` + `index.html`.
`test/routes/cli-registry-routes.test.ts` (425 lines) and `test/cli-registry-no-id-branching.test.ts`
cover it. This status section, plus the fix and gap below, is the one piece of that work done in
a *different* session from the one that wrote Phases 1–6 — reviewed by reading the diff and
verifying each claim against the actual routes/tests, not by re-implementing anything.

### Gotcha found and fixed (commit `0c77dd0a`)

**Toggling a CLI off in Settings had no effect anywhere except the Settings row itself.**
`window.__codemanCliAvailable` — the flag `isCliAvailable()` reads client-side to gate the
welcome-screen buttons, the Run-menu dropdown and the mobile overview — is injected **once**, at
initial page render (`server.ts`), built purely from each CLI's own installed-on-PATH resolver
(`isClaudeAvailable()` etc.), with **no reference to the registry's `enabled` flag at all**. So
disabling a CLI here updated its own row and nothing else — every launch surface kept offering it,
both live and after a full page reload, since even a *fresh* render never consulted the registry.
Root-caused and reported by the user testing the live feature ("toggle those off, they still
appear in that menu and on the front main screen").

Fixed two places:
- `server.ts`: after building `available`, intersect the nine real `SessionMode` ids against
  `enabledClis()`. `git`/`cloudflared` (utility binaries, not CLI registry entries) and
  `deepseekBinary` (a secondary installed-only flag for the "add a profile" affordance) are
  deliberately left alone — they were never registry-gated to begin with.
- `settings-ui.js`: `toggleCliEnabled()` now patches `window.__codemanCliAvailable` in place and
  refreshes the welcome screen, the mobile overview and an already-open Run menu, mirroring the
  existing `installDeepSeekProfile()` pattern for the same "injected once, needs an explicit
  patch" reason — the server-side fix alone still left every surface stale until the next reload.

New test in `test/render-index-html.test.ts`: an installed-but-disabled CLI (codex, forced via
`clis.json` + `reloadCliRegistry()`) reads as unavailable, while an installed-and-enabled one
(claude) is unaffected by the override.

**Verified on the Debian devbox** (`codeman-devbox`, real tmux — this sandbox has none and
`WebServer`'s constructor hard-requires it): typecheck clean, the new test passes (17/17 in
`render-index-html.test.ts`), the CLI-registry suites pass (86/86), and the **full CI gate is
green — 415 test files, 7855 tests, 0 failures**.

### Launch-surface registry integration — completed

The welcome screen, desktop Run menu and mobile Run picker now use the same injected CLI catalog.
Every enabled registry entry is rendered; unavailable binaries remain hidden as before. Settings
updates the catalog and availability flags in place after enable/disable, create, edit or delete,
so the launch surfaces update without a page reload. A custom entry uses the generic quick-start
path, while stock entries retain their existing per-CLI launch settings.

Not otherwise re-verified line-by-line against every Phase 1–6 checklist item below (e.g. the
exact wording of toasts, the "same PR" sequencing notes) — the checklists are left as originally
written; treat the **Status** section above as authoritative for what exists.

---

## Background

`src/config/cli-registry/registry.ts` is READ-ONLY today, and says so in its own header comment:

> "⚠️ READ-ONLY. Nothing in this module writes, creates or migrates the file... there is no
> settings UI and no write API yet... A `seededStockIds` ratchet belongs with the write API that
> needs it."

Confirmed on `master` (2026-09-21): no `/api/clis` route exists at all (read or write);
`~/.codeman/clis.json` is hand-edit-only; `resolveInstallCommandForPlatform()` is documented
"Display text only — never executed" — nothing runs an install command server-side today. The
original #343 review flagged the opposite (`spawn(command, {shell: true})`, `env.allowedPrefixes`
contributed from a write) as needing its own trust-model decision; that decision was never made
after the split, just dropped. This plan makes it.

**Closest existing precedent, and the template this plan follows for the read/write API**:
`src/web/routes/custom-model-routes.ts` + `src/custom-model-hosts.ts` (#393/#430/#459) — a small
per-item JSON store, Settings-UI-driven, admin-gated in multi-user mode, tmp+rename+0600 writes.

**Precedent for the new master feature flag (Phase 1)**: `customModelEndpointsEnabled` —
`z.boolean().optional()` in `SettingsUpdateSchema` (`schemas.ts:1319`), a checkbox read/written by
id in `openAppSettings()`/`saveAppSettings()` (`settings-ui.js:401`/`:2120`). SYNCED, not
per-device (present in the schema, absent from `displayKeys`), default OFF.

**Spec refs for the whole plan:**
- `src/config/cli-registry/registry.ts` — the read path; `resolveRegistry()`'s merge semantics
  (`deepMerge`, `UNMERGEABLE_KEYS`) apply unchanged to whatever this plan writes
- `docs/cli-registry.md` — registry shape, "The override file", "Arg-template safety" (the four
  layers Phase 5's custom-entry validation must not weaken), "Adding a CLI" (the 5-step recipe a
  custom entry does NOT get to skip just because it arrives via UI instead of a stock.ts edit)
- `src/web/routes/custom-model-routes.ts` + `src/custom-model-hosts.ts` — read/write API template
- `docs/multi-user-plan.md`, `docs/security-architecture.md` — admin-gating conventions
- `CLAUDE.md` §Multi-user mode, §"Settings surface", §"Per-device vs synced settings"

---

## Decisions (Phase 0, closed 2026-09-21)

1. **Enable/disable a stock CLI's `enabled` flag** — IN SCOPE. Plus a **master feature flag**
   (`cliManagementEnabled`, synced, default OFF) gating the whole Settings UI section's visibility,
   matching this codebase's standing convention for new admin-facing surfaces.
2. **Auto-install** (stock CLIs' already-shipped, already-vetted install commands) — IN SCOPE,
   same PR.
3. **Custom CLI entries via the UI** — IN SCOPE, **typed-argv only**: a custom entry goes through
   the exact same schema/argv-safety path stock entries do (named token patterns, no raw shell-text
   field). Its install command stays **display-only text**, same as every stock entry today — Phase
   4's auto-install NEVER executes a custom entry's install command, only a stock one's. This is
   the one place scope was deliberately narrowed relative to what was agreed in principle, because
   `docs/cli-registry.md`'s arg-template-safety section exists specifically to keep config free of
   shell text, and a free-text install command for a user-defined entry would reopen exactly that.
4. **`shell`/`claude` un-disableable** — enforced at the **backend**, not just the UI (a
   frontend-only guard is bypassable with curl).
5. **Non-admin visibility in multi-user mode** — the CLI-management Settings section is **hidden
   entirely** for a non-admin, not shown-empty.
6. **`seededStockIds` ratchet** — not needed. `deepMerge()` only overrides a key the file actually
   sets, so a CLI absent from `clis.json.clis` always falls through to its stock `enabled` value
   with no special-casing. (Carried over from the first draft, not re-litigated.)

---

## Phase 1 — Master feature flag: `cliManagementEnabled`

**Status:** DONE (commit `da07b38c`) — verified present in `SettingsUpdateSchema`, `index.html`,
`openAppSettings()`/`saveAppSettings()`.

**Spec refs:**
- `schemas.ts:1319` (`customModelEndpointsEnabled`) — the exact pattern to mirror: `z.boolean().optional()`
  in `SettingsUpdateSchema`
- `settings-ui.js:401`/`:2120` — checkbox read/write by id in `openAppSettings()`/`saveAppSettings()`
- `CLAUDE.md` §"Adding Features" → "App setting" — decide per-device vs synced FIRST (this one is
  synced: a feature toggle, not a display preference) and add to `displayKeys` NEVER for a synced
  setting

**Checklist:**
- [x] Add `cliManagementEnabled: z.boolean().optional()` to `SettingsUpdateSchema`
- [x] Add the checkbox to `index.html`'s `#settings-clis` section, above where Phase 6's per-CLI
      list will render — reads/writes via `openAppSettings()`/`saveAppSettings()` by id, same as
      `customModelEndpointsEnabled`
- [x] `readCliManagementEnabled()` helper (mirrors `readCustomModelEndpointsEnabled()` in
      `custom-model-routes.ts:609`) for the route file(s) in Phases 2-5 to gate on
- [x] When OFF: `GET /api/clis` still exists but the Settings UI section stays hidden
      (`applyCliManagementVisibility()`); the write endpoints reject (see Phase 3)

**Verify:** `npm run typecheck` passes; a unit test confirms `SettingsUpdateSchema` accepts/rejects
the field correctly; toggling it in a fresh browser profile shows/hides the Settings section with
no server restart.

---

## Phase 2 — Read endpoint: `GET /api/clis`

**Status:** DONE (commit `da07b38c`) — verified present in `src/web/routes/cli-registry-routes.ts`.

**Spec refs:**
- `src/web/routes/custom-model-routes.ts:730` (`GET /api/model-endpoints`) — multi-user read
  gating: empty list for a non-admin, never a 403
- `src/config/cli-registry/registry.ts` — `listClis()` (every entry, including disabled stock
  ones — this is an admin/settings surface, unlike `enabledClis()`)
- `window.__codemanCliAvailable`'s resolvers (`isClaudeAvailable()` etc.) — candidate `installed`
  source; confirm whether to reuse directly or the response needs its own probe (Open Question 4,
  carried from the first draft — still genuinely open, decide during this phase not before)

**Checklist:**
- [x] New route file `cli-registry-routes.ts`
- [x] Response excludes `launch`/`env`/`capabilities`/`overlays`/`discovery`
- [x] `isMultiUserMode() && !isAdmin(req)` → `[]`
- [x] Unit tests in `test/routes/cli-registry-routes.test.ts` (admin/non-admin/single-user,
      disabled stock CLI still present)

**Verify:** `npm test -- test/routes/cli-registry-routes.test.ts` passes; `curl localhost:3000/api/clis | jq`
shows every stock CLI including disabled ones.

---

## Phase 3 — Write endpoint: `PUT /api/clis/:id` (stock enable/disable)

**Status:** DONE (commit `db4557d9`) — `UNDISABLEABLE_IDS`, admin gate, tmp+rename+0600 all
confirmed present.

**Spec refs:**
- `src/web/routes/custom-model-routes.ts:753` + `src/custom-model-hosts.ts:91` — write-path
  template: `adminOnly` gate, read-modify-write the WHOLE file, tmp+rename+0600
- `registry.ts:47` (`filePath()` = `dataPath(...)`) and `reloadCliRegistry()` — write to the same
  resolved path, invalidate the cache on every successful write or the change is invisible until
  restart

**Checklist:**
- [x] Body: `{ enabled: boolean }`. Zod schema in `schemas.ts`
- [x] Gate order: `cliManagementEnabled` → `adminOnly` → shell/claude guard → stock-only guard
- [x] Rejects disabling `shell` or `claude` (`UNDISABLEABLE_IDS`)
- [x] Rejects a write for an id that isn't a stock CLI
- [x] Deep-merges `{ clis: { [id]: { enabled } } }`, preserving other override keys
- [x] tmp+rename+0600 write, `reloadCliRegistry()` on success
- [x] Unit tests (`test/routes/cli-registry-routes.test.ts`)

**Verify:** `npm test` full gate green; `curl -X PUT localhost:3000/api/clis/grok -d '{"enabled":false}'`
then `GET /api/clis` shows the change with no restart; same against `shell`/`claude` returns an
error and changes nothing; `ls -la ~/.codeman/clis.json` shows mode 0600.

---

## Phase 4 — Auto-install: `POST /api/clis/:id/install` (stock CLIs only)

**Status:** DONE (commit `db4557d9`) — route present, `appendAdminAudit` wired in.

**Spec refs:**
- `registry.ts:231` (`resolveInstallCommandForPlatform`) — currently "Display text only — never
  executed"; this phase is what changes that, for stock entries only, with Decision 2's sign-off
- Original #343 review's exact concern re: `env.allowedPrefixes` contributed from a write — stays
  out of scope; this phase only ever runs a command, never touches the env allowlist

**Checklist:**
- [x] Separate endpoint from Phase 3's toggle
- [x] Gate order: `cliManagementEnabled` → `adminOnly` → stock-entry-only guard
- [x] `resolveInstallCommandForPlatform(entry)` for the target
- [x] Bounded execution (timeout, captured stdout/stderr)
- [x] Does NOT auto-enable on successful install
- [x] Audit-logged via `appendAdminAudit`
- [x] Unit tests

**Verify:** a real install triggered via the endpoint against a CLI not currently installed,
`GET /api/clis`'s `installed` field flips true with no restart; audit log entry present; attempting
install against a custom entry's id fails with a clear error; full CI gate green.

---

## Phase 5 — Custom CLI entries: create / update / delete via API

**Status:** DONE (commit `db4557d9`) — `POST /api/clis`, `PUT /api/clis/custom/:id`,
`DELETE /api/clis/:id` all present. Open Question 2 resolved: a **separate** endpoint
(`PUT /api/clis/custom/:id`), not Phase 3's `PUT /api/clis/:id` widened.

**Spec refs:**
- `docs/cli-registry.md` §"Arg-template safety" (all four layers), §"Adding a CLI" (the 5-step
  recipe) — a custom entry created via this API must satisfy the SAME schema (`CliEntrySchema`)
  every stock entry does; there is no relaxed path for UI-originated entries
- `registry.ts`'s `resolveRegistry()` — the custom-entry branch (`stock: false`, dropped with a
  warning on validation failure, never falls back silently) already exists and is unchanged by
  this phase; this phase only adds a way to WRITE what that branch reads

**Checklist:**
- [x] `POST /api/clis` (create), full `CliEntrySchema` validation
- [x] `PUT /api/clis/custom/:id` (update) — separate endpoint from Phase 3's stock toggle
- [x] `DELETE /api/clis/:id` refuses for any stock id
- [x] `id` collision check against existing stock ids
- [x] `discovery.install.command` on a custom entry stays DISPLAY-ONLY
- [x] Same tmp+rename+0600 write pattern, `reloadCliRegistry()` on every successful mutation
- [x] Unit tests

**Verify:** `npm test` full gate green; create a custom entry via curl, confirm it appears in
`GET /api/clis` — **confirm it appears in the Run menu is UNVERIFIED and currently FALSE, see
"Outstanding" above**; delete it, confirm it's gone and `clis.json` no longer references it.

---

## Phase 6 — Settings UI

**Status:** DONE (commit `db4557d9`) — `#cliListGroup`, row rendering, toggle, Install button,
custom-entry create/edit/delete form all present in `settings-ui.js`/`index.html`. Manual browser
verification per the phase's own "Verify" step (flag on/off, non-admin hidden, toggle stops the
Run menu offering a CLI, create/enable/launch a custom entry, delete it, shell/claude undisableable)
has **not** been re-run in this session — the toggle→Run-menu leg specifically was BROKEN until the
gotcha fix above, and the create→launch leg for a custom entry is the confirmed gap in
"Outstanding".

**Spec refs:**
- `index.html:2357` (`#settings-clis`) — the existing home; Phase 1's master toggle at the top,
  then the per-CLI list, then (if `cliManagementEnabled`) a "custom CLI" creation form, all above
  the existing Codex-only groups
- `CLAUDE.md` §"Settings surface" — App Settings scrolls, it does not tab-switch
- `admin-ui.js` — pattern for an admin-only-VISIBLE section (not just admin-only-writable),
  needed here per Decision 5

**Checklist:**
- [x] Whole section hidden when `cliManagementEnabled` is OFF, and separately hidden for a
      non-admin in multi-user mode (`_applyCliManagementAdminGate`)
- [x] Fetches `GET /api/clis` when the section becomes visible; renders one row per CLI
- [x] Stock rows: enabled toggle only; `shell`/`claude` rows show the toggle disabled/greyed
- [x] Custom rows: enabled toggle plus edit/delete affordances
- [x] "Add custom CLI" form (id/label/badge/binary/argv)
- [x] Toggle/edit/delete update the row in place

**Verify:** manual browser test per `CLAUDE.md`'s "Always Test Before Deploying" rule — **not yet
re-run end-to-end in this session**; do this before considering the feature ready to ship, and
expect the custom-entry-launch step to fail until the Outstanding gap above is closed.

---

## Remaining Open Questions

1. **Phase 2's `installed` source** — resolved: reuses `window.__codemanCliAvailable`'s existing
   resolvers via `GET /api/clis`'s own probe (confirmed by reading the route).
2. **Phase 5's `PUT` endpoint shape** — resolved: a **separate** endpoint
   (`PUT /api/clis/custom/:id`), not Phase 3's toggle route widened.
3. **Sequencing against the parked Copilot plan** — unchanged, still not blocking.
4. **NEW: custom-CLI Run-menu integration** — see "Outstanding" above. Not decided or started.

---

Implementation is underway (see Status above); this line is left for history rather than removed —
the plan was originally approved before Phases 1–6 landed.
