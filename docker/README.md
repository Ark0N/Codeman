# Codeman Docker deployment

This folder contains the Compose configuration, server image Dockerfile, and environment template for a locally built Codeman server.

## Start

From the repository root, create the runtime environment file and set the required values, especially `CODEMAN_PASSWORD`.

```sh
cp docker/.env.example docker/.env
bash docker/Start-Codeman.sh
```

On PowerShell, use the following command instead.

```powershell
Copy-Item docker/.env.example docker/.env
docker compose --env-file docker/.env -f docker/docker-compose.yaml up --build -d
```

Every required value is defined and explained in `.env.example`. `GEMINI_API_KEY` is intentionally optional and may remain blank.

On Linux, `Start-Codeman.sh` stops with an error when required paths are missing. It creates the application-data directory when safe, detects its numeric owner as `PUID:PGID`, and detects `DOCKER_SOCKET_GID` from the configured Docker socket. It rejects a root-owned application-data directory because Codeman and its local CLI sessions must remain unprivileged.

Codeman, Claude, OpenCode, and other local sessions run as the unprivileged account named by `CODEMAN_RUNTIME_USER`, which defaults to `opencode`. When Compose is run directly, `PUID` and `PGID` default to `1000:1000`; set them in `.env` when the application-data directory has a different owner. The Bash start script determines them automatically instead.

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

## Application data storage

The default configuration uses a host-folder bind mount:

```yaml
volumes:
  - type: bind
    source: ${CODEMAN_APPDATA_PATH}
    target: /home/${CODEMAN_RUNTIME_USER}
```

Set `CODEMAN_APPDATA_PATH` in `.env` to a directory that the Docker daemon can access. The example value is `/mnt/user/appdata/Coding/codeman`.

`CODEMAN_CASES_PATH` is the separate host directory for managed case workspaces. It is mounted into Codeman at the same absolute path, allowing the host Docker daemon to bind it into an isolated case container. Set it to a child directory of `CODEMAN_APPDATA_PATH` unless you deliberately store workspaces elsewhere.

Compose also exposes `CODEMAN_APPDATA_PATH` to Codeman as `CODEMAN_DOCKER_HOST_HOME`. This lets Docker case seed files, CLI credentials and the hook secret be mounted using paths that exist in the host daemon's filesystem. Direct host installations do not set this variable and retain their existing behaviour.

Set `CODEMAN_DOCKER_DISABLE_SWAP_LIMIT=1` when `docker info` reports `SwapLimit=false`. Codeman continues to apply the configured case memory limit, omits Docker's unsupported `--memory-swap` option, and filters only the daemon's exact swap-capability warning. Every other Docker create error and its exit status remain visible.

For an existing installation created by a root-running image, change ownership of the application-data directory before upgrading so the configured `PUID` and `PGID` can read the saved credentials and state:

```sh
chown -R 99:100 /mnt/user/appdata/Coding/codeman
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
