#!/usr/bin/env bash
# The Linux CLI, with the same commands as docker-compose.ps1; the drives are already on this host's USB.
if [ "${BASH_VERSINFO[0]}" -lt 4 ] || { [ "${BASH_VERSINFO[0]}" -eq 4 ] && [ "${BASH_VERSINFO[1]}" -lt 3 ]; }; then
    echo "docker-compose.sh needs bash 4.3 or newer; this is bash $BASH_VERSION" >&2
    exit 1
fi
set -euo pipefail
# shellcheck disable=SC2034 # read by the CLI parity check, not here
windows_only=(attach)

here=$(cd "$(dirname "$0")" && pwd)
config_file="$here/config.env"
example_file="$here/config.env.example"
compose=(docker compose --project-directory "$here" --env-file "$config_file")

# shellcheck source=gateway/tailnet-node.sh
. "$here/gateway/tailnet-node.sh"

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
    if grep -qE "^\s*$name\s*=" "$config_file"; then sed -i "s|^\s*$name\s*=.*|$name=$value|" "$config_file"
    else echo "$name=$value" >> "$config_file"
    fi
}

assert_config() {
    [ -f "$config_file" ] || fail "No config.env - run './docker-compose.sh init-config' first."
    [ -n "$(config_value STORAGE_NODE)" ] || fail "config.env is missing STORAGE_NODE - run init-config."
}

new_ntfy_topic() { echo "storage-$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"; }

init_config() {
    [ -f "$config_file" ] || cp "$example_file" "$config_file"
    if [ -n "$(config_value STORAGE_NODE)" ]; then ok "config.env already names this host."
    else
        set_config_value STORAGE_NODE "$(hostname -s | tr '[:upper:]' '[:lower:]')"
        ok "Wrote STORAGE_NODE=$(config_value STORAGE_NODE) to config.env."
    fi
    if [ -n "$(config_value NTFY_TOPIC)" ]; then ok "config.env already has a notification topic."
    else
        set_config_value NTFY_TOPIC "$(new_ntfy_topic)"
        ok "Wrote NTFY_TOPIC to config.env; subscribe to it in the ntfy app: $(config_value NTFY_URL https://ntfy.sh)/$(config_value NTFY_TOPIC)"
    fi
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

show_urls() {
    echo
    echo "  Storage : https://$(config_value STORAGE_HOST)   (from any device on your tailnet)"
    echo "  Locally : http://localhost:8442, Syncthing http://localhost:8443   (this host only)"
}

show_credentials() {
    local secrets host
    secrets="/mnt/storage/$(config_value ARRAY_PREFIX storage)-data1/.storage/secrets"
    host=$(config_value STORAGE_HOST)
    secret() { "${compose[@]}" exec -T mounter cat "$secrets/$1"; }
    echo "  Samba      : smb://$host/storage   user storage, password $(secret samba)"
    echo "  Syncthing  : http://localhost:8443 (this host only)   user storage, password $(secret syncthing-gui)"
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

# remove_array_tailnet_identity FOLDER NAME: removes the node the array's tailscaled.state in FOLDER
# identifies, then that state, through the mounter. Fails when the node may still be in the tailnet,
# which keeps the state so delete can run again.
remove_array_tailnet_identity() {
    local folder=$1 name=$2 node_id result=0
    if ! "${compose[@]}" exec -T mounter test -f "$folder/tailscaled.state"; then
        ok "No node identity on the array, so no node is removed from the tailnet."
        return 0
    fi
    node_id=$("${compose[@]}" exec -T mounter cat "$folder/tailscaled.state" | tailnet_node_id) || node_id=""
    if [ -z "$node_id" ]; then
        printf '\033[31m%s\033[0m\n' "The array's tailscaled.state names no node, so none is removed and the state is kept." \
            "  Remove $name on the Machines page, $tailnet_machines_page." >&2
        return 1
    fi
    remove_tailnet_node "$node_id" "$name" "$config_file" || result=$?
    if [ "$result" -eq 1 ]; then
        printf '\033[31m%s\033[0m\n' "The array's tailnet state is kept, so delete can run again." >&2
        return 1
    fi
    "${compose[@]}" exec -T mounter rm -rf "$folder" || { printf '\033[31m%s\033[0m\n' "Could not remove $folder from the array." >&2; return 1; }
    ok "Removed the tailnet state from the array; the next up joins the tailnet fresh."
}

# invoke_delete: how the stack is deleted: its node leaves the tailnet, its tailnet state goes from the
# array, then everything stops as in down, so a later up joins fresh. The node key lives on the array,
# which only the running mounter has mounted and down unmounts, so unlike the other stacks the node is
# removed before the down: tailscale stops first so the node is quiet. Once started, the down always runs.
invoke_delete() {
    local folder name removed=true
    [ "$(docker inspect -f '{{.State.Running}}' storage-mounter 2>/dev/null)" = true ] ||
        fail "The node identity is on the array, which is not mounted; run './docker-compose.sh up' first, then delete."
    folder="/mnt/storage/$(config_value ARRAY_PREFIX storage)-data1/.storage/tailscale"
    name=$(config_value STORAGE_HOST "$(config_value TS_HOSTNAME storage)")
    step "Stopping the tailnet node..."
    "${compose[@]}" stop tailscale || true
    remove_array_tailnet_identity "$folder" "$name" || removed=false
    stop_array
    $removed || exit 1
    ok "Deleted. The volumes stay in Docker; remove this folder to finish."
}

# Runs in a one-off SnapRAID container while the stack is down; on success ARRAY_PREFIX becomes the
# array's id, so the stack finds its state on <id>-data1.
migrate_labels() {
    local from output id
    assert_config
    [ -z "$("${compose[@]}" ps -q --status running)" ] || fail "The stack is running; run './docker-compose.sh down' first."
    from=$(config_value ARRAY_PREFIX storage)
    step "Building the SnapRAID image..."
    "${compose[@]}" build --quiet snapraid
    step "Migrating the labels of the array $from..."
    output=$(mktemp)
    "${compose[@]}" run --rm --no-deps -T --entrypoint /usr/local/bin/migrate-labels.sh snapraid --from "$from" "$@" | tee "$output"
    id=$(sed -n 's/^migrated //p' "$output")
    rm -f "$output"
    [ -n "$id" ] || return 0
    set_config_value ARRAY_PREFIX "$id"
    ok "Wrote ARRAY_PREFIX=$id to config.env; start the array with './docker-compose.sh up'."
}

# split_data_source SOURCE: sets data_url and data_ref from owner/repo[@ref] or a git URL[@ref]. The
# ref follows the last @ after a URL's user@, so git@host:owner/repo@ref keeps its user.
split_data_source() {
    local rest=$1 user=""
    if [[ $rest =~ ^([A-Za-z][A-Za-z0-9+.-]*://[^/@]+@)(.*)$ || $rest =~ ^([^/@:]+@)([^/:]+:.*)$ ]]; then
        user=${BASH_REMATCH[1]}
        rest=${BASH_REMATCH[2]}
    fi
    data_ref=main
    if [[ $rest == *@* ]]; then
        data_ref=${rest##*@}
        rest=${rest%@*}
    fi
    if [[ -z $data_ref || $data_ref == -* ]]; then
        printf '\033[31m%s\033[0m\n' "A data ref must not be empty or start with '-': '$data_ref'" >&2
        exit 1
    fi
    data_url=$user$rest
    [[ $data_url == *://* || -n $user ]] || data_url="https://github.com/$data_url.git"
}

data_command() {
    local subcommand url ref
    subcommand=$(printf '%s' "${1:-status}" | tr '[:upper:]' '[:lower:]')
    case "$subcommand" in
        status) git -C "$here" submodule status -- data ;;
        use)
            if [ -n "${2:-}" ]; then
                split_data_source "$2"
                url=$data_url
                ref=$data_ref
            else
                url=$(git -C "$here" config -f .gitmodules submodule.data.url)
                ref=main
            fi
            step "Pointing data at $url @ $ref"
            [ -e "$here/data/.git" ] || git -C "$here" submodule update --init -- data > /dev/null 2>&1 || true
            git -C "$here" config submodule.data.url "$url"
            git -C "$here/data" remote set-url origin "$url"
            git -C "$here/data" fetch -q origin "$ref"
            git -C "$here/data" checkout -q FETCH_HEAD
            ok "data now at $(git -C "$here/data" rev-parse --short HEAD)" ;;
        *) usage ;;
    esac
}

usage() {
    cat <<'EOF'
Usage: ./docker-compose.sh [accept-smart|credentials|data|delete|down|drives|init-config|kopia-user|logs|migrate-labels|restart|scrub|snapraid|status|sync|up|url]
  init-config  Create config.env, name this host and generate the notification topic
  up           Mount and lock the array, join the tailnet, start the stack (default)
  down         Stop the stack, release the lock and unmount
  delete       With the array mounted: remove the stack's node from the tailnet (with TS_API_TOKEN) and its tailnet state from the array, then down; for a stack being removed
  restart      down, then up
  status       Show the containers and their health
  logs         [service]  follow logs, e.g. logs mounter
  drives       List the block devices with their labels
  url          Print the tailnet URL
  data         status | use [owner/repo[@ref]]  point data/ at a data repo (none = template)
  sync         [--anyway]  run a SnapRAID sync now; --anyway accepts more deletions than SYNC_MAX_DELETED
  scrub        Run a SnapRAID scrub now (SCRUB_PERCENT of the array, blocks older than SCRUB_OLDER_THAN_DAYS)
  snapraid     [args]  run snapraid with the array's config, e.g. snapraid status
  credentials  Print the Samba, Syncthing and Kopia logins, which live on the array
  kopia-user   <user@host>  add a Kopia client account (or reset its password) and print it
  accept-smart <role>  take a drive's current SMART counts as its baseline, e.g. accept-smart data2
  migrate-labels [--id <4 hex>] [--name <name>] [--dry-run]  with the stack down, move the array from the
               storage-* labels to <id>-*, keeping its parity; ARRAY_PREFIX becomes the id
EOF
    exit 1
}

command=${1:-up}
[ $# -gt 0 ] && shift
case "$command" in
    init-config) init_config ;;
    up)          start_array ;;
    down)        stop_array ;;
    delete)      assert_config; invoke_delete ;;
    restart)     stop_array; start_array ;;
    status)      "${compose[@]}" ps -a ;;
    logs)        "${compose[@]}" logs -f "$@" ;;
    drives)      lsblk -o NAME,SIZE,FSTYPE,LABEL,MODEL,SERIAL,TRAN ;;
    url)         show_urls ;;
    data)        data_command "$@" ;;
    credentials) show_credentials ;;
    kopia-user)  "${compose[@]}" exec -T kopia kopia.sh user "$@" ;;
    accept-smart) "${compose[@]}" exec -T mounter mounter.sh accept-smart "$@" ;;
    migrate-labels) migrate_labels "$@" ;;
    sync)        "${compose[@]}" exec -T snapraid snapraid.sh run sync "$@" ;;
    scrub)       "${compose[@]}" exec -T snapraid snapraid.sh run scrub ;;
    snapraid)    "${compose[@]}" exec -T snapraid snapraid.sh config >/dev/null
                 "${compose[@]}" exec -T snapraid snapraid -c /etc/snapraid.conf "$@" ;;
    *)           usage ;;
esac
