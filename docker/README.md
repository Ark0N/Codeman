# Codeman Docker deployment

This folder contains the Compose configuration, server image Dockerfile, and environment template for a locally built Codeman server.

## Start

From the repository root, create the runtime environment file and set the required values, especially `CODEMAN_PASSWORD`.

```sh
cp docker/.env.example docker/.env
bash docker/Start-Codeman.sh
```

On PowerShell, use the following commands instead. Running Compose from inside `docker/` with no `-f` lets it discover `docker-compose.override.yml` on its own (see [Local customisation](#local-customisation)); naming the file with `-f docker/docker-compose.yaml` from the repository root silently drops the override unless it is named too.

```powershell
Copy-Item docker/.env.example docker/.env
Set-Location docker
docker compose --env-file .env up --build -d
```

Every required value is defined and explained in `.env.example`. `GEMINI_API_KEY` is intentionally optional and may remain blank.

The container starts as root so `entrypoint.sh` can correct the ownership of a bind source the Docker daemon created (it creates a missing one as `root:root`), then drops to `PUID:PGID` with `setpriv` before the server starts, so Codeman itself never runs privileged. That drop needs `cap_add: [CHOWN, DAC_OVERRIDE, KILL, SETGID, SETUID]` against the file's `cap_drop: ALL`; a compose file written elsewhere (Unraid's Compose Manager, a hand-written unit) must carry the same additions, and the entrypoint names them when they are missing. A directory owned by neither root nor `PUID:PGID` is never re-owned: it is probed for writability as the runtime account and refused with a clear message if that fails. Setting `user:` in Compose skips the whole step.

On Linux, `Start-Codeman.sh` stops with an error when required paths are missing. It creates the application-data directory when safe, detects its numeric owner as `PUID:PGID`, and detects `DOCKER_SOCKET_GID` from the configured Docker socket. It rejects a root-owned application-data directory because Codeman and its local CLI sessions must remain unprivileged.

Codeman, Claude, OpenCode, and other local sessions run as the unprivileged account named by `CODEMAN_RUNTIME_USER`, which defaults to `codeman`. When Compose is run directly, `PUID` and `PGID` default to `1000:1000`; set them in `.env` when the application-data directory has a different owner. The Bash start script determines them automatically instead.

To retain Docker-case support without root when running Compose directly, set `DOCKER_SOCKET_GID` to the numeric group ID of the host socket. On a standard Linux Docker host, obtain it with `stat -c '%g' /var/run/docker.sock`. The Bash start script detects it automatically.

## Updating

Use **App Settings → Updates** in the web UI. The checkout Compose builds from is
also mounted at `/opt/codeman`, so an update's `git checkout` and rebuild persist
on the host, and the server exiting is what restarts the container onto the new
build.

Releases that change `server.Dockerfile`, `docker-compose.yaml`, or add a key to
`.env.example` cannot be applied that way — the updater detects them, names what
changed, and asks you to run `Start-Codeman.sh` here on the host instead. Details:
[`../docs/docker-self-update.md`](../docs/docker-self-update.md).

### Major updates

`Start-Codeman.sh` rebuilds the image on every start, but with the layer cache,
and it refreshes the build-artefact volumes selectively: `codeman-dist` when
the checkout's HEAD moved, `codeman-node-modules` only when `package-lock.json`
changed. That is right for an ordinary `git pull`. It is not enough when a
`server.Dockerfile` change bumps the Node base image without touching the
lockfile: `node-pty` is compiled from source (there is no Linux prebuild), so
the old `codeman-node-modules` volume would keep a build made for the previous
Node version. For that case, or whenever you want to be certain of what ships,
`docker/Update-Codeman.sh` force-rebuilds the image with no layer cache, stops
the stack, removes the `codeman-node-modules` and `codeman-dist` volumes, then
hands off to `Start-Codeman.sh` for the usual start:

```sh
bash docker/Update-Codeman.sh
```

Pass `--keep-volumes` to skip clearing them (safe only if you know the
rebuilt image's `node_modules`/`dist` did not change). The scripted default
is the "Resetting the build artefacts" procedure in
[`../docs/docker-self-update.md`](../docs/docker-self-update.md). Only those
two volumes are removed, by name within this Compose project; any volume a
`docker-compose.override.yml` adds is left alone, and application data and
case workspaces are host bind mounts, never touched either way.

## Git commit identity

Set `GIT_USER_NAME` and `GIT_USER_EMAIL` in `docker/.env` before rebuilding:

```sh
GIT_USER_NAME='Your Name'
GIT_USER_EMAIL='you@example.com'
```

Compose passes the values to the Codeman server build, and to the server process
when it builds Docker-case agent images. Both images write the pair to Git's
system configuration during their build, so commits retain the same identity
after a container or agent image is recreated. Set both values together; an
image build with only one value fails rather than using a partial identity.

Run `bash docker/Start-Codeman.sh` after changing the server values. Rebuild an
existing agent image with `node scripts/build-agent-image.mjs --no-cache` in the
server container, then recreate any Docker cases that should use it.

## Private repositories (GitHub and Azure DevOps)

The images can include the GitHub CLI (`gh`) and the Azure CLI (`az`, with the `azure-devops` extension), wired into the system Git configuration as credential helpers, so Codeman can clone private repositories. Both are **opt-in and off by default**, and are turned on per host in `docker-compose.override.yml`.

### Turning them on

Add the build arguments to `docker-compose.override.yml` (see [Local customisation](#local-customisation)), then rebuild with `Start-Codeman.sh`. Set only the one you need:

```yaml
services:
  codeman:
    build:
      args:
        CODEMAN_INSTALL_GH: '1'
        CODEMAN_INSTALL_AZ: '1'
    environment:
      # The same two switches for the Docker-case agent image Codeman builds.
      CODEMAN_AGENT_IMAGE_INSTALL_GH: '1'
      CODEMAN_AGENT_IMAGE_INSTALL_AZ: '1'
```

The `build: args:` pair controls the Codeman server image. The `environment:` pair controls the agent image for [Docker cases](../docs/docker-cases.md), which Codeman builds on the first Docker case; an agent image that already exists is not rebuilt by this, so run `node scripts/build-agent-image.mjs --no-cache` inside the container afterwards. The same variables work in front of that command when building it by hand. Values must be `0` or `1`; anything else stops the build with an error naming the argument.

They are not `.env` settings: turning a CLI on is a per-host choice, which is what the override file is for, and a new `.env.example` key makes the in-app updater refuse to update every existing installation until its `.env` gains the key.

The Azure CLI is the large one, about 600 MB of the roughly 670 MB the pair adds. A CLI left off leaves nothing functional behind: no apt repository, no package, no `azure-devops` extension and no credential-helper entry, so git for that host behaves exactly as it does without this feature. With both off the image is functionally unchanged; it still carries the `AZURE_EXTENSION_DIR` variable, an empty extensions directory and one small layer that copies and then removes the helper script.

### Signing in

With a CLI on, the system Git configuration routes credentials through it:

| Host                                                  | Credential helper                         | Sign in with                 |
| ----------------------------------------------------- | ----------------------------------------- | ---------------------------- |
| `https://github.com`, `https://gist.github.com`       | `gh auth git-credential`                  | `gh auth login`              |
| `https://dev.azure.com`, `https://*.visualstudio.com` | `/usr/local/bin/git-credential-azure-cli` | `az login --use-device-code` |

Codeman itself still collects no Git credentials. Sign the container in once from a **Terminal / Shell** session (Run menu). The session runs as the runtime account, so the sign-in is stored under `CODEMAN_APPDATA_PATH` (`~/.config/gh`, `~/.azure`) and survives rebuilds and container recreation:

```sh
gh auth login                  # GitHub.com -> HTTPS -> "Login with a web browser" (device code)
az login --use-device-code     # then: az devops configure --defaults organization=https://dev.azure.com/<org>
```

After that, **Add Case → Clone Repo** accepts private `https://` URLs on those hosts, and `git clone` works from any session. Until a CLI is signed in its helper prints nothing, so a private clone fails immediately with the usual authentication error rather than waiting on a prompt.

**Multi-user mode:** every Codeman user's git runs as the same server account, so these sign-ins would otherwise be shared. Clone Repo therefore runs a **non-admin**'s clone and preflight with every git credential helper cleared (`git -c credential.helper=`): a non-admin can clone public repositories and anything their own SSH setup allows, but not a private https repository through the admin's `gh`/`az` sign-in. Admins, and single-user mode, keep the helpers. A non-admin's own agent sessions still run as that same account, and with the agent-image `gh`/`az` switches on, a non-admin's Docker case with credential seeding on also receives the server account's `gh`/`az` sign-in, the same as the Claude and Codex credentials; see `docs/security-architecture.md`, multi-user mode.

Azure DevOps is authenticated with an Entra ID access token that the helper requests from `az` for each Git operation, so nothing is written to disk beyond `az`'s own sign-in. An account that has to use a personal access token can set `AZURE_DEVOPS_EXT_PAT` for the container instead (for example under `environment:` in `docker-compose.override.yml`); the helper prefers it when present. SSH remotes are unaffected by any of this and keep using the account's own keys.

Docker cases copy these sign-ins into a case container only when the matching agent-image switch is on (`CODEMAN_AGENT_IMAGE_INSTALL_GH=1` for `~/.config/gh/hosts.yml` and `config.yml`, `CODEMAN_AGENT_IMAGE_INSTALL_AZ=1` for the sign-in files from `~/.azure`) and the case has credential seeding on. With a switch off they are never copied, even when the files exist, because a GitHub token or an Azure refresh token is usable by anything in the container. The copies are made when the container is **created**, so an existing case container never picks them up: after turning a switch on, signing in, or rebuilding the agent image, **recreate the case container** (remove it; the next session in that case creates a fresh one).

The GitHub agent skill for `gh` installs into the runtime account's home in the same session:

```sh
gh skill install cli/cli gh --scope user
gh skill update gh              # after a later gh release
```

### Versions

Both CLIs, and the extension, are installed from their vendors' repositories with no version pinned, so they arrive at whatever is current when that build step runs. Docker caches the step, though: `Start-Codeman.sh` rebuilds with the cache, which keeps the versions from the first build until the Dockerfile changes at or above that step or the image is rebuilt with `--no-cache`. They are apt packages owned by root, so they cannot be upgraded from a session; `az extension update --name azure-devops` is the exception and works without a rebuild.

## Local customisation

Compose merges `docker-compose.override.yml` on top of `docker-compose.yaml`. Keep host-specific changes there rather than editing `docker-compose.yaml`, so this repository can be updated without losing them. Both `docker-compose.override.yml` and `docker-compose.override.yaml` are ignored by Git.

`Start-Codeman.sh` names the Compose file explicitly, which disables Compose's automatic discovery of the override file, so the script adds it back when one is present and prints the file it used. Running `docker compose` from this folder without any `-f` option finds it automatically. When passing `-f docker/docker-compose.yaml` from the repository root, add `-f docker/docker-compose.override.yml` as well, or the override is silently ignored.

An override file adds to and replaces individual settings. It cannot delete a key from `docker-compose.yaml`, and Compose concatenates rather than replaces `ports`, so removing a published port still requires editing `docker-compose.yaml`. The example below replaces the restart policy and adds a mount, leaving every other setting in place:

```yaml
services:
  codeman:
    restart: always
    volumes:
      - /srv/projects:/srv/projects
```

### Reverse-proxy host allowlist

Codeman rejects any request whose `Host` header is not on its own allowlist - a
DNS-rebinding guard, not a Compose or Docker concern. Loopback, any IP literal,
the configured `--host`, and a few tunnel-provider suffixes are allowed by
default; a reverse-proxied domain is not, and is rejected with
`403 Forbidden: host not allowed` before the request reaches any handler.

Add the domain with `CODEMAN_ALLOWED_HOSTS` in `.env`:

```sh
CODEMAN_ALLOWED_HOSTS='codeman.example.com,.internal.example.com'
```

`docker-compose.yaml` forwards it into the container (Compose only passes
through the environment keys it explicitly lists, and this is one of them, with
an empty default so the line is optional in `.env`).

See the application's own `docs/wiki/Remote-Access.md` for the full allowlist
format and the tunnel providers it accepts by default.

## Application data storage

The default configuration uses a host-folder bind mount:

```yaml
volumes:
  - type: bind
    source: ${CODEMAN_APPDATA_PATH}
    target: /home/${CODEMAN_RUNTIME_USER}
```

Set `CODEMAN_APPDATA_PATH` in `.env` to a directory that the Docker daemon can access. The example value is `/mnt/user/appdata/codeman`.

`CODEMAN_CASES_PATH` is the separate host directory for managed case workspaces. It is mounted into Codeman at the same absolute path, allowing the host Docker daemon to bind it into an isolated case container. Set it to a child directory of `CODEMAN_APPDATA_PATH` unless you deliberately store workspaces elsewhere.

Compose also exposes `CODEMAN_APPDATA_PATH` to Codeman as `CODEMAN_DOCKER_HOST_HOME`. This lets Docker case seed files, CLI credentials and the hook secret be mounted using paths that exist in the host daemon's filesystem. Direct host installations do not set this variable and retain their existing behaviour.

Set `CODEMAN_DOCKER_DISABLE_SWAP_LIMIT=1` when `docker info` reports `SwapLimit=false`. Codeman continues to apply the configured case memory limit, omits Docker's unsupported `--memory-swap` option, and filters only the daemon's exact swap-capability warning. Every other Docker create error and its exit status remain visible.

For an existing installation created by a root-running image, change ownership of the application-data directory before upgrading so the configured `PUID` and `PGID` can read the saved credentials and state:

```sh
chown -R 99:100 /mnt/user/appdata/codeman
```

Replace `99:100` and the path with the values from your `.env` file.

Do not replace this bind mount with a Docker-managed named volume when Docker cases are enabled. Codeman passes seed, credential, transcript and hook-secret bind sources to the host Docker daemon, so their source files must have stable paths in the daemon's filesystem. A named volume does not provide the required host path mapping.

## Static macvlan networking

The default configuration publishes a host port. It does not use `network_mode: host`. To attach Codeman directly to an existing external macvlan network with a static IP address and MAC address, remove the `ports:` section from `docker-compose.yaml` and add the following to the `codeman` service. The service and network additions can instead be placed in `docker-compose.override.yml`, but the `ports:` removal cannot, as described under [Local customisation](#local-customisation):

```yaml
mac_address: ${CODEMAN_MAC_ADDRESS}
networks:
  codeman_lan:
    ipv4_address: ${CODEMAN_IPV4_ADDRESS}
```

Then add this top-level network declaration:

```yaml
networks:
  codeman_lan:
    external: true
    name: ${CODEMAN_MACVLAN_NETWORK}
```

Set `CODEMAN_MACVLAN_NETWORK`, `CODEMAN_IPV4_ADDRESS`, and `CODEMAN_MAC_ADDRESS` in `.env`. The values in `.env.example` match the supplied Unraid example network and should be changed for other hosts.

### Create a managed macvlan network

If an external macvlan network does not already exist, use this top-level declaration instead. Do not use it together with the external-network declaration.

```yaml
networks:
  codeman_lan:
    driver: macvlan
    driver_opts:
      parent: ${CODEMAN_MACVLAN_PARENT}
    ipam:
      config:
        - subnet: ${CODEMAN_MACVLAN_SUBNET}
          gateway: ${CODEMAN_MACVLAN_GATEWAY}
```

Macvlan containers are ordinarily not reachable from their Docker host without additional host-network routing. Confirm the selected address, MAC address, parent interface, and subnet are reserved and valid for the target network before starting the stack.
