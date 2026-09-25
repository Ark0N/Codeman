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

# GitHub CLI and Azure CLI (with the azure-devops extension), so a user can sign
# this container in to GitHub and Azure DevOps from a Codeman shell session and
# then clone PRIVATE repositories, both from that session and through Add Case
# -> Clone Repo. Codeman still collects no Git credentials itself: the clone
# path (src/git-clone.ts) only inherits HOME and git's config, so whatever the
# user signs in to here is what authenticates, and nothing when they have not
# (the clone then fails fast with AUTH_REQUIRED, exactly as before).
#
# Each is OPT-IN and OFF by default: the image is functionally unchanged
# unless the build gets CODEMAN_INSTALL_GH=1 and/or CODEMAN_INSTALL_AZ=1, which
# a deployment sets under `build: args:` in docker-compose.override.yml
# (docker/README.md, "Private repositories"). Off installs no apt repository,
# package, extension or credential-helper entry; all that remains is the
# AZURE_EXTENSION_DIR variable, its empty directory and one layer that copies
# and then removes the helper script. The Azure CLI is the heavy one (~600 MB,
# mostly its bundled Python). The base docker-compose.yaml
# and .env deliberately do not carry them: turning a CLI on is a per-host
# choice, which is what the override file is for, and a new .env.example key
# would make the self-updater refuse existing installs until their .env gained
# it (docs/docker-self-update.md).
#
# Both come from their vendors' own apt repositories, the same ones the
# documented one-liners configure (https://github.com/cli/cli/blob/trunk/docs/install_linux.md
# and https://learn.microsoft.com/cli/azure/install-azure-cli-linux?pivots=apt).
# Microsoft's `deb_install.sh` is deliberately not piped into the build: it does
# exactly this plus a `gnupg` install, and a remote script run at build time is
# the one step a reviewer cannot read in this file. apt reads an ASCII-armoured
# `.asc` key directly, which is what keeps `gnupg` out of the image.
#
# Not pinned, unlike the agent CLIs below: nothing in Codeman depends on a
# particular gh or az behaviour, so the pinning argument there does not apply.
# The layer cache still keeps whatever version the first build fetched until a
# --no-cache rebuild.
ARG CODEMAN_INSTALL_GH=0
ARG CODEMAN_INSTALL_AZ=0
RUN set -eux; \
    for flag in "CODEMAN_INSTALL_GH=${CODEMAN_INSTALL_GH}" "CODEMAN_INSTALL_AZ=${CODEMAN_INSTALL_AZ}"; do \
      case "${flag#*=}" in 0|1) ;; *) echo "${flag%%=*} must be 0 or 1, got '${flag#*=}'" >&2; exit 1;; esac; \
    done; \
    codename="$(. /etc/os-release && echo "${VERSION_CODENAME}")"; \
    arch="$(dpkg --print-architecture)"; \
    pkgs=""; \
    install -d -m 0755 /etc/apt/keyrings; \
    if [ "${CODEMAN_INSTALL_GH}" = 1 ]; then \
      curl -fsSL -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
        https://cli.github.com/packages/githubcli-archive-keyring.gpg; \
      chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
      echo "deb [arch=${arch} signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list; \
      # GitHub CLI copies its device-login code with xclip when available. Keep
      # this dependency inside the existing opt-in GitHub CLI branch so images
      # without gh do not gain desktop-clipboard tooling. \
      pkgs="${pkgs} gh xclip"; \
    fi; \
    if [ "${CODEMAN_INSTALL_AZ}" = 1 ]; then \
      curl -fsSL -o /etc/apt/keyrings/microsoft.asc \
        https://packages.microsoft.com/keys/microsoft.asc; \
      chmod go+r /etc/apt/keyrings/microsoft.asc; \
      echo "deb [arch=${arch} signed-by=/etc/apt/keyrings/microsoft.asc] https://packages.microsoft.com/repos/azure-cli/ ${codename} main" \
        > /etc/apt/sources.list.d/azure-cli.list; \
      pkgs="${pkgs} azure-cli"; \
    fi; \
    if [ -n "${pkgs}" ]; then \
      apt-get update; \
      apt-get install -y --no-install-recommends ${pkgs}; \
      rm -rf /var/lib/apt/lists/*; \
    fi

# The azure-devops extension goes into a SYSTEM directory rather than the
# default ~/.azure/cliextensions: HOME is the application-data bind mount, which
# hides anything installed there at build time. The directory is handed to the
# runtime account below (next to /opt/codeman-cli) so `az extension update`
# works from a session. Nothing that runs as root executes from it. It is
# created even without az, so the chown below does not have to know.
ENV AZURE_EXTENSION_DIR=/opt/codeman-az-extensions
RUN set -eux; \
    install -d -m 0755 "${AZURE_EXTENSION_DIR}"; \
    if [ "${CODEMAN_INSTALL_AZ}" = 1 ]; then \
      az extension add --name azure-devops --only-show-errors; \
      rm -rf /root/.azure; \
    fi

# Git credential helpers, in the SYSTEM gitconfig so they apply to every
# account and survive a fresh application-data directory. Each one answers only
# for its own host and prints nothing when its CLI is not signed in, so git
# falls through to its normal non-interactive failure. Only an installed CLI
# gets an entry: a helper naming a missing binary would print an error on every
# clone from that host.
#   github.com     `gh auth git-credential`, what `gh auth setup-git` configures.
#   Azure DevOps   an Entra ID token from `az login` (git-credential-azure-cli),
#                  for both dev.azure.com and the legacy *.visualstudio.com hosts.
COPY docker/git-credential-azure-cli /usr/local/bin/git-credential-azure-cli
RUN set -eux; \
    if [ "${CODEMAN_INSTALL_GH}" = 1 ]; then \
      for host in https://github.com https://gist.github.com; do \
        git config --system "credential.${host}.helper" '!/usr/bin/gh auth git-credential'; \
      done; \
    fi; \
    if [ "${CODEMAN_INSTALL_AZ}" = 1 ]; then \
      chmod 0755 /usr/local/bin/git-credential-azure-cli; \
      for host in https://dev.azure.com 'https://*.visualstudio.com'; do \
        git config --system "credential.${host}.helper" /usr/local/bin/git-credential-azure-cli; \
        git config --system "credential.${host}.useHttpPath" true; \
      done; \
    else \
      rm -f /usr/local/bin/git-credential-azure-cli; \
    fi

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
# The prefix is APPENDED to PATH, never prepended: it is chowned to the runtime
# account below, and entrypoint.sh runs as root calling stat/chown/setpriv by
# bare name. A prefix ahead of /usr/bin would let a session drop a `setpriv`
# there and have it run as root at the next container start (measured with a
# minimal image of this exact shape). The four CLIs live only in this prefix,
# so they still resolve; entrypoint.sh additionally pins its own PATH to the
# system directories for the root part of the start.
ENV NPM_CONFIG_PREFIX=/opt/codeman-cli
ENV PATH=$PATH:/opt/codeman-cli/bin
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
    chown -R "${PUID}:${PGID}" /opt/codeman-cli /opt/codeman-az-extensions

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
