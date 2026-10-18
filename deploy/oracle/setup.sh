#!/usr/bin/env bash
# CryptoAlgo backend on an Oracle Cloud (or any Ubuntu) VM. Idempotent: safe to run again.
#   needs in the environment: ADMIN_PASSWORD, PROXY_SHARED_SECRET   (everything else is generated once and kept)
#   optional: API_HOST (your own domain), PUBLIC_IP_OVERRIDE, APP_DIR, DRY_RUN=1 (checks + .env only, installs nothing)
# Secrets are written to deploy/oracle/.env (chmod 600) and are never printed.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/cryptoalgo}"
DEPLOY_DIR="$APP_DIR/deploy/oracle"
ENV_FILE="$DEPLOY_DIR/.env"
STATUS_FILE="$APP_DIR/STATUS.txt"
DRY_RUN="${DRY_RUN:-0}"

log() { printf '[cryptoalgo-setup] %s\n' "$*"; }
die() { printf '[cryptoalgo-setup] ERROR: %s\n' "$*" >&2; exit 1; }

check_secret() { # name value min_len
  local name="$1" value="${2:-}" min="$3"
  [[ -n "$value" ]] || die "$name is empty"
  [[ "$value" != *CHANGE_ME* ]] || die "$name still contains CHANGE_ME: edit the first lines of the cloud-init script and recreate the instance"
  (( ${#value} >= min )) || die "$name must be at least $min characters (it has ${#value})"
  [[ "$value" =~ ^[A-Za-z0-9._@%+=:,-]+$ ]] || die "$name may only contain letters, digits and . _ @ % + = : , -  (no spaces, quotes, # or \$)"
}

check_secret ADMIN_PASSWORD "${ADMIN_PASSWORD:-}" 12
check_secret PROXY_SHARED_SECRET "${PROXY_SHARED_SECRET:-}" 32
[[ -d "$DEPLOY_DIR" ]] || die "$DEPLOY_DIR not found (clone the repository to $APP_DIR first)"

# ---------------------------------------------------------------------------- system preparation
if [[ "$DRY_RUN" != "1" ]]; then
  [[ "$(id -u)" == "0" ]] || die "run as root (sudo bash $0)"

  # The image build needs more memory than a 1 GB free-tier VM has: add swap.
  mem_kb="$(awk '/MemTotal/ {print $2}' /proc/meminfo)"
  if (( mem_kb < 3000000 )) && [[ -z "$(swapon --show --noheadings)" ]]; then
    log "adding 2 GB swap (RAM is $((mem_kb / 1024)) MB)"
    fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
    chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  fi

  if ! command -v docker >/dev/null 2>&1; then
    log "installing Docker"
    curl -fsSL https://get.docker.com | sh
  fi
  systemctl enable --now docker
  docker compose version >/dev/null 2>&1 || apt-get install -y docker-compose-plugin

  # Oracle's Ubuntu images ship restrictive iptables rules: allow web traffic in (harmless if already open).
  for p in 80 443; do
    iptables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport "$p" -j ACCEPT || true
  done
  if command -v netfilter-persistent >/dev/null 2>&1; then netfilter-persistent save >/dev/null 2>&1 || true; fi
fi

# ---------------------------------------------------------------------------- .env (secrets generated ONCE and kept)
umask 077
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"

get_kv() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true; }
set_kv() { # key value  (replace or append)
  local tmp
  tmp="$(mktemp)"
  grep -vE "^$1=" "$ENV_FILE" > "$tmp" 2>/dev/null || true
  printf '%s=%s\n' "$1" "$2" >> "$tmp"
  cat "$tmp" > "$ENV_FILE"
  rm -f "$tmp"
}
init_kv() { [[ -n "$(get_kv "$1")" ]] || set_kv "$1" "$2"; } # only when missing: these must never change after first boot

init_kv POSTGRES_PASSWORD "$(openssl rand -hex 24)"
init_kv SESSION_SECRET "$(openssl rand -hex 32)"
init_kv CREDENTIAL_ENCRYPTION_KEY "$(openssl rand -base64 32)"
set_kv ADMIN_USERNAME admin
set_kv ADMIN_PASSWORD "$ADMIN_PASSWORD"
set_kv PROXY_SHARED_SECRET "$PROXY_SHARED_SECRET"
set_kv NODE_ENV production
set_kv DELTA_ENV production
set_kv MARKET_DATA_SOURCE delta
set_kv SYMBOL ETHUSD
set_kv BOT_AUTOSTART true
set_kv WORKER_ENABLED true
set_kv LIVE_HARD_DISABLE false # Live still needs credentials AND the dashboard activation workflow

# ---------------------------------------------------------------------------- public host name (HTTPS needs a name)
detect_ip() {
  local ip url
  for url in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do
    ip="$(curl -4 -fsS --max-time 8 "$url" 2>/dev/null | tr -d '[:space:]' || true)"
    if [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then echo "$ip"; return 0; fi
  done
  return 1
}
if [[ -n "${API_HOST:-}" ]]; then
  HOST_NAME="$API_HOST"
else
  PUBLIC_IP="${PUBLIC_IP_OVERRIDE:-$(detect_ip)}" || die "could not detect the public IP (set PUBLIC_IP_OVERRIDE or API_HOST)"
  HOST_NAME="${PUBLIC_IP//./-}.sslip.io"
fi
[[ "$HOST_NAME" =~ ^[A-Za-z0-9.-]+$ ]] || die "invalid host name: $HOST_NAME"
set_kv API_HOST "$HOST_NAME"
log "backend will be served at https://$HOST_NAME"

cat > "$STATUS_FILE" <<STATUS
CryptoAlgo backend
BACKEND_URL (for Vercel): https://$HOST_NAME
Health check:             https://$HOST_NAME/api/health
Login user:               admin  (password = the ADMIN_PASSWORD you put in the cloud-init script)
PROXY_SHARED_SECRET:      the same value you put in the cloud-init script (must also be set on Vercel)
Logs:                     /var/log/cryptoalgo-setup.log  and  docker compose -f $DEPLOY_DIR/docker-compose.yml logs
STATUS
chmod 644 "$STATUS_FILE"

if [[ "$DRY_RUN" == "1" ]]; then
  log "DRY_RUN: checks passed and $ENV_FILE written; nothing installed or started"
  exit 0
fi

# ---------------------------------------------------------------------------- start
cd "$DEPLOY_DIR"
log "building and starting (first build takes several minutes)"
docker compose up -d --build

log "waiting for https://$HOST_NAME/api/health (certificate issuance can take a minute)"
for _ in $(seq 1 60); do
  if curl -fsS --max-time 8 "https://$HOST_NAME/api/health" -o /dev/null 2>/dev/null; then
    log "UP: set BACKEND_URL=https://$HOST_NAME on Vercel (and the same PROXY_SHARED_SECRET), then redeploy"
    exit 0
  fi
  sleep 10
done
log "NOT healthy after 10 minutes. Check: docker compose -f $DEPLOY_DIR/docker-compose.yml ps / logs; ports 80 and 443 must be open in the Oracle subnet security list"
exit 1
