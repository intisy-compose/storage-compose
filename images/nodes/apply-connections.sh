#!/bin/sh
# apply-connections.sh <node id> <api url> <api key>: applies the node's connection profile from the
# dashboard's /status/connections.json once the node's Syncthing answers, for the nodes service's
# instances and the cluster alike (POSIX sh: the cluster's image has busybox only). Only the options
# and listen addresses; each device's addresses stay the dashboard's, which adds no device. A missing
# file or entry changes nothing; an option of the wrong type is left out, and a listen list with any
# address of an unknown scheme is left out whole, as the host agent does (windows/syncthing.ps1).
set -u

node=$1
api=$2
key=$3
connections=${CONNECTIONS_FILE:-/status/connections.json}
wait_seconds=${APPLY_WAIT_SECONDS:-300}

log() { echo "$(date -u +%FT%TZ) apply-connections $node: $*" >&2; }

wanted_options() {
    jq -c --arg id "$node" '
        def is_count: type == "number" and . >= 0 and . == floor;
        def is_valid($key):
            if $key == "maxSendKbps" or $key == "maxRecvKbps" then is_count
            elif $key == "globalAnnounceServers" then type == "array" and all(.[]; type == "string")
            elif $key == "limitBandwidthInLan" or $key == "natEnabled" or $key == "localAnnounceEnabled"
                or $key == "globalAnnounceEnabled" or $key == "relaysEnabled" then type == "boolean"
            else false end;
        def is_listen_address: type == "string" and test("^(tcp|quic|relay|dynamic\\+https?)://");
        def is_listen_list: type == "array" and length > 0 and all(.[]; is_listen_address);
        .[$id] | select(type == "object")
        | ((.options | if type == "object" then . else {} end) | with_entries(select(.key as $key | .value | is_valid($key)))) as $options
        | $options + (if .listenAddresses | is_listen_list then {listenAddresses: .listenAddresses} else {} end)
        | select(length > 0)' "$connections" 2> /dev/null
}

api_answers() { curl -fsS -m 5 -H "X-API-Key: $key" "$api/rest/system/ping" > /dev/null 2>&1; }

[ -f "$connections" ] || exit 0
options=$(wanted_options) || { log "$connections cannot be read as a connections file; nothing applied"; exit 0; }
[ -n "$options" ] || exit 0

waited=0
until api_answers; do
    [ "$waited" -ge "$wait_seconds" ] && { log "Syncthing did not answer within $wait_seconds s; nothing applied"; exit 1; }
    sleep 2
    waited=$((waited + 2))
done

if curl -fsS -m 30 -X PATCH -H "X-API-Key: $key" -H "Content-Type: application/json" --data "$options" "$api/rest/config/options" > /dev/null; then
    log "applied the connection profile"
else
    log "Syncthing refused the connection profile"
    exit 1
fi
