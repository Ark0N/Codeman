/**
 * @fileoverview Git hook bodies + install policy, shared by scripts/postinstall.js and
 * pinned by test/git-hooks.test.ts.
 *
 * Why a pre-push hook: the static CI job (lockfile, typecheck, lint, format, frontend
 * syntax, ...) fails often on things a contributor could have caught locally in seconds,
 * and finding out after a push costs a full CI round-trip plus a fix-up commit. Running
 * the same checks before the push surfaces those failures in ~10-40s instead (12s on a fast
 * workstation, ~35s measured elsewhere; typecheck, format:check and lint dominate).
 *
 * Why pre-PUSH and not pre-commit: a commit is cheap and local, a push is what CI and
 * reviewers pick up. And why the STATIC tier only: the unit/integration suite takes
 * minutes, which nobody tolerates per push, so a hook that ran it would be bypassed
 * within a day. The checks below mirror the static CI job.
 *
 * ⚠️ The checks read the WORKING TREE, not the commits being pushed. So the hook skips
 * (with a one-line notice) whenever the two can differ: when HEAD is not the commit being
 * pushed, and when `git status` shows uncommitted or untracked changes in a path a check
 * reads ({@link PRE_PUSH_WATCHED_PATHS}). In a checkout shared by several agent sessions
 * the second case is usually another session's WIP, which must not block this push.
 *
 * ⚠️ This installer is deliberately MARKER-OWNED, unlike the older pre-commit installer in
 * postinstall.js which overwrites whatever it finds. A developer's own pre-push hook must
 * survive `npm install`.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/** Ownership marker. Bump the version suffix when the body changes meaningfully. */
export const PRE_PUSH_MARKER = '# codeman-managed-hook: pre-push v1';

/**
 * Checks that make up the fast tier, cheapest first so failures surface sooner. Each entry
 * is the argument list for `npm run`, and each is a step of the static job in
 * .github/workflows/ci.yml (test/git-hooks.test.ts pins that every script exists).
 */
export const PRE_PUSH_CHECKS = [
  ['check:lockfile'],
  ['generate:cli-catalog', '--', '--check'],
  ['check:browser-excludes'],
  ['check:frontend-syntax'],
  ['format:check'],
  ['lint'],
  ['typecheck'],
];

/**
 * Paths whose uncommitted state would leak into a check, so a dirty one makes the hook skip.
 * Derived from what each check reads: src/ (format:check, lint, typecheck,
 * check:frontend-syntax), config/ (eslint + vitest configs, test-suites.ts, the CLI
 * catalogue), scripts/ (every check is a script there, and typecheck's second pass compiles
 * one), test/ (check:browser-excludes scans it and runs `vitest list` over it),
 * package.json + package-lock.json (check:lockfile) and install.sh (generate:cli-catalog
 * --check diffs its generated block).
 */
export const PRE_PUSH_WATCHED_PATHS = [
  'src',
  'config',
  'scripts',
  'test',
  'package.json',
  'package-lock.json',
  'install.sh',
];

/**
 * Render the pre-push hook script.
 *
 * POSIX sh, not bash: this ships to whatever shell the contributor's git uses.
 */
export function renderPrePushHook() {
  const runs = PRE_PUSH_CHECKS.map((args) => `run_check ${args.join(' ')}`).join('\n');
  const watched = PRE_PUSH_WATCHED_PATHS.join(' ');

  return `#!/bin/sh
${PRE_PUSH_MARKER}
# Installed by scripts/postinstall.js. Edit scripts/git-hooks.mjs, not this file:
# it is regenerated on npm install. Delete the marker line above to take ownership
# and the installer will leave your version alone.
#
# Skip once:   CODEMAN_SKIP_PREPUSH=1 git push
# Skip always: remove this file.

[ "$CODEMAN_SKIP_PREPUSH" = "1" ] && exit 0

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$repo_root" || exit 0

# Nothing to check without dependencies (fresh clone, or a worktree that never ran
# npm install). Warn rather than blocking the push on a setup detail.
if [ ! -d node_modules ]; then
  echo "pre-push: node_modules missing, skipping checks (run 'npm install' to enable them)."
  exit 0
fi

# git feeds us "<localref> <localsha> <remoteref> <remotesha>" per ref. A deletion has an
# all-zero local sha and no tree worth checking; if every ref is a deletion, skip.
# The checks below read the working tree, so they only say something about a pushed commit
# that IS the checked-out HEAD (tags are peeled to their commit first).
head=$(git rev-parse -q --verify HEAD 2>/dev/null)
has_content=0
not_head=''
while read -r localref localsha _remoteref _remotesha; do
  [ -z "$localsha" ] && continue
  case "$localsha" in
    0000000000000000000000000000000000000000) ;;
    *)
      has_content=1
      commit=$(git rev-parse -q --verify "$localsha^{commit}" 2>/dev/null)
      [ -n "$head" ] && [ "$commit" = "$head" ] || not_head="$localref"
      ;;
  esac
done
[ "$has_content" = "0" ] && exit 0

if [ -n "$not_head" ]; then
  echo "pre-push: skipping static checks: $not_head is not the checked-out HEAD, and the checks read the working tree."
  exit 0
fi

# Uncommitted or untracked changes in a path a check reads would be judged instead of the
# pushed commit. In a checkout shared by several sessions that is usually someone else's WIP.
if [ -n "$(git --no-optional-locks status --porcelain -- ${watched} 2>/dev/null)" ]; then
  echo "pre-push: skipping static checks: uncommitted changes under ${watched} would be checked instead of the pushed commit."
  exit 0
fi

log=$(mktemp "\${TMPDIR:-/tmp}/codeman-prepush.XXXXXX") || exit 0
trap 'rm -f "$log"' EXIT

failed=''
run_check() {
  if ! npm run --silent "$@" >"$log" 2>&1; then
    echo ""
    echo "pre-push: FAILED  npm run $*"
    tail -n 25 "$log"
    failed="$failed $1"
  fi
}

echo "pre-push: running static checks (~10-40s)..."
${runs}

if [ -n "$failed" ]; then
  echo ""
  echo "pre-push: blocked by:$failed"
  echo "Fix, or push anyway with:  CODEMAN_SKIP_PREPUSH=1 git push"
  exit 1
fi

echo "pre-push: static checks passed."
exit 0
`;
}

/**
 * Decide what to do with an existing hook file.
 *
 * @param {{ existing: string | null | undefined, next: string }} args
 * @returns {'write' | 'up-to-date' | 'skip-foreign'}
 */
export function planHookInstall({ existing, next }) {
  if (existing === null || existing === undefined || existing.trim() === '') return 'write';
  if (!existing.includes(PRE_PUSH_MARKER)) return 'skip-foreign';
  return existing === next ? 'up-to-date' : 'write';
}

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/**
 * realpath() that tolerates a missing leaf: a fresh `.git` may have no `hooks/` yet, so
 * canonicalize the parent and re-append the name. Throws if the parent is missing too.
 *
 * @param {string} path
 */
function canonicalPath(path) {
  return existsSync(path) ? realpathSync(path) : join(realpathSync(dirname(path)), basename(path));
}

/**
 * Resolve the hooks directory for the checkout rooted at `repoRoot`, or null when there
 * is nothing to install into.
 *
 * Asks git (`--git-path hooks`) rather than assuming `<root>/.git/hooks`: in a worktree
 * `.git` is a FILE pointing at the parent repo, so the hooks live under
 * `--git-common-dir`.
 *
 * ⚠️ Returns a directory ONLY when it is this repository's own `<git-common-dir>/hooks`.
 * `--git-path hooks` also reports `core.hooksPath`, and that setting is often GLOBAL (a
 * shared hooks directory used by every repo on the machine); installing there would
 * overwrite the user's own hooks and run Codeman's checks on unrelated repos. A
 * `core.hooksPath` that points back at the repo's own hooks dir still resolves, because
 * the comparison is on canonical paths rather than on whether the setting exists.
 *
 * Also returns null unless `repoRoot` is itself the top of a work tree. Without that guard,
 * a copy of this package sitting inside SOMEONE ELSE's repository (e.g. under their
 * node_modules) would resolve to their hooks directory and install Codeman's hook there.
 *
 * @param {string} repoRoot
 * @returns {string | null}
 */
export function resolveGitHooksDir(repoRoot) {
  try {
    const top = git(repoRoot, ['rev-parse', '--show-toplevel']);
    if (!top || realpathSync(top) !== realpathSync(repoRoot)) return null;
    // Both are printed relative to the cwd (repoRoot) unless already absolute.
    const hooks = git(repoRoot, ['rev-parse', '--git-path', 'hooks']);
    const common = git(repoRoot, ['rev-parse', '--git-common-dir']);
    if (!hooks || !common) return null;
    const own = join(realpathSync(resolve(repoRoot, common)), 'hooks');
    return canonicalPath(resolve(repoRoot, hooks)) === own ? own : null;
  } catch {
    return null;
  }
}

/**
 * Install (or refresh) the managed pre-push hook in `hooksDir`, honouring
 * {@link planHookInstall}: a hook without the marker is never touched.
 *
 * @param {string} hooksDir
 * @returns {'write' | 'up-to-date' | 'skip-foreign'}
 */
export function installPrePushHook(hooksDir) {
  const path = join(hooksDir, 'pre-push');
  const next = renderPrePushHook();
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : null;
  const action = planHookInstall({ existing, next });
  if (action === 'write') {
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(path, next, { mode: 0o755 });
    chmodSync(path, 0o755); // `mode` only applies when the file is created
  }
  return action;
}
