#!/bin/sh
# Runs the private relay and publishes its relay id, taken from the URI line strelaysrv prints at each
# start, in /status/bridge.json for the dashboard; the file goes when the relay stops.
set -eu
port=${BRIDGE_PORT:?}
keys=${BRIDGE_KEYS:-/var/strelaysrv}
status=${BRIDGE_STATUS:-/status/bridge.json}
relay=${STRELAYSRV:-/bin/strelaysrv}

publish() {
    while IFS= read -r line; do
        printf '%s\n' "$line"
        case $line in
            *"URI: relay://"*"?id="*) ;;
            *) continue ;;
        esac
        relay_id=${line#*\?id=}
        relay_id=${relay_id%%&*}
        case $relay_id in
            "" | *[!A-Z0-9-]*) continue ;;
        esac
        printf '{ "relayId": "%s", "port": %s }\n' "$relay_id" "$port" >"$status.tmp"
        mv "$status.tmp" "$status"
    done
}

rm -f "$status"
run_as=
if [ "$(id -u)" = 0 ]; then
    # A bind from a Windows folder may refuse chown and is writable by every user anyway.
    chown -R "${PUID:-1000}:${PGID:-1000}" "$keys" || true
    run_as="su-exec ${PUID:-1000}:${PGID:-1000}"
fi

output=$(mktemp -u)
mkfifo "$output"
$run_as "$relay" -pools="" -status-srv="" -listen=":$port" -keys="$keys" >"$output" 2>&1 &
relay_pid=$!
publish <"$output" &
publisher_pid=$!
trap 'kill -TERM "$relay_pid" 2>/dev/null || true' TERM INT

set +e
wait "$relay_pid"
code=$?
if kill -0 "$relay_pid" 2>/dev/null; then
    wait "$relay_pid"
    code=$?
fi
wait "$publisher_pid"
rm -f "$output" "$status" "$status.tmp"
exit "$code"
