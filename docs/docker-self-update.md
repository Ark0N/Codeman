# Self-update in the Docker Compose deployment

Codeman running as a container updates itself from **App Settings → Updates**, the
same place and the same button as a bare-host install. This document explains how
that works, what it deliberately refuses to do, and how to recover when it stops.

The bare-host updater is documented in
[`architecture-invariants.md#self-update`](architecture-invariants.md#self-update);
this file covers only what the container changes.

## The short version

| Change in the release            | Applied by                                       |
| -------------------------------- | ------------------------------------------------ |
| Application code                 | The in-app updater                               |
| `docker/server.Dockerfile`       | `docker/Start-Codeman.sh` on the host            |
| `docker/docker-compose.yaml`     | `docker/Start-Codeman.sh` on the host            |
| New key in `docker/.env.example` | Add it to `docker/.env`, then `Start-Codeman.sh` |

The in-app updater detects all three of the bottom rows itself and refuses with a
message naming what changed, so you never have to work out which case you are in.

## Why the container needs its own path

The bare-host updater does `git checkout <tag> && npm install && npm run build`,
then asks systemd or launchd to restart the service. Two of those assumptions are
false in a container:

1. **There is no init system.** A container's supervisor is the Docker daemon,
   which acts on the container, not on processes inside it.
2. **The image is immutable.** A `git pull` into the image's baked `/opt/codeman`
   would land in the container's writable layer, survive `docker restart`, and be
   silently discarded by the next `docker compose up`.

Both are solved by configuration rather than by a second updater:

- **The checkout is a host bind mount.** `docker-compose.yaml` mounts the repo
  (the same directory used as the build context) over `/opt/codeman`, so the
  updater's `git checkout` writes to the host filesystem and survives the
  container being recreated.
- **The restart is the server exiting.** `restart: unless-stopped` relaunches the
  container whenever its main process ends, including on a clean exit — so the
  updater's final step is to signal the server, and Docker starts it again on the
  freshly built `dist/`.

Everything else — the release-tag channel, the auto-stash, the atomic
`update-status.json` the browser polls across the connection drop, the boot-time
reconcile that flips `restarting` to `completed` — is the existing machinery,
unchanged. The container path is a new `SupervisorKind`, not a new updater.

## What the pieces are

| Piece                                          | Role                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------- |
| Repo bind mount at `/opt/codeman`              | Makes the pull persistent. Without it, self-update is unavailable.   |
| `codeman-node-modules`, `codeman-dist` volumes | Container-owned build artefacts, layered over the bind mount.        |
| `CODEMAN_IN_CONTAINER=1`                       | Tells `detectSupervisor()` to restart by exiting.                    |
| `restart: unless-stopped`                      | Turns that exit into a restart. Verified before every update.        |
| `CODEMAN_RESTART_BY_EXIT=1`                    | The Compose file's declaration of that policy, so the updater may exit even with no Docker socket. |
| Toolchain + devDependencies in the image       | Lets `npm install` and `npm run build` run inside the container.     |
| `docker-env-applied.json`                      | Fingerprint baseline, written by `Start-Codeman.sh` on every start.  |
| `docker-build-source.json`                     | What HEAD/`package-lock.json` the build artefact volumes currently reflect. Written by both `Start-Codeman.sh` and this in-place update, so the two agree on whether those volumes are stale. |

### Why build artefacts are in named volumes

`node_modules` and `dist` are mounted as named volumes **on top of** the repo bind
mount. Without that, an update's `npm install` would write into the host checkout,
leaving container-compiled native modules (node-pty builds from source here) in a
directory that may also be used to run Codeman natively, and leaving `git status`
permanently noisy.

Docker seeds an empty named volume from the image, so the first start inherits the
image's already-built `node_modules` and `dist` and pays no bootstrap cost.
`docker compose down -v` is the supported reset: the next start re-seeds them.

That seeding-only-while-empty behaviour has a second, less obvious edge: it also
means a plain `docker compose build` triggered from OUTSIDE the container (for
example `Start-Codeman.sh`, after a `git pull` done by hand rather than through
this in-app updater) produces a fresh image whose freshly-built `dist`/
`node_modules` then sit unused behind the volumes' OLD content — the container
comes back up looking unchanged. `Start-Codeman.sh` detects this by comparing the
checkout's current HEAD and `package-lock.json` hash against `docker-build-source.json`,
and clears just the affected volume(s) before its own `--build` if they moved.
This in-place update writes that same file after a successful build precisely so
that comparison does not fire on stale information: without it, the next plain
`Start-Codeman.sh` run would see the HEAD this update just checked out, not
recognise it as already accounted for, and wipe the volumes this update just
correctly rebuilt right back to the OLDER image.

### Why the runtime image carries a build toolchain

`npm run build` is `tsc` plus `esbuild`, both devDependencies, so the image no
longer runs `npm prune --omit=dev`. And `npm install` may rebuild node-pty, which
ships no Linux prebuild, so `python3`, `make` and `g++` are installed as well.

This is the real cost of in-place updates: a noticeably larger image than a
runtime-only one. It buys an update that takes about a minute instead of a full
image rebuild, and it is why `NODE_ENV=production` is paired with an explicit
`npm install --include=dev` in the updater.

## The environment gate

An in-place update applies **code only**. A restarted container reuses its existing
image and configuration, so a release that changes the environment cannot take
effect that way — and would half-apply: new code against an old environment. The
updater therefore checks the **target release's own files**, read straight out of
git with `git show <tag>:<path>` before anything is checked out.

### 1. `server.Dockerfile` changed, so the image must be rebuilt

Compared by sha256 against the fingerprint `Start-Codeman.sh` recorded when the
running container was built.

### 2. `docker-compose.yaml` changed, so the container must be recreated

Same mechanism. A restart cannot pick up a new mount, port or environment
variable; only recreating the container can.

### 3. `.env.example` gained keys your `.env` has no value for

The check that matters most, because **Compose will not tell you**. An unset
`${VAR}` interpolates to the empty string; Compose prints a warning to a terminal
nobody is watching and starts anyway. A new required setting therefore arrives as
a silently blank environment variable and misbehaves later, far from the cause.
The updater names the missing keys instead.

Commented-out lines in `.env.example` are deliberately *not* keys — that is how
the file marks optional overrides such as `# PUID=1000`, and counting them would
block updates on settings you are meant to leave alone.

### 4. A restart policy that would not bring the container back

Before signalling the server, the updater asks the Docker daemon for its own
container's restart policy. If it is `no`, the update is refused: applying it
would take Codeman down and leave no UI to recover from.

If the policy cannot be read at all (no Docker socket mounted) the update is
still allowed, but the final step changes: the server exits only when the
Compose file declared `CODEMAN_RESTART_BY_EXIT=1` (the shipped one does, because
it is the file that sets `restart: unless-stopped`) or the daemon confirmed an
auto-restart policy. Otherwise the build completes and the panel asks you to
restart the container by hand. A container started by plain `docker run` with no
restart policy therefore gets a staged update, never an outage.

### What the gate deliberately does not do

Every unknown fails **open**:

- A missing fingerprint baseline (a container started before this feature existed)
  is not treated as a change, or those installs could never update at all.
- An unreadable `.env`, an unreachable Docker socket, or a target tag whose files
  cannot be read all yield "no blocker" rather than a refusal.

The one place an unknown does NOT fail open is the kill itself: with neither the
Compose declaration nor a daemon answer, the updater stages the build and asks
for a manual restart rather than exiting a server nothing may bring back.

The gate catches a specific, detectable class of mistake; it is not a last line of
defence. It is also re-evaluated server-side on `POST /api/system/update`, so
hiding the button in the UI is a courtesy rather than the control.

## The one residual risk

The gate is derived from the diff, so it cannot see a release that needs a newer
environment **without changing any of those files** — for example, code that
depends on newer agent-CLI behaviour.

That is why the four global CLIs in `server.Dockerfile` are **pinned**. Unpinned,
the versions a user ends up with are a function of when their image was built
rather than of any commit, and in-app updates make rebuilds rarer, which makes
that drift worse over time. Pinned, "this release needs a newer CLI" becomes a
Dockerfile change, which check 1 already detects. Bump them deliberately, as part
of a release.

The complementary merge-side guard is `test/docker-compose-env-parity.test.ts`,
which fails CI when a variable is added to `docker-compose.yaml` without an entry
in `.env.example`, or the reverse.

## Sequence of an in-place update

1. **Check** — `GET /api/system/update/check` finds the latest release tag, fetches
   that one ref so the gate can read the target's files, and returns any blockers.
2. **Start** — `POST /api/system/update` re-evaluates the gate, writes `queued` to
   `update-status.json`, stages `self-update.sh` outside the repo and runs it.
3. **Apply** — stash if dirty, fetch the tag, check it out, `npm install
   --include=dev`, `npm run build`. A failure at any step rolls back to the
   previous commit, rebuilds it and reports `failed`; the server is never
   restarted into a broken build.
4. **Restart** — write the terminal `restarting` marker, then signal the server.
   The container exits and Docker restarts it.
5. **Reconcile** — the rebooted server compares its own version against the target
   and flips the status to `completed` or `failed`. The browser, still polling,
   picks that up.

Step 4 kills the updater script along with the container — unlike the systemd
path, it does not outlive the restart. That is safe only because the terminal
marker is written first, which is why nothing may be appended after the kill.

## Troubleshooting

**"This install can't update itself (unknown)"** — the repo bind mount is missing,
so the container is running the baked image copy. Check `CODEMAN_REPO_PATH` and
confirm the mounted directory really contains `.git`.

**The update fails immediately with a git ownership or permission error** — the
mounted checkout belongs to a different user than the one Codeman runs as
(`PUID`), so git refuses it as "dubious ownership". `Start-Codeman.sh` warns
about this at start; fix it by chowning the checkout to the same account that
owns `CODEMAN_APPDATA_PATH`.

**A rebuild is reported as required every time** — the fingerprint baseline does
not match the checkout. `Start-Codeman.sh` writes it on every start, so start
through that script rather than a bare `docker compose up` after either file
changes.

**Codeman does not come back after an update** — the build succeeded, since the
updater gates the restart on it, so read the container logs with `docker compose
logs codeman`. To roll back, check out the previous tag in the host checkout and
run `docker/Start-Codeman.sh`.

**The update failed during `npm install`** — most likely a native rebuild with no
toolchain, meaning the image predates the toolchain being added. Rebuild once from
the host and the in-app path works from then on.

**Resetting the build artefacts** — `docker compose down -v`, then
`Start-Codeman.sh`. This discards the named volumes and re-seeds them from a fresh
image.

## Disabling it

Set `CODEMAN_DISABLE_SELF_UPDATE=1` in `docker/.env` and pass it through in the
compose file's `environment:` block. The Updates panel then reports that in-app
updates are disabled, and the host-side script is the only way to update.
