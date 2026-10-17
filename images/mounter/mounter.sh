#!/bin/bash
# Mounts every array drive by its ext4 label under $STORAGE_ROOT/<label>, holds the array's lock,
# mirrors the stack state from data1 to data2, and decides every 10 s whether the array is healthy,
# degraded or stopped, which the other services follow. A drive that drops off and comes back within
# DROP_GRACE_SECONDS is checked and mounted again; one that stays away, or fails, is notified.
#   mounter.sh                      the service; releases the lock and unmounts when stopped
#   mounter.sh accept-smart <role>  take the drive's current SMART counts as its new baseline
#   mounter.sh disk-labels          each disk's GPT id and whether it holds an array drive
set -u

root=${STORAGE_ROOT:-/mnt/storage}
prefix=${ARRAY_PREFIX:-storage}
node=${STORAGE_NODE:-}
lock_timeout=${LOCK_TIMEOUT_SECONDS:-600}
drop_grace=${DROP_GRACE_SECONDS:-120}
smart_interval=$(( ${SMART_INTERVAL_HOURS:-6} * 3600 ))
ntfy_url=${NTFY_URL:-https://ntfy.sh}
ntfy_topic=${NTFY_TOPIC:-}
label_pattern="^${prefix}-(data|parity)[0-9]+$"
state_dir="$root/$prefix-data1/.storage"
mirror_dir="$root/$prefix-data2/.storage"
status_dir=/status
wsl_disks_file=$status_dir/wsl-disks.json
runtime=/run/mounter
ready_file=/run/mounter.ready
service_user_id=1000
secret_names=(samba syncthing-gui kopia-repository kopia-server)
array_state=

log() { echo "$(date -u +%FT%TZ) $*"; }

library=/usr/local/lib/storage
# shellcheck source=lib/drives.sh
source "$library/drives.sh"
# shellcheck source=lib/health.sh
source "$library/health.sh"
# shellcheck source=lib/folders.sh
source "$library/folders.sh"
# shellcheck source=lib/state.sh
source "$library/state.sh"
# shellcheck source=lib/notify.sh
source "$library/notify.sh"

if [ "${1:-}" = accept-smart ]; then accept_smart "${2:?accept-smart needs a role, e.g. data2}"; exit $?; fi
if [ "${1:-}" = disk-labels ]; then report_disk_labels; exit 0; fi
[ -n "$node" ] || { log "STORAGE_NODE is not set"; exit 1; }

lock_holder_is_live_elsewhere() {
    local lock="$state_dir/lock" holder seen
    [ -f "$lock" ] || return 1
    read -r holder seen < "$lock"
    [ "$holder" != "$node" ] && [ $(( $(date +%s) - seen )) -lt "$lock_timeout" ]
}

# The secrets live on the array, so every host that runs it presents the same passwords.
ensure_service_state() {
    mkdir -p "$state_dir/secrets" "$state_dir/kopia" "$state_dir/syncthing"
    chmod 700 "$state_dir/secrets"
    chown "$service_user_id:$service_user_id" "$state_dir/syncthing"
    local name
    for name in "${secret_names[@]}"; do
        [ -s "$state_dir/secrets/$name" ] && continue
        head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$state_dir/secrets/$name"
        chmod 600 "$state_dir/secrets/$name"
        log "generated the $name secret"
    done
}

write_lock() {
    state_dir_is_writable || return 0
    mkdir -p "$state_dir" && echo "$node $(date +%s)" > "$state_dir/lock.tmp" && mv "$state_dir/lock.tmp" "$state_dir/lock"
}

mirror_state() {
    state_dir_is_writable && is_usable "$prefix-data2" || return 0
    rsync -a --delete "$state_dir/" "$mirror_dir/"
}

unmount_all() {
    local target
    for target in "$root/$prefix"-*; do mountpoint -q "$target" && umount "$target" && log "unmounted ${target##*/}"; done
}

shut_down() {
    log "stopping: releasing the lock and unmounting"
    rm -f "$ready_file"
    [ -f "$state_dir/lock" ] && read -r holder _ < "$state_dir/lock" && [ "$holder" = "$node" ] && rm -f "$state_dir/lock"
    mirror_state
    unmount_all
    exit 0
}
trap shut_down TERM INT

check_round() {
    unmount_lost_drives
    notice_lost_drives
    mount_found_drives
    register_mounted_drives
    revive_absent_drives
    check_due_smart
    hold_failing_drives_read_only
    assess_array
    announce_changes
    send_notifications
}

rm -rf "$runtime"
mkdir -p "$root" "$status_dir" "$runtime"
mount_found_drives
if ! is_mounted "$prefix-data1"; then log "no drive labelled $prefix-data1 found; it holds the stack state"; exit 1; fi
if lock_holder_is_live_elsewhere; then
    log "the array is in use by $(cut -d' ' -f1 "$state_dir/lock") (seen less than ${lock_timeout}s ago); refusing"
    unmount_all
    exit 1
fi
write_lock
ensure_service_state
register_mounted_drives
log "holding the array as $node"
[ -n "$ntfy_topic" ] || log "NTFY_TOPIC is empty: notifications are only logged"

tick=0
while true; do
    check_round
    [ "$tick" -eq 0 ] && touch "$ready_file"
    if (( tick % 6 == 0 )); then write_lock; mirror_state; fi
    tick=$(( tick + 1 ))
    sleep 10 & wait $!
done
