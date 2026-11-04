#!/bin/bash
# One Syncthing per node on this host, each with the identity kept on its own storage, so a node
# keeps it whichever host serves it: every drive and folder node in the registry (/status/nodes) and
# every array but the cluster, whose Syncthing is the stack's own service. An instance starts when
# its node is present and stops when it goes. Each gets a sync port 22000+n (n from 21 to 99, kept
# per node in /status/nodes/ports; 1 to 20 are the host agent's native nodes) and a GUI on 8390+n
# on the gateway namespace's Docker address (never 127.0.0.1, where tailscale hands it tailnet
# connections), recorded for the dashboard in /status/nodes/<id>.syncthing.json.
# An array's instance runs with its own guard, which pauses the folders the mounter names, so the
# C-24 freeze holds per array. Each instance takes its connection profile from
# /status/connections.json once its API answers (apply-connections.sh).
set -u

root=${STORAGE_ROOT:-/mnt/storage}
cluster=${ARRAY_PREFIX:-storage}
node_volumes=/mnt/nodes
registry=/status/nodes
ports_file=$registry/ports
connections_file=/status/connections.json
service_user=${SERVICE_USER_ID:-1000}
declare -A instance_pid guard_pid

log() { echo "$(date -u +%FT%TZ) $*"; }

# "<id> <home> <kind>" for every node that should have an instance now.
wanted_nodes() {
    local entry directory id
    for entry in "$registry"/*.json; do
        [[ ${entry##*/} =~ ^[0-9a-f]{4}\.json$ ]] || continue
        jq -e --arg volumes "$node_volumes" '.present and (.root | startswith($volumes))' "$entry" > /dev/null 2>&1 || continue
        echo "$(jq -r .id "$entry") $(jq -r .root "$entry")/.storage/syncthing node"
    done
    for directory in /status/arrays/*/; do
        id=$(basename "$directory")
        [ "$id" = "$cluster" ] && continue
        jq -e '.present' "$directory/status.json" > /dev/null 2>&1 || continue
        mountpoint -q "$root/$id-data1" || continue
        echo "$id $root/$id-data1/.storage/syncthing array"
    done
}

is_index_taken() { awk -v n="$1" '$2 == n {found = 1} END {exit !found}' "$ports_file"; }

port_index() {   # <id>: the node's n, given once and kept; fails when 21 to 99 are all taken
    local index candidate
    touch "$ports_file"
    index=$(awk -v id="$1" '$1 == id {print $2}' "$ports_file")
    if [ -z "$index" ]; then
        for candidate in $(seq 21 99); do is_index_taken "$candidate" || { index=$candidate; break; }; done
        [ -n "$index" ] || { log "no sync port left for $1: 22021 to 22099 are all taken" >&2; return 1; }
        echo "$1 $index" >> "$ports_file"
    fi
    echo "$index"
}

has_connections_entry() { jq -e --arg id "$1" '.[$id] | type == "object"' "$connections_file" > /dev/null 2>&1; }

# A new home gets its identity once. A node the dashboard has a profile entry for keeps the listen
# addresses that entry set; any other node, and a fresh home whose `default` would take the cluster's
# 22000, gets the one address tcp://:<port>.
prepare_home() {   # <id> <home> <sync port>
    local home=$2 config=$2/config.xml
    mkdir -p "$home"
    chown "$service_user:$service_user" "$home"
    if [ ! -f "$config" ]; then
        setpriv --reuid="$service_user" --regid="$service_user" --clear-groups syncthing generate --home "$home" --no-port-probing > /dev/null
        log "generated a Syncthing identity in $home"
    fi
    if has_connections_entry "$1" && ! grep -q '<listenAddress>default</listenAddress>' "$config"; then return 0; fi
    awk -v address="tcp://:$3" '
        /<listenAddress>/ { if (!written) { sub(/<listenAddress>[^<]*<\/listenAddress>/, "<listenAddress>" address "</listenAddress>"); print; written = 1 }; next }
        { print }' "$config" > "$config.new" \
        && chown --reference="$config" "$config.new" && chmod --reference="$config" "$config.new" && mv "$config.new" "$config"
}

api_key_of() { sed -n 's:.*<apikey>\(.*\)</apikey>.*:\1:p' "$1/config.xml"; }

record_endpoint() {   # <id> <home> <index>
    jq -n --arg url "http://gateway:$(( 8390 + $3 ))" --arg apiKey "$(api_key_of "$2")" --argjson syncPort "$(( 22000 + $3 ))" \
        '{url: $url, apiKey: $apiKey, syncPort: $syncPort}' > "$registry/$1.syncthing.json.tmp" && mv "$registry/$1.syncthing.json.tmp" "$registry/$1.syncthing.json"
}

start_guard() {   # <id> <home> <gui address>
    PAUSE_FILE="/status/arrays/$1/syncthing.pause" ARRAY_ENV="/status/arrays/$1/array.env" SYNCTHING_PID=${instance_pid[$1]} \
        STHOMEDIR="$2" STGUIADDRESS="$3" sh /guard.sh &
    guard_pid[$1]=$!
}

start_instance() {   # <id> <home> <kind>
    local id=$1 home=$2 index gui
    index=$(port_index "$id") || return 1
    gui="$gui_host:$(( 8390 + index ))"
    prepare_home "$id" "$home" "$(( 22000 + index ))" || { log "could not prepare $home"; return 1; }
    STGUIADDRESS=$gui setpriv --reuid="$service_user" --regid="$service_user" --clear-groups \
        syncthing serve --home "$home" --no-browser --no-port-probing --no-restart > >(sed -u "s/^/[$id] /") 2>&1 &
    instance_pid[$id]=$!
    record_endpoint "$id" "$home" "$index"
    CONNECTIONS_FILE=$connections_file sh /usr/local/bin/apply-connections.sh "$id" "http://$gui" "$(api_key_of "$home")" &
    [ "$3" = array ] && start_guard "$id" "$home" "$gui"
    log "started Syncthing for $id ($home), sync port $(( 22000 + index ))"
}

stop_instance() {   # <id>
    local id=$1
    [ -n "${guard_pid[$id]:-}" ] && kill "${guard_pid[$id]}" 2> /dev/null
    [ -n "${instance_pid[$id]:-}" ] && kill -TERM "${instance_pid[$id]}" 2> /dev/null && wait "${instance_pid[$id]}" 2> /dev/null
    unset "instance_pid[$id]" "guard_pid[$id]"
    rm -f "$registry/$id.syncthing.json"
    log "stopped Syncthing for $id"
}

is_running() { [ -n "${instance_pid[$1]:-}" ] && kill -0 "${instance_pid[$1]}" 2> /dev/null; }

keep_instances() {
    local wanted id home kind
    wanted=$(wanted_nodes)
    for id in "${!instance_pid[@]}"; do
        grep -q "^$id " <<< "$wanted" || stop_instance "$id"
    done
    while read -r id home kind; do
        [ -n "$id" ] || continue
        is_running "$id" && continue
        [ -n "${instance_pid[$id]:-}" ] && { log "Syncthing for $id exited; starting it again"; stop_instance "$id"; }
        start_instance "$id" "$home" "$kind"
    done <<< "$wanted"
}

shut_down() {
    local id
    log "stopping every node's Syncthing"
    for id in "${!instance_pid[@]}"; do stop_instance "$id"; done
    exit 0
}

main() {
    trap shut_down TERM INT
    gui_host=$(sh /namespace-address.sh --single) || exit 1
    mkdir -p "$registry"
    while true; do
        keep_instances
        sleep 10 & wait $!
    done
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main; fi
