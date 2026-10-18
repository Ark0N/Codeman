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

3. **Consume the changeset**: `npm run version-packages` (auto-bumps `package.json` files, updates `CHANGELOG.md`, runs `npm install --package-lock-only`, and verifies lockfile sync via `scripts/check-lockfile-sync.mjs` — all in one command; never hand-edit `CHANGELOG.md` or `package-lock.json` versions. It also writes `src/web/public/whats-new.json` (`scripts/generate-whats-new.mjs`): the bold lead-in of each change in the new `CHANGELOG.md` section, which the browser announces once per version in a toast. Commit it with the release; `test/whats-new.test.ts` fails when its version differs from `package.json`, so a hand bump needs `node scripts/generate-whats-new.mjs && npx prettier --write src/web/public/whats-new.json` too. A release whose notes have no bold lead-ins ships an empty list and shows no toast)
4. **Sync CLAUDE.md version**: Update the `**Version**` line in the root `CLAUDE.md` (under COM Shorthand) to match the new version from `package.json`
5. **Commit and deploy**: verify the branch first (`git branch --show-current`), then stage EXPLICIT paths — never `git add -A`, which has swept another session's WIP into a release. `git status --short` and account for every line before committing:
   `git add <paths> && git commit -m "chore: version packages" && git push && npm run build && systemctl --user restart codeman-web`
6. **Refresh the getcodeman.com version badge**: the landing page's status bar carries the release version (`v<x.y.z> · getcodeman.com · MIT`), so it goes stale on every release if nobody bumps it. The site source and its deploy script are maintained outside this repository, on the maintainer's machine only; follow the local site handbook there, which also covers the numbers strip and `sitemap.xml` refresh that belong in the same pass. Poll production (`curl -s https://getcodeman.com/ | grep v<x.y.z>`) before calling it done, since the edge lags a deploy by up to a minute. Not applicable to contributor clones — skip it and say so.
7. **Wait for CI**: after `git push`, TWO workflows fire per master push — `CI` and `Release` (the npm publish + GitHub release). List both runs for the pushed commit with `gh run list --commit $(git rev-parse HEAD) --json databaseId,workflowName` and watch EACH with `gh run watch <id> --exit-status`. Confirm both pass before considering the release done (`gh run list -L 1` returns only one of the two).

8. **Publish the new version to the MCP registry**: `codeman mcp` is listed in the official MCP registry as `io.github.Ark0N/codeman`, and the registry does not follow npm, so every release is published there by hand or the listing stays on the old version. `npm run version-packages` has already written the new version into `config/mcp-registry/server.json` (`scripts/sync-plugin.mjs`). Wait until npm serves it (`npm view aicodeman version`; it can lag the green `Release` run by several minutes), because the registry checks that the npm package exists and carries `mcpName: io.github.Ark0N/codeman`. Then run `cd config/mcp-registry && mcp-publisher publish`, preceded by `mcp-publisher login github` when the saved login has expired, signed in as the account that owns the `io.github.Ark0N/` namespace. Use mcp-publisher 1.8.1 or newer (`mcp-publisher --version`), the release binary from https://github.com/modelcontextprotocol/registry/releases: the Snap Store package is stuck at 1.1.0 and rejects the current `$schema` with a false "deprecated schema detected", so never edit `server.json` for that error. Older publishers also save their login as `.mcpregistry_github_token` and `.mcpregistry_registry_token` (live tokens) in the current directory; move those out of the repo, never commit them. Confirm with `curl -s 'https://registry.modelcontextprotocol.io/v0/servers?search=io.github.Ark0N/codeman' | jq -r '.servers[] | "\(.server.version) latest=\(._meta["io.modelcontextprotocol.registry/official"].isLatest)"'`: the new version must be the one with `latest=true`. Maintainer only (it needs that GitHub account); contributor clones skip it and say so.

9. **Announce it in Discussions**: every release gets a post in the [Announcements](https://github.com/Ark0N/Codeman/discussions/categories/announcements) category, shaped like #418 and #302: the short version first (one bold lead-in per theme, features before fixes, what it does for the user rather than how it works), contributor @-mentions inline where their work is described (a mention notifies them, and a contributor reposting is the cheapest reach this project has), a link to the release, and the Thanks names at the end. Casual first-person voice, no em-dashes, humanizer pass when the skill is available. A same-day follow-on patch (1.28.1 after 1.28.0) is folded into the previous post as an edit, never a second thread. Post it with `gh api graphql -F body=@<file> -f title='Codeman <x.y.z>: <hook>' -f repo=R_kgDOQ-SMDg -f cat=DIC_kwDOQ-SMDs4DCHZE -f query='mutation($repo:ID!,$cat:ID!,$title:String!,$body:String!){createDiscussion(input:{repositoryId:$repo,categoryId:$cat,title:$title,body:$body}){discussion{number url}}}'` (the repo's node id and its Announcements category id; `pinDiscussion` does not exist in the API, so pinning stays a click in the UI). This step exists because announcements stopped at 1.18 (#302) while ten releases shipped with nobody notified; #418 is the backfill covering 1.19.0 to 1.28.1, and release notes only count as content once they reach a surface people are subscribed to.

CI runs `npm run check:lockfile` on every push/PR, so lockfile drift fails the build even if the `version-packages` script is bypassed.
