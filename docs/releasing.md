# Releasing Codeman (the COM procedure)

> Moved from the root `CLAUDE.md`, which keeps a pointer here. What SemVer covers is defined in `docs/versioning-policy.md`. The root file's Session Safety rules (branch check, explicit paths, never `git add -A`) apply to every step.

When user says "COM":

1. **Determine bump type**: `COM` = patch (default), `COM minor` = minor, `COM major` = major
2. **Create a changeset file** (no interactive prompts). Write a `.md` file in `.changeset/` with a random filename:

   ```bash
   cat > .changeset/$(openssl rand -hex 4).md << 'CHANGESET'
   ---
   "aicodeman": patch
   ---

   Detailed description of ALL changes since last release (not just the most recent commit — review full git log since last version tag)
   CHANGESET
   ```

   Replace `patch` with `minor` or `major` as needed. Include `"xterm-zerolag-input": patch` on a separate line if that package changed too.

   **Write it in the shape the release page is built from.** `CHANGELOG.md` keeps changesets' format, and the `Release` workflow rebuilds the GitHub release from that section (`scripts/generate-release-notes.mjs`, which also titles it `Codeman <x.y.z>`). The in-app update toast reads the same bold lead-ins:

   ```markdown
   ### Thanks
   - @someone for what they did (#123).

   **What the change does for the user (#123).** Two or three plain sentences.

   **Fixes.**
   - **What works now (#124).** What was wrong. Behaviour change: what a user has to do differently.

   **Fixes applied while landing.** One sentence each.

   **Docs and tests.** One sentence.
   ```

   `### Thanks` stays first and opens the page. A bold lead-in that ends in punctuation becomes a heading under What's new, so make it a short headline. `**Fixes.**` and its list become a Fixes section, and the last two labels share an Also in this release section (the labels are `SECTION_LABELS` in `scripts/lib/whats-new.mjs`). `Behaviour change:` and `Breaking:` are put in bold wherever they appear, so use those words for anything a user has to act on. Keep each change short: how it works belongs in the docs, and a long paragraph is a wall of text even under a heading. Text the script does not recognise stays on the page as plain paragraphs. After step 3, `node scripts/generate-release-notes.mjs` prints the page. If the workflow warns that it kept the changesets notes, fix the changelog and run `gh release edit codeman@<x.y.z> --notes-file <file>`.

3. **Consume the changeset**: `npm run version-packages` (auto-bumps `package.json` files, updates `CHANGELOG.md`, runs `npm install --package-lock-only`, and verifies lockfile sync via `scripts/check-lockfile-sync.mjs` — all in one command; never hand-edit `CHANGELOG.md` or `package-lock.json` versions. It also writes `src/web/public/whats-new.json` (`scripts/generate-whats-new.mjs`): the bold lead-in of each change in the new `CHANGELOG.md` section, which the browser announces once per version in a toast. Commit it with the release; `test/whats-new.test.ts` fails when its version differs from `package.json`, so a hand bump needs `node scripts/generate-whats-new.mjs && npx prettier --write src/web/public/whats-new.json` too. A release whose notes have no bold lead-ins ships an empty list and shows no toast)
4. **Sync CLAUDE.md version**: Update the `**Version**` line in the root `CLAUDE.md` (under COM Shorthand) to match the new version from `package.json`
5. **Commit and deploy**: verify the branch first (`git branch --show-current`), then stage EXPLICIT paths — never `git add -A`, which has swept another session's WIP into a release. `git status --short` and account for every line before committing:
   `git add <paths> && git commit -m "chore: version packages" && git push && npm run build && systemctl --user restart codeman-web`
6. **Refresh the getcodeman.com version badge**: the landing page's status bar carries the release version (`v<x.y.z> · getcodeman.com · MIT`), so it goes stale on every release if nobody bumps it. The site source and its deploy script are maintained outside this repository, on the maintainer's machine only; follow the local site handbook there, which also covers the numbers strip and `sitemap.xml` refresh that belong in the same pass. Poll production (`curl -s https://getcodeman.com/ | grep v<x.y.z>`) before calling it done, since the edge lags a deploy by up to a minute. Not applicable to contributor clones — skip it and say so.

   A site change that links the Mac app (`Codeman.dmg`, `/mac`) deploys only after step 7 showed the `macOS app` job green and the [DMG check](#the-mac-app-codemandmg) answered 200: the DMG reaches the release well after the npm publish, and the download link answers 404 until then.

7. **Wait for CI**: after `git push`, TWO workflows fire per master push: `CI` and `Release` (the npm publish, the GitHub release, the MCP registry publish and, when Codeman itself was published, the `macOS app` job that attaches `Codeman.dmg`). List both runs for the pushed commit with `gh run list --commit $(git rev-parse HEAD) --json databaseId,workflowName` and watch EACH with `gh run watch <id> --exit-status`. Confirm both pass before considering the release done (`gh run list -L 1` returns only one of the two).

8. **Check the MCP registry**: `codeman mcp` is listed in the official MCP registry as `io.github.Ark0N/codeman`, and the registry does not follow npm, so every release is published there. The `Release` workflow does this itself in its `MCP registry` job (`.github/workflows/publish-mcp.yml`): it waits until npm serves the version, because the registry checks that the npm package exists and carries `mcpName: io.github.Ark0N/codeman`, signs in with the workflow's GitHub OIDC token (no secret, no browser) and publishes the `config/mcp-registry/server.json` that `npm run version-packages` wrote (`scripts/sync-plugin.mjs`). A version the registry already has is skipped. Confirm with `curl -s 'https://registry.modelcontextprotocol.io/v0/servers?search=io.github.Ark0N/codeman' | jq -r '.servers[] | "\(.server.version) latest=\(._meta["io.modelcontextprotocol.registry/official"].isLatest)"'`: the new version must be the one with `latest=true`. If the job failed, `gh workflow run publish-mcp.yml` publishes the version on master again. Its publisher is pinned: bump `MCP_PUBLISHER_VERSION` and `MCP_PUBLISHER_SHA256` together, the digest from the release's asset. The local fallback is `cd config/mcp-registry && ~/.local/bin/mcp-publisher login github && ~/.local/bin/mcp-publisher publish`, signed in as the account that owns the `io.github.Ark0N/` namespace, with mcp-publisher 1.8.1 or newer, the release binary from https://github.com/modelcontextprotocol/registry/releases: the Snap Store package is stuck at 1.1.0 and rejects the current `$schema` with a false "deprecated schema detected", so never edit `server.json` for that error. Older publishers also save their login as `.mcpregistry_github_token` and `.mcpregistry_registry_token` (live tokens) in the current directory; move those out of the repo, never commit them.

9. **Announce it in Discussions**: every release gets a post in the [Announcements](https://github.com/Ark0N/Codeman/discussions/categories/announcements) category, shaped like #418 and #302: the short version first (one bold lead-in per theme, features before fixes, what it does for the user rather than how it works), contributor @-mentions inline where their work is described (a mention notifies them, and a contributor reposting is the cheapest reach this project has), a link to the release, and the Thanks names at the end. Casual first-person voice, no em-dashes, humanizer pass when the skill is available. A same-day follow-on patch (1.28.1 after 1.28.0) is folded into the previous post as an edit, never a second thread. Post it with `gh api graphql -F body=@<file> -f title='Codeman <x.y.z>: <hook>' -f repo=R_kgDOQ-SMDg -f cat=DIC_kwDOQ-SMDs4DCHZE -f query='mutation($repo:ID!,$cat:ID!,$title:String!,$body:String!){createDiscussion(input:{repositoryId:$repo,categoryId:$cat,title:$title,body:$body}){discussion{number url}}}'` (the repo's node id and its Announcements category id; `pinDiscussion` does not exist in the API, so pinning stays a click in the UI). This step exists because announcements stopped at 1.18 (#302) while ten releases shipped with nobody notified; #418 is the backfill covering 1.19.0 to 1.28.1, and release notes only count as content once they reach a surface people are subscribed to.

CI runs `npm run check:lockfile` on every push/PR, so lockfile drift fails the build even if the `version-packages` script is bypassed.

## The Mac app (Codeman.dmg)

Every Codeman release carries the native macOS app (`packages/desktop`) as `Codeman.dmg` plus `Codeman.dmg.sha256`. The name never changes, so https://github.com/Ark0N/Codeman/releases/latest/download/Codeman.dmg always serves the newest app, while each release keeps its own copy at `https://github.com/Ark0N/Codeman/releases/download/codeman@<x.y.z>/Codeman.dmg` (link that one in release notes). The app keeps its own version (`packages/desktop/Cargo.toml`), so the DMG of Codeman 1.50.0 holds app 0.1.0.

**How it gets there.** When npm took a Codeman release (not one that moved only xterm-zerolag-input), the `Release` run's `macOS app` job calls `.github/workflows/desktop-dmg.yml` with the tag `codeman@<x.y.z>`. It has three jobs, so no job that holds a secret runs code from a crate: `build` runs `cargo test --locked` and `bundle-macos.sh --universal` on the release commit with a read-only token and no secret; `sign` imports the Developer ID certificate into a throwaway keychain and runs `packages/desktop/scripts/sign-macos.sh`, which signs the app with the hardened runtime, has Apple notarize it, staples the ticket, builds the DMG around it and signs, notarizes and staples that too; `attach` uploads both files to the release (`--clobber`) and checks that the download links serve those bytes. The release job's `Keep Latest on the Codeman release` step puts the Latest badge back on the newest `codeman@` release after every publish, since the stable link follows that badge.

**The secrets** are repository secrets, passed to the job by name (never `secrets: inherit`, which would hand it `NPM_TOKEN`): `MACOS_CERT_P12` (the Developer ID Application certificate WITH its private key, exported from Keychain Access as a .p12, then `base64 -i <file>.p12`), `MACOS_CERT_PASSWORD` (the export password), `APPLE_ID`, `APPLE_APP_PASSWORD` (an app-specific password for that Apple ID, made at account.apple.com) and `APPLE_TEAM_ID`. A Developer ID certificate lasts five years; its successor replaces the first two secrets and nothing else.

**Check it before anything links to it.** The DMG lands after a universal build and two notary submissions, so well after the npm publish, and until then the stable link answers 404:

```bash
gh release view codeman@<x.y.z> --json assets -q '.assets[].name'   # Codeman.dmg and Codeman.dmg.sha256
curl -sIL -o /dev/null -w '%{http_code}\n' https://github.com/Ark0N/Codeman/releases/latest/download/Codeman.dmg   # 200
```

**Dry run.** `gh workflow run desktop-dmg.yml` builds, signs and notarizes master and attaches nothing; `gh workflow run desktop-dmg.yml --ref <branch>` does the same for a branch that carries the workflow (GitHub starts a manual run only for a workflow file that is also on master). The signed DMG is the run's `codeman-dmg` artifact (`gh run download <run-id> -n codeman-dmg`). For a first-launch test, download it on a Mac through the browser from the run page instead, so the copy is quarantined like one from a release.

**Rebuild a release's DMG.** `gh workflow run desktop-dmg.yml -f tag=codeman@<x.y.z>`, started from master (the only ref allowed to attach), builds that tag and replaces its `Codeman.dmg`. It works for any release that carries `packages/desktop/scripts/sign-macos.sh`. The tag must be a Codeman release tag (`codeman@x.y.z`, or the `aicodeman@x.y.z` a failed rename leaves) whose commit is on master's history: `build` and `sign` both refuse anything else before they run its scripts, since `sign` runs them with the signing key unlocked. A failed job is also retried in place with `gh run rerun <run-id> --failed`.

**If notarization fails.** The `Sign and notarize` job's log names the submission and prints Apple's log for it (`xcrun notarytool log <id>` with the same login shows it again).

- `HTTP status code: 401` (invalid credentials) or `403` (a required agreement is missing or has expired) at the first submission: a new Apple ID password revokes every app-specific password, so make a new one and update `APPLE_APP_PASSWORD`, or accept the new agreement at developer.apple.com, then `gh run rerun <run-id> --failed`.
- `0 valid Developer ID Application identities` in the `Signing keychain` step: the .p12 lacks its private key or holds another certificate type. A team mismatch there means `APPLE_TEAM_ID` names another team than the certificate.
- `In Progress` at the 45-minute limit, or a network error: Apple's service was slow. Rerun the failed job.
- `Invalid`: Apple's log names the file and the reason (a binary without the hardened runtime or a secure timestamp, an entitlement it refuses). That is a code fix and a new release. Until then keep the stable link on the last app that passed, `gh release edit codeman@<previous> --latest`, and hold any site change that links the new one.

**By hand on a Mac**, only when the workflow cannot be fixed in time: in a clean checkout of the tag, `env -u CODEMAN_DESKTOP_INSTALLER_URL -u CODEMAN_DESKTOP_INSTALL_BRANCH packages/desktop/scripts/bundle-macos.sh --universal`, then `SIGN_IDENTITY="Developer ID Application: ..." NOTARY_PROFILE=<profile> packages/desktop/scripts/sign-macos.sh packages/desktop/dist/Codeman.app <out-dir>` (a profile saved with `xcrun notarytool store-credentials`), then `gh release upload codeman@<x.y.z> <out-dir>/Codeman.dmg <out-dir>/Codeman.dmg.sha256 --clobber`. Never upload a build made with either of those two variables set: it installs Codeman from the test branch it names.

**Toolchain and runner.** `desktop-dmg.yml` and the pull-request check `desktop-ci.yml` (`cargo fmt --check`, clippy with `-D warnings` and `cargo test --locked` on macOS, for changes under `packages/desktop`) both pin `RUST_TOOLCHAIN` and run on `macos-26`. Move them together.

## Security notices

A security notice is a sticky warning card about something outside Codeman that its users should act on (the first: OpenCode's Console breach, October 2026). On a browser that gets the release's update toast it appears inside that toast instead, so nobody sees it twice. Notices live in `src/web/public/security-notices.json`, which is maintained BY HAND; never put one in `whats-new.json`, which `npm run version-packages` rewrites. A notice reaches users only with a release, so add it before the COM that should carry it.

**Adding one**: append an entry to `notices`:

```json
{
  "id": "opencode-console-breach-2026-10",
  "severity": "warning",
  "cli": "opencode",
  "published": "2026-10-17",
  "expires": "2026-12-31",
  "title": "OpenCode Console breach: check your API keys",
  "message": "A few short plain sentences, about 50 words at most: what happened and what to do.",
  "link": { "label": "Read OpenCode's notice", "url": "https://..." },
  "i18n": { "zh-CN": { "title": "...", "message": "...", "label": "..." } }
}
```

- `id` is stable and unique, and never reused: a browser that closed a notice remembers its id (`codeman-security-notices-seen` in localStorage), so a reworded notice under the same id is NOT shown again to anyone who closed it. Give a materially new warning a new id.
- `cli` (optional) is a registry CLI id. The notice is then shown only on a server where that CLI is installed and enabled; without `cli` it is shown to everyone.
- `published` and `expires` are inclusive `YYYY-MM-DD` days in the viewer's local time. Set `published` a day before the release ships, so the notice is already live in every timezone when it lands (a browser still on the previous day would otherwise take the plain update toast and see the notice later as a separate card). `expires` is what keeps an old notice from alarming a browser that first opens Codeman months later, so always set one.
- Keep `message` to about 50 words and do not repeat the card's chrome (the "Security notice" eyebrow and the title are already on it): on a phone the card shares the screen with the update toast's text, and a longer one has to be scrolled to reach its buttons. State only what the affected vendor has said.
- `title` (optional) is the card's bold line; keep it short. `link.url` must be https. `i18n` is optional; a missing string falls back to the English one.
- Run `npx prettier --write src/web/public/security-notices.json` and `npm test -- test/security-notices.test.ts`, which validates the file (unique ids, real dates, https links, every `cli` a stock registry id, a zh-CN title wherever there is an English one).

**Retiring one**: let it expire, or delete the entry once it has. Removing it early stops it on the next release only; browsers already showing it keep the card until they close it or reload. Until then a fresh install gets it too, because a new browser has no seen list, so give an `expires` no later than the warning stays useful. An empty list (`{ "notices": [] }`) is a valid file.
