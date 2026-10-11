#!/usr/bin/env bash
# The Linux CLI, with the same commands as docker-compose.ps1; the drives are already on this host's USB.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
config_file="$here/config.env"
example_file="$here/config.env.example"
compose=(docker compose --project-directory "$here" --env-file "$config_file")

step() { printf '\033[36m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m%s\033[0m\n' "$*"; }
fail() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

config_value() {
    local name=$1 default=${2:-} value
    value=$(grep -E "^\s*$name\s*=" "$config_file" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' | xargs || true)
    echo "${value:-$default}"
}

set_config_value() {
    local name=$1 value=$2
    sed -i "s|^\s*$name\s*=.*|$name=$value|" "$config_file"
}

assert_config() {
    [ -f "$config_file" ] || fail "No config.env - run './docker-compose.sh init-config' first."
    [ -n "$(config_value STORAGE_NODE)" ] || fail "config.env is missing STORAGE_NODE - run init-config."
}

init_config() {
    [ -f "$config_file" ] || cp "$example_file" "$config_file"
    if [ -n "$(config_value STORAGE_NODE)" ]; then ok "config.env already names this host; nothing changed."; return; fi
    set_config_value STORAGE_NODE "$(hostname -s | tr '[:upper:]' '[:lower:]')"
    ok "Wrote STORAGE_NODE=$(config_value STORAGE_NODE) to config.env."
}

# Bind propagation from the mounter needs a shared mount point on the host.
prepare_root() {
    local root; root=$(config_value STORAGE_ROOT /mnt/storage)
    sudo mkdir -p "$root"
    mountpoint -q "$root" || sudo mount --bind "$root" "$root"
    sudo mount --make-rshared "$root"
}

wait_for_mounter() {
    step "Mounting the array..."
    "${compose[@]}" up -d mounter
    for _ in $(seq 45); do
        [ "$(docker inspect -f '{{.State.Health.Status}}' storage-mounter 2>/dev/null)" = healthy ] && { ok "Array mounted and locked"; return; }
        [ "$(docker inspect -f '{{.State.Running}}' storage-mounter 2>/dev/null)" = false ] && break
        sleep 2
    done
    "${compose[@]}" logs --tail 20 mounter
    "${compose[@]}" stop mounter >/dev/null
    fail "The mounter did not get ready."
}

has_joined() {
    "${compose[@]}" exec -T mounter test -f "/mnt/storage/$(config_value ARRAY_PREFIX storage)-data1/.storage/tailscale/tailscaled.state"
}

connect_tailnet() {
    if [ -z "$(config_value TS_AUTHKEY)" ] && ! has_joined; then
        fail "TS_AUTHKEY is empty in config.env and this array has not joined the tailnet yet. Create a key at https://login.tailscale.com/admin/settings/keys"
    fi
    step "Joining the tailnet..."
    "${compose[@]}" up -d tailscale
    local tailnet_host=
    for _ in $(seq 45); do
        tailnet_host=$("${compose[@]}" exec -T tailscale tailscale --socket=/var/run/tailscale/tailscaled.sock status --json 2>/dev/null \
            | python3 -c 'import json,sys; s=json.load(sys.stdin); print(s["Self"]["DNSName"].rstrip(".") if s.get("BackendState")=="Running" else "")' 2>/dev/null || true)
        [ -n "$tailnet_host" ] && break
        sleep 2
    done
    [ -n "$tailnet_host" ] || fail "The node did not join within 90s; check './docker-compose.sh logs tailscale'."
    ok "Joined as $tailnet_host"
    [ "$(config_value STORAGE_HOST)" = "$tailnet_host" ] || { set_config_value STORAGE_HOST "$tailnet_host"; ok "Wrote STORAGE_HOST to config.env."; }
}

show_urls() { echo; echo "  Storage : https://$(config_value STORAGE_HOST)   (from any device on your tailnet)"; }

show_credentials() {
    local secrets host
    secrets="/mnt/storage/$(config_value ARRAY_PREFIX storage)-data1/.storage/secrets"
    host=$(config_value STORAGE_HOST)
    secret() { "${compose[@]}" exec -T mounter cat "$secrets/$1"; }
    echo "  Samba      : smb://$host/storage   user storage, password $(secret samba)"
    echo "  Syncthing  : https://$host:8384   user storage, password $(secret syncthing-gui)"
    echo "  Kopia      : https://$host:51515   web UI user storage, password $(secret kopia-server)"
    echo "               clients need their own account: ./docker-compose.sh kopia-user <user@host>"
    echo "  Kopia repository password (only for opening the repository without the server): $(secret kopia-repository)"
}

# Every build stamps a new image ID, so building after the array is up would recreate the mounter
# under the running stack; the images are built once, before anything starts.
start_array() {
    assert_config
    step "Building the images..."
    "${compose[@]}" build --quiet
    prepare_root
    wait_for_mounter
    connect_tailnet
    step "Starting the stack..."
    "${compose[@]}" up -d && show_urls
}

stop_array() { step "Stopping everything and unmounting..."; "${compose[@]}" down; }

usage() {
    cat <<'EOF'
Usage: ./docker-compose.sh [credentials|down|drives|init-config|kopia-user|logs|restart|scrub|snapraid|status|sync|up|url]
  init-config  Create config.env and name this host
  up           Mount and lock the array, join the tailnet, start the stack (default)
  down         Stop the stack, release the lock and unmount
  restart      down, then up
  status       Show the containers and their health
  logs         [service]  follow logs, e.g. logs mounter
  drives       List the block devices with their labels
  url          Print the tailnet URL
  sync         [--anyway]  run a SnapRAID sync now; --anyway accepts more deletions than SYNC_MAX_DELETED
  scrub        Run a SnapRAID scrub now (8 percent, blocks older than 10 days)
  snapraid     [args]  run snapraid with the array's config, e.g. snapraid status
  credentials  Print the Samba, Syncthing and Kopia logins, which live on the array
  kopia-user   <user@host>  add a Kopia client account (or reset its password) and print it
EOF
    exit 1
}

command=${1:-up}
[ $# -gt 0 ] && shift
case "$command" in
    init-config) init_config ;;
    up)          start_array ;;
    down)        stop_array ;;
    restart)     stop_array; start_array ;;
    status)      "${compose[@]}" ps -a ;;
    logs)        "${compose[@]}" logs -f "$@" ;;
    drives)      lsblk -o NAME,SIZE,FSTYPE,LABEL,MODEL,SERIAL,TRAN ;;
    url)         show_urls ;;
    credentials) show_credentials ;;
    kopia-user)  "${compose[@]}" exec -T kopia kopia.sh user "$@" ;;
    sync)        "${compose[@]}" exec -T snapraid snapraid.sh run sync "$@" ;;
    scrub)       "${compose[@]}" exec -T snapraid snapraid.sh run scrub ;;
    snapraid)    "${compose[@]}" exec -T snapraid snapraid.sh config >/dev/null
                 "${compose[@]}" exec -T snapraid snapraid -c /etc/snapraid.conf "$@" ;;
    *)           usage ;;
esac
