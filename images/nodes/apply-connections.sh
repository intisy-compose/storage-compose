#!/bin/sh
# apply-connections.sh <node id> <api url> <api key>: applies the node's connection profile from the
# dashboard's /status/connections.json once the node's Syncthing answers, for the nodes service's
# instances and the cluster alike (POSIX sh: the cluster's image has busybox only). Only the options
# and listen addresses; each device's addresses stay the dashboard's, which adds no device. A missing
# file or entry changes nothing; an option of the wrong type is left out, and a listen list with any
# address of an unknown scheme is left out whole while the valid options are still applied, the rule
# every keeper follows (windows/syncthing.ps1 and the joins' storage-connections steps too).
set -u

node=$1
api=$2
key=$3
connections=${CONNECTIONS_FILE:-/status/connections.json}
wait_seconds=${APPLY_WAIT_SECONDS:-300}

log() { echo "$(date -u +%FT%TZ) apply-connections $node: $*" >&2; }

wanted_options() {
    jq -c -L "$(dirname "$0")" --arg id "$node" '
        include "connection-profile";
        .[$id] | select(type == "object") | profile_settings | select(length > 0)' "$connections" 2> /dev/null
}

api_answers() { curl -fsS -m 5 -H "X-API-Key: $key" "$api/rest/system/ping" > /dev/null 2>&1; }

# Prints true or false, and nothing when Syncthing gives no answer.
restart_required() {
    curl -fsS -m 5 -H "X-API-Key: $key" "$api/rest/config/restart-required" 2> /dev/null | jq -r '.requiresRestart | booleans' 2> /dev/null
}

# A restart request ends a Syncthing run with --no-restart, which nodes.sh starts again within a round;
# the cluster's runs under its own monitor, which restarts it in place.
restart_for_profile() {
    case $(restart_required) in
        false) ;;
        true)
            if curl -fsS -m 10 -X POST -H "X-API-Key: $key" "$api/rest/system/restart" > /dev/null; then log "restarted Syncthing for the connection profile"
            else log "Syncthing needs a restart for the connection profile and refused one; it takes effect at the next start"; fi ;;
        *) log "could not ask whether Syncthing needs a restart for the connection profile; it takes effect at the next start at the latest" ;;
    esac
}

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
    restart_for_profile
else
    log "Syncthing refused the connection profile"
    exit 1
fi
