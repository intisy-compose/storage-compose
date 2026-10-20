#!/bin/bash
# Finds every storage node on this host by metadata and keeps it running. An array is found by its
# drives' ext4 labels, <id>-dataN and <id>-parityN; its drives are mounted under $STORAGE_ROOT/<label>,
# it holds its own lock, and every 10 s it is decided whether it is healthy, degraded or stopped,
# which the other services follow. Drive and folder nodes are found by the node file at a volume root
# under /mnt/nodes. A device or mount event starts a discovery at once; a slow poll catches a missed
# one. The array named by ARRAY_PREFIX holds the stack state on its data1, mirrored to data2.
#   mounter.sh                              the service; releases the locks and unmounts when stopped
#   mounter.sh accept-smart <role> [array]  take the drive's current SMART counts as its new baseline
#   mounter.sh disk-labels                  each disk's GPT id and whether it holds an array drive
set -u

root=${STORAGE_ROOT:-/mnt/storage}
cluster=${ARRAY_PREFIX:-storage}
node=${STORAGE_NODE:-}
lock_timeout=${LOCK_TIMEOUT_SECONDS:-600}
drop_grace=${DROP_GRACE_SECONDS:-120}
smart_interval=$(( ${SMART_INTERVAL_HOURS:-6} * 3600 ))
discovery_interval=${DISCOVERY_POLL_SECONDS:-300}
ntfy_url=${NTFY_URL:-https://ntfy.sh}
ntfy_topic=${NTFY_TOPIC:-}
any_array_label="^([0-9a-f]{4}|$cluster)-(data|parity)[0-9]+$"
status_root=/status
wsl_disks_file=$status_root/wsl-disks.json
runtime=/run/mounter
events=$runtime/events
ready_file=/run/mounter.ready
node_volumes=/mnt/nodes
service_user_id=1000
secret_names=(samba syncthing-gui kopia-repository kopia-server)

prefix=
label_pattern=
state_dir=
mirror_dir=
status_dir=
array_runtime=
array_state=

log() { echo "$(date -u +%FT%TZ) $*"; }

library=/usr/local/lib/storage
# shellcheck source=lib/nodefile.sh
source "$library/nodefile.sh"
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
# shellcheck source=lib/arrays.sh
source "$library/arrays.sh"
# shellcheck source=lib/volumes.sh
source "$library/volumes.sh"

if [ "${1:-}" = accept-smart ]; then select_array "${3:-$cluster}"; accept_smart "${2:?accept-smart needs a role, e.g. data2}"; exit $?; fi
if [ "${1:-}" = disk-labels ]; then report_disk_labels; exit 0; fi
[ -n "$node" ] || { log "STORAGE_NODE is not set"; exit 1; }

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

shut_down() {
    local id
    log "stopping: releasing the locks and unmounting"
    rm -f "$ready_file"
    stop_event_watchers
    for id in $(known_arrays); do
        select_array "$id"
        release_lock
        mirror_state
        unmount_all
    done
    exit 0
}
trap shut_down TERM INT

check_round() {   # <whether the description is due>
    unmount_lost_drives
    notice_lost_drives
    if [ -n "$discovering" ]; then
        mount_found_drives
        claim_array || return 1
    fi
    register_mounted_drives
    [ "$1" = yes ] && keep_array_description
    take_accept_smart_request
    revive_absent_drives
    check_due_smart
    hold_failing_drives_read_only
    assess_array
    announce_changes
}

round_for_array() {   # <id> <tick>
    local due=no
    select_array "$1"
    if is_held_elsewhere; then
        [ -n "$discovering" ] || return 0
        rm -f "$array_runtime/held_by"
    fi
    { [ -n "$discovering" ] || (( $2 % 6 == 0 )); } && due=yes
    check_round "$due" || return 0
    if (( $2 % 6 == 0 )); then write_lock; mirror_state; fi
}

rm -rf "$runtime"
mkdir -p "$root" "$status_root" "$runtime"
start_event_watchers
scan_devices
select_array "$cluster"
mount_found_drives
if ! is_mounted "$prefix-data1"; then log "no drive labelled $prefix-data1 found; it holds the stack state"; exit 1; fi
if lock_holder_is_live_elsewhere; then
    log "the array is in use by $(cut -d' ' -f1 "$state_dir/lock") (seen less than ${lock_timeout}s ago); refusing"
    unmount_all
    exit 1
fi
write_lock
ensure_service_state
link_cluster_status
log "holding the array $prefix as $node"
[ -n "$ntfy_topic" ] || log "NTFY_TOPIC is empty: notifications are only logged"

# A device's node appears before it can be read (a disk before its partitions, a mapper device before
# its table), so every round rescans for a while after an event.
settle_seconds=30
rescan_until=0
block_devices_changed
tick=0
discovering=yes
last_discovery=$(date +%s)
while true; do
    for array_id in $(known_arrays); do round_for_array "$array_id" "$tick"; done
    { [ -n "$discovering" ] || (( tick % 6 == 0 )); } && discover_volume_nodes
    send_notifications
    [ "$tick" -eq 0 ] && touch "$ready_file"
    tick=$(( tick + 1 ))
    discovering=
    if wait_for_event 10 || take_discovery_request || block_devices_changed; then rescan_until=$(( $(date +%s) + settle_seconds )); fi
    if [ "$(date +%s)" -le "$rescan_until" ] || [ $(( $(date +%s) - last_discovery )) -ge "$discovery_interval" ]; then
        scan_devices
        discovering=yes
        last_discovery=$(date +%s)
    fi
done
