#!/bin/sh
# Entry point of the dashboard test peer: a Syncthing with its own identity that is announced to the
# dashboard through the node registry exactly like a folder node, and re-announced every 60 s so the
# entry never goes stale (the dashboard shows an entry older than 5 minutes as offline).
#
# The peer shares the gateway's namespace, which already holds the cluster's Syncthing on 22000 and
# 8385, so it takes sync port 22199 and GUI port 8389 and turns discovery, relays and NAT off.
set -eu

node_id=d7e5
node_name=dashboard-test-peer
node_root=/var/syncthing/data
sync_port=22199
gui_port=8389
registry=/status/nodes
home=${STHOMEDIR:-/var/syncthing/config}
service_user=${PUID:-1000}:${PGID:-1000}

prepare_home() {
    mkdir -p "$home" "$node_root"
    chown "$service_user" "$home" "$node_root"
    if [ ! -f "$home/config.xml" ]; then
        su-exec "$service_user" syncthing generate --home "$home" --no-port-probing > /dev/null
        sed -i -E \
            -e "s#<listenAddress>[^<]*</listenAddress>#<listenAddress>tcp://:$sync_port</listenAddress>#" \
            -e 's#<(globalAnnounceEnabled|localAnnounceEnabled|relaysEnabled|natEnabled)>true<#<\1>false<#' \
            -e 's#<autoUpgradeIntervalH>[0-9]+<#<autoUpgradeIntervalH>0<#' "$home/config.xml"
        sed -i '/<folder /,/<\/folder>/d' "$home/config.xml"
    fi
    chown -R "$service_user" "$home"
}

write_atomically() {   # <file> <content>
    printf '%s\n' "$2" > "$1.tmp"
    mv "$1.tmp" "$1"
}

announce() {
    api_key=$(sed -n 's:.*<apikey>\(.*\)</apikey>.*:\1:p' "$home/config.xml")
    write_atomically "$registry/$node_id.json" "$(printf \
        '{"id":"%s","name":"%s","kind":"folder","threshold":0,"assigned":[],"root":"%s","present":true,"space":{"size":null,"used":null},"syncthing":null,"updated":"%s"}' \
        "$node_id" "$node_name" "$node_root" "$(date -u +%FT%TZ)")"
    write_atomically "$registry/$node_id.syncthing.json" "$(printf \
        '{"url":"http://gateway:%s","apiKey":"%s","syncPort":%s}' "$gui_port" "$api_key" "$sync_port")"
}

keep_announcing() {
    while true; do
        announce
        sleep 60
    done
}

prepare_home
mkdir -p "$registry"
keep_announcing &
exec su-exec "$service_user" env HOME="$HOME" syncthing serve --home "$home" --no-browser --no-restart --no-port-probing
