#!/bin/sh
# Pauses the Syncthing folders the mounter names in /status/syncthing.pause (those a missing or
# failing drive touches, every folder once the array has stopped) and resumes them when they leave
# the list. A folder paused by hand is never resumed here. The nodes service runs one per array
# instance, with its own files and the instance's pid.
set -u
config="$STHOMEDIR/config.xml"
api="http://${STGUIADDRESS:-127.0.0.1:8385}/rest"
wanted=${PAUSE_FILE:-/status/syncthing.pause}
array_env=${ARRAY_ENV:-/status/array.env}
syncthing_pid=${SYNCTHING_PID:-1}
paused_here="$STHOMEDIR/guard-paused"

log() { echo "$(date -u +%FT%TZ) guard: $*"; }

api_key() { sed -n 's:.*<apikey>\(.*\)</apikey>.*:\1:p' "$config"; }

url_encode() { printf '%s' "$1" | od -An -tx1 | tr -s ' \n' ' ' | sed -e 's/^ //' -e 's/ $//' -e 's/ /%/g' -e 's/^/%/'; }

request() {   # <method> <path> [body]
    curl -fsS -m 10 -X "$1" -H "X-API-Key: $(api_key)" -H 'Content-Type: application/json' ${3:+-d "$3"} "$api$2"
}

is_paused() { request GET "/config/folders/$(url_encode "$1")" | grep -q '"paused": *true'; }

set_paused() {   # <folder id> <true or false>
    request PATCH "/config/folders/$(url_encode "$1")" "{\"paused\":$2}" > /dev/null
}

is_listed() { grep -qxF "$1" "$2" 2>/dev/null; }

pause_wanted_folders() {
    while IFS= read -r id || [ -n "$id" ]; do
        if [ -z "$id" ] || is_listed "$id" "$paused_here" || is_paused "$id"; then continue; fi
        set_paused "$id" true && echo "$id" >> "$paused_here" && log "paused $id"
    done < "$wanted"
}

resume_released_folders() {
    [ -f "$paused_here" ] || return 0
    cp "$paused_here" "$paused_here.read"
    while IFS= read -r id || [ -n "$id" ]; do
        if [ -z "$id" ] || is_listed "$id" "$wanted"; then continue; fi
        set_paused "$id" false || continue
        grep -vxF "$id" "$paused_here" > "$paused_here.new"; mv "$paused_here.new" "$paused_here"
        log "resumed $id"
    done < "$paused_here.read"
}

generation() { sed -n 's/^generation=//p' "$array_env" 2>/dev/null; }

# The config folder is a bind mount of data1; once data1 is mounted anew, only a fresh container sees
# the live one, so Syncthing is stopped and Docker restarts the container.
started_on=$(generation)
until request GET /system/ping > /dev/null 2>&1; do sleep 2; done
log "watching $wanted"
while true; do
    if [ -f "$wanted" ]; then
        pause_wanted_folders
        resume_released_folders
    fi
    current=$(generation)
    [ -n "$started_on" ] || started_on=$current
    if [ -n "$current" ] && [ "$current" != "$started_on" ]; then log "data1 was mounted anew; restarting Syncthing"; kill -TERM "$syncthing_pid"; exit 0; fi
    sleep 5
done
