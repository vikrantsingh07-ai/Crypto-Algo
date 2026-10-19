#!/usr/bin/env bash
# CryptoAlgo backend: update to the latest code on the Oracle (or any Ubuntu) VM. Idempotent: safe to run again.
#   sudo bash /opt/cryptoalgo/deploy/oracle/update.sh
# What it does: git pull --ff-only in APP_DIR, docker compose up -d --build in deploy/oracle (it reuses the .env that
# setup.sh created, so NO secrets have to be passed), then waits for the server container to answer its health check.
# It refuses to run when tracked files in the working tree were changed locally. Nothing is reset or deleted.
#   optional env: APP_DIR (default /opt/cryptoalgo), HEALTH_TIMEOUT seconds (default 300), HEALTH_INTERVAL seconds
#   (default 5), DRY_RUN=1 (read-only checks, prints the plan, changes nothing)
# No secret is printed: log lines shown on a failure have every secret value from .env replaced by ***. (git pull runs
# with --quiet so a remote URL that carries an access token is never echoed.)
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/cryptoalgo}"
DEPLOY_DIR="$APP_DIR/deploy/oracle"
ENV_FILE="$DEPLOY_DIR/.env"
DRY_RUN="${DRY_RUN:-0}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-300}"
HEALTH_INTERVAL="${HEALTH_INTERVAL:-5}"
LOCK_FILE="${LOCK_FILE:-/var/lock/cryptoalgo-update.lock}"

log() { printf '[cryptoalgo-update] %s\n' "$*"; }
die() { printf '[cryptoalgo-update] ERROR: %s\n' "$*" >&2; exit 1; }
# safe.directory: the checkout may belong to another user than root (command-line config is honoured by git)
g() { git -c safe.directory="$APP_DIR" -C "$APP_DIR" "$@"; }

[[ "$HEALTH_TIMEOUT" =~ ^[0-9]+$ && "$HEALTH_INTERVAL" =~ ^[1-9][0-9]*$ ]] || die "HEALTH_TIMEOUT and HEALTH_INTERVAL must be whole numbers of seconds"
[[ -d "$APP_DIR/.git" ]] || die "$APP_DIR is not a git checkout (the first install is done by setup.sh)"
[[ -f "$ENV_FILE" ]] || die "$ENV_FILE not found: run deploy/oracle/setup.sh first (it creates the .env this script reuses)"

if [[ "$DRY_RUN" != "1" ]]; then
  [[ "$(id -u)" == "0" ]] || die "run as root (sudo bash $0)"
  command -v docker >/dev/null 2>&1 || die "docker is not installed (run setup.sh first)"
  docker compose version >/dev/null 2>&1 || die "the docker compose plugin is missing (run setup.sh first)"
  # one update at a time
  exec 9>"$LOCK_FILE"
  flock -n 9 || die "another update is already running"
fi

# ---------------------------------------------------------------------------- local changes block the update
# Tracked files only: .env and STATUS.txt are untracked/ignored on purpose. File NAMES are shown, never contents.
dirty="$(g status --porcelain --untracked-files=no)"
if [[ -n "$dirty" ]]; then
  printf '%s\n' "$dirty" >&2
  die "the working tree in $APP_DIR has local changes (listed above). Nothing was changed. Commit or discard them (git -C $APP_DIR diff shows them), then run this again."
fi

before="$(g rev-parse HEAD)"
log "current version: $(g rev-parse --short HEAD) ($(g log -1 --format=%s))"

if [[ "$DRY_RUN" == "1" ]]; then
  log "DRY_RUN: the working tree is clean. Would run: git pull --ff-only; docker compose up -d --build (in $DEPLOY_DIR); wait up to ${HEALTH_TIMEOUT}s for the server health check"
  exit 0
fi

# ---------------------------------------------------------------------------- pull
log "fetching the latest code (fast-forward only)"
g pull --ff-only --quiet || die "git pull --ff-only failed (no network, no upstream branch, or the local history diverged). Nothing was rebuilt; the old version is still running."
after="$(g rev-parse HEAD)"
if [[ "$before" == "$after" ]]; then
  log "already at the latest code ($(g rev-parse --short HEAD)); rebuilding anyway so the containers match it"
else
  log "updated $(g rev-parse --short "$before") -> $(g rev-parse --short "$after"): $(g log -1 --format=%s)"
fi

# ---------------------------------------------------------------------------- rebuild + restart
cd "$DEPLOY_DIR"

# Secret values of .env replaced by *** in anything printed from container logs.
scrub() {
  awk '
    FILENAME == ARGV[1] {
      i = index($0, "=")
      if (i > 1) {
        k = substr($0, 1, i - 1); v = substr($0, i + 1)
        if (k ~ /(PASSWORD|SECRET|KEY|TOKEN)/ && length(v) >= 6) secret[++n] = v
      }
      next
    }
    {
      line = $0
      for (j = 1; j <= n; j++) {
        while ((p = index(line, secret[j])) > 0) line = substr(line, 1, p - 1) "***" substr(line, p + length(secret[j]))
      }
      print line
    }
  ' "$ENV_FILE" -
}

log "building and starting (a build with new code takes a few minutes)"
if ! docker compose up -d --build; then
  die "docker compose up --build failed (the build output is above). The previous containers were not removed unless compose already replaced them; check: docker compose -f $DEPLOY_DIR/docker-compose.yml ps"
fi

# ---------------------------------------------------------------------------- health
# Same probe as the image's HEALTHCHECK, run directly so there is no wait for Docker's own interval.
healthy() {
  docker compose exec -T server node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>r.json()).then(j=>process.exit(j.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1
}

log "waiting up to ${HEALTH_TIMEOUT}s for the server to report healthy"
start=$SECONDS
while true; do
  if healthy; then
    log "OK: the backend runs $(g rev-parse --short HEAD) and is healthy"
    exit 0
  fi
  if (( SECONDS - start >= HEALTH_TIMEOUT )); then break; fi
  sleep "$HEALTH_INTERVAL"
done

log "NOT healthy after ${HEALTH_TIMEOUT}s. Last 40 log lines of the server (secrets hidden):"
docker compose logs --no-color --tail 40 server 2>&1 | scrub || true
log "The version that ran before this update was $(g rev-parse --short "$before"). To go back to it (the working tree is clean, nothing local is lost): git -C $APP_DIR reset --hard $before && cd $DEPLOY_DIR && docker compose up -d --build. Then tell the developer what the log above shows."
exit 1
