#!/bin/sh
set -eu

node_id=d7e5
node_name=dashboard-test-peer
node_root=/var/syncthing/data
# The gateway namespace already holds the cluster's Syncthing on 22000 and 8385.
sync_port=22199
gui_port=8389
registry=/status/nodes
home=${STHOMEDIR:-/var/syncthing/config}
service_user=${PUID:-1000}:${PGID:-1000}

remove_default_folder() {
    sed -i '\#<folder #,\#</folder>#d' "$home/config.xml"
}

prepare_home() {
    mkdir -p "$home" "$node_root"
    chown "$service_user" "$home" "$node_root"
    if [ ! -f "$home/config.xml" ]; then
        su-exec "$service_user" syncthing generate --home "$home" --no-port-probing > /dev/null
        sed -i -E \
            -e "s#<listenAddress>[^<]*</listenAddress>#<listenAddress>tcp://:$sync_port</listenAddress>#" \
            -e 's#<(globalAnnounceEnabled|localAnnounceEnabled|relaysEnabled|natEnabled)>true<#<\1>false<#' \
            -e 's#<autoUpgradeIntervalH>[0-9]+<#<autoUpgradeIntervalH>0<#' "$home/config.xml"
        remove_default_folder
    fi
    chown -R "$service_user" "$home"
}

write_atomically() {
    target_file=$1
    file_content=$2
    printf '%s\n' "$file_content" > "$target_file.tmp"
    mv "$target_file.tmp" "$target_file"
}

announce() {
    api_key=$(sed -n 's:.*<apikey>\(.*\)</apikey>.*:\1:p' "$home/config.xml")
    write_atomically "$registry/$node_id.json" "$(printf \
        '{"id":"%s","name":"%s","kind":"folder","threshold":0,"assigned":[],"root":"%s","present":true,"space":{"size":null,"used":null},"syncthing":null,"updated":"%s","remember":false}' \
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
