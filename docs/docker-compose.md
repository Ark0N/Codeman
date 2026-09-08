# Docker Compose deployment

This configuration builds the Codeman application image locally from this checkout. It does not download or depend on a pre-built Codeman image.

For the Compose configuration, environment settings, storage migration, and macvlan networking examples, see the [Docker deployment guide](../docker/README.md).

The image includes Claude Code, Codex, Gemini CLI, and OpenCode. Authenticate a CLI from its Codeman session; credentials are never baked into the image.

## Prerequisites

- Docker Engine or Docker Desktop with Docker Compose v2
- A reachable Docker daemon

The application container mounts the Docker daemon socket so Codeman can create and manage its isolated Docker cases. Treat anyone who can administer this Compose project as having Docker-host-equivalent access.

## Start

Copy the environment template, set a strong password, and confirm `CODEMAN_APPDATA_PATH`. The example maps `/mnt/user/appdata/codeman` on the host to `/home/${CODEMAN_RUNTIME_USER}` in the container, preserving Codeman state and CLI credentials outside Docker-managed volumes.

```sh
cp docker/.env.example docker/.env
```

On PowerShell, use the following command instead.

```powershell
Copy-Item docker/.env.example docker/.env
```

On Linux, run the stack with the start script. It determines `PUID` and `PGID` from the owner of `CODEMAN_APPDATA_PATH`, and `DOCKER_SOCKET_GID` from the configured Docker socket, before invoking Compose. A root-owned application-data directory is rejected so the runtime account cannot become UID 0.

```sh
bash docker/Start-Codeman.sh
```

On other platforms, run Compose directly. `PUID` and `PGID` default to `1000:1000`; set them in `docker/.env` when the application-data directory has a different owner.

```sh
docker compose --env-file docker/.env -f docker/docker-compose.yaml up --build -d
```

Open `http://localhost:3000` and sign in with the username and password from `docker/.env`.

## Operations

The local image is tagged `codeman:local` by default. Change `CODEMAN_IMAGE` in `docker/.env` if a different local tag suits your environment.

```sh
docker compose --env-file docker/.env -f docker/docker-compose.yaml logs -f codeman
bash docker/Start-Codeman.sh
docker compose --env-file docker/.env -f docker/docker-compose.yaml down
```

`CODEMAN_APPDATA_PATH` holds Codeman state and survives container recreation. Remove that host directory only when deliberately resetting the installation.

`CODEMAN_CASES_PATH` must be an absolute path on the Docker host. Compose mounts it at the same path inside Codeman, so the host daemon can bind the managed workspace into isolated Docker cases. Do not set it to `/home/${CODEMAN_RUNTIME_USER}/codeman-cases`.

Compose passes `CODEMAN_APPDATA_PATH` into Codeman as `CODEMAN_DOCKER_HOST_HOME`. Codeman uses that value to translate generated Docker seed, credential and hook-secret bind sources from the container's home path into paths visible to the host Docker daemon.

If `docker info` reports `SwapLimit=false`, set `CODEMAN_DOCKER_DISABLE_SWAP_LIMIT=1`. Isolated cases retain their configured memory limit. Codeman omits the unsupported swap-limit option and filters only the daemon's exact swap-capability warning while retaining every other Docker create error.

If that directory was created by an earlier root-running image, change its ownership to the configured `PUID:PGID` before starting this version. This preserves existing CLI credentials and session state while allowing the unprivileged runtime account to use them.

## Updating

Codeman updates itself from **App Settings → Updates**, as it does on a bare host. The checkout mounted at `/opt/codeman` is the same directory Compose builds from, so the update's `git checkout` and rebuild land on the host and survive container recreation; the restart is the server exiting, which `restart: unless-stopped` turns into a relaunch on the new build.

That applies application code only. A release that changes `docker/server.Dockerfile`, `docker/docker-compose.yaml`, or adds a key to `docker/.env.example` needs the image rebuilt or the container recreated, which a container cannot do to itself. The updater detects each case and refuses with a message naming what changed; run `docker/Start-Codeman.sh` on the host to apply those.

`CODEMAN_REPO_PATH` overrides which checkout is mounted. It defaults to the compose project's parent directory, so it normally needs no setting. Point it at a directory that is not a git checkout and in-app updates are reported as unavailable.

Full detail, including the fingerprint baseline and the troubleshooting table: [`docker-self-update.md`](docker-self-update.md).

## Docker cases

The default socket path is `/var/run/docker.sock`, which works with a standard Linux Docker Engine. The Bash start script detects its numeric group ID. When running Compose directly, set `DOCKER_SOCKET_GID`, for example using `stat -c '%g' /var/run/docker.sock`, so the unprivileged `CODEMAN_RUNTIME_USER` account can create Docker cases. Docker Desktop users should set `DOCKER_SOCKET` in `docker/.env` only when their Docker installation exposes a different compatible socket path.

Codeman Docker cases are sibling containers on the host daemon, not children of the application container. The Compose configuration handles their workspace bind mount through `CODEMAN_CASES_PATH`; the `/home/${CODEMAN_RUNTIME_USER}` application-data mapping is for Codeman state and ordinary in-container sessions, not sibling-case workspaces.
