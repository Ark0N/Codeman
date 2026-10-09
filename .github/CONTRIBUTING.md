# Contributing to Codeman

Thanks for wanting to help! Codeman is a small project with a fast loop: issues usually get a response within a day, good PRs get reviewed quickly, and every release credits its contributors and bug reporters by name in the release notes. This guide gets you from clone to merged PR without stepping on the traps.

## The short version

1. **Bugs**: open an issue with your OS, install method (installer / npm / git clone), browser, and which CLI + version the session was running.
2. **Questions and ideas**: use [Discussions](https://github.com/Ark0N/Codeman/discussions), not issues.
3. **Small fixes** (docs, typos, a new skin, a translation): just send the PR.
4. **Anything bigger**: open an issue or Discussion first and get a nod before building. Codeman has strong architectural invariants, and a design chat up front is what turns a big idea into a merged PR instead of a stalled one. This flow works: features like Clone Repo (#236) went idea, then design discussion, then review, then shipped.
5. **Security issues**: never a public issue. See [SECURITY.md](SECURITY.md).

## Dev setup

Requirements: Node.js 22+ (see `.nvmrc`), tmux, and at least one supported agent CLI on your PATH (Claude Code is the primary one).

```bash
git clone https://github.com/Ark0N/Codeman.git
cd Codeman
npm install        # postinstall builds the vendored xterm addon bundles
npm run dev        # dev server on http://localhost:3000
```

The frontend is plain JS served from `src/web/public/` with no bundler in dev: edit a `.js`/`.css` file and reload the page. The one exception is `index.html`, which is read once at server start, so markup changes need a server restart.

## Before you push

CI runs all of these, so save yourself a round trip:

```bash
npm run typecheck               # tsc --noEmit, strict mode
npm run lint
npm run format:check
npm run check:frontend-syntax   # syntax-checks the plain-JS frontend modules
npm run check:browser-excludes  # every browser-driven test is kept out of `npm test`
```

`npm install` also installs a `pre-push` git hook that runs these static checks (about 10-40s, machine-dependent) and blocks the push if one fails. It skips itself when you push something other than the checked-out HEAD, or when the tree has uncommitted changes the checks would read. Skip it once with `CODEMAN_SKIP_PREPUSH=1 git push`; it never replaces a `pre-push` hook of your own.

### Tests

```bash
npm test                          # the gate — exactly what CI runs
npm test -- test/<file>.test.ts   # one file
```

`npm test` is the same suite CI runs, so a green run locally means a green run there. It leaves out three suites that cannot pass on an arbitrary machine, each with its own command:

```bash
npm run test:browser   # Playwright + chromium (+ a live server; codex-predictive-echo needs a real codex binary)
npm run test:mobile    # the above plus environment-specific PNG baselines
npm run test:perf      # wall-clock benchmarks — run on an otherwise idle machine
npm run test:all       # literally everything, environmental failures included
```

Expect `test:browser`/`test:mobile`/`test:perf` to fail where the machine cannot provide what they need; read that as "not runnable here", not as a regression. `config/test-suites.ts` holds the globs, and both configs derive from it, so the exclusions and those runners cannot drift apart.

The browser suite also runs nightly (and on demand) in `.github/workflows/browser-suite.yml`; it is informational, not a gate.

If you add a test that binds a port, bind port 0 (`new WebServer(0, …)` + `server.boundPort`, or `listen({ port: 0 })` + `address().port`), or use `app.inject()` when no socket is needed; `test/test-ports-guard.test.ts` fails a `WebServer` built on any other port. Mobile tests (`test/mobile/**`, via `createTestServer(PORT)`) keep the fixed-port convention in `test/mobile/README.md` for now, because that helper caches servers by port. Never 3000.

Tests are tmux-safe by design: under vitest, the tmux layer becomes an in-memory mock, so tests cannot touch real sessions.

## Finding your way around

- Every source file starts with a `@fileoverview` JSDoc block. Read it before diving into the file, it is the map.
- [`CLAUDE.md`](../CLAUDE.md) at the repo root is the densest architecture primer in the repo. It is written for AI coding agents, but the invariants and gotchas in it apply to humans exactly the same, and most review feedback on PRs traces back to something already written there.
- Deep mechanisms and the history behind each rule live in [`docs/architecture-invariants.md`](../docs/architecture-invariants.md).
- Third-party extension surfaces are documented in [`docs/extending-codeman.md`](../docs/extending-codeman.md).

## Great first contributions

These are well-fenced areas where a first PR is genuinely easy to get right:

- **A new theme skin.** A skin is four things kept in sync: the `html[data-skin="…"]` token block in `styles.css`, the xterm ANSI palette in `terminal-ui.js`, the pre-paint allowlist and the settings picker (both in `index.html`). `test/skin-themes.test.ts` statically checks the sync, so if the test passes, your skin works.
- **A new language.** `src/web/public/i18n.js` is dependency-free, English is the canonical source, and `zh-CN` is a complete example to copy. Add your language's entries and register it in `SUPPORTED_LANGUAGES`.
- **Docs.** If you got stuck on something and then figured it out, the sentence that would have unstuck you is a PR.
- Anything labeled [`good first issue`](https://github.com/Ark0N/Codeman/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22).

Bigger extension points worth discussing first: new CLI backends (the pluggable resolver pattern has absorbed six CLIs so far; `docs/extending-codeman.md` and `docs/opencode-integration.md` show the shape), and real-device testing reports, especially mobile, which always find things emulation cannot.

## PR expectations

- **One change per PR.** Small and focused reviews fast; a grab-bag stalls.
- Target the `master` branch.
- **Keep your branch mergeable.** A PR with conflicts silently gets no CI runs at all (GitHub quirk), so rebase or merge master when conflicts appear.
- Include or update tests when you change behavior. Route handlers have a lightweight pattern in `test/routes/` using `app.inject()` (no live server needed).
- Formatting is Prettier with a deliberately narrow scope (`npm run format`), several frontend files are hand-formatted on purpose and excluded via `.prettierignore`. Don't "fix" a file by adding it back into Prettier's scope.
- Don't bump versions or touch `CHANGELOG.md`; releases are handled by the maintainer via changesets after merge.
- AI-assisted contributions are welcome (much of Codeman is built that way), with one condition: you must understand what you're submitting and have actually run it. "The model said it works" is not a test.

## Conduct

Be kind, be direct, assume good faith. Report unacceptable behavior privately via the contact in [SECURITY.md](SECURITY.md).
