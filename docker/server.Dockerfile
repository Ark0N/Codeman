# syntax=docker/dockerfile:1

# Build the application from the checkout supplied as the Docker build context.
# No published Codeman application image is required.
FROM node:22-bookworm-slim AS build

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/codeman

COPY . .

# devDependencies are deliberately KEPT (no `npm prune --omit=dev`). The in-app
# updater rebuilds from inside this container, and `npm run build` is tsc +
# esbuild — both devDependencies. Pruning them saves image size and takes the
# self-updater with it. See docs/docker-self-update.md.
RUN npm ci \
 && npm run build \
 && npm cache clean --force

# The Docker CLI talks to the host daemon through the socket mounted by
# docker/docker-compose.yaml. It does not run a Docker daemon in this container.
FROM node:22-bookworm-slim

ARG CODEMAN_RUNTIME_USER=codeman
ARG PUID=1000
ARG PGID=1000

# python3/make/g++ are here for the SELF-UPDATER, not for this build. An update
# runs `npm install` inside the running container, and node-pty ships no Linux
# prebuild, so a release that bumps it compiles from source right here. Without
# a toolchain that install fails and the update rolls back — every time, on the
# releases that need it most. Same reason install.sh installs one on bare hosts.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      g++ \
      git \
      make \
      openssh-client \
      procps \
      python3 \
      ripgrep \
      tmux \
 && rm -rf /var/lib/apt/lists/*

# The Docker CLI, taken from the official image rather than Debian's `docker.io`.
# That package is the full ENGINE: with --no-install-recommends it still pulls 15
# packages including containerd, runc, dmsetup and iptables, none of which a
# client that only talks to a mounted socket can use. Measured on top of this
# base image: `docker.io` costs 266 MB and ships Docker 20.10.24 (2023), while
# these two files cost 108 MB and ship the current CLI (493 MB vs 335 MB total).
#
# The binaries are STATIC Go builds, so they run on this glibc image even though
# the image they come from is Alpine (verified: `docker --version`, `docker ps`
# and `docker build` all work here against a mounted host socket).
#
# buildx is copied on purpose. `scripts/build-agent-image.mjs` shells out to
# `docker build` — Codeman auto-builds the agent image on the first Docker case —
# and without the plugin that silently falls back to the CLASSIC builder, which
# Docker has deprecated and will eventually drop. `docker-compose` is NOT copied:
# Codeman never shells out to it.
COPY --from=docker:29-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker:29-cli \
     /usr/local/libexec/docker/cli-plugins/docker-buildx \
     /usr/local/libexec/docker/cli-plugins/docker-buildx

# Keep credentials out of the image. Users authenticate these CLIs at runtime
# through Codeman sessions, and the configured host bind mount retains state.
#
# Installed into a DEDICATED prefix, /opt/codeman-cli, not the base image's
# default /usr/local. A session needs write access to wherever these CLIs live
# so it can self-update one in place (observed via Codex's own
# `npm install -g @openai/codex`, which renames the old package directory
# aside before installing the new one — a rename needs write access to the
# PARENT directory, not just the target, so the runtime account needs that
# access at the directory level). Chowning /usr/local/bin and
# /usr/local/lib/node_modules directly to get it would ALSO hand away
# entrypoint.sh (COPY'd to /usr/local/bin below, root-owned, executed as root
# on every container start with CHOWN/DAC_OVERRIDE/SETUID/SETGID) and the node
# binary: owning the DIRECTORY is enough to rename it aside and drop a
# replacement, even though the file itself stays root-owned, which would let a
# compromised session arrange for its own script to run as root at the next
# restart — undoing the "the server itself never runs privileged" guarantee
# the entrypoint exists to provide. /opt/codeman-cli holds nothing else to
# escalate through, so owning it is exactly the CLI-update access it needs and
# no more.
#
# ⚠️ PINNED ON PURPOSE. Unpinned, the agent CLI versions a user ends up with are
# a function of WHEN their image was built, not of any commit — so a Codeman
# release that depends on newer CLI behaviour (the trust-dialog handling is
# pinned to Claude Code 2.1.252's layout; wheel forwarding to >= 2.1.187) breaks
# on an older image with no diff anywhere to explain why. In-app updates make
# rebuilds RARER, which makes that drift worse. Pinning turns "this release needs
# a newer CLI" into a Dockerfile change, which the updater's environment gate
# already detects and refuses (docs/docker-self-update.md).
#
# Bump these deliberately, in a release. `--no-cache` is still needed to rebuild
# this layer when only the pins change upstream.
ENV NPM_CONFIG_PREFIX=/opt/codeman-cli
ENV PATH=/opt/codeman-cli/bin:$PATH
RUN npm install --global \
      @anthropic-ai/claude-code@2.1.258 \
      @google/gemini-cli@0.58.0 \
      @openai/codex@0.152.1 \
      opencode-ai@1.18.26 \
 && npm cache clean --force

# Keep the web server and every local Codeman session unprivileged. PUID and
# PGID match the host-owned application-data directory mounted by Compose. The
# requested GID may not exist in the base image, and a host UID such as 1000 may
# already belong to the baked `node` account, so handle both cases explicitly.
#
# The trailing chown hands the CLI prefix (/opt/codeman-cli, populated above)
# to that same account, so a session can self-update one of the CLIs in place.
# /usr/local stays root-owned throughout — see the comment on the npm install
# above for why that boundary matters.
RUN set -eux; \
    case "${PUID}" in ''|*[!0-9]*) echo "PUID must be numeric" >&2; exit 1;; esac; \
    case "${PGID}" in ''|*[!0-9]*) echo "PGID must be numeric" >&2; exit 1;; esac; \
    if [ "${PUID}" -eq 0 ]; then \
      echo "PUID must identify an unprivileged account, not root" >&2; \
      exit 1; \
    fi; \
    if ! getent group "${PGID}" >/dev/null; then \
      groupadd --gid "${PGID}" codeman-runtime; \
    fi; \
    existing_user="$(getent passwd "${PUID}" | cut -d: -f1 || true)"; \
    if [ -n "${existing_user}" ]; then \
      usermod \
        --login "${CODEMAN_RUNTIME_USER}" \
        --gid "${PGID}" \
        --home "/home/${CODEMAN_RUNTIME_USER}" \
        --move-home \
        --shell /bin/bash \
        "${existing_user}"; \
    else \
      useradd \
        --uid "${PUID}" \
        --gid "${PGID}" \
        --create-home \
        --home-dir "/home/${CODEMAN_RUNTIME_USER}" \
        --shell /bin/bash \
        "${CODEMAN_RUNTIME_USER}"; \
    fi; \
    chown -R "${PUID}:${PGID}" /opt/codeman-cli

WORKDIR /opt/codeman

COPY --from=build /opt/codeman /opt/codeman

# CODEMAN_IN_CONTAINER tells the self-updater it must restart by exiting rather
# than by asking an init system that is not here (src/web/self-update.ts).
# NODE_ENV stays `production`; the updater passes `npm install --include=dev`
# explicitly, since that value would otherwise omit the build toolchain.
ENV CODEMAN_IN_CONTAINER=1 \
    CODEMAN_PORT=3000 \
    HOME=/home/${CODEMAN_RUNTIME_USER} \
    NODE_ENV=production

# Runtime defaults for the entrypoint, matching the account created above.
ENV PGID=${PGID} PUID=${PUID}

EXPOSE 3000

# The container starts as root so the entrypoint can correct the ownership of
# the host bind mounts, which the daemon creates as root whenever they do not
# already exist. The entrypoint then drops to PUID:PGID with setpriv, so the
# server itself never runs privileged. Setting `user:` in Compose bypasses both
# steps, leaving the caller in full control.
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

CMD ["node", "dist/index.js", "web"]
