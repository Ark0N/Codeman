# Multi-User Mode

Share one Codeman with a small trusted team. Each person gets their own login and workspace,
and sessions, cases, search, and live events are scoped to their owner.

**Off by default.** Without the flag, behaviour is identical to single-user Codeman, because
every scoping check short-circuits.

## Read this before enabling it

**Multi-user mode separates workspaces. It does not sandbox users from each other.**

Every session still runs as the **same operating system account**. A determined user's agent
can reach another user's files, because at the OS level they are the same user. This is a
convenience and organization feature, not a security boundary.

If you need real isolation:

- Pair each user with [Docker Cases](Docker-Cases), which gives their work its own
  filesystem and network.
- Or run separate Codeman instances under separate OS accounts, each with its own
  `CODEMAN_INSTANCE`.

"Small trusted team" is the honest description of who this is for.

## Enabling it

```bash
codeman users add alice --admin      # create the first admin, prompts for a password
codeman web --multiuser              # or CODEMAN_MULTIUSER=1
```

Then manage users from the CLI or the **Users** entry in App Settings:

```bash
codeman users add bob                # a regular user
codeman users list
codeman users passwd bob             # reset to a one-time password
codeman users rm bob
```

`--password-stdin` reads the password from standard input, for scripts.

Accounts live in `~/.codeman/users.json` with scrypt-hashed passwords, mode 0600.
Administrative actions are audited to `~/.codeman/admin-audit.jsonl`.

## What each user gets

| Thing               | Scope                                                                        |
| ------------------- | ---------------------------------------------------------------------------- |
| **Case space**      | `~/codeman-users/<name>/cases`, their own.                                    |
| **Sessions**        | Only theirs are listed, reachable, or controllable.                           |
| **Events**          | Live event routing is per owner, and fails closed.                            |
| **Search**          | Scoped on read, including historical results.                                 |
| **File previews**   | Scoped to sessions they own.                                                  |
| **Path picker**     | Only their own user space as a root, not the whole home directory.            |

Admins see everything.

Ownership threads through every list endpoint, the session lookup helper, the WebSocket
layer, and file previews. A user cannot address another user's session even by id.

## Sharing a selected workspace

An admin can open **App Settings → Users → Workspaces** on a regular user's row and select
one or more already linked local projects. Saving the selection restricts that account to
those project directories, including their subdirectories. Its private case space and other
linked, remote, and Docker cases are hidden; creating or cloning projects is disabled. Saving
an empty selection blocks workspace access until the admin grants a project. **Remove
restriction** restores the normal private case space.

The admin can link an existing project from **New Case → Link Existing** before granting it.
Saving or changing a user's grants stops live sessions whose working directories are no longer
allowed. Sessions in a shared project still belong to the user who started them; other regular
users cannot see or control those sessions, while admins can.

This is still application-level path confinement. All sessions run as the same OS account, so
an agent allowed to run arbitrary host commands can access files outside Codeman's UI rules.
An existing **bypass-permissions grant remains effective** for a restricted user, as does shell
mode. Use this feature to prevent accidental project selection; use separate OS accounts or
Docker isolation when users must not be able to cross that boundary.

## Safer defaults for regular users

Non-admins get tighter defaults, and lifting them is an explicit per-user grant:

| Default                            | Meaning                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------ |
| Claude runs in `auto` permission mode | Anthropic's classifier-guarded mode instead of skip-prompts.           |
| Raw shell sessions require a grant  | A plain shell is unmediated machine access.                              |
| Skip-permissions requires a grant   | Same reasoning.                                                          |
| Cron `launchCommand` requires a grant | It is an arbitrary command on a schedule.                              |
| Pi project trust defaults to off    | Trust makes Pi execute repo-local TypeScript.                            |

These exist because the OS boundary is shared. They narrow what a normal account can do
casually; they do not make the account a sandbox.

## Accounts and sessions

Each user authenticates with their own name and password rather than the shared
`CODEMAN_PASSWORD`. Logins are individually revocable: disable, reset, or delete an account
at any time, and existing browser sessions can be revoked.

## Gotchas

- **Enabling it does not migrate existing cases** into a user space. They stay where they
  are, owned by whoever the ownership rules resolve them to.
- **Admins see everything**, including other users' sessions. Choose admins accordingly.
- **Shared project files are common.** Users may have private sessions in the same workspace,
  but edits to that project's files are visible to every user granted access.
- **The audit log is append-only and local.** Ship it somewhere if you care about it.
- **It is not a substitute for OS accounts.** Restating this because it is the one thing
  people get wrong.

## Read next

- [Security](Security) - where this fits in the model, and what it does not cover.
- [Docker Cases](Docker-Cases) - the isolation story that actually isolates.
- [`docs/multi-user-plan.md`](https://github.com/Ark0N/Codeman/blob/master/docs/multi-user-plan.md) - the design.
