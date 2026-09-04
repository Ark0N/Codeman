# Codeman agent base image (built locally by scripts/build-agent-image.mjs).
#
# Contains the agent toolchain (node + the CLIs + git/tmux/ripgrep) but NO
# secrets: credentials are delivered at RUNTIME via bind mounts (~/.claude etc.)
# or name-only `docker exec --env`, never baked in, so `docker save` exports stay
# secret-free. tmux is a HARD prerequisite (the in-container tmux is what makes a
# reconnect durable), so it is installed here and probed before launch.
#
# HOME is made writable by an ARBITRARY host uid via the OpenShift "gid 0,
# group-writable" convention: on Linux we run `--user <hostUid>:0`, so the agent
# uid is the host uid (workspace files stay host-owned) while gid 0 keeps $HOME
# writable even though the uid is not the baked 1000.
FROM node:22-bookworm-slim

# Base toolchain. `curl` is needed for the hook callbacks (`curl -sk $CODEMAN_API_URL`),
# `procps` for `ps`, `tmux` for the durable in-container session.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git \
      tmux \
      ripgrep \
      curl \
      ca-certificates \
      less \
      procps \
      openssh-client \
 && rm -rf /var/lib/apt/lists/*

# The npm-published agent CLIs, supplied by scripts/build-agent-image.mjs from
# config/clis.stock.json so a new stock CLI needs no edit here. The default is
# today's literal list, so a bare `docker build` still produces the same image.
#
# ⚠️ Expanded UNQUOTED on purpose: word splitting is what turns the list into
# several arguments. Every token is validated against
# ^[@A-Za-z0-9][@A-Za-z0-9/._-]*$ on the producing side
# (scripts/lib/cli-catalog.mjs) precisely because of that.
#
# ⚠️ Filtered on each entry's `enabled` flag, so a CLI that ships disabled is
# never baked into every image.
#
# Pinning is left to the rebuild cadence (see docs/docker-cases-plan.md,
# user-decision 2).
# ⚠️ The default is in REGISTRY order, byte-identical to what the generator emits.
# A different order is a different RUN string, which is a different layer hash and
# so a needless cache miss between a bare `docker build` and a scripted one.
ARG CLI_NPM_PACKAGES="@anthropic-ai/claude-code opencode-ai @openai/codex @google/gemini-cli"
RUN npm install -g ${CLI_NPM_PACKAGES} \
 && npm cache clean --force

# Antigravity (`agy`) is NOT on npm — Google ships a standalone binary through its
# own installer, so it needs its own step. `--dir /usr/local/bin` is load-bearing:
# the installer's default target is `$HOME/.local/bin`, which at build time is
# root's home and would be unreachable by the `agent` user the container runs as.
# ⚠️ This binary is ~190MB on its own; it is the single largest layer in the image.
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash -s -- --dir /usr/local/bin \
 && chmod 755 /usr/local/bin/agy \
 && agy --version

# Pi (pi.dev). Upstream documents --ignore-scripts (pi needs no lifecycle scripts);
# kept out of the shared npm block above so the flag cannot silently change how the
# other four CLIs install.
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent \
 && npm cache clean --force \
 && pi --version

# Grok Build (`grok`, xAI) is NOT on npm: a standalone ~160MB Rust binary through
# xAI's installer, which targets $HOME/.grok/bin with no --dir override. At build
# time that is root's home and unreachable by the `agent` user, so copy the binary
# into /usr/local/bin and drop root's ~/.grok in the same layer so the image does
# not carry the download twice. The staging cp -T is what makes this survive the
# installer's own behavior EITHER way: newer installers already symlink
# /usr/local/bin/grok -> /root/.grok/bin/grok, and a direct `cp -L` onto that
# symlink fails with "same file" (2026-08-24 rebuild), while removing the link
# first and copying fresh works for both old and new installers.
RUN curl -fsSL https://x.ai/cli/install.sh | bash \
 && cp -L /root/.grok/bin/grok /usr/local/bin/grok.real \
 && rm -f /usr/local/bin/grok \
 && mv /usr/local/bin/grok.real /usr/local/bin/grok \
 && chmod 755 /usr/local/bin/grok \
 && rm -rf /root/.grok /root/.local/bin/grok /root/.local/bin/agent \
 && grok --version

# DeepSeek Harness (`dsh`). A normal npm package, but the ONLY entry here whose
# binary runs nothing on its own: `dsh` is a profile launcher, and DeepSeek ships
# only `web` and `headless`, so without an interactive profile a
# `mode: 'deepseek'` container would start a pane that dies on arrival. The
# profile itself is installed further down, into the `agent` HOME, because
# Codeman deliberately does NOT seed `profiles/` from the host: it is a
# per-profile node_modules tree, host-arch-specific and far too large to copy on
# every container start.
# ⚠️ `pnpm` is a HARD dependency of `dsh plugin`, not optional tooling: the
# subcommand is a thin forwarder that `spawnSync`s a literal `pnpm` with no
# fallback to npm, so on an image without it the profile install below dies
# with `dsh: pnpm not found on PATH` / exit 127 and takes the whole build with
# it (issue #352). It stays on PATH at runtime too, so a container user can run
# `dsh plugin add` themselves.
RUN npm install -g @deepseek-ai/dsh pnpm \
 && npm cache clean --force \
 && dsh --version \
 && pnpm --version

# OMP (Oh My Pi) is NOT on npm: a standalone binary via omp.sh's installer, which
# targets $HOME/.local/bin with no --dir override (verified 2026-08-27 — the
# resolver's OMP_SEARCH_DIRS lists ~/.omp/bin first, which turned out to be the
# WRONG guess for the installer's actual target; build this step for real
# rather than trust that ordering). At build time $HOME is root's home and
# unreachable by the `agent` user, so copy the binary into /usr/local/bin and
# drop root's ~/.local/bin/omp in the same layer so the image does not carry
# the download twice.
RUN curl -fsSL https://omp.sh/install | sh \
 && cp -L /root/.local/bin/omp /usr/local/bin/omp.real \
 && rm -f /usr/local/bin/omp \
 && mv /usr/local/bin/omp.real /usr/local/bin/omp \
 && chmod 755 /usr/local/bin/omp \
 && rm -f /root/.local/bin/omp \
 && omp --version

# `agent` user (gid 0) with an arbitrary-uid-writable HOME. The uid is
# auto-assigned (node:22-slim already occupies uid 1000 with its `node` user); at
# runtime Codeman overrides with `--user <hostUid>:0` on Linux, so the baked uid
# only matters for a hand-run / Docker Desktop container. gid 0 + group-writable
# HOME (OpenShift arbitrary-uid convention) keeps $HOME writable for any uid.
# UTF-8 locale so tmux/Ink render Unicode box-drawing instead of VT100 ACS `q`
# glyphs (C.UTF-8 is built into glibc; no locales package needed). Codeman also
# sets these at run time so containers built before this line still get UTF-8.
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8
ENV HOME=/home/agent
# `.claude` (+ `.claude/projects` mount point) and `.codex` (+ `.codex/sessions`) are
# pre-created gid-0 group-writable so the container owns its OWN credential config
# dirs: tokens/settings/config are seeded in as writable copies and each CLI's runtime
# state (backups, tasks, refreshed tokens) stays container-local, while ONLY the shared
# transcript/rollout dirs (`.claude/projects`, `.codex/sessions`) are bind-mounted from
# the host. (gemini/gcloud/opencode are whole seed-copies and need no pre-created dir;
# Antigravity nests its state inside `.gemini/antigravity-cli`, so it rides that seed.)
# `.pi/agent` and `.grok` ARE pre-created: both are seeded per-FILE (pi:
# auth/settings/trust/models; grok: auth.json/config.toml/pager.toml), and a
# per-file seed copy, unlike a whole-dir one, does not create its parent directory.
# `.dsh` is pre-created for the same per-file reason (.env/settings.yaml/
# cordis.patch.yml), and the interactive profile is built into it HERE rather than
# after `USER agent`: this layer's closing chgrp/chmod is what makes the whole tree
# writable by the arbitrary uid the container actually runs as, and a profile
# installed after it would miss that fixup. DSH_HOME points the launcher at the
# agent's dir while this still runs as root.
# ⚠️ `dangerouslyAllowAllBuilds` is what keeps that profile install from becoming
# the next #352. pnpm (unlike npm) blocks dependency lifecycle scripts by default
# and FAILS the install over it — `ERR_PNPM_IGNORED_BUILDS`, exit 1, measured on
# pnpm 11.24 — so any package in the tui's tree that ships one stops the build
# dead. An allowlist of the offenders rots: `@deepseek-harness-tui/dsh-tui` is
# resolved by dist-tag, not pinned, and 0.9.3 pulled `@google/genai` (a
# `preinstall: no-op`) where 0.10.0-beta.x does not, so the names to allow move
# under us between rebuilds. Allowing them wholesale is also the SAME exposure
# this image already accepts three layers up: `npm install -g` runs the install
# scripts of every transitive dep of the five CLIs above it, with no gate at all.
# `.omp/agent` is pre-created for the same reason `.codex` is: it is a MIXED
# store (per-file config seeds PLUS a shared `sessions/` RW bind mount for
# Codeman's own host-side history/resume reads), and neither kind of artifact
# creates its own parent directory.
RUN useradd -g 0 -m -d /home/agent -s /bin/bash agent \
 && mkdir -p /home/agent/.npm /home/agent/.cache /home/agent/.config /home/agent/.codeman \
      /home/agent/.claude/projects /home/agent/.codex/sessions /home/agent/.pi/agent /home/agent/.grok \
      /home/agent/.dsh /home/agent/.omp/agent \
 && DSH_HOME=/home/agent/.dsh HOME=/home/agent \
      dsh plugin --profile dsh-tui add --config.dangerouslyAllowAllBuilds=true \
      @deepseek-harness-tui/dsh-tui \
 && test -f /home/agent/.dsh/profiles/dsh-tui/package.json \
 && chgrp -R 0 /home/agent \
 && chmod -R g=u /home/agent

USER agent
WORKDIR /home/agent

# Codeman overrides the command with `sleep infinity` at create time; this is the
# fallback so a hand-run container also idles rather than exiting.
CMD ["sleep", "infinity"]
