# CLI Registry Follow-up — Deployment Plan

## Background

PR #343 (`feat: data-driven CLI registry`) introduced a single data-driven catalogue (`src/config/cli-registry/`) replacing ~123 per-CLI branch sites, and shipped Copilot/Grok as proof-of-concept registry-only additions. It was too large to review/merge as one unit and was split into a three-PR series:

- **PR A — [#347](https://github.com/Ark0N/Codeman/pull/347)** (merged 2026-09-04): the registry core as a pure internal refactor. Every run mode became a `CliEntry`; spawn commands stayed byte-identical; branch sites dropped from ~123 to 32 allowlisted locations. **DONE.**
- **PR B — [#380](https://github.com/Ark0N/Codeman/pull/380)** (merged 2026-09-14): drove `install.sh` and the Docker agent image from the generated catalogue (`config/clis.stock.json` + an embedded `install.sh` block via `npm run generate:cli-catalog`), replacing hand-maintained lists that had already drifted. **DONE.**
- **PR B2 — not started.** #380's own description explicitly held this back: *"The frontend half — injecting `window.__codemanCliCatalog` and making `mobile-overview.js` / `session-ui.js` catalogue-driven — is held back as PR B2"*, to avoid conflicts across files that six of the thirteen PRs open at the time also touched.

**Confirmed still outstanding** (verified directly against the current `master` checkout, 2026-09-17):
- `grep -r "__codemanCliCatalog"` → no matches anywhere in the repo.
- `src/web/public/session-ui.js` still hardcodes the CLI id list in at least 10 places (run-mode dispatch at L397-422, the mode-iteration loop at L512, the button-label ternary chain at L828, nine near-duplicate `mode: '<id>'` launch blocks at L1293-1700, and the `isAltMode`/`isExternalCliMode` OR-chains at L1787/1817/4027).
- `src/web/public/mobile-overview.js` also hardcodes CLI ids/labels (16 occurrences).
- `docs/cli-registry.md` §"Fields declared for later" confirms by design: *"the frontend is deliberately untouched here: `app.js`, `terminal-ui.js` and `styles.css` keep their own hand-authored per-CLI rules... moving them is its own piece of work verified by a browser/mobile suite the CI gate cannot see."*

This plan scopes **PR B2** and the remaining frontend/registry loose ends visible from the repo today. There is no upstream doc describing B2's exact boundaries beyond the one sentence above, so several checklist items are marked `[UNDOCUMENTED]` and need confirmation before implementation.

**⚠️ Active conflict, checked 2026-09-17:** local branch `feature/run-menu-custom-model-picker` (based on current `HEAD`, 32 commits ahead, last commit today) implements the Run-menu picker for Custom Model Endpoint Profiles and is **not yet merged**. It directly rewrites the same regions B2 targets:

| File | Lines changed on that branch | Overlap |
| --- | --- | --- |
| `src/web/public/session-ui.js` | 734 | Hunks land exactly on the 9 near-duplicate per-mode launch blocks Phase 2 plans to consolidate — it injects custom-model launch-param handling into each block individually |
| `src/web/server.ts` | 98 | Same region Phase 1 plans to inject `window.__codemanCliCatalog` into |
| `src/web/public/index.html` | 123 | New picker markup |
| `src/config/cli-registry/{types,schema,stock}.ts` | 149 combined | Adds `customModelInjection`-related capability fields to `CliEntry` |
| `src/web/public/mobile-overview.js` | 0 | No overlap |

If B2 ships first and collapses the 9 launch blocks into one data-driven function, that branch's per-block hunks lose their context entirely (a manual re-port, not a rebase). If the picker branch ships first, Phase 2 only has to fold custom-model-launch-param handling into the new function once, at the point of writing it. **Phase 0 below makes this an explicit hard dependency.**

**Spec refs for the whole plan:**
- `docs/cli-registry.md` — registry shape, the no-id-branching rule, generated-artifact contract, "Fields declared for later" section
- `CLAUDE.md` §CLI registry — architecture summary + `test/cli-registry-no-id-branching.test.ts` behaviour
- PR #380 body (GitHub) — the B2 handoff note and the six-PR frontend-conflict rationale

---

## ⚠️ Working-directory note (2026-09-20)

Mid-round-2, this shared checkout (`C:\Scripts\GitHub\opticon454\Codeman\master`) got checked out to `feature/run-menu-picker-currently-loaded-model` by another session (the exact hazard CLAUDE.md's "Session Safety" section documents), with that session's own uncommitted WIP left in the working tree. Caught via `git branch --show-current` before committing anything — nothing of B2's was lost (both `followups` commits were already pushed) and nothing of the other session's WIP was touched.

**Continued round 2 in an isolated `git worktree`** at `C:\Scripts\GitHub\opticon454\Codeman\followups-b2`, checked out to `followups` directly, rather than disturbing the other session's branch. That worktree is where `d9e6ebb2` was committed and pushed from. It's left in place (not removed) in case round 3 is needed — reuse it rather than assuming this `master` directory is on the right branch, until whatever is using it there finishes.

---

## PR opened, review round 1 (2026-09-19 → 2026-09-20)

[Ark0N/Codeman#458](https://github.com/Ark0N/Codeman/pull/458) opened from `opticon454:followups` → `Ark0N:master`, commit `cd64b0a3`. Ark0N reviewed same-day. Full response: `PR-B2-review-response.md`. Summary:

- **Two required fixes, both applied and re-verified live on the devbox (reproduced the exact bug, confirmed the fix, confirmed clean again):**
  1. `test/frontend-cli-no-id-branching.test.ts`'s `ALLOWED_BRANCHES` keyed on `<file>::<line>::<expression>` — a single inserted line at the top of `session-ui.js` shifted every subsequent line number and made all 21 entries go stale simultaneously, reporting the same 21 branches as "new". Fixed by dropping the line number from the key (`<file>::<expression>`, mirroring the backend guard exactly), collapsing to 11 entries.
  2. `test/run-mode-ui.test.ts`'s terminal-ownership guard scans method bodies via a `^ {2}async (run[A-Za-z]*)\(\) \{$` regex, which matched the 8 one-line `run<Mode>()` wrappers but not `_runCliMode(mode)` where the real logic (and the actual risk this guard exists to catch) now lives. Fixed per the reviewer's exact suggested regex (`^ {2}async (_?run[A-Za-z]*)\(\w*\) \{$`) plus adding `_runCliMode` to the sanity list. Same-class, lower-priority fix also applied to `test/opencode-resize.test.ts`, which had the identical blind spot via `runOpenCode.toString()`.
- **Open Question 2 resolved: dropped `window.__codemanCliCatalog` entirely.** Nothing consumes it, and the reviewer's asymmetry argument (a registry `DECLARED_FOR_LATER` field costs nothing; a script tag serialized into every page render with no consumer is a different trade) was more convincing than keeping it as speculative infrastructure. Phase 1 is now fully reverted: `server.ts`'s injection removed, `shortBadge` restored to `types.ts`'s `DECLARED_FOR_LATER` list and `test/cli-registry-no-id-branching.test.ts`'s pinned list, the 3 new/modified assertions in `test/render-index-html.test.ts` and `test/server-index-title.test.ts` removed.
- **Open Question 1 (OMP label mismatch) closed by the reviewer**: "leave the label ternary hardcoded... it is my mistake, not yours" — the `stock.ts` `shortBadge` fix is the maintainer's own follow-up, not part of this PR.
- **Open Question 3 (splitting) closed**: "current head is clean against master, nothing else open conflicts with these files, so no further splitting needed."
- **Open Question 4 (accent mismatches)**: confirmed wanted as a separate small PR — not yet started.
- Small drive-by fix: `session-ui.js`'s `EXTERNAL_CLI_MODES` header comment referenced a nonexistent `_isAltCliMode()` method (the actual check is inlined as `EXTERNAL_CLI_MODES.has(...)` in `openSessionOptions`) — corrected.
- Two minor doc-staleness / `String.replace`-escaping points were left for the maintainer to take at merge, per their own explicit preference ("happy to take at merge rather than have you respin").

**Full gate after all fixes: 405 files / 7717 tests / 0 failures** (unchanged net count — removed 1 test, restored 1 test), typecheck/lint/format clean.

## Review round 2 (2026-09-20)

Ark0N re-verified with an 80-combination JSDOM harness comparing every launch body against master (byte-identical) and confirmed both round-1 fixes reproduce as fixes. Found one real remaining gap and offered to take 4 small items himself "at merge" — applied 3 of them proactively instead (commit `d9e6ebb2`, pushed from the `followups-b2` worktree — see the note above):

- **Count-based allowlist**: dropping the line number (round 1's fix) closed the line-shift problem but opened a new one — every stock id was already allowlisted for `session-ui.js` in the `mode === '<id>'` form, so a genuinely NEW branch reusing that exact expression passed silently. Reproduced live (`if (this.mode === 'codex')` in `runOpenCode()`, stayed green under the old version), fixed by giving each allowlist entry a `{ count, reason }` and asserting actual-vs-declared count, reproduced again against the fix (now fails with `expected 2, found 3`).
- **New `test/run-mode-launch-table-drift.test.ts`**: `RUN_MODE_LAUNCH` restates 4 things `stock.ts` already owns (label, install command, `supportsCustomModel`, the external-mode key set) with nothing enforcing agreement. `supportsCustomModel` is the dangerous one — traced the real consequence: `window.__codemanCustomModelClis` and `RUN_MODE_LAUNCH`'s flag could silently disagree, offering a CLI in the Run-menu custom-model picker while `_runCliMode` drops the `customModel` field at actual launch (session launches on the vendor's cloud, UI claims the local endpoint). Drives real `session-ui.js` via JSDOM, compares against `STOCK_CLIS` on all 4 axes.
- Inlined the dead `"Open Question 7 in PR-B2.md"` references (`PR-B2.md` is a local planning doc, never committed — pointing the repo's own test comments at it was a mistake) and added a sentence to `docs/cli-registry.md` naming the new guard.
- Left 2 items for Ark0N as he asked: the `$&`/`$'` `String.replace` escaping fix, and retitling the PR (the squash-commit title still names the reverted `window.__codemanCliCatalog`).

**Full gate: 406 files / 7721 tests / 0 failures** (net +4, the new drift test), typecheck/lint/format:check/check:frontend-syntax all clean.

---

## Phase 0 — Sequencing gate: wait for the Run-menu custom-model picker

**Status:** DONE (confirmed 2026-09-19 — `feature/run-menu-custom-model-picker` merged; master is at v1.31.0/commit `2d573d8a`)
**Agent:** orchestrator

**Re-verification findings (2026-09-19):** the merged branch added `window.__codemanCliAvailable` (pre-existing boolean install-availability map, unrelated to this plan) and **`window.__codemanCustomModelClis`** (new: `{id, label}[]`, injected in `renderIndexHtml()` via `enabledClis().filter(kind==='agent' && capabilities.customModelInjection.kind!=='unsupported')`, escaped through `escapeScriptJson()`). It did **not** touch the 9 hardcoded per-mode launch blocks, the mode-dispatch chain, the label ternary, the mode-iteration loop, or the `isAltMode`/`isExternalCli` OR-chains in `session-ui.js` — those are all still present and unconsolidated (now larger, since custom-model launch logic presumably lives inside each block). Phase 2's target is unchanged and still real. Phase 1 needs revision — see below.

**Spec refs:**
- `docs/custom-model-endpoints-plan.md` — describes the feature as "backend + HTTP API only until the Run-menu picker lands," confirming the picker is expected, in-scope, upstream work, not a rogue branch
- Local branch `feature/run-menu-custom-model-picker` (merge-base `origin/master`@`bd286bf5`, 32 commits ahead) — see the conflict table above

**Checklist:**
- [ ] Confirm with the user/maintainer whether `feature/run-menu-custom-model-picker` is intended to merge before B2 work starts (recommended, given it is the more mature/blocking piece of work and already carries a changeset — `fbee1b2d docs(changeset): add changeset for the Run-menu custom-model picker PR`)
- [ ] Do not start Phase 1 or Phase 2 until that branch (or its eventual PR) has merged to `master`, OR the user explicitly decides to proceed in parallel and accept the rebase cost described above
- [ ] Once merged, re-run the file-overlap check (`git diff <old-base>...<new-master> --stat -- src/web/public/session-ui.js src/web/server.ts src/web/public/index.html src/config/cli-registry/`) to confirm no further unmerged branches have since appeared in the same region before starting Phase 1
- [ ] Re-read the merged `customModelInjection` capability shape in `src/config/cli-registry/types.ts` before writing Phase 1's serializer allowlist — it did not exist when this plan was drafted

**Verify:** `git log origin/master | grep -i "run-menu custom-model"` (or equivalent PR-merge check) shows the picker work has landed; `git diff HEAD -- src/web/public/session-ui.js src/web/server.ts src/web/public/index.html` against the pre-Phase-0 snapshot is empty (i.e., B2 has not started ahead of the gate).

---

## Phase 1 — Land `window.__codemanCliCatalog` on the server

**Status:** TODO
**Agent:** orchestrator (no specialist TS/frontend agent configured for this repo's tooling)

**Revised 2026-09-19** — per user decision, this phase now **generalizes the existing `window.__codemanCustomModelClis` injection pattern** rather than inventing an unrelated third global. `window.__codemanCliAvailable` (booleans) and `window.__codemanCustomModelClis` (`{id,label}[]`, feature-filtered) both stay as-is — they serve narrower, already-shipped consumers and touching them is out of scope. This phase adds one more catalogue, built with the **same discipline** (`enabledClis()` read generically off `capabilities`/fields — never an id list in the injection code, per the existing comment at `server.ts`:1660-1664 — `escapeScriptJson()`-guarded, injected in `renderIndexHtml()`), but with a **broader filter** (all enabled CLIs, not just custom-model-capable ones) and a **broader field set** (id/label/shortBadge/order/kind, not just id/label), since Phase 2/3 need to drive the full run-menu, not just the custom-model picker.

**Spec refs:**
- `src/web/server.ts` L1660-1676 (current `window.__codemanCustomModelClis` injection) — the pattern to extend: `enabledClis().filter(...)`, `escapeScriptJson(JSON.stringify(...))`, injected via `html.replace('</head>', ...)` inside the `if (!soloSessionId)` block
- `docs/cli-registry.md` §"Consumers outside the server" — the existing `stock.ts` → `config/clis.stock.json` export pattern (`id`, `label`, `shortBadge`, `enabled`, `order`, `kind`, `discovery` only; `launch`/`env`/`capabilities`/`overlays` never leak into a consumer artifact) — this phase's field allowlist should mirror that one, not the narrower custom-model one
- `[UNDOCUMENTED]` exact field list — id/label/shortBadge/order/kind is the working assumption (mirrors `clis.stock.json`'s exported fields); confirm before implementing whether Phase 2/3 need anything from `discovery` (e.g. install-availability, though that's arguably `__codemanCliAvailable`'s job already) or `capabilities.workDetect`/`accent` (currently "declared but not yet read" per `docs/cli-registry.md`)

**Checklist:**
- [ ] Factor the shared shape out of the current `window.__codemanCustomModelClis` block into a small reusable helper (or just a second, parallel block following the identical pattern) — do not refactor the existing custom-model injection's behavior, only reuse its *shape*
- [ ] Add a pure serializer projecting `enabledClis()` into `{id, label, shortBadge, order, kind}[]` (no filter beyond `enabled`, unlike the custom-model global) — resolved at **call time** inside `renderIndexHtml()`, never a module-level const, per `docs/cli-registry.md` §"Resolve at call time, never at import"
- [ ] Inject `window.__codemanCliCatalog = <escapeScriptJson-guarded json>;` right beside the existing `__codemanCustomModelClis` injection (same `if (!soloSessionId)` guard, same escaping — `label` is a user-`clis.json`-settable string exactly like the custom-model global's, so the same `escapeScriptJson()` call is required, not just `JSON.stringify`)
- [ ] Confirm `index.html` is read once into `indexHtmlTemplate` at server construction (per CLAUDE.md "index.html itself is the exception") — this injection must happen in the per-request `renderIndexHtml()` path, not the cached template, or a CLI enabled/disabled at runtime won't be reflected without a server restart
- [x] Add/extend a unit test (alongside `test/render-index-html.test.ts`) asserting the new catalogue script is present, valid JSON, excludes `launch`/`env`/`capabilities`/`overlays` (including any custom-model-related capability fields), and is properly `escapeScriptJson`-escaped

**Status: REVERTED 2026-09-20, per maintainer review.** Was implemented, tested, and shipped in the PR — see below for the original implementation notes — but Open Question 2 was resolved against keeping it (see "PR opened, review round 1" above): nothing consumed it, and the maintainer's cost asymmetry argument (a registry field costs nothing; a script tag on every page render with no consumer is a different trade) won out. `server.ts`'s injection, the `types.ts`/`test/cli-registry-no-id-branching.test.ts` `shortBadge` changes, and the associated `render-index-html.test.ts`/`server-index-title.test.ts` assertions were all reverted to their pre-Phase-1 state. Original implementation notes, kept for history:

Implemented in `src/web/server.ts` (new `window.__codemanCliCatalog` block beside the existing `__codemanCustomModelClis` one) + `test/render-index-html.test.ts` (new test + solo-window exclusion check).

Local sandbox has no `tmux` binary and `WebServer`'s constructor hard-requires one, so real test execution wasn't possible here. Set up a tmux-capable Debian VM (10.10.10.12, user `devvyn`) for this instead: dedicated SSH keypair, `~/.ssh/config` alias `codeman-devbox`, synced the exact working tree over via `git bundle` (matching local commit `2d573d8a`) + a `git diff`/`git apply` for uncommitted changes — no push to GitHub involved.

First full-suite run surfaced **two real regressions**, both fixed:
- `test/cli-registry-no-id-branching.test.ts` — the `DECLARED_FOR_LATER` pinned-list guard correctly caught that `shortBadge` is now genuinely read outside the registry (by the new catalogue serializer). Removed it from that list and updated `CliEntry`'s header comment in `types.ts` per the guard's own instruction.
- `test/server-index-title.test.ts` — needed a third strip regex for the new `__codemanCliCatalog` script block, alongside the existing two (`__codemanCliAvailable`, `__codemanCustomModelClis`).

Re-ran everything after fixing both: **full CI gate green — 404 test files, 7712 tests, 0 failures**, plus `npm run typecheck`, `npm run lint`, and `npm run format:check` all clean on the same VM. Verified the local working tree is byte-identical to what was tested (`diff` against the file pulled back from the VM). The devbox (`codeman-devbox` SSH alias) stays available for Phase 2/3's much larger changes.

**Verify:** `npm test -- test/render-index-html.test.ts` passes; manual: `curl -s http://localhost:3000/ | grep __codemanCliCatalog` shows a JSON array matching `enabledClis()`.

---

## Phase 2 — Make `session-ui.js` catalogue-driven

**Status:** TODO
**Agent:** orchestrator

**Spec refs:**
- `src/web/public/session-ui.js` — current hardcoded sites (verified 2026-09-17): L397-422 (`_runMode` dispatch), L512 (mode-iteration loop), L828 (button-label ternary chain), L1293/1347/1404/1455/1515/1563/1622/1700 (near-duplicate per-mode launch blocks), L1787/1817 (`isAltMode`/`isExternalCli` OR-chains), L4027 (external-mode check)
- `docs/cli-registry.md` §"The no-id-branching rule" — the shape of guard the backend already enforces (`test/cli-registry-no-id-branching.test.ts`); B2 should leave the frontend in a state that could plausibly be added to that guard later, even if the guard itself stays backend-scoped for now
- `CLAUDE.md` §CLI registry — `capabilities.workDetect`, `shortBadge`, `accent` are "declared but not yet read" by the frontend; B2 is what starts reading them

**Checklist — revised after real investigation (2026-09-19):**
- [x] Consolidated the **8** near-duplicate launch functions (`runOpenCode`/`runCodex`/`runGemini`/`runAntigravity`/`runPi`/`runOmp`/`runGrok`/`runDeepSeek` — not 9; `runClaude`/`runShell` were never near-duplicates and stay separate, they have genuinely different flows) into one shared `_runCliMode(mode)` plus a local `RUN_MODE_LAUNCH` config table (label, install hint, per-CLI wire-config builder, custom-model eligibility). All 8 names stay as thin wrappers — `index.html`'s welcome-screen buttons call them by name (`app.runOpenCode()` etc.), and several tests assert on the name directly.
- [x] Simplified `run()`'s 8-branch if-chain to `if (mode==='shell') ...; if (mode==='claude' || !EXTERNAL_CLI_MODES.has(mode)) return runClaude(); return this._runCliMode(mode);`
- [x] Consolidated the duplicated `isAltMode`/`isExternalCli` 8-way OR-chains (same expression, copy-pasted TWICE inside one function, `openSessionOptions`) into one `EXTERNAL_CLI_MODES.has(session.mode)` check backed by the same local Set the launch table derives from.
- [x] Deliberately did **NOT** touch three items originally in scope, each verified unsafe or unnecessary by reading the real code and its pinned tests:
  - **Label ternary chain** (`'Run OC'`/`'Run CX'`/etc.): `test/run-mode-ui.test.ts` pins the exact text `'Run OMP'`, but the registry's `shortBadge` for omp is `'OM'` (2 chars) — deriving the label from the catalogue would silently change displayed text and fail that pinned test. Left as-is; flagged as Open Question 7 below.
  - **`_refreshRunModeAvailability`'s mode array**: `test/run-mode-ui.test.ts`'s *"gates every mode the run-mode menu actually offers"* test **scans this function's source text** for literal `'<mode>'` string occurrences — it is an intentional anti-drift guard (its own comment: "Catches a sixth run mode being added to index.html without being gated"), not an anti-pattern. Making this catalogue-driven would remove the literal strings the guard requires and break it.
  - **`window.__codemanCliCatalog` was NOT consumed here at all**: several of the affected tests (`test/run-mode-ui.test.ts`) run session-ui.js inside a bare `vm.createContext()` with no `window` global — referencing `window.anything` unguarded there throws `ReferenceError`, not `undefined`. Building `_runCliMode`/`EXTERNAL_CLI_MODES` on local, static, file-scoped constants instead sidesteps this entirely while still achieving the actual goal (one source of truth instead of 8 duplicated functions / 2 duplicated OR-chains).
- [x] `shell` mode's distinct handling (`kind: 'shell'`, no CLI probe, no config table entry) preserved exactly — untouched.
- [x] `npm run check:frontend-syntax` clean (session-ui.js is `.prettierignore`d — hand-formatted by design, per CLAUDE.md, so no `npm run format` needed; `npm run lint` only covers `src/**/*.ts`, not this file).

**Status: DONE, fully verified (2026-09-19), on the same `codeman-devbox` VM as Phase 1.** Net diff: -446/+153 lines in `session-ui.js`. Verification:
- Full CI gate: **404 test files, 7712 tests, 0 failures** (identical count to Phase 1's baseline — no regressions, no new failures).
- Targeted: `test/run-mode-ui.test.ts` (32), `test/custom-model-run-menu-ui.test.ts` (51), `test/custom-model-one-shot-launch.test.ts` (11) — 94/94 passing, covering exact wire-body assertions per CLI (codexConfig/geminiConfig/antigravityConfig/grokConfig/deepSeekConfig shapes, pi's deliberate absence of piConfig, the static `this.terminal.clear`/`writeln` ownership guard, and the custom-model one-shot launch path).
- Ran `npm run test:browser -- test/opencode-resize.test.ts` (Playwright, real Chromium — installed on the devbox for this): the one test that directly inspects `runOpenCode.toString()` for the historical activeSessionId-bypass bug **passes**. The other 5 tests in that file fail identically with my changes stashed OUT (confirmed) — they create real sessions via `POST /api/sessions`, which needs an authenticated `claude` CLI this fresh VM doesn't have; a pre-existing environment gap, not a regression.
- `npm run typecheck` clean (session-ui.js is untyped JS, unaffected either way — checked for completeness).
- Local working tree confirmed byte-identical to what was tested (diffed against the file pulled back from the devbox).

---

## Phase 3 — Make `mobile-overview.js` catalogue-driven

**Status:** TODO
**Agent:** orchestrator

**Spec refs:**
- `src/web/public/mobile-overview.js` — 16 hardcoded CLI-related occurrences (verified 2026-09-17, exact line numbers not yet enumerated — first checklist item below is to do that enumeration)
- CLAUDE.md §"Phone overview home screen" — describes `mobile-overview.js`'s run-mode picker as "mirrors the toolbar run-mode menu (`setRunMode()` + `run()` ...)", so this picker must stay in lockstep with Phase 2's session-ui.js changes or the two surfaces will silently diverge again

**Checklist — revised after real investigation (2026-09-19):**
- [x] Enumerated every CLI-id occurrence in `mobile-overview.js` (re-grepped; the "16 occurrences" estimate from the original pre-investigation pass was stale/rough — the real count of actual per-CLI logic is much smaller and already well-structured)
- [x] Found exactly **one** CLI-related data structure: `MOBILE_OVERVIEW_RUN_MODES` (L50-61), a single literal array of `{mode, label, short}` — **not** duplicated branching logic, and not the "16 scattered occurrences" originally assumed
- [x] Checked whether this should be made `window.__codemanCliCatalog`-driven (the original plan's assumption) — **it should NOT be**, for two independent, verified reasons:
  1. `test/mobile-overview.test.ts`'s *"gates every mode the picker actually offers"* test **slices this exact array's source text** and requires `mode: 'omp'` (etc.) to appear as a literal — an intentional anti-drift guard, same pattern as session-ui.js's `_refreshRunModeAvailability` guard found in Phase 2. Removing the literal array would break it.
  2. The array's `label`/`short` values genuinely differ from the catalogue's `label`/`shortBadge` fields (e.g. `'Claude Code'` here vs. catalogue `'Claude'`; `short: 'OpenCode'` here vs. catalogue `shortBadge: 'OC'`) — swapping sources would silently change displayed text, the same class of risk the OMP label mismatch (Open Question 7) already flagged in Phase 2.
- [x] Confirmed the list is **not currently drifted** from its siblings: cross-checked against `index.html`'s `#runModeMenu` `data-mode` attributes (10/10 identical) and it already gates on `isCliAvailable()` per-mode (the file's own comment: `#201` gated the toolbar menu on availability; this list didn't, until it was fixed — that fix is already shipped and tested, this is not new work).
- [x] No `data-i18n-skip` changes needed — nothing here was touched.

**Status: DONE — no code changes made, verified safe/correct as-is (2026-09-19).** `mobile-overview.js` was NOT actually in the state the original plan assumed (that assumption was written before reading the file in detail). It is a single, already-gated, already-tested literal table — genuinely different from `session-ui.js`'s problem (8 near-identical ~45-line duplicated *functions*). Forcing it onto `window.__codemanCliCatalog` would trade a working, tested, anti-drift-guarded design for a fragile one that breaks a pinned test and silently changes user-visible text. This is a legitimate "investigated, found nothing unsafe to fix" outcome, not a shortfall — see Open Question 8 below on what `window.__codemanCliCatalog` is actually for now, given neither Phase 2 nor Phase 3 ended up needing it.

---

## Phase 4 — Regression coverage for the no-branching guard

**Status:** TODO
**Agent:** orchestrator

**Spec refs:**
- `docs/cli-registry.md` §"The no-id-branching rule" — `test/cli-registry-no-id-branching.test.ts` today scans everything outside `stock.ts`, but per CLAUDE.md's own admission the frontend was "deliberately untouched" and presumably carved out of or never reached by this guard
- `[UNDOCUMENTED]` whether `test/cli-registry-no-id-branching.test.ts` currently scans `src/web/public/*.js` at all — confirm by reading the test before writing this phase's checklist in detail

**Checklist — completed 2026-09-19:**
- [x] Read `test/cli-registry-no-id-branching.test.ts`'s scanner (`walk()`): it only visits files ending `.ts` under `src/`, so it **never touches any frontend `.js` file today** — confirmed by reading the walker directly, not assumed.
- [x] Decided **against** widening that existing guard to `src/web/public/*.js`: a full scan there hits real, expected branches across `app.js`, `terminal-ui.js`, `settings-ui.js` and others that CLAUDE.md explicitly documents as out of scope ("the frontend is deliberately untouched... moving them is its own piece of work verified by a browser/mobile suite the CI gate cannot see"). Widening the guard would force either fixing or allowlisting dozens of unrelated branches in files this plan never touched — real scope creep, not a safety net.
- [x] Added a **separate, narrowly-scoped** guard instead: `test/frontend-cli-no-id-branching.test.ts`, scanning ONLY `session-ui.js` and `mobile-overview.js` (the two files B2 actually covers), reusing the exact same four-shape `BRANCH_PATTERN` (`===`/`!==`/`case`/`.includes()`) and `STOCK_CLIS`-derived id list as the backend guard, with its own small `ALLOWED_BRANCHES` allowlist.
- [x] Manually scanned both files post-Phase-2/3 and reviewed every hit in context (not guessed): 21 branches remain across 7 logical sites, all legitimate — `run()`'s claude/shell dispatch split, `runCustomModelEntry()`'s restart-vs-one-shot mechanism difference (documented in CLAUDE.md), the Respawn/Ralph claude-only gate, the button-label ternary (Open Question 7), the `runMode` setter's validity check, and `mobile-overview.js`'s shell-exempt availability gate. Zero unreviewed/accidental hits.
- [x] Verified anti-vacuity for real: injected a genuine unrelated branch (`mode === 'codex'` in a throwaway probe function) on the live devbox, confirmed the guard **failed** (both the unapproved-branch and stale-allowlist checks fired), then reverted and confirmed it passes again — not just written to assert, actually proven to catch a regression.
- [x] Skipped the golden/snapshot-coverage checklist item (`test/cli-registry-spawn-golden.test.ts`-style pin for the frontend launch consolidation): Phase 2's own `test/run-mode-ui.test.ts`/`test/custom-model-run-menu-ui.test.ts`/`test/custom-model-one-shot-launch.test.ts` (94 tests, unmodified, still passing) already pin the exact wire-body shape per CLI end-to-end — a golden snapshot on top would duplicate coverage those tests already provide.

**Status: DONE, fully verified (2026-09-19), same devbox.** Full CI gate: **405 test files, 7717 tests, 0 failures** (5 more tests than Phase 2's baseline — exactly the new guard file's 5 tests, nothing else moved). `npm run typecheck` clean. Local working tree confirmed byte-identical to what was tested (per-file checksum comparison against the devbox, after catching and fixing a `git checkout` mishap mid-session that briefly reverted the devbox's `session-ui.js` to its pre-Phase-2 state during anti-vacuity testing — caught immediately via checksum mismatch, restored from local, re-verified).

---

## Phase 5 — Wire the "declared but not yet read" frontend fields (stretch, optional)

**Status:** TODO
**Agent:** orchestrator

**Spec refs:**
- `docs/cli-registry.md` §"Fields declared for later" — `shortBadge`, `accent`, `capabilities.echo`, `capabilities.wheelForward`, `capabilities.keyboardAccessory`, `capabilities.maxFrameBytes` are declared but unread; the doc explicitly warns *"nothing enforces that `echo.policy` matches `_updateLocalEchoState`'s fallthrough, or that `accent` matches the gradient CSS paints, so re-measure before wiring one up... A field that is both wrong and unread is worse than an absent one, because the next reader trusts it"*

**Checklist — completed via investigation 2026-09-19, confirmed OUT OF SCOPE:**
- [x] Resolved Open Question 1 definitively (not a guess): traced each field's real frontend consumer.
  - `keyboardAccessory` → `keyboard-accessory.js`'s own hand-authored shell-vs-agent bar logic (grepped directly — has its own switching logic, does not read the registry)
  - `echo`/`wheelForward` → `terminal-ui.js`'s `_updateLocalEchoState`/scroll-routing logic (the whole "Terminal scrollback strip + wheel/touch forwarding" and codex-predictive-echo sections of CLAUDE.md)
  - `accent` → `styles.css`'s hand-authored per-CLI gradient rules (`.btn-toolbar.btn-run.mode-<id>`, multi-stop gradients, not a single flat color)
  - **None of these live in `session-ui.js` or `mobile-overview.js`** — B2's actual, documented boundary (PR #380's handoff note names exactly those two files). `docs/cli-registry.md`'s own words are more specific than the plan first assumed: "`app.js`, `terminal-ui.js` and `styles.css` keep their own hand-authored per-CLI rules... verified by a browser/mobile suite the CI gate cannot see" — this is a different, larger, separately-scoped piece of work, not B2's stretch goal.
- [x] Re-measured `accent` against real rendered CSS anyway, since it was cheap to check and the doc explicitly asked for re-measurement before ever wiring a field: **found real drift**. At least 4 of 9 registry `accent` values don't match their CLI's actual button gradient — claude registers `#d97757` (orange, its real brand color) but renders a **blue** gradient; opencode registers `#f59e0b` (amber) but renders **green**; antigravity registers `#8b5cf6` (purple) but renders **cyan**; pi registers `#10b981` (green) but renders **pink/rose**. (deepseek, by contrast, matches exactly — `#4d6bfe` appears literally in both places.) This confirms `docs/cli-registry.md`'s own "transcribed, not authoritative" warning empirically rather than by assumption.
- [ ] NOT wired up. Doing so would mean either (a) editing `terminal-ui.js`/`keyboard-accessory.js`/`styles.css`, files with no mandate in this PR and their own required browser/mobile verification suite, or (b) treating the `accent` mismatches as a standalone color-correctness bugfix unrelated to B2's actual goal. Neither belongs in this PR.

**Status: Investigated, confirmed genuinely out of scope, not attempted (2026-09-19).** This closes Open Question 1. The `accent` mismatch is a real, separate finding worth flagging to the maintainer (see `PR-B2.md`), but is not part of this PR's diff.

---

## Open Questions

1. **Exact B2 scope boundary** — is Phase 5 (wiring `accent`/`echo`/`wheelForward`/`keyboardAccessory`) part of "PR B2" as originally conceived, or a separate follow-up? The only source (#380's body) names just catalogue injection + the two named files.
2. **`window.__codemanCliCatalog` field list** — Phase 1 (revised 2026-09-19) assumes `id/label/shortBadge/order/kind`, mirroring `clis.stock.json`'s exported fields. Confirm this is sufficient for Phase 2/3's needs, or whether `capabilities.external`/`altScreen`/`workDetect` also need to ship client-side (which would be new precedent — today those are spawn-time, server-only concerns per `docs/cli-registry.md`).
3. **Guard test scope (Phase 4)** — should `test/cli-registry-no-id-branching.test.ts` itself be widened to cover the frontend, or should B2 ship its own separate guard? No existing doc states an intent either way.
4. **PR sequencing** — should Phases 1-4 ship as one PR ("B2" as originally scoped) or be split further, given #380's own rationale was "avoid conflicts in a crowded area of the codebase"? Worth checking how many of the 13 PRs that touched these 3 files at #380's merge time (2026-09-14) are still open today before starting implementation.
5. ~~**`feature/run-menu-custom-model-picker` merge timing**~~ — **RESOLVED 2026-09-19**: merged, master is at v1.31.0. Phase 0 is DONE.
6. **`window.__codemanCliCatalog` vs. `window.__codemanCustomModelClis` divergence risk** — the two globals will now compute overlapping-but-different filtered views of `enabledClis()` on every `renderIndexHtml()` call. Confirm this duplication is acceptable (both are cheap, memoized-resolver-backed reads) rather than refactoring `__codemanCustomModelClis` to derive from the new broader catalogue client-side — the user's stated preference was reusing the *injection pattern*, not necessarily making one derive from the other, but worth a second look once Phase 1 code exists.
7. **OMP's run-button label is `'Run OMP'` but `CliEntry.shortBadge` is `'OM'`** (discovered during Phase 2 implementation) — a pre-existing, harmless inconsistency between the registry's "two-ish character tab badge" field and the hardcoded frontend ternary's actual 3-character text for this one CLI. Not touched (see Phase 2's revised checklist above for why). Worth a decision: leave `'Run OMP'` as a documented one-off exception if the label ternary is ever made catalogue-driven, or update `stock.ts`'s omp entry's `shortBadge` to `'OMP'` (need to check whether `shortBadge` is used elsewhere, e.g. tab badges, where 3 characters may not fit the intended UI slot, before changing it).
8. ~~**`window.__codemanCliCatalog` currently has no frontend consumer**~~ — **RESOLVED 2026-09-19 (best judgement, no user sign-off requested):** keeping it as shipped, not reverting. Both Phase 2 and Phase 3's obvious consumption sites turned out to be guarded by pinned anti-drift tests that specifically want hardcoded literals (plus real label-text mismatches between the catalogue and each file's existing values — see Open Question 7), so nothing consumes it today. Kept anyway because: (a) it's cheap — one small, already-tested, correctly-scoped `enabledClis()` projection, no ongoing maintenance cost; (b) `docs/cli-registry.md`'s own "declared but not yet read" fields (`accent`, `capabilities.echo`, etc.) are this exact pattern already established as normal practice in this codebase — verified, correct data shipped ahead of a consumer, clearly documented as such; (c) reverting would discard real, tested work to solve a problem (unused code) that this codebase already has a sanctioned pattern for. It remains genuinely useful infrastructure for any future truly-dynamic menu/picker (one that doesn't hardcode one `<button>` per CLI in `index.html` the way every current surface does) — see Phase 1's own header comment on `RUN_MODE_LAUNCH` in `session-ui.js`, which documents this exact reasoning at the point Phase 2 chose not to use it.

---

Please review `DEPLOYMENT_PLAN.md` and reply **approved** to begin implementation.
