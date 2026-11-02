#!/bin/sh
# apply-connections.sh <node id> <api url> <api key>: applies the node's connection profile from the
# dashboard's /status/connections.json once the node's Syncthing answers, for the nodes service's
# instances and the cluster alike (POSIX sh: the cluster's image has busybox only). Only the options
# and listen addresses; each device's addresses stay the dashboard's, which adds no device. A missing
# file or entry changes nothing; a value of the wrong type or a listen address of an unknown scheme
# is left out, never sent.
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
        def is_listen_address: type == "string" and test("^(tcp|quic|relay|dynamic\\+https)://[^[:space:]]+$");
        .[$id] | select(type == "object")
        | ((.options | if type == "object" then . else {} end) | with_entries(select(.key as $key | .value | is_valid($key)))) as $options
        | ((.listenAddresses | if type == "array" then . else [] end) | map(select(is_listen_address))) as $listen
        | $options + (if $listen == [] then {} else {listenAddresses: $listen} end)
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
