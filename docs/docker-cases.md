# Docker cases

Run a case inside an **isolated Docker container** instead of directly on the host. Any number of Codeman sessions can share one container (it is scoped to the case, not the session), so a whole project lives in a sandbox with its own network, resource caps, and filesystem, and you can **export the container to move it to another machine**.

Docker mode is a **location overlay on cases**, the direct analog of [remote SSH cases](./remote-hosts.md): where a remote case runs a local tmux pane doing `ssh host` into a durable remote tmux server, a docker case runs a local tmux pane doing `docker exec -it` into a durable **in-container** tmux server. It is not a separate `SessionMode`, so `claude` / `shell` / `opencode` / `codex` / `gemini` / `antigravity` / `pi` / `grok` / `deepseek` / `omp` all work inside the container.

## One-time setup: build the base image

The container needs a base image with the agent toolchain (node, the CLIs, git, tmux). Build it locally once:

```bash
node scripts/build-agent-image.mjs          # builds codeman/agent:base
# options: --engine docker|podman  --image <ref>  --no-cache
```

The image is **secret-free**: credentials are delivered at runtime (bind mounts or `docker exec --env`), never baked in, so exports never leak them.

⚠️ **Re-build with `--no-cache`, always.** The CLIs are installed in a single `RUN npm install -g` layer, so a plain rebuild re-uses it from the Docker layer cache and the CLIs stay frozen at whatever versions the image was **first** built with, however long ago that was. Editing the Dockerfile does not help unless the edit lands at or above that line: a change appended below it leaves the npm layer cached and only runs the new step. Observed 2026-08-06: a rebuild silently kept a stale `@openai/codex@0.144.6` whose aliased platform binary had not installed, so every `codex` docker case died with `Missing optional dependency @openai/codex-linux-x64` while the build itself reported success.

```bash
node scripts/build-agent-image.mjs --no-cache
```

### Which CLIs the image contains

The npm-published CLIs come from `ARG CLI_NPM_PACKAGES`, which `scripts/build-agent-image.mjs`
fills from `config/clis.stock.json` (generated from `src/config/cli-registry/stock.ts`). Adding
a stock CLI that installs with a plain `npm install -g` needs no Dockerfile edit. The ARG
defaults to the same list in the same order, so a bare `docker build` produces a byte-identical
layer — a different order would be a different `RUN` string and so a needless cache miss.

⚠️ It reads the **stock** catalogue, never the merged registry. A user's `~/.codeman/clis.json`
must not change what is inside an image tagged `codeman/agent:base`, or two machines holding
that tag hold different images and every cache decision downstream is a lie. Each entry's
`enabled` flag IS honoured, so a CLI that ships disabled is never baked in.

Four CLIs keep hand-written layers, because the registry cannot express what makes them
special:

| CLI | Why it is not in the shared npm layer |
| ------------- | ------------------------------------------------------------------------------------- |
| `pi` | Installs with `--ignore-scripts`, kept in its own layer so the flag cannot leak to the others. |
| `deepseek` | Needs `pnpm` alongside it (`dsh plugin`, issue #352) plus a `dsh-tui` profile install. |
| `antigravity` | Not on npm — Google ships a standalone binary (~190MB, the largest layer). |
| `grok`, `omp` | Not on npm — standalone vendor installers. |

`test/docker-agent-image-coverage.test.ts` requires every special case to carry a written
reason AND still be present in the Dockerfile, so an exclusion cannot silently become an
omission — which is the same failure upstream `b6d0f1fa` hit in `install.sh`.

Two things build this image: `scripts/build-agent-image.mjs` (a human) and
`ensureAgentBaseImage()` in `src/docker-hosts.ts` (the app, on the first Docker case). They
assemble the argv independently, because a `.mjs` cannot import TypeScript, so
`test/agent-image-build-args-parity.test.ts` pins them together. Without it, an image built by
hand and one built by the app could hold different CLIs under the same tag.

A zero exit code only proves the layers ran, not that the toolchain works. Verify by actually executing each CLI in the image, and check the build log for `Using cache` lines:

```bash
docker run --rm codeman/agent:base bash -lc \
  'for c in claude codex gemini opencode agy pi grok dsh omp; do printf "%-9s " $c; $c --version 2>&1 | head -1; done'
```

⚠️ `dsh --version` is the one line above that answers a different question than the
others: `dsh` is a profile launcher, so a working binary says nothing about whether
the image can actually run a DeepSeek session. Check the profile the Dockerfile
installs into the agent's HOME as well, or a `mode: 'deepseek'` case starts a pane
that dies on arrival:

```bash
docker run --rm codeman/agent:base ls ~/.dsh/profiles/dsh-tui/package.json
```

Building that profile is also why `pnpm` is in the image: `dsh plugin` forwards straight to a literal `pnpm` and exits 127 without it (issue #352), and pnpm — unlike npm — blocks dependency lifecycle scripts by default and fails the install over it, so the profile step passes `--config.dangerouslyAllowAllBuilds=true`.

Antigravity (`agy`) and Grok (`grok`) are the two CLIs not installed from npm (Google and xAI ship standalone binaries), so each has its own Dockerfile step, adding roughly 190MB and 160MB respectively. Pi also gets its own step, because upstream documents installing it with `--ignore-scripts` and that flag must not silently change how the other npm CLIs install.

Pi's credentials are seeded per-FILE rather than as a whole directory (`auth.json`, `settings.json`, `trust.json`, `models.json`, `models-store.json` out of `~/.pi/agent`), because that directory also holds `sessions/`, `extensions/`, `skills/` and the installed package trees — gigabytes on an active host. Consequence: in-container pi sessions are invisible host-side, so `pi -c` inside a Docker case only sees that container's own history. See [`pi-integration.md`](./pi-integration.md). Grok is seeded per-file for the same reason (`auth.json`, `config.toml`, `pager.toml` out of `~/.grok`, which also holds `sessions/`, `memory/` and the ~160MB binary under `downloads/`), with the same consequence for `grok -c`. See [`grok-integration.md`](./grok-integration.md). OMP is the one CLI in this family where `sessions/` is the EXCEPTION rather than the rule: `~/.omp/agent/{config.yml,mcp.json,models.yml,settings.yml}` are seeded per-file (the dir also holds SQLite caches and `terminal-sessions/`), but `~/.omp/agent/sessions/` is shared RW like codex's, not seeded, because Codeman reads it host-side for history recovery and `--resume` pinning. See [`omp-integration.md`](./omp-integration.md).

## Quickest path: one-click "Run in Docker"

On the **New case → Create New** tab there's a **🐳 Run in an isolated Docker container** checkbox. Checking it alone is enough: Codeman creates the case folder in `~/codeman-cases/<name>`, spins up a hardened container with sensible defaults (auto-provisioning a shared `default` host), and starts the session inside it. No host/image/network fields to fill in.

Click the checkbox's **Container settings** to optionally tweak the predefined defaults, including a **Template** picker:

| Template | Memory | CPUs | GPUs |
|----------|--------|------|------|
| Small | 2 GB | 1 | none |
| Medium (default) | 4 GB | 2 | none |
| Large | 8 GB | 4 | none |
| GPU | 8 GB | 4 | all (needs the NVIDIA container toolkit) |

**Disk is elastic** — the container's storage grows automatically as data flows in; there is no fixed cap (bounded only by host disk). Any tweaked setting creates a dedicated per-case host so it never changes the shared `default`.

## Create a docker case (full control)

App → **New case → Docker** tab:

- **Case Name** / **Workspace Path**: the workspace is a real HOST directory bind-mounted into the container at the same path. Codeman scaffolds `CLAUDE.md` + `.claude/settings.local.json` (hooks) into it, and file previews / attachments work on the real bytes.
- **Host ID**: a reusable docker host profile (image, network, resources). Reuse the same ID across cases to share settings.
- **Network**: `bridge` (internet on, default), `none` (fully isolated), or a `custom` bridge.
- **Advanced**: memory / CPU caps, **Mount host credentials** (on = your existing `~/.claude` login just works; off = a sealed sandbox you log into inside the container), **Resume last conversation on relaunch**.

Then run it like any case (Run Claude / Run Shell / …). The first launch creates the container (`codeman-case-<name>`); subsequent sessions attach to the same one.

Equivalent API:

```bash
curl -X POST localhost:3000/api/docker-hosts -d '{"id":"local","label":"Local","image":"codeman/agent:base"}'
curl -X POST localhost:3000/api/cases/docker-link -d '{"name":"sandbox","hostId":"local","hostWorkspacePath":"/home/you/projects/sandbox"}'
curl -X POST localhost:3000/api/quick-start -d '{"caseName":"sandbox","mode":"claude"}'
```

## Attach to a container you already run

The tab's **Attach to an existing container** toggle points a case at a container **you**
built and run. Codeman only ever `docker exec`s into it: it never creates, starts, stops,
restarts or removes it, and it seeds no credentials into it, so the CLIs inside must already
be installed and logged in. A missing or stopped container is an error to report, not a state
to fix — start it yourself and reopen the session.

- **Container Name** is a picker over the engine's containers that you can also type into
  (the engine may be remote, or the container may not exist yet when you fill the form).
  Stopped containers are listed too, sorted last and labelled, so "mine isn't here" is never
  a dead end.
- **Container Workdir** is a path that must already exist **inside** the container. Adoption
  mounts nothing, so it need not match the host workspace path; **Browse** lists directories
  inside the container itself. Without this check, a wrong path fails at launch as a bare
  `execvp failed` inside the pane.
- **Workspace Path** is still a real host directory. It backs file previews, attachments and
  watchers exactly as it does for an owned case, but here it is only a mirror: nothing is
  bind-mounted, so point it at whatever host directory your container already exposes.
- **Check container** runs a read-only preflight and reports what is inside before you commit
  to a case name (running or not, tmux present, which CLIs resolved).
- **Run modes come from the container**, not the host: a host with no `claude` still offers
  Claude if the container ships it, and a mode the container lacks is hidden.
- Claude is launched **without** `--dangerously-skip-permissions` when the container's exec
  user is root, because Claude Code refuses that flag as root and the refusal is only visible
  inside the container.
- Image, network and resource settings disappear from the form: they describe a
  `docker create` that adoption never runs.

Recreate is refused for an adopted case, full-image export is refused (it would commit a
container that is not ours), unlinking the case leaves the container running, and the boot
reaper skips it. Workspace-only export still works and never pauses the container.

Equivalent API:

```bash
curl -X POST localhost:3000/api/docker-cases/adopt-preflight -d '{"hostId":"local","container":"my-dev-box","containerWorkdir":"/workspace"}'
curl -X POST localhost:3000/api/cases/docker-adopt -d '{"name":"devbox","hostId":"local","container":"my-dev-box","hostWorkspacePath":"/home/you/projects/devbox","containerWorkdir":"/workspace"}'
```

In multi-user mode adoption is **admin-only**, unlike `docker-link`: an adopted container's
mounts belong to whoever built it, so one mounting `/` would hand the adopter the whole host.

## Lifecycle

- **Reconnect after a Codeman restart** lands back in the same live agent (the in-container tmux survives).
- **Container stop / host reboot** restarts the container and **resumes** the last conversation from the bind-mounted transcript. Claude sessions launch with a pinned conversation id (`--session-id <sessionId>`, with a `--resume` fallback when the transcript already exists), and the case remembers its last conversation (`lastClaudeSessionId`), so a relaunch after the container was stopped, rebooted, or recreated continues where it left off.
- **Killing one session** only kills that session's in-container tmux session; the shared container stays up for sibling sessions.
- **Editing the docker host config** (image, memory, network, ...) is detected on the next launch: the desired config hash is compared against the container's `codeman.confighash` label, and a mismatch refuses the launch with a "config changed, recreate?" confirm. Confirming calls `POST /api/docker-cases/:name/recreate` (refused while sessions of the case are live), which removes the container so the next launch recreates it with the new config; the workspace and the conversation survive.
- **Deleting the case** `docker rm -f`s the container (the bind-mounted workspace on the host survives). An instance-scoped boot reaper removes containers whose case is gone.

## Isolation & security

Every container runs hardened: `--cap-drop ALL`, `--security-opt no-new-privileges`, non-root (`--user <hostUid>:0` so workspace files stay host-owned), `--pids-limit`, `--memory` == `--memory-swap`, `--init`. Never `--privileged`, never the docker socket. The default **convenient** profile bind-mounts host credential dirs read-write so the common login just works (creds stay on the host, never captured by `docker commit`); the **sealed** profile (`mountCredentials:false` + `network:none`) is the opt-in for genuinely untrusted work.

Rootless engines without cgroup-v2 systemd delegation cannot enforce resource caps; linking such a host warns that caps are advisory.

## Export / Import (move to another machine)

**Export** (from the Docker tab, or `POST /api/docker-cases/:name/export`): choose

- **Full image + workspace**: `docker commit` the container to an image, `docker save` it, tar the workspace, and a manifest, all into one portable `<case>-<ts>.codeman-container.tgz` (the whole toolchain, installed packages, and files). Runs in the background; you are notified when the bundle is ready.
- **Workspace only**: just the project files (fast, small).

The container is paused across the capture so the image and workspace are consistent; a full `/var/lib/docker` is guarded against with a free-space precheck; the intermediate image is always cleaned up.

**Import** (`POST /api/docker-cases/import`, or the Manage tab): copy the `.tgz` onto the new machine's `~/.codeman/docker-exports/`, then import it into a new case. The manifest and per-member SHA-256 checksums are validated, the workspace tar is extracted with a path-traversal guard, and the image is `docker load`ed and **re-tagged into a quarantined namespace** (`codeman/imported-<case>:<ts>`) so it never overwrites a local tag. The destination supplies its own credentials, so nothing secret crosses machines.

`GET /api/docker-exports` lists bundles; `GET /api/docker-exports/:filename` downloads one; `DELETE` removes one.

## Hooks require the server to be reachable from the container

In-container hooks (permission events, hook-based idle/stop/task notifications) POST to `CODEMAN_API_URL`, which is derived as `https://host.docker.internal:<port>` (`host.docker.internal` → the docker bridge gateway, e.g. `172.17.0.1`, via `--add-host …:host-gateway`). For that callback to succeed, the Codeman server must be **listening on an interface the container can reach**.

- If Codeman binds **loopback-only** (`127.0.0.1`, the default and the production systemd config), a container reaching `172.17.0.1:<port>` cannot connect, so by default **in-container hooks do not fire**. The session still works fully: idle/stop detection falls back to **output-based** detection through the `docker exec` PTY (which always works), and claude runs with `--dangerously-skip-permissions` so there are no permission prompts to forward anyway.
- **To enable in-container hooks on a loopback-only server, set `CODEMAN_DOCKER_BRIDGE_HOOKS=1`** (env). Codeman then starts a SECOND listener bound to the docker bridge gateway (`172.17.0.1`, auto-detected; override with `CODEMAN_DOCKER_BRIDGE_HOST`) that serves **only the hook endpoints** (`/api/hook-event`, `/api/status-telemetry`) and delegates them into the same secret-gated pipeline. The bridge is host-internal (containers + host, not the LAN), and every other path returns `403`, so this does not widen your network exposure. Add `Environment=CODEMAN_DOCKER_BRIDGE_HOOKS=1` to the systemd unit and restart.
- Alternatively, bind `0.0.0.0` **with `CODEMAN_PASSWORD` set** (exposes on the LAN too).

The host-gateway mapping, `CODEMAN_API_URL` derivation, host-guard allowlist, and hook-secret mount are all wired correctly; `CODEMAN_DOCKER_BRIDGE_HOOKS` closes the last gap for loopback-only servers.

## Notes & limits

- Requires Docker (or Podman) with a reachable daemon; tmux must be present in the base image (a hard prerequisite, probed at link time).
- Per-session `envOverrides` / `effort` / per-CLI config are rejected for docker cases (they do not cross into the container); configure the container via the docker host's per-mode command override instead.
- macOS Docker Desktop takes a dedicated uid path (the baked image uid; memory caps are subject to the VM ceiling).

Design + rationale: [`docker-cases-plan.md`](./docker-cases-plan.md).
