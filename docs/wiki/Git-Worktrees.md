# Git Worktrees

Sessions in one case share its folder. That is fine for one agent, but three agents in the
same checkout edit the same files, overwrite each other's builds, and commit each other's
half-finished work. A **git worktree** gives each of them a checkout of its own: same
repository, same history, a separate folder on a separate branch.

Codeman creates worktrees for a case whose folder is a git repository, starts sessions in
them, and removes them again when the work is done.

## Where they live

`<case>/.claude/worktrees/<name>`, on a new branch `worktree-<name>`. That is exactly where
Claude Code's own `claude --worktree <name>` puts them, so a worktree made in Codeman is one
Claude Code recognizes, and the other way round. Codeman's Recent Sessions and Session Manager
lists mark a session that runs in one with a `⑂ <name>` pill.

The main checkout does not show the worktrees as untracked: Codeman adds `/.claude/worktrees/`
(and `/.claude/settings.local.json`, the hooks file it writes for every Claude session, plus the
`codeman` folder it writes when **Codeman Agent Skill** is on) to the repository's local
`.git/info/exclude` when git does not ignore them already. Without that, those files would make
every worktree look modified and git would refuse to remove it. Your tracked `.gitignore` is
never touched.

## Creating one and starting a session in it

1. Pick the case in the toolbar's case picker.
2. Open the picker again and choose **Git worktrees…** (on a phone: the case sheet's
   **Worktrees** button).
3. Under **New worktree**, type a name (letters, digits, `.`, `_`, `-`, up to 64 characters).
4. Pick the CLI under **Start sessions with** (Claude Code, Codex, a shell, any installed run
   mode).
5. **Create & start session**.

The worktree is created from the case's current commit, and the session opens in it as a tab
named `w1-<name>`. Under **Branch and start point** you can name the branch yourself or start
from another branch, tag or commit. An existing branch is never reused or reset: pick another
name.

**Open** on a worktree's row starts another session in it, with the CLI chosen above.

## Removing one

Two ways, and both use `git worktree remove` **without** `--force`:

- **Remove…** on the worktree's row in the dialog.
- Closing a session that runs in a worktree: the Close Session dialog offers **Kill & remove
  worktree**, which kills the session and then removes its worktree.

git refuses to remove a worktree that still holds uncommitted or untracked files, and Codeman
shows that refusal as git worded it and leaves everything in place. Commit, stash or delete the
work first, then remove again. A worktree a live session still runs in is refused too.

**Also delete its branch** deletes the branch with `git branch -d`, which keeps a branch whose
commits are not merged yet. The worktree is still removed, and the message says the branch was
kept.

If a worktree's folder was deleted by hand, its row says **missing** and offers only
**Remove…**: that clears the record git keeps of it, so the name can be used for a new worktree.

## What is not supported

- **Docker cases and remote (SSH) cases.** A container can write to its workspace, and creating
  a worktree runs the repository's hooks and checkout filters on the Codeman machine, so git is
  never run there. A remote case's repository is on another machine. For the same reason a
  worktree that a Docker case uses as its workspace (or that holds one) is never removed from
  here: remove the Docker case first.
- A case folder that is not the top of a repository (a subfolder of one), a bare repository, or
  an empty repository with no commit yet.
- Worktrees outside `.claude/worktrees/` (made by hand with `git worktree add`) are listed, but
  Codeman neither starts sessions in them from the dialog nor removes them.

The HTTP endpoints are in the [HTTP API](HTTP-API) reference (`/api/cases/:name/worktrees`).
