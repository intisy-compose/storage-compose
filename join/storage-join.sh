#!/usr/bin/env bash
# Joins this Linux device to the storage network (specs/2026-10-20-connect-devices-design.md, the join
# script): installs Tailscale and Syncthing if missing and joins the tailnet, writes the node file for
# the data root and runs Syncthing with its home on the node, registers with the storage dashboard,
# applies the answer to Syncthing and links the home folders. Run as root (an imprint firstboot hook);
# a second run changes nothing and exits 0.
#
# Settings, all optional:
#   STORAGE_JOIN_KEY        Tailscale auth key; else $IMPRINT_PERSONAL/tailscale.key
#   STORAGE_DASHBOARD       the dashboard's join API, default https://storage.<tailnet>:8447
#   STORAGE_JOIN_ROOT       the data root that becomes this device's node, default /data
#   STORAGE_JOIN_NAME       the node and device name, default the name of the device list's entry
#                           with this device's Syncthing ID, else the host name
#   STORAGE_JOIN_LAYOUT     that device list, default data/drive-sync.toml beside join/
#   STORAGE_JOIN_KIND       drive or folder, default drive
#   STORAGE_JOIN_THRESHOLD  the layered sync threshold written into a new node file, default 50
#   STORAGE_JOIN_ALLOW_KEEP_ALL  1 lets a device node keep everything (threshold 0)
#   STORAGE_JOIN_USER       whose home gets the folder links, default the data root's owner
#   STORAGE_JOIN_OFFLINE_REPO  a pacman repository directory (the stick's `offline`) tried first
#
# Run from a terminal with none of these set, it asks for the node, the threshold and whether to join,
# as imprint's review screen does. A folder node is also listed in its volume's .storage/nodes.toml.
set -euo pipefail

readonly HOME_LINKS="Documents:Documents Pictures:Pictures Music:Music Videos:Videos Downloads:Downloads Desktop:Desktop Templates:Templates Public:Public Documents/GitHub:code"
readonly UNIT_NAME="storage-syncthing.service"

readonly ESSENTIAL_THRESHOLD=80 WORKING_THRESHOLD=50
# The dashboard's tailnet-only join port, where tailscale names the caller (PORTS.md).
readonly JOIN_PORT=8447

join_kind="${STORAGE_JOIN_KIND:-drive}"
join_threshold="${STORAGE_JOIN_THRESHOLD:-50}"
allow_keep_all="${STORAGE_JOIN_ALLOW_KEEP_ALL:-}"
unit_dir="${STORAGE_JOIN_UNIT_DIR:-/etc/systemd/system}"
gui_port="${STORAGE_JOIN_GUI_PORT:-8384}"
listen_port="${STORAGE_JOIN_LISTEN_PORT:-22000}"
changes=0
answer=""

use_root() {
    join_root="$1"
    syncthing_home="$join_root/.storage/syncthing"
    node_file="$join_root/.storage/node.toml"
}
use_root "${STORAGE_JOIN_ROOT:-/data}"

log() { printf 'storage-join: %s\n' "$*"; }
changed() { changes=$((changes + 1)); log "$*"; }
fail() { printf 'storage-join: %s\n' "$*" >&2; exit 1; }

layout_path() { printf '%s' "${STORAGE_JOIN_LAYOUT:-$(dirname "${BASH_SOURCE[0]}")/../data/drive-sync.toml}"; }

# The [devices.<name>] table whose id is the given Syncthing ID; only those tables' id lines count.
layout_device_name() {
    local layout
    layout="$(layout_path)"
    [[ -n "$1" && -f "$layout" ]] || return 0
    awk -v wanted="$1" '
        /^[[:space:]]*\[/ { section = ""; if (match($0, /^[[:space:]]*\[devices\.[A-Za-z0-9_-]+\][[:space:]]*$/)) { section = $0; sub(/^[[:space:]]*\[devices\./, "", section); sub(/\].*$/, "", section) }; next }
        section != "" && $0 ~ /^[[:space:]]*id[[:space:]]*=/ { value = $0; sub(/^[^"]*"/, "", value); sub(/".*$/, "", value); if (value == wanted) { print section; exit } }
    ' "$layout"
}

# The computer's name, never the user's: a device list entry names the machine.
device_name() {
    local name="${STORAGE_JOIN_NAME:-}"
    [[ -n "$name" ]] || name="$(layout_device_name "${1:-}")"
    [[ -n "$name" ]] || name="$(hostname)"
    name="$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-' | sed 's/^-*//; s/-*$//')"
    [[ -n "$name" ]] || fail "no usable device name; set STORAGE_JOIN_NAME"
    printf '%s' "$name"
}


package_for() {
    case "$1" in
        tailscale) echo tailscale ;;
        syncthing) echo syncthing ;;
        curl) echo curl ;;
        jq) echo jq ;;
    esac
}

missing_packages() {
    local command
    for command in tailscale syncthing curl jq; do
        command -v "$command" > /dev/null 2>&1 || package_for "$command"
    done
}

# The stick's repository goes first, so an install works without internet; pacman falls back to the
# mirrors for anything it lacks.
install_with_pacman() {
    local config=/etc/pacman.conf
    if [[ -n "${STORAGE_JOIN_OFFLINE_REPO:-}" && -d "$STORAGE_JOIN_OFFLINE_REPO" ]]; then
        config="$(mktemp)"
        { printf '[offline]\nSigLevel = Optional TrustAll\nServer = file://%s\n\n' "$STORAGE_JOIN_OFFLINE_REPO"; cat /etc/pacman.conf; } > "$config"
    fi
    pacman --config "$config" -Sy --needed --noconfirm "$@"
    [[ "$config" == /etc/pacman.conf ]] || rm -f "$config"
}

install_packages() {
    local packages
    mapfile -t packages < <(missing_packages)
    [[ ${#packages[@]} -gt 0 ]] || return 0
    if command -v pacman > /dev/null 2>&1; then install_with_pacman "${packages[@]}"
    elif command -v apt-get > /dev/null 2>&1; then apt-get update -q && apt-get install -y -q "${packages[@]}"
    elif command -v dnf > /dev/null 2>&1; then dnf install -y "${packages[@]}"
    else fail "cannot install ${packages[*]}: no pacman, apt-get or dnf"; fi
    changed "installed ${packages[*]}"
}

tailnet_state() { tailscale status --json 2> /dev/null | jq -r '.BackendState // "NoState"' 2> /dev/null || echo NoState; }

auth_key() {
    if [[ -n "${STORAGE_JOIN_KEY:-}" ]]; then printf '%s' "$STORAGE_JOIN_KEY"; return; fi
    local key_file="${IMPRINT_PERSONAL:-}/tailscale.key"
    if [[ -n "${IMPRINT_PERSONAL:-}" && -s "$key_file" ]]; then tr -d '[:space:]' < "$key_file"; return; fi
    fail "not on the tailnet yet and no auth key: set STORAGE_JOIN_KEY or put personal/tailscale.key on the stick"
}

join_tailnet() {
    if ! systemctl is-active --quiet tailscaled; then
        systemctl enable --now tailscaled
        changed "started tailscaled"
    fi
    [[ "$(tailnet_state)" == "Running" ]] && return 0
    local key
    key="$(auth_key)"
    tailscale up --auth-key="$key" --hostname="$(device_name)"
    [[ "$(tailnet_state)" == "Running" ]] || fail "tailscale up did not join the tailnet"
    changed "joined the tailnet as $(device_name)"
}


new_node_id() { od -An -N2 -tx1 /dev/urandom | tr -d ' \n'; }

local_device_id() { as_owner syncthing device-id --home="$syncthing_home" 2> /dev/null | grep -E '^[A-Z0-9]{7}(-[A-Z0-9]{7}){7}$' | head -n 1; }

# The keys exist before the node file, so the file is named after the device list's entry for this ID.
generate_keys() {
    [[ -f "$syncthing_home/config.xml" ]] && return 0
    [[ -d "$join_root" ]] || fail "the data root $join_root does not exist"
    as_owner syncthing generate --home="$syncthing_home" --no-port-probing > /dev/null
    changed "generated Syncthing's keys in $syncthing_home"
}

write_node_file() {
    [[ -f "$node_file" ]] && return 0
    [[ -d "$join_root" ]] || fail "the data root $join_root does not exist"
    as_owner mkdir -p "$(dirname "$node_file")"
    printf '[node]\nid        = "%s"\nname      = "%s"\nkind      = "%s"\nthreshold = %s\nassigned  = []\n' \
        "$(new_node_id)" "$(device_name "$(local_device_id)")" "$join_kind" "$join_threshold" > "$node_file.partial"
    chown "$(node_owner):" "$node_file.partial"
    mv "$node_file.partial" "$node_file"
    changed "wrote $node_file"
}

node_owner() { stat -c %U "$join_root"; }

as_owner() {
    local owner
    owner="$(node_owner)"
    if [[ "$owner" == "$(id -un)" ]]; then "$@"; else runuser -u "$owner" -- "$@"; fi
}

unit_text() {
    cat << EOF
[Unit]
Description=Syncthing for the storage node at $join_root
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
User=$(node_owner)
Environment=STNOUPGRADE=1
ExecStart=$(command -v syncthing) serve --home=$syncthing_home --no-browser --gui-address=127.0.0.1:$gui_port
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
}

install_unit() {
    local unit="$unit_dir/$UNIT_NAME"
    if [[ ! -f "$unit" ]] || [[ "$(cat "$unit")" != "$(unit_text)" ]]; then
        mkdir -p "$unit_dir"
        unit_text > "$unit"
        systemctl daemon-reload
        changed "wrote $unit"
        systemctl enable "$UNIT_NAME" > /dev/null 2>&1 || true
        systemctl restart "$UNIT_NAME"
        return 0
    fi
    if ! systemctl is-active --quiet "$UNIT_NAME"; then
        systemctl enable --now "$UNIT_NAME"
        changed "started $UNIT_NAME"
    fi
}

start_syncthing() {
    generate_keys
    install_unit
}


api_key() { sed -n 's:.*<apikey>\(.*\)</apikey>.*:\1:p' "$syncthing_home/config.xml" | head -n 1; }

api() {
    local method="$1" path="$2"
    shift 2
    curl -fsS -X "$method" -H "X-API-Key: $(api_key)" -H "Content-Type: application/json" "$@" "http://127.0.0.1:$gui_port$path"
}

api_status() {
    local method="$1" path="$2"
    curl -sS -o /dev/null -w '%{http_code}' -X "$method" -H "X-API-Key: $(api_key)" "http://127.0.0.1:$gui_port$path"
}

wait_for_syncthing() {
    for _ in $(seq 1 60); do
        api GET /rest/system/status > /dev/null 2>&1 && return 0
        sleep 1
    done
    fail "Syncthing did not answer on 127.0.0.1:$gui_port within 60 s"
}

tailnet_address() { tailscale ip -4 | head -n 1; }

# Peers reach a node only over the tailnet, by the address the dashboard hands out (the port table's
# kind `protocol`), so discovery, relays and NAT traversal stay off.
configure_options() {
    local wanted current
    wanted="$(jq -n --arg listen "tcp://$(tailnet_address):$listen_port" '{
        listenAddresses: [$listen], globalAnnounceEnabled: false, localAnnounceEnabled: false,
        relaysEnabled: false, natEnabled: false, urAccepted: -1, autoUpgradeIntervalH: 0, crashReportingEnabled: false }')"
    current="$(api GET /rest/config/options | jq --argjson wanted "$wanted" 'with_entries(select(.key as $key | $wanted | has($key)))')"
    if [[ "$(jq -S . <<< "$current")" != "$(jq -S . <<< "$wanted")" ]]; then
        api PATCH /rest/config/options -d "$wanted" > /dev/null
        changed "set Syncthing to the tailnet only"
    fi
    if [[ "$(api GET /rest/config/restart-required | jq -r .requiresRestart)" == "true" ]]; then
        systemctl restart "$UNIT_NAME"
        wait_for_syncthing
    fi
}


dashboard_url() {
    if [[ -n "${STORAGE_DASHBOARD:-}" ]]; then printf '%s' "${STORAGE_DASHBOARD%/}"; return; fi
    local suffix
    suffix="$(tailscale status --json | jq -r '.MagicDNSSuffix // empty')"
    [[ -n "$suffix" ]] || fail "cannot tell the tailnet's name; set STORAGE_DASHBOARD"
    printf 'https://storage.%s:%s' "$suffix" "$JOIN_PORT"
}

join_request() {
    jq -n --arg name "$(device_name "$1")" --arg id "$1" --arg kind "$join_kind" --arg path "$join_root" \
        --argjson threshold "$(node_file_threshold)" \
        '{name: $name, os: "linux", syncthingDeviceId: $id, nodes: [{kind: $kind, path: $path, threshold: $threshold}]}'
}

call_dashboard() {
    local body answer status
    body="$(join_request "$1")"
    answer="$(mktemp)"
    status="$(curl -sS -o "$answer" -w '%{http_code}' -X POST -H "Content-Type: application/json" -d "$body" "$(dashboard_url)/api/join")" \
        || fail "the dashboard at $(dashboard_url) did not answer"
    case "$status" in
        200) cat "$answer"; rm -f "$answer" ;;
        403) local reason; reason="$(jq -r '.error // empty' "$answer" 2> /dev/null || head -c 300 "$answer")"; rm -f "$answer"; fail "the dashboard refused this device (403): $reason" ;;
        409) rm -f "$answer"; fail "the dashboard knows $(device_name "$1") with another Syncthing ID (409): re-admit the reinstalled device from the dashboard" ;;
        *) local detail; detail="$(head -c 300 "$answer")"; rm -f "$answer"; fail "the dashboard answered $status: $detail" ;;
    esac
}

apply_device() {
    local device="$1" id current wanted
    id="$(jq -r .syncthingDeviceId <<< "$device")"
    wanted="$(jq '{deviceID: .syncthingDeviceId, name: .name, addresses: (.addresses // ["dynamic"])}' <<< "$device")"
    if [[ "$(api_status GET "/rest/config/devices/$id")" == "200" ]]; then
        current="$(api GET "/rest/config/devices/$id")"
        [[ "$(jq -c '{deviceID, name, addresses}' <<< "$current")" == "$(jq -c . <<< "$wanted")" ]] && return 0
        wanted="$(jq --argjson wanted "$wanted" '. + $wanted' <<< "$current")"
    fi
    api PUT "/rest/config/devices/$id" -d "$wanted" > /dev/null
    changed "device $(jq -r .name <<< "$device") ($id) set"
}

folder_path() {
    local path="$1"
    if [[ "$path" == /* ]]; then printf '%s' "$path"; else printf '%s/%s' "$join_root" "$path"; fi
}

apply_folder() {
    local folder="$1" device_ids="$2" id path current wanted
    id="$(jq -r .id <<< "$folder")"
    path="$(folder_path "$(jq -r .path <<< "$folder")")"
    if [[ "$(api_status GET "/rest/config/folders/$id")" == "200" ]]; then
        current="$(api GET "/rest/config/folders/$id")"
        if [[ "$(jq -r .path <<< "$current")" != "$path" ]]; then
            log "folder $id NOT CHANGED: Syncthing has it at $(jq -r .path <<< "$current"), the dashboard says $path"
            return 0
        fi
        wanted="$(jq --argjson ids "$device_ids" '.devices = ((.devices | map(.deviceID)) + $ids | unique | map({deviceID: .}))' <<< "$current")"
        [[ "$(jq -S '.devices | map(.deviceID) | sort' <<< "$current")" == "$(jq -S '.devices | map(.deviceID) | sort' <<< "$wanted")" ]] && return 0
    else
        as_owner mkdir -p "$path"
        wanted="$(api GET /rest/config/defaults/folder | jq --arg id "$id" --arg path "$path" --arg type "$(jq -r '.type // "sendreceive"' <<< "$folder")" \
            --argjson ids "$device_ids" '.id = $id | .label = $id | .path = $path | .type = $type | .devices = ((.devices | map(.deviceID)) + $ids | unique | map({deviceID: .}))')"
    fi
    api PUT "/rest/config/folders/$id" -d "$wanted" > /dev/null
    changed "folder $id at $path shared with $(jq -r 'length' <<< "$device_ids") device(s)"
}

apply_answer() {
    local answer="$1" device folder device_ids
    while IFS= read -r device; do apply_device "$device"; done < <(jq -c '.devices[]?' <<< "$answer")
    device_ids="$(jq -c '[.devices[]?.syncthingDeviceId]' <<< "$answer")"
    while IFS= read -r folder; do apply_folder "$folder" "$device_ids"; done < <(jq -c '.folders[]?' <<< "$answer")
}


link_user() {
    if [[ -n "${STORAGE_JOIN_USER:-}" ]]; then printf '%s' "$STORAGE_JOIN_USER"; return; fi
    local owner
    owner="$(node_owner)"
    if [[ "$owner" != root ]]; then printf '%s' "$owner"; return; fi
    printf '%s' "${SUDO_USER:-}"
}

# A real folder in the way is merged into the target first; a name both hold stops the link, as
# drive-sync does, so nothing is ever overwritten.
# shellcheck disable=SC2088 # "~/name" here is log text, never a path
link_home() {
    local target="$1" link="$2" entry
    if [[ -L "$link" ]]; then
        [[ "$(readlink -f "$link")" == "$(readlink -f "$target")" ]] || log "~/$(basename "$link"): NOT LINKED, it points to $(readlink "$link")"
        return 0
    fi
    if [[ -e "$link" && ! -d "$link" ]]; then log "~/$(basename "$link"): NOT LINKED, it is a file"; return 0; fi
    if [[ -d "$link" ]]; then
        for entry in "$link"/* "$link"/.[!.]* "$link"/..?*; do
            [[ -e "$entry" || -L "$entry" ]] || continue
            if [[ -e "$target/$(basename "$entry")" || -L "$target/$(basename "$entry")" ]]; then
                log "~/$(basename "$link"): NOT LINKED, $link and $target both hold $(basename "$entry")"
                return 0
            fi
        done
        as_owner mkdir -p "$target"
        for entry in "$link"/* "$link"/.[!.]* "$link"/..?*; do
            [[ -e "$entry" || -L "$entry" ]] && mv "$entry" "$target/"
        done
        rmdir "$link"
    fi
    as_owner mkdir -p "$target"
    ln -s "$target" "$link"
    chown -h "$(stat -c %U:%G "$(dirname "$link")")" "$link"
    changed "~/$(basename "$link") linked to $target"
}

link_homes() {
    local answer="$1" user home pair relative name path
    user="$(link_user)"
    if [[ -z "$user" ]]; then log "no user to link home folders for; set STORAGE_JOIN_USER"; return 0; fi
    home="$(getent passwd "$user" | cut -d: -f6)"
    [[ -d "$home" ]] || { log "home of $user not found; no links"; return 0; }
    for pair in $HOME_LINKS; do
        relative="${pair%%:*}"
        name="${pair#*:}"
        path="$(jq -r --arg relative "$relative" '.folders[]? | select(.path == $relative) | .path' <<< "$answer" | head -n 1)"
        [[ -n "$path" ]] && link_home "$(folder_path "$path")" "$home/$name"
    done
    return 0
}

node_file_threshold() { sed -n 's/^threshold *= *\([0-9]*\).*/\1/p' "$node_file" | head -n 1; }

# Threshold 0 keeps everything the network holds, backups and archives included, which only the
# cluster is meant to; a device node keeps the working and essential bands (50).
check_threshold() {
    local threshold="$join_threshold"
    [[ -f "$node_file" ]] && threshold="$(node_file_threshold)"
    [[ "$threshold" =~ ^[0-9]+$ ]] || fail "the threshold must be a whole number, not '$threshold'"
    [[ "$threshold" -ne 0 || "$join_kind" == array || "$allow_keep_all" == 1 ]] && return 0
    fail "threshold 0 keeps everything the network holds, backups and archives included, which only the cluster should; use 50 (working and essential), or set STORAGE_JOIN_ALLOW_KEEP_ALL=1"
}


volume_root_of() {
    local path
    path="$(realpath -m "$1")"
    if command -v findmnt > /dev/null 2>&1; then findmnt -n -o TARGET -T "$path"; else df --output=target "$path" | tail -n 1; fi
}

is_volume_root() { [[ "$(volume_root_of "$1")" == "$(realpath -m "$1")" ]]; }

relative_to_volume() {
    local root volume
    root="$(realpath -m "$1")"
    volume="$(volume_root_of "$root")"
    printf '%s' "${root#"${volume%/}"/}"
}

index_file_of() { printf '%s/.storage/nodes.toml' "${1%/}"; }

index_paths() {
    local index
    index="$(index_file_of "$1")"
    [[ -f "$index" ]] || return 0
    tr '\n' ' ' < "$index" | sed -n 's/.*paths *= *\[\([^]]*\)\].*/\1/p' | grep -o '"[^"]*"' | tr -d '"' || true
}

is_nested() { [[ "$1" == "$2"/* || "$2" == "$1"/* ]]; }

# The host agent's rule: a node is never nested in another, or its files would be synced twice.
node_placement_problem() {
    local kind="$1" root volume relative listed
    root="$(realpath -m "$2")"
    [[ -d "$root" ]] || return 0
    volume="$(volume_root_of "$root")"
    if [[ "$kind" != folder ]]; then
        [[ -z "$(index_paths "$root")" ]] || echo "$(index_file_of "$root") lists folder nodes, and a node is never nested in another, so $root cannot be a drive node"
        return 0
    fi
    if [[ "$root" == "$volume" ]]; then echo "$root is a drive root; a folder node is a folder below one"; return 0; fi
    if [[ -f "${volume%/}/.storage/node.toml" ]]; then echo "the volume at $volume is a drive node, and a node is never nested in another"; return 0; fi
    relative="$(relative_to_volume "$root")"
    while IFS= read -r listed; do
        [[ -n "$listed" && "$listed" != "$relative" ]] || continue
        if is_nested "$relative" "$listed"; then echo "$root and ${volume%/}/$listed are nested; a folder node cannot hold another"; return 0; fi
    done < <(index_paths "$volume")
}

check_node_placement() {
    local problem
    problem="$(node_placement_problem "$join_kind" "$join_root")"
    [[ -z "$problem" ]] || fail "$problem"
}

# A folder node is found only through its volume's index, never by searching, so it is listed there.
register_folder_node() {
    [[ "$join_kind" == folder ]] || return 0
    local volume relative index listed paths=()
    volume="$(volume_root_of "$join_root")"
    relative="$(relative_to_volume "$join_root")"
    index="$(index_file_of "$volume")"
    mapfile -t paths < <(index_paths "$volume")
    for listed in "${paths[@]}"; do [[ "$listed" == "$relative" ]] && return 0; done
    paths+=("$relative")
    mkdir -p "$(dirname "$index")"
    printf 'paths = [%s]\n' "$(printf '"%s", ' "${paths[@]}" | sed 's/, $//')" > "$index.partial"
    mv "$index.partial" "$index"
    changed "listed $relative in $index"
}


ask() {
    local question="$1" default="$2"
    if [[ -n "$default" ]]; then printf '%s [%s]: ' "$question" "$default" >&2; else printf '%s: ' "$question" >&2; fi
    IFS= read -r answer || fail "no answer to: $question"
    answer="${answer:-$default}"
}

confirm() {
    local question="$1" default="$2" hint="y/N"
    [[ "$default" == yes ]] && hint="Y/n"
    while true; do
        printf '%s [%s]: ' "$question" "$hint" >&2
        IFS= read -r answer || fail "no answer to: $question"
        case "${answer:-$default}" in
            y | Y | yes | Yes | YES) return 0 ;;
            n | N | no | No | NO) return 1 ;;
            *) log "yes or no, please" ;;
        esac
    done
}

threshold_bands() {
    if [[ "$1" -le 0 ]]; then echo "keeps EVERYTHING, backups included"
    elif [[ "$1" -ge "$ESSENTIAL_THRESHOLD" ]]; then echo "keeps essential"
    elif [[ "$1" -ge "$WORKING_THRESHOLD" ]]; then echo "keeps essential and working"
    else echo "keeps essential, working and archive"; fi
}

root_choice_problem() {
    local kind="$1" path="$2"
    if [[ "$path" != /?* ]]; then echo "an absolute path below /, please"
    elif [[ "$path" == *'"'* ]]; then echo "the path '$path' holds a quote"
    elif [[ ! -d "$path" ]]; then echo "$path does not exist"
    elif [[ "$kind" == drive ]] && ! is_volume_root "$path"; then echo "$path is not a drive root (its volume is at $(volume_root_of "$path")); choose it as a folder"
    else node_placement_problem "$kind" "$path"; fi
}

choose_root() {
    local kind="$1" question="$2" default="$3" problem
    while true; do
        ask "$question" "$default"
        [[ "$answer" == / ]] || answer="${answer%/}"
        problem="$(root_choice_problem "$kind" "$answer")"
        if [[ -z "$problem" ]]; then join_kind="$kind"; use_root "$answer"; return 0; fi
        log "$problem"
    done
}

choose_node() {
    local default=3
    [[ -d "$join_root" ]] && is_volume_root "$join_root" && default=1
    log "the drive or folder this device keeps in the storage network:"
    printf '  1) a drive root\n  2) a folder\n  3) none: this device does not join the storage network\n' >&2
    while true; do
        ask "choose 1, 2 or 3" "$default"
        case "$answer" in
            1) choose_root drive "the drive root that becomes the storage node (a mount point)" "$([[ "$default" == 1 ]] && echo "$join_root")"; return 0 ;;
            2) choose_root folder "the folder that becomes the storage node (an absolute path)" ""; return 0 ;;
            3) join_kind=none; return 0 ;;
            *) log "1, 2 or 3, please" ;;
        esac
    done
}

choose_threshold() {
    local threshold
    if [[ -f "$node_file" ]]; then log "$node_file keeps its threshold, $(node_file_threshold)"; return 0; fi
    while true; do
        ask "threshold, 0 to 100 (essential 80+, working 50+, archive 1+, 0 keeps everything)" "$join_threshold"
        threshold="$answer"
        if [[ ! "$threshold" =~ ^[0-9]{1,3}$ ]] || (( 10#$threshold > 100 )); then
            log "the threshold is a whole number from 0 to 100, not '$threshold'"
            continue
        fi
        threshold=$((10#$threshold))
        if [[ "$threshold" -eq 0 ]]; then
            if ! confirm "threshold 0 keeps EVERYTHING the storage network holds, backups and archives included. Keep everything?" no; then
                log "the threshold was not changed"
                continue
            fi
            allow_keep_all=1
        fi
        join_threshold="$threshold"
        log "threshold $join_threshold, $(threshold_bands "$join_threshold")"
        return 0
    done
}

has_auth_key() { [[ -n "${STORAGE_JOIN_KEY:-}" || ( -n "${IMPRINT_PERSONAL:-}" && -s "$IMPRINT_PERSONAL/tailscale.key" ) ]]; }

choose_join() {
    local default=yes
    if ! has_auth_key && [[ "$(tailnet_state)" != Running ]]; then
        default=no
        log "no Tailscale key (STORAGE_JOIN_KEY or personal/tailscale.key) and not on the tailnet yet: a join now stops at the tailnet"
    fi
    confirm "join the storage network now?" "$default"
}

# Returns 1 when the answers mean there is nothing to do.
ask_choices() {
    choose_node
    if [[ "$join_kind" == none ]]; then log "no storage node chosen; this device does not join the storage network"; return 1; fi
    choose_threshold
    if ! choose_join; then log "not joining; run this again to join"; return 1; fi
    log "joining with the $join_kind node at $join_root"
}

stdin_is_terminal() { [[ -t 0 ]]; }

has_join_settings() { [[ -n "$(compgen -v STORAGE_JOIN_)" ]]; }

is_interactive() { stdin_is_terminal && ! has_join_settings; }

main() {
    [[ "$(id -u)" -eq 0 ]] || fail "run as root"
    if is_interactive && ! ask_choices; then return 0; fi
    check_threshold
    check_node_placement
    install_packages
    join_tailnet
    generate_keys
    write_node_file
    register_folder_node
    start_syncthing
    wait_for_syncthing
    configure_options
    local device_id answer
    device_id="$(api GET /rest/system/status | jq -r .myID)"
    answer="$(call_dashboard "$device_id")"
    apply_answer "$answer"
    link_homes "$answer"
    if [[ "$changes" -eq 0 ]]; then log "already joined; nothing changed"; else log "joined ($changes changes)"; fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
