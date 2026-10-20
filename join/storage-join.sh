#!/usr/bin/env bash
# Joins this Linux device to the storage network (specs/2026-10-20-connect-devices-design.md, the join
# script): installs Tailscale and Syncthing if missing and joins the tailnet, writes the node file for
# the data root and runs Syncthing with its home on the node, registers with the storage dashboard,
# applies the answer to Syncthing and links the home folders. Run as root (an imprint firstboot hook);
# a second run changes nothing and exits 0.
#
# Settings, all optional:
#   STORAGE_JOIN_KEY        Tailscale auth key; else $IMPRINT_PERSONAL/tailscale.key
#   STORAGE_DASHBOARD       the dashboard, default https://storage.<tailnet>
#   STORAGE_JOIN_ROOT       the data root that becomes this device's node, default /data
#   STORAGE_JOIN_NAME       the node and device name, default the host name
#   STORAGE_JOIN_KIND       drive or folder, default drive
#   STORAGE_JOIN_THRESHOLD  the layered sync threshold written into a new node file, default 0
#   STORAGE_JOIN_USER       whose home gets the folder links, default the data root's owner
#   STORAGE_JOIN_OFFLINE_REPO  a pacman repository directory (the stick's `offline`) tried first
set -euo pipefail

readonly HOME_LINKS="Documents:Documents Pictures:Pictures Music:Music Videos:Videos Downloads:Downloads Desktop:Desktop Templates:Templates Public:Public Documents/GitHub:code"
readonly UNIT_NAME="storage-syncthing.service"

join_root="${STORAGE_JOIN_ROOT:-/data}"
join_kind="${STORAGE_JOIN_KIND:-drive}"
join_threshold="${STORAGE_JOIN_THRESHOLD:-0}"
unit_dir="${STORAGE_JOIN_UNIT_DIR:-/etc/systemd/system}"
gui_port="${STORAGE_JOIN_GUI_PORT:-8384}"
listen_port="${STORAGE_JOIN_LISTEN_PORT:-22000}"
syncthing_home="$join_root/.storage/syncthing"
node_file="$join_root/.storage/node.toml"
changes=0

log() { printf 'storage-join: %s\n' "$*"; }
changed() { changes=$((changes + 1)); log "$*"; }
fail() { printf 'storage-join: %s\n' "$*" >&2; exit 1; }

device_name() {
    local name="${STORAGE_JOIN_NAME:-$(hostname)}"
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

write_node_file() {
    [[ -f "$node_file" ]] && return 0
    [[ -d "$join_root" ]] || fail "the data root $join_root does not exist"
    as_owner mkdir -p "$(dirname "$node_file")"
    printf '[node]\nid        = "%s"\nname      = "%s"\nkind      = "%s"\nthreshold = %s\nassigned  = []\n' \
        "$(new_node_id)" "$(device_name)" "$join_kind" "$join_threshold" > "$node_file.partial"
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
    if [[ ! -f "$syncthing_home/config.xml" ]]; then
        as_owner syncthing generate --home="$syncthing_home" --no-port-probing > /dev/null
        changed "generated Syncthing's keys in $syncthing_home"
    fi
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
    local attempt
    for attempt in $(seq 1 60); do
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
    printf 'https://storage.%s' "$suffix"
}

join_request() {
    jq -n --arg name "$(device_name)" --arg id "$1" --arg kind "$join_kind" --arg path "$join_root" \
        --argjson threshold "$(sed -n 's/^threshold *= *\([0-9]*\).*/\1/p' "$node_file" | head -n 1)" \
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
        403) rm -f "$answer"; fail "the dashboard refused this device (403): it is not on the tailnet's owner's account and not tagged tag:storage" ;;
        409) rm -f "$answer"; fail "the dashboard knows $(device_name) with another Syncthing ID (409): re-admit the reinstalled device from the dashboard" ;;
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

main() {
    [[ "$(id -u)" -eq 0 ]] || fail "run as root"
    install_packages
    join_tailnet
    write_node_file
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
