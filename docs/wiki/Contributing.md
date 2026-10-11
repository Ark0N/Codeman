# Contributing

The full guide lives in
[CONTRIBUTING.md](https://github.com/Ark0N/Codeman/blob/master/.github/CONTRIBUTING.md).
This page is the short orientation, plus how to fix a page in this wiki.

## Where things go

| You have                    | Send it to                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| A bug                       | An [issue](https://github.com/Ark0N/Codeman/issues), with OS, install method, browser, and which CLI the session was running. |
| A question or setup problem | [Discussions](https://github.com/Ark0N/Codeman/discussions).                                    |
| An idea                     | [Ideas](https://github.com/Ark0N/Codeman/discussions/categories/ideas), where it gets voted on.  |
| A small fix                 | Straight to a PR.                                                                                |
| A bigger feature            | An issue or Discussion first, then build once the design has a nod.                              |
| A security problem          | Never a public issue. See [SECURITY.md](https://github.com/Ark0N/Codeman/blob/master/.github/SECURITY.md). |

Issues usually get a response within a day, and every release credits its contributors and
bug reporters by name.

## Dev setup

```bash
git clone https://github.com/Ark0N/Codeman.git
cd Codeman
npm install        # postinstall builds the vendored xterm addon bundles
npm run dev        # http://localhost:3000
```

Requirements: Node 22+, tmux, and at least one agent CLI on your PATH.

The frontend is plain JavaScript with no bundler in dev: edit a `.js` or `.css` file and
reload. The exception is `index.html`, which is read once at server start, so markup changes
need a restart.

## Before you push

CI runs all of these, so running them locally saves a round trip:

```bash
npm run typecheck
npm run lint
npm run format:check
npm run check:frontend-syntax
npm run check:browser-excludes
npm test                          # the gate, exactly what CI runs
npm test -- test/<file>.test.ts   # one file
```

`npm install` installs a `pre-push` git hook that runs the static checks above (about 10-40s,
machine-dependent) and blocks a push that would fail them. It skips itself when you push
something other than the checked-out HEAD, or when the tree has uncommitted changes the
checks would read. Skip it once with `CODEMAN_SKIP_PREPUSH=1 git push`; a
`pre-push` hook of your own is never overwritten.

`npm test` runs the same suite CI runs, so a green run locally means a green run there. A bare
`npx vitest run` resolves the same isolated config (a root `vitest.config.ts`), so it never
touches your real `~/.codeman`; it did before that file existed. `npm test` also
leaves out three suites that cannot pass on an arbitrary machine, each with its own command:
`npm run test:browser` (Playwright, Chromium and a live server), `npm run test:mobile` (the
same plus environment-specific screenshot baselines) and `npm run test:perf` (wall-clock
benchmarks for an otherwise idle machine). Expect those to fail where the machine cannot
provide what they need; that means "not runnable here", not a regression.

Tests are tmux-safe by design: under vitest the tmux layer becomes an in-memory mock, so
tests cannot touch real sessions. If you add a test that binds a port, bind port 0
(`new WebServer(0, …)` + `server.boundPort`, or `listen({ port: 0 })` + `address().port`),
or use `app.inject()` when no socket is needed. Mobile tests call `createTestServer()` and
read `server.boundPort`. Never 3000.

## Finding your way around

- Every source file opens with a `@fileoverview` block. Read it before the file; it is the
  map.
- [`CLAUDE.md`](https://github.com/Ark0N/Codeman/blob/master/CLAUDE.md) at the repo root is
  the densest architecture primer there is. It is written for AI coding agents, but its
  invariants apply identically to humans, and most review feedback traces back to something
  already written there.
- [`docs/architecture-invariants.md`](https://github.com/Ark0N/Codeman/blob/master/docs/architecture-invariants.md)
  holds the deep mechanisms and the history behind each rule.

## Good first contributions

- **A theme skin.** A skin is four things kept in sync, and a static test checks the sync, so
  if the test passes your skin works.
- **A language.** The i18n module is dependency-free, English is canonical, and Simplified
  Chinese is a complete example to copy.
- **Docs.** If you got stuck and then figured it out, the sentence that would have unstuck
  you is a pull request.
- Anything labelled
  [good first issue](https://github.com/Ark0N/Codeman/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22).

Worth discussing first: new CLI backends, and real-device testing reports, especially
mobile, which always find things emulation cannot.

## PR expectations

- One change per PR. Small and focused reviews fast; a grab bag stalls.
- Target `master`.
- **Keep your branch mergeable.** A PR with conflicts silently gets no CI runs at all, which
  is a GitHub quirk rather than a Codeman one. Rebase when conflicts appear.
- Include or update tests when you change behaviour.
- Do not bump versions or edit the changelog; releases are handled after merge.
- AI-assisted contributions are welcome, with one condition: understand what you are
  submitting, and actually run it. "The model said it works" is not a test.

## Fixing this wiki

These pages are generated from
[`docs/wiki/`](https://github.com/Ark0N/Codeman/tree/master/docs/wiki) in the main
repository, and pushed here automatically when master changes.

**Editing a page in the browser will be overwritten by the next sync.** Send a pull request
against `docs/wiki/` instead. It is plain markdown, and a documentation PR is a genuinely
useful contribution.

Conventions for wiki pages:

- Links between pages use the wiki form: `[Remote Access](Remote-Access)`, no `.md`.
- Links into the repository are absolute `https://github.com/Ark0N/Codeman/blob/master/...`
  URLs.
- Images are referenced from the main repository over raw URLs rather than being copied into
  the wiki.
- Say what the default is, especially when it is off. Most of Codeman is opt-in.
- Label Claude-only behaviour every time it appears. Nine of the ten run modes are not
  Claude.

## Conduct

Be kind, be direct, assume good faith. Report unacceptable behaviour privately via the
contact in
[SECURITY.md](https://github.com/Ark0N/Codeman/blob/master/.github/SECURITY.md).
