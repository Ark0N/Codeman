# GitHub Copilot CLI integration — plan

> Tracked separately from `DEPLOYMENT_PLAN.md` (repo root), which is currently scoped to the
> unrelated, unapproved **PR B2** frontend-catalogue work (`session-ui.js`/`mobile-overview.js`
> hardcoding cleanup — also a leftover of the #343 split, see Background). Merging the two would
> conflate two independently-sequenced pieces of work; this plan follows the same
> `DEPLOYMENT_PLAN.md` phase/checklist/verify format so it can be promoted or merged later if the
> user prefers a single tracker.

## Background

[PR #343](https://github.com/Ark0N/Codeman/pull/343) ("feat: data-driven CLI registry") introduced
the whole `src/config/cli-registry/` architecture in one large, closed (not merged) PR, and shipped
a GitHub Copilot CLI entry and a Grok Build entry as proof-of-concept additions on top of it. It was
too large to review as one unit and was split:

- **PR #347** (merged 2026-09-04) — the registry core as a pure internal refactor. **DONE.**
- **PR #380** (merged 2026-09-14) — `install.sh` / Docker agent-image generation from the catalogue. **DONE.**
- Grok was subsequently carried into `master` as a real, enabled-by-default stock CLI.
- DeepSeek Harness and OMP were added to `master` later still, independently of #343.
- **Copilot was dropped during the split and was never merged.** Verified on `master`
  (2026-09-17): `git grep -i copilot` under `src/` returns nothing, and
  `src/config/cli-registry/stock.ts`'s `STOCK_CLIS` is
  `[CLAUDE, SHELL, OPENCODE, CODEX, GEMINI, ANTIGRAVITY, PI, GROK, DEEPSEEK, OMP]`.

A full, hand-written Copilot `CliEntry` still exists on a local worktree branch
(`feature/data-driven-cli-registry`, checked out at
`C:\Scripts\GitHub\opticon454\Codeman\feature-data-driven-cli-registry`) — the original #343
branch. That branch is **stale**: it predates DeepSeek/OMP joining the catalog and its `CLAUDE.md`
is still at v1.22.0 against `master`'s 1.29.1, so its registry shape (schema.ts/types.ts) has since
evolved. It is useful as **design input**, not as a diff to cherry-pick. Its Copilot entry:

- id `copilot`, label "GitHub Copilot", shortBadge "GH", binary `copilot`, npm package
  `@github/copilot`
- shipped `enabled: false` — the only stock entry disabled by default — because the branch's
  research found no verified way to resume a specific transcript id (`--resume`/`--continue`
  looked like they opened an interactive picker rather than taking an id)
- minimal launch shape: empty `launch.params`, a single `{ lit: 'copilot' }` variant, no `--model`
  support
- `env.allowedPrefixes: ['COPILOT_']`, deliberately **not** admitting `GH_TOKEN`/`GITHUB_TOKEN`
  (too generic — other tools use them, and the env-override allowlist is one global list per
  `CLAUDE.md`'s "Multi-CLI prefix discipline")
- `overlays.credStore: { rel: '.copilot', seedWhole: true }`
- `capabilities`: `agentDefaults()` spread, `altScreen: 'strip-mux-only'`, buffer echo/cursor
  anchor, `privilegedParams: []` (no bypass flag identified)

**Fresh research for this plan (2026-09-17, GitHub's own Copilot CLI docs)** turned up two things
the old branch's entry did not know about and that change its shape:

1. **Auth env precedence is documented and matches the old branch's guess**: `COPILOT_GITHUB_TOKEN`
   is checked ahead of `GH_TOKEN`, which is checked ahead of `GITHUB_TOKEN`. The `COPILOT_`-prefix
   allowlist decision holds.
2. **The config directory is `~/.copilot/` by default but is relocatable via a `COPILOT_HOME` env
   var** (`--config-dir` is called out as *deprecated* in favor of it). The old branch's
   `credStore: { rel: '.copilot', seedWhole: true }` is still right for the on-disk seed path, but
   `COPILOT_HOME` is the same shape as `CODEX_HOME`/`GROK_HOME`/DeepSeek's `DSH_HOME` elsewhere in
   the registry — a directory-redirect env var that (a) should very likely be treated as a
   `privilegedEnvKeys` entry once it is admitted anywhere, and (b) is a candidate `customModelInjection`
   `configDir` mechanism later, though that is explicitly **out of scope** for this plan (see Open
   Questions).
3. Public docs still do **not** document `--resume <id>`/`--continue` as flags with a defined
   id-based contract — only a `/resume` in-session slash command and a "session picker" are
   mentioned, with keyboard shortcuts, not an argv contract. This **confirms** the old branch's
   conclusion still holds: there is no verified way to launch straight into a specific past
   transcript, so `resumeAppend` should stay unset and the entry should ship `enabled: false`,
   exactly as before. (This should be re-verified against a real installed `copilot` binary's
   `--help` output before merging — public docs are not always exhaustive; see Phase 1.)

**Spec refs for the whole plan:**
- `docs/cli-registry.md` — registry shape, the "Adding a CLI" 5-step recipe, the no-id-branching
  rule, generated-artifact contract
- `CLAUDE.md` §CLI registry, §Multi-CLI prefix discipline
- Live reference entries on `master`: `PI`, `GROK`, `OMP` in `src/config/cli-registry/stock.ts`
  (all three are npm/curl-installed agent CLIs with no bypass flag or a codex/antigravity-shaped
  one — closest shape to Copilot)
- GitHub Copilot CLI docs: `install-copilot-cli` (auth env vars, `/login`), `cli-command-reference`
  (subcommand flags, `COPILOT_HOME`, session-picker shortcuts)

---

## Phase 0 — Verify against a real installed `copilot` binary

**Status:** TODO
**Agent:** orchestrator

**Spec refs:**
- `docs/cli-registry.md` §"Adding a CLI" — every existing entry's comments show it was verified
  against a real binary, not just docs (pi/grok/deepseek/omp's `customModelInjection` comments all
  say "CORRECTED after live-testing" at least once)
- `[UNDOCUMENTED]` public docs do not give a full top-level `copilot --help` flag list; confirm
  directly

**Checklist:**
- [ ] Install `@github/copilot` (`npm install -g @github/copilot`) on a scratch machine/container
      and run `copilot --help` / `copilot version` to get the real top-level flag list
- [ ] Confirm whether `--resume`/`--continue` (or any flag) can target a specific past session id
      non-interactively; if one exists, the entry should use it (`resumeAppend`, `resumeId` param)
      instead of shipping `enabled: false`
- [ ] Confirm whether a `--model` flag or equivalent exists
- [ ] Confirm whether copilot has any "auto-approve"/"yolo"/bypass-permissions flag analogous to
      codex's `--dangerously-bypass-approvals-and-sandbox` or grok's `--always-approve` — if one
      exists, it changes `capabilities.privilegedParams` from `[]` to a real clamp entry, which is
      a correctness-relevant gap the old branch's entry left as `[]` without confirming
- [ ] Confirm `~/.copilot/`'s real contents (config, session history, logs, "plaintext auth
      fallback" per the old branch's comment) to decide `seedWhole: true` vs a `seedFiles` list —
      cross-reference with pi/grok's per-file `credStore`, which switched away from `seedWhole`
      once they knew the directory held large/regenerable content
- [ ] Confirm `copilot --version` output format for `discovery.version.regex`

**Verify:** a captured real terminal transcript (paste or screenshot) of `copilot --help`, `copilot version`, and a live `/login` + one turn, attached to the PR description or this doc.

---

## Phase 1 — Add the `COPILOT` `CliEntry` to `stock.ts`

**Status:** TODO
**Agent:** orchestrator

**Spec refs:**
- `docs/cli-registry.md` §"The shape of an entry", §"Adding a CLI" step 1
- `src/config/cli-registry/stock.ts` — `PI`/`GROK`/`OMP` as the closest live reference shapes
  (npm/curl-installed agent CLI, no or simple bypass flag)
- `CLAUDE.md` §"Multi-CLI prefix discipline" — env-var admission must be a deliberate per-CLI
  decision, never a blanket widen

**Checklist:**
- [ ] Add `const COPILOT: CliEntry = { ... }` after `OMP` (or wherever `order` places it — next
      free `order` slot after 90, e.g. `100`), following Phase 0's confirmed flag/env/dir facts
      rather than the stale branch's guesses wherever they conflict
- [ ] `id: 'copilot'`, `label: 'GitHub Copilot'`, `shortBadge: 'GH'`, `kind: 'agent'`
- [ ] `enabled: false` unless Phase 0 found a real resume-by-id flag (in which case reconsider —
      but default disabled is the safer initial ship regardless, matching the old branch's
      reasoning that this is new/unverified territory)
- [ ] `discovery.binaries: ['copilot']`, `searchDirs` following the `HOME_DIRS` pattern used by
      every other npm-installed CLI (`local`, `usrLocal`, `npmGlobal`, `homeBin`)
- [ ] `discovery.version`: `{ arg: '--version', regex: <confirmed from Phase 0> }` — decide whether
      `requireVersionMatch` is needed (only if `copilot` is a generic-enough binary name to risk an
      npm/PATH collision, per pi/grok/omp's precedent — check npm for squatters on the name first)
- [ ] `discovery.install`: `{ command: { linux: 'npm install -g @github/copilot', darwin: 'npm
      install -g @github/copilot' }, npmPackage: '@github/copilot', docsUrl:
      'https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli'
      }`
- [ ] `launch.params`/`variants` per Phase 0's confirmed flags — empty/minimal (`{ lit: 'copilot'
      }`) if nothing else was confirmed
- [ ] `env.allowedPrefixes: ['COPILOT_']`, `env.allowedKeys: []` — do **not** admit
      `GH_TOKEN`/`GITHUB_TOKEN` (see Open Questions #1 for the one case to reconsider this)
- [ ] `capabilities: { ...agentDefaults(), altScreen: 'strip-mux-only', echo: { policy: 'buffer',
      anchor: { kind: 'cursor' } } }` unless Phase 0 found copilot's composer is per-keystroke
      reactive (codex-shaped), in which case flag it for the `'off'`/predictive-echo branch instead
      — a note-worthy risk given `docs/cli-registry.md` marks `echo` as "declared but not yet
      read" today anyway, so getting it exactly right is lower urgency than the argv/env fields
- [ ] `capabilities.privilegedParams`: `[]` unless Phase 0 found a bypass flag
- [ ] `overlays.credStore`: `{ rel: '.copilot', seedWhole: true }` (or `seedFiles` list per Phase 0)
- [ ] Add `COPILOT` to the `STOCK_CLIS` export array
- [ ] Write the `// GitHub Copilot CLI (...)` explanatory comment block above the entry, in the
      same style as the other entries — cite this plan doc and PR #343 as prior art per Open
      Question #4

**Verify:** `npm run typecheck` passes; a quick `node -e` or unit test importing `STOCK_CLIS` shows 11 entries with `copilot` present and `enabled: false`.

---

## Phase 2 — Registry mechanics: generated artifacts + required test rows

**Status:** TODO
**Agent:** orchestrator

**Spec refs:**
- `docs/cli-registry.md` §"Adding a CLI" steps 2-4
- `CLAUDE.md` §"Regenerate the CLI catalogue" — `npm run generate:cli-catalog` rewrites
  `config/clis.stock.json` **and** the embedded block in `install.sh`; **commit both**
- `test/cli-registry-spawn-golden.test.ts`, `test/cli-capability-predicates.test.ts`,
  `test/location-overlay-commands.test.ts`, `test/install-sh-detection-parity.test.ts`,
  `test/cli-catalog-sync.test.ts` — the five tests `docs/cli-registry.md` names as required per new
  entry

**Checklist:**
- [ ] Run `npm run generate:cli-catalog` and commit the resulting diffs to `config/clis.stock.json`
      and `install.sh` (verify `install.sh` still passes `bash -n` and stays bash-3.2-clean per
      CLAUDE.md — the generator should guarantee this, but confirm no manual edits crept in)
- [ ] Add a golden spawn-command pin for `copilot` to `test/cli-registry-spawn-golden.test.ts`
- [ ] Add a row for `copilot` to `test/cli-capability-predicates.test.ts` (this also exercises the
      "no two of `external`/`hooks`/`altScreen` are equivalent" cross-catalog assertion — a new
      entry with the wrong combination fails the whole suite, not just its own row)
- [ ] Add `copilot`'s remote/docker overlay commands to `test/location-overlay-commands.test.ts` —
      since Copilot has no known bypass flag, this is likely the plain `exec copilot` / login-shell
      shape (same as grok's "no remote/docker overlay needed" case) — confirm rather than assume
- [ ] Add `copilot`'s search paths to `test/install-sh-detection-parity.test.ts`
- [ ] Run `npm run generate:cli-catalog -- --check` to confirm no drift after all the above

**Verify:** `npm test` (full CI gate) passes with all five test files updated; `npm run generate:cli-catalog -- --check` exits 0.

---

## Phase 3 — Docker agent image

**Status:** TODO
**Agent:** orchestrator

**Spec refs:**
- `CLAUDE.md` §"Build the docker agent image" — `node scripts/build-agent-image.mjs --no-cache`
- `docker/agent.Dockerfile` — confirmed 2026-09-17: `claude`/`opencode`/`codex`/`gemini` share one
  `RUN npm install -g ${CLI_NPM_PACKAGES}` layer (line 47); `pi` gets a dedicated layer because it
  needs `--ignore-scripts`; `deepseek` gets a dedicated layer because it needs `pnpm` alongside it;
  `antigravity`/`grok`/`omp` are curl-installed, each its own `RUN curl ... | bash` layer
- `docs/cli-registry.md` §"Adding a CLI" step 4 — a dedicated layer is needed **only if** the CLI
  cannot install with a plain `npm install -g <pkg>`; `test/docker-agent-image-coverage.test.ts`
  requires both the layer AND the `agentImageLayer` field on a dedicated-layer entry, so an
  exclusion cannot quietly become an omission

**Checklist:**
- [ ] Confirm `npm install -g @github/copilot` needs no special flags (no `--ignore-scripts`, no
      companion package) — if confirmed, Copilot joins the shared `${CLI_NPM_PACKAGES}` layer and
      needs **no** `discovery.install.agentImageLayer` field and **no** Dockerfile edit
- [ ] If it does need something special, add a dedicated `RUN npm install -g @github/copilot ...`
      layer (mirroring pi's or deepseek's shape) and set
      `discovery.install.agentImageLayer: { kind: 'dedicated', reason: '<why>' }` on the stock
      entry from Phase 1
- [ ] Run `test/docker-agent-image-coverage.test.ts` to confirm the layer/field pairing is
      consistent either way
- [ ] Rebuild the image (`node scripts/build-agent-image.mjs --no-cache`) and confirm `copilot
      --version` answers inside a container exec, once Copilot is enabled via an override (Phase 4)

**Verify:** `npm test -- test/docker-agent-image-coverage.test.ts` passes; a real `--no-cache` image build succeeds and `docker exec <container> copilot --version` returns a version string.

---

## Phase 4 — Manual verification (no frontend work in this plan)

**Status:** TODO
**Agent:** orchestrator

**Spec refs:**
- `docs/cli-registry.md` §"The override file" — `~/.codeman/clis.json` (mode 0600) is how a
  disabled stock entry is enabled without a code change, and is how this plan's Copilot entry
  should be exercised end-to-end before any Settings-UI toggle exists for it
- `CLAUDE.md` §"CRITICAL: Always Test Before Deploying"

**Checklist:**
- [ ] Enable Copilot for a local dev server via `~/.codeman/clis.json`:
      `{ "clis": { "copilot": { "enabled": true } } }`, mode 0600
- [ ] Confirm `codeman doctor` / the CLI's own detection path reports `copilot` once installed
- [ ] Launch a session with `mode: 'copilot'` via `POST /api/sessions` (curl, not the UI — there is
      no Run-menu entry for it yet, see the note below) and confirm the pane spawns
- [ ] Complete `/login` inside the session and confirm auth persists across a respawn
- [ ] Confirm `~/.copilot` (or `$COPILOT_HOME`) gets seeded/shared per the `credStore` overlay
      chosen in Phase 1
- [ ] Confirm `npm run typecheck && npm run lint && npm test` all pass on the final diff

**⚠️ No Run-menu entry, no accent color, no welcome-screen button for Copilot from this plan
alone.** `docs/cli-registry.md` §"Fields declared for later" and the existing (separate, pending)
`DEPLOYMENT_PLAN.md` both confirm `src/web/public/session-ui.js` and `mobile-overview.js` are
still hand-authored per-CLI lists that only reflect that catalogue once "PR B2" lands — verified
2026-09-17, `session-ui.js` currently has 11 hardcoded per-mode occurrences (`grep -c`), none of
which mention `copilot`. Grok/DeepSeek/OMP all shipped their registry entries *before* getting
frontend polish, so registry-only + `enabled: false` + manual override is consistent with existing
precedent, not a shortcut unique to Copilot. Wiring the Run-menu button is out of scope here and
belongs in that other plan or a follow-up.

**Verify:** a captured transcript of the full manual flow above; `npm test` green.

---

## Open Questions

1. **`GH_TOKEN`/`GITHUB_TOKEN` passthrough** — deliberately excluded from `allowedPrefixes`
   because they're generic across tools (the pi-shaped "widens one global allowlist for every
   mode" concern from `CLAUDE.md`). Confirm this is still the right call, or whether Copilot's
   `/login`-only auth path is acceptable friction for users who already have `GITHUB_TOKEN`/`GH_TOKEN`
   exported in their shell for `gh` itself.
2. **`COPILOT_HOME` handling** — newly discovered (not in the old #343 branch). Should this plan
   add `COPILOT_HOME` to `env.tmuxSetenvKeys`/`allowedPrefixes` now, or leave it fully unhandled
   until a later `customModelInjection`-style feature needs it (the codex/grok/deepseek precedent
   of a directory-redirect env var going straight into `privilegedEnvKeys` once admitted anywhere)?
   Leaving it unhandled for this first cut is the conservative default — confirm.
3. **Referencing PR #343** — should the stock.ts comment block and/or the eventual PR description
   credit #343 as prior art (same pattern this doc already follows), and should the eventual commit
   trailer or PR body link back to it? Purely a documentation/attribution question, no code impact.
4. **Docker layer decision (Phase 3)** — pending Phase 0's install verification; flagged here so it
   isn't silently skipped if the "plain npm install" assumption turns out wrong.
5. **Sequencing against the pending, unrelated `DEPLOYMENT_PLAN.md` (PR B2)** — this plan's Phase 4
   explicitly does not touch `session-ui.js`/`mobile-overview.js`. If the user wants Copilot to get
   full frontend treatment in the same push as B2 lands, that would mean folding a "wire Copilot
   into the Run menu" checklist item into that other plan's Phase 2/3 instead of leaving it as a
   permanent gap here — confirm which the user prefers.

---

Please review `docs/copilot-integration-plan.md` and reply **approved** to begin implementation.
