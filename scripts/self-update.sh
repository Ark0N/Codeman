#!/usr/bin/env bash
#
# self-update.sh — apply a Codeman release update from inside the running app.
#
# Spawned DETACHED by the web server (POST /api/system/update → src/web/self-update.ts).
# It outlives the service restart it triggers, so it MUST run from a copy OUTSIDE
# the repo (the server stages it at ~/.codeman/self-update-runner.sh) — `git
# checkout` rewrites the in-repo copy and bash reads scripts lazily.
#
# ⚠️ The `docker-compose` supervisor is the exception to "outlives": there the
# restart IS the container exiting, which kills this script too. That is safe
# because the terminal "restarting" marker is written before the kill and the
# rebooted server reconciles it — but nothing may be added after that kill.
#
# Reports progress by writing ~/.codeman/update-status.json atomically; the
# browser polls GET /api/system/update/status across the restart drop. The
# freshly-booted server reconciles the final "restarting" → "completed"/"failed".
#
# Cross-platform: restarts via systemd (Linux), launchd (macOS), a container exit
# under Docker Compose (the restart policy relaunches it), or prints a manual
# command (foreground installs). Linux launches inside a transient systemd scope
# so `systemctl restart codeman-web` can't kill it mid-build.
#
# Args (all from the server, never user input — tag is validated server-side):
#   --repo <dir> --tag <codeman@X.Y.Z> --supervisor <systemd|launchd|docker-compose|none>
#   --status-file <path> --update-id <uuid> --from-version <ver> --node <path>
#   --log <path> [--prev-sha <sha>] [--stash] [--server-pid <pid>]
#   [--restart-by-exit 0|1]   (docker-compose only: may we exit the server?)
#
set -uo pipefail

# puppeteer is a devDependency (scripts/browser-comparison.mjs only) — its chrome
# download is never needed to build or run Codeman, and a corrupt prior download
# (folder present, executable missing) makes `npm install` fail fatally. Skip it
# for every npm install below (initial install + rollback). Caller can override.
export PUPPETEER_SKIP_DOWNLOAD="${PUPPETEER_SKIP_DOWNLOAD:-1}"

REPO=""
TAG=""
SUPERVISOR="none"
SERVER_PID=""
RESTART_BY_EXIT="0"
STATUS_FILE=""
UPDATE_ID=""
FROM_VERSION=""
NODE="node"
LOG="/dev/null"
PREV_SHA=""
DO_STASH=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --tag) TAG="$2"; shift 2 ;;
    --supervisor) SUPERVISOR="$2"; shift 2 ;;
    --status-file) STATUS_FILE="$2"; shift 2 ;;
    --update-id) UPDATE_ID="$2"; shift 2 ;;
    --from-version) FROM_VERSION="$2"; shift 2 ;;
    --node) NODE="$2"; shift 2 ;;
    --log) LOG="$2"; shift 2 ;;
    --prev-sha) PREV_SHA="$2"; shift 2 ;;
    --server-pid) SERVER_PID="$2"; shift 2 ;;
    --restart-by-exit) RESTART_BY_EXIT="$2"; shift 2 ;;
    --stash) DO_STASH=1; shift ;;
    *) shift ;;
  esac
done

# All output → the log file (the process is detached, no tty).
exec >>"$LOG" 2>&1 || true
echo "[self-update] $(date) start tag=$TAG supervisor=$SUPERVISOR repo=$REPO"

# Make node/npm/git reachable regardless of the (possibly minimal) service env.
export PATH="$(dirname "$NODE"):$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
export GIT_TERMINAL_PROMPT=0

TO_VERSION="${TAG##*@}"   # codeman@0.9.4 → 0.9.4 (tag is validated upstream)
STASH_REF=""
MANUAL_CMD=""

# Write the status file atomically via node (valid JSON, preserves startedAt).
write_status() {
  local phase="$1" message="$2" err="${3:-}"
  STATUS_FILE="$STATUS_FILE" UPDATE_ID="$UPDATE_ID" PHASE="$phase" MESSAGE="$message" \
  FROM_VERSION="$FROM_VERSION" TO_VERSION="$TO_VERSION" TO_TAG="$TAG" PREV_SHA="$PREV_SHA" \
  STASH_REF="$STASH_REF" SUPERVISOR="$SUPERVISOR" ERROR="$err" MANUAL_CMD="$MANUAL_CMD" \
  "$NODE" -e '
    const fs = require("fs");
    const f = process.env.STATUS_FILE;
    let started = 0;
    try { const cur = JSON.parse(fs.readFileSync(f, "utf8")); if (cur && cur.startedAt) started = cur.startedAt; } catch {}
    const s = {
      updateId: process.env.UPDATE_ID,
      phase: process.env.PHASE,
      message: process.env.MESSAGE,
      fromVersion: process.env.FROM_VERSION,
      startedAt: started,
      updatedAt: Date.now(),
    };
    if (process.env.TO_VERSION) s.toVersion = process.env.TO_VERSION;
    if (process.env.TO_TAG) s.toTag = process.env.TO_TAG;
    if (process.env.PREV_SHA) s.prevSha = process.env.PREV_SHA;
    s.stashRef = process.env.STASH_REF || null;
    if (process.env.SUPERVISOR) s.supervisor = process.env.SUPERVISOR;
    if (process.env.ERROR) s.error = process.env.ERROR;
    if (process.env.MANUAL_CMD) s.manualRestartCommand = process.env.MANUAL_CMD;
    const tmp = f + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
    fs.renameSync(tmp, f);
  ' || echo "[self-update] WARN: status write failed ($phase)"
}

# Run a slow step with a heartbeat so the status file (and the UI polling it) keeps
# moving instead of looking frozen during npm install / build. Every few seconds it
# refreshes the status with the latest output line, and mirrors full output to the
# log. Returns the wrapped command's exit code.
run_step() {
  local phase="$1" base="$2"; shift 2
  local step_log; step_log="$(mktemp "${TMPDIR:-/tmp}/codeman-update.XXXXXX" 2>/dev/null || echo "/tmp/codeman-update.$$")"
  write_status "$phase" "$base…"
  echo "[self-update] $phase: $* (output below)"
  "$@" >"$step_log" 2>&1 &
  local pid=$! start=$SECONDS last_line=""
  while kill -0 "$pid" 2>/dev/null; do
    sleep 3
    local line
    line="$(tr -d '\r' <"$step_log" 2>/dev/null | grep -aE '[^[:space:]]' | tail -n 1 | cut -c1-100)"
    [[ -n "$line" && "$line" != "$last_line" ]] && last_line="$line"
    if [[ -n "$last_line" ]]; then
      write_status "$phase" "$base… · $last_line"
    else
      write_status "$phase" "$base… (working)"
    fi
  done
  wait "$pid"; local rc=$?
  echo "[self-update] $phase finished in $((SECONDS - start))s (rc=$rc)"
  cat "$step_log" >>"$LOG" 2>/dev/null || true
  rm -f "$step_log" 2>/dev/null || true
  return $rc
}

fail() {
  local msg="$1" err="${2:-}"
  echo "[self-update] FAILED: $msg ($err)"
  write_status "failed" "$msg" "$err"
  exit 1
}

# Restore the previous commit + working build so the still-running server keeps
# serving good code. We do NOT restart on failure.
rollback_and_fail() {
  local msg="$1"
  echo "[self-update] $msg — rolling back to ${PREV_SHA:-<none>}"
  if [[ -n "$PREV_SHA" ]]; then
    git checkout --force "$PREV_SHA" >/dev/null 2>&1 || true
    npm install --no-fund --no-audit --include=dev >/dev/null 2>&1 || true
    npm run build >/dev/null 2>&1 || true
  fi
  fail "$msg — rolled back to the previous version" "$msg"
}

cd "$REPO" || fail "Install directory not found" "cd $REPO"
git rev-parse --git-dir >/dev/null 2>&1 || fail "Not a git repository" "$REPO"

write_status "preparing" "Preparing update to v$TO_VERSION…"

# 1) Stash local changes (left for the user to pop — never auto-popped).
if [[ "$DO_STASH" == "1" ]]; then
  write_status "stashing" "Stashing local changes…"
  STASH_MSG="codeman-pre-update-$UPDATE_ID"
  if git stash push -u -m "$STASH_MSG" >/dev/null 2>&1; then
    STASH_REF="$STASH_MSG"
    echo "[self-update] stashed local changes as $STASH_MSG"
  fi
fi

# 2) Fetch the target tag.
write_status "fetching" "Fetching $TAG…"
git fetch --tags --force origin "refs/tags/$TAG:refs/tags/$TAG" 2>/dev/null \
  || git fetch --tags --force origin \
  || fail "Could not fetch the release" "git fetch $TAG"

# 3) Check out the release tag (detached HEAD at the release).
write_status "checkout" "Checking out $TAG…"
git -c advice.detachedHead=false checkout --force "$TAG" || rollback_and_fail "Could not check out $TAG"

# 4) Install dependencies (heartbeat keeps the UI live during this slow step).
# --include=dev: tsc and esbuild are devDependencies, and the Compose image sets
# NODE_ENV=production, which would otherwise omit them and fail the build below.
run_step "installing" "Installing dependencies" npm install --no-fund --no-audit --include=dev \
  || rollback_and_fail "Dependency install failed"

# 5) Build (gate the restart on success — never restart into a torn dist/).
run_step "building" "Building" npm run build || rollback_and_fail "Build failed"

# Docker Compose only: record what HEAD/package-lock.json the freshly-built
# codeman-dist/codeman-node-modules volumes now reflect. `Start-Codeman.sh`
# reads this same file (`$appdata_path/.codeman/…`, i.e. this container's own
# $HOME/.codeman since that path IS the appdata bind mount) to detect source
# changes an EXTERNAL `docker compose build` made and refresh those volumes —
# without this, the next plain `Start-Codeman.sh` run would see the HEAD this
# update just checked out, not recognise it as already accounted for, and wipe
# the volumes this update just correctly rebuilt right back to the OLDER image.
if [[ "$SUPERVISOR" == "docker-compose" ]]; then
  build_source_file="$HOME/.codeman/docker-build-source.json"
  mkdir -p -- "$HOME/.codeman"
  build_head=$(git rev-parse HEAD 2>/dev/null || true)
  build_lockfile_sha=''
  if command -v sha256sum >/dev/null 2>&1; then
    build_lockfile_sha=$(sha256sum -- package-lock.json 2>/dev/null | cut -d' ' -f1)
  elif command -v shasum >/dev/null 2>&1; then
    build_lockfile_sha=$(shasum -a 256 package-lock.json 2>/dev/null | cut -d' ' -f1)
  fi
  printf '{\n  "headCommit": "%s",\n  "lockfileSha256": "%s"\n}\n' \
    "$build_head" "$build_lockfile_sha" >"$build_source_file.tmp" \
    && mv -- "$build_source_file.tmp" "$build_source_file"
fi

# 6) Restart the service so the new code loads. Write the terminal pre-restart
#    marker FIRST so the freshly-booted server can reconcile it deterministically.
write_status "restarting" "Restarting Codeman…"
echo "[self-update] build OK, restarting via $SUPERVISOR"

case "$SUPERVISOR" in
  systemd)
    systemctl --user restart codeman-web.service \
      || fail "Build succeeded but restart failed — run: systemctl --user restart codeman-web" "systemctl restart"
    ;;
  launchd)
    launchctl kickstart -k "gui/$(id -u)/com.codeman.web" 2>/dev/null || {
      PLIST="$HOME/Library/LaunchAgents/com.codeman.web.plist"
      launchctl unload "$PLIST" 2>/dev/null || true
      launchctl load "$PLIST" 2>/dev/null \
        || fail "Build succeeded but launchd restart failed" "launchctl"
    }
    ;;
  docker-compose)
    # In the Compose deployment there is no init system to ask: the "restart" is
    # the server EXITING, so the container's `restart: unless-stopped` policy
    # relaunches it on the dist/ we just built. The repo and dist/ live on host
    # mounts, so the new build survives the container being replaced.
    #
    # ⚠️ This script dies WITH the container it is restarting — it is a child of
    # the server process, not a survivor like the systemd-scope path. That is
    # fine, and load-bearing: the terminal "restarting" marker is already written
    # above, and the freshly-booted server reconciles it. Nothing may be appended
    # after the kill that the update depends on.
    #
    # ⚠️ The server is signalled by PID rather than `docker restart`: this
    # container's own Docker CLI talks to the HOST daemon, and a self-directed
    # restart there races the client's own death. Exiting is the one path that
    # needs no cooperation from anything outside the container.
    #
    # ⚠️ Only when the SERVER said the container comes back (`--restart-by-exit 1`:
    # the Compose file declared it, or the daemon reported an auto-restart policy).
    # An unknown policy stages the build and asks for a restart instead. Exiting
    # blind would take a container the daemon does not restart down for good,
    # with no UI left to recover it from.
    if [[ "$RESTART_BY_EXIT" != "1" ]]; then
      MANUAL_CMD="docker restart \$(hostname)  # from the Docker host"
      write_status "completed-needs-manual-restart" "Update built — restart the Codeman container to apply v$TO_VERSION."
      echo "[self-update] docker-compose: restart-by-exit not confirmed — not exiting; manual restart required"
      exit 0
    fi
    if [[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null; then
      : # container exit + restart policy take it from here
    else
      MANUAL_CMD="docker restart \$(hostname)  # from the Docker host"
      write_status "completed-needs-manual-restart" "Update staged — restart the Codeman container to apply v$TO_VERSION."
      echo "[self-update] docker-compose: could not signal server pid '$SERVER_PID' — manual restart required"
      exit 0
    fi
    ;;
  launchd-daemon)
    # System-level KeepAlive LaunchDaemon (headless Mac): kickstarting the system
    # domain needs root, but we don't need it — kill the server and launchd
    # respawns it on the new dist/ within ThrottleInterval seconds.
    if [[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null; then
      : # respawn is launchd's job from here
    else
      MANUAL_CMD="sudo launchctl kickstart -k system/com.codeman.web"
      write_status "completed-needs-manual-restart" "Update staged — restart Codeman to apply v$TO_VERSION."
      echo "[self-update] launchd-daemon: could not signal server pid '$SERVER_PID' — manual restart required"
      exit 0
    fi
    ;;
  *)
    MANUAL_CMD="pkill -f 'codeman.*web'; codeman web &"
    write_status "completed-needs-manual-restart" "Update staged — restart Codeman to apply v$TO_VERSION."
    echo "[self-update] no supervisor — manual restart required"
    exit 0
    ;;
esac

echo "[self-update] restart issued; done"
exit 0
