#!/bin/bash
# Keeps SnapRAID's config in step with the drives and runs every job that changes the array.
#   snapraid.sh                          the scheduler: sync and scrub when they are due
#   snapraid.sh run sync [--anyway]      run one job now; jobs never overlap, here or in the dashboard
#   snapraid.sh run scrub
#   snapraid.sh run rebuild <role> <device>   erase <device>, label it as <role>, restore onto it
#   snapraid.sh run remove <role>        drop a missing data drive from the array, losing its files
#   snapraid.sh config                   write and print the config
set -u

root=${STORAGE_ROOT:-/mnt/storage}
prefix=${ARRAY_PREFIX:-storage}
state_dir="$root/$prefix-data1/.storage"
log_file="$state_dir/log/snapraid.log"
status_file=/status/snapraid.json
config=/etc/snapraid.conf
job_lock=/status/snapraid.job
empty_dir=/var/lib/snapraid/empty
sync_interval=$(( ${SYNC_INTERVAL_HOURS:-24} * 3600 ))
scrub_interval=$(( ${SCRUB_INTERVAL_DAYS:-7} * 86400 ))
start_delay=${START_DELAY_SECONDS:-300}
max_deleted=${SYNC_MAX_DELETED:-500}
mount_wait_seconds=90

log() { local line; line="$(date -u +%FT%TZ) $*"; echo "$line"; mkdir -p "$(dirname "$log_file")" && echo "$line" >> "$log_file"; }

state_value() { cat "$state_dir/snapraid.$1" 2>/dev/null || echo 0; }
state_text() { cat "$state_dir/snapraid.$1" 2>/dev/null; }
set_state_value() { echo "$2" > "$state_dir/snapraid.$1"; }

is_role() { [[ $1 =~ ^(data|parity)[0-9]+$ ]]; }
role_path() { echo "$root/$prefix-$1"; }
is_removing() { grep -qxF "$1" "$state_dir/snapraid.removing" 2>/dev/null; }

# SnapRAID names the first parity "parity" and the others "2-parity", "3-parity" and so on.
snapraid_name() {
    case "$1" in
        parity1) echo parity ;;
        parity*) echo "${1#parity}-parity" ;;
        *) echo "$1" ;;
    esac
}

# A drive that is missing stays in the config, so SnapRAID refuses to sync instead of dropping it.
drive_paths() {
    local known="$state_dir/snapraid.drives"
    touch "$known"
    for target in "$root/$prefix-$1"[0-9]*; do
        [[ $(basename "$target") =~ ^$prefix-$1[0-9]+$ ]] && mountpoint -q "$target" \
            && { grep -qxF "$target" "$known" || echo "$target" >> "$known"; }
    done
    grep -E "/$prefix-$1[0-9]+$" "$known" | sort -V
}

forget_drive() {
    local known="$state_dir/snapraid.drives"
    grep -vxF "$1" "$known" > "$known.new"; mv "$known.new" "$known"
}

# Drops the role's [section] from array.toml, so the dashboard no longer links a removed drive to its asset.
forget_role_asset() {
    local description="$state_dir/array.toml"
    [ -f "$description" ] || return 0
    awk -v section="[$1]" '/^\[/{skip = ($0 == section)} !skip' "$description" > "$description.new" && mv "$description.new" "$description"
}

write_config() {
    local parity_drives data_drives role
    mapfile -t parity_drives < <(drive_paths parity)
    mapfile -t data_drives < <(drive_paths data)
    if [ ${#parity_drives[@]} -eq 0 ] || [ ${#data_drives[@]} -eq 0 ]; then return 1; fi
    mkdir -p "$empty_dir"
    {
        for drive in "${parity_drives[@]}"; do
            role=${drive##*-}
            echo "$(snapraid_name "$role") $drive/snapraid.parity"
            mountpoint -q "$drive" && echo "content $drive/snapraid.content"
        done
        for drive in "${data_drives[@]}"; do
            role=${drive##*-}
            mountpoint -q "$drive" && echo "content $drive/.snapraid.content"
            if is_removing "$role"; then echo "data $role $empty_dir/"; else echo "data $role $drive/"; fi
        done
        echo "exclude /.storage/"
        echo "exclude /lost+found/"
        echo "exclude /.snapraid.content"
        echo "exclude *.tmp"
        echo "autosave 500"
    } > "$config.new" && mv "$config.new" "$config"
}

write_status() {
    printf '{"lastSync":%s,"lastSyncResult":"%s","lastScrub":%s,"lastScrubResult":"%s","refused":"%s","running":"%s","lastAction":"%s","lastActionResult":"%s"}\n' \
        "$(state_value sync)" "$(state_text sync-result)" "$(state_value scrub)" "$(state_text scrub-result)" \
        "$(state_text refused)" "$(cat "$job_lock.name" 2>/dev/null)" "$(state_text action)" "$(state_text action-result)" \
        > "$status_file.tmp" && mv "$status_file.tmp" "$status_file"
}

run_snapraid() {
    local output result
    output=$(snapraid -c "$config" "$@" 2>&1); result=$?
    echo "$output" >> "$log_file"
    snapraid_output=$output
    return $result
}

deleted_since_last_sync() { snapraid -c "$config" diff 2>/dev/null | awk '$2=="removed"{count=$1} END{print count+0}'; }

# --anyway never adds --force-empty: on a drive that is only unplugged, that would discard its parity.
is_emptied_disk_refusal() { grep -q "use 'snapraid --force-empty sync'" <<< "$1"; }

# A mass deletion, or a data drive that mounted empty, would otherwise be written into parity for good.
run_sync() {
    local anyway=${1:-} deleted
    deleted=$(deleted_since_last_sync)
    if [ "$deleted" -gt "$max_deleted" ] && [ "$anyway" != "--anyway" ]; then
        set_state_value refused "$deleted files deleted since the last sync (limit $max_deleted); run 'sync --anyway' to accept"
        log "sync refused: $deleted files deleted since the last sync, limit $max_deleted"
        return 3
    fi
    rm -f "$state_dir/snapraid.refused"
    log "sync started ($deleted deleted since the last one)"
    if run_snapraid sync; then
        set_state_value sync "$(date +%s)"; set_state_value sync-result ok; log "sync done"
    elif is_emptied_disk_refusal "$snapraid_output"; then
        local disk; disk=$(grep -o "present in disk '[^']*'" <<< "$snapraid_output" | head -1 | cut -d"'" -f2)
        set_state_value refused "every file on $disk is missing or rewritten; check that it is mounted, then rebuild it or remove it from the array"
        set_state_value sync-result refused; log "sync refused by SnapRAID: every file on $disk is missing or rewritten"
        return 3
    else
        set_state_value sync-result failed; log "sync FAILED, see the lines above"; return 1
    fi
}

run_scrub() {
    log "scrub started (8 percent, blocks older than 10 days)"
    if run_snapraid scrub -p 8 -o 10; then
        set_state_value scrub "$(date +%s)"; set_state_value scrub-result ok; log "scrub done"
    elif grep -q "array appears to be empty" <<< "$snapraid_output"; then
        set_state_value scrub "$(date +%s)"; set_state_value scrub-result empty; log "scrub: the array is empty, nothing to check"
    else
        set_state_value scrub-result failed; log "scrub FAILED, see the lines above"; return 1
    fi
}

# blkid reads the labels off the disk; lsblk has no udev database to take them from in a container.
device_holds_array_label() {
    local part label
    for part in $(lsblk -lnpo NAME "$1"); do
        label=$(blkid -c /dev/null -o value -s LABEL "$part" 2>/dev/null)
        [[ $label =~ ^$prefix-(data|parity)[0-9]+$ ]] && return 0
    done
    return 1
}

device_is_mounted() { [ -n "$(lsblk -nro MOUNTPOINTS "$1" | tr -d '[:space:]')" ]; }

# Loop devices take the filesystem directly; a real disk gets one GPT partition first.
format_device() {
    local device=$1 label=$2 target=$1
    wipefs -q -a "$device"
    if [ "$(lsblk -dno TYPE "$device")" = disk ]; then
        echo 'type=linux' | sfdisk -q --label gpt "$device" && partx -u "$device" 2>/dev/null
        sleep 2
        target=$(lsblk -lnpo NAME,TYPE "$device" | awk '$2=="part"{print $1; exit}')
        [ -b "$target" ] || { log "the new partition on $device did not appear"; return 1; }
    fi
    mkfs.ext4 -q -F -L "$label" -m 0 "$target"
}

wait_for_mount() {
    local path; path=$(role_path "$1")
    for _ in $(seq $(( mount_wait_seconds / 3 ))); do mountpoint -q "$path" && return 0; sleep 3; done
    return 1
}

run_rebuild() {
    local role=${1:-} device=${2:-}
    is_role "$role" || { log "rebuild refused: '$role' is not a role"; return 2; }
    [ -b "$device" ] || { log "rebuild refused: $device is not a block device"; return 2; }
    grep -qxF "$(role_path "$role")" "$state_dir/snapraid.drives" || { log "rebuild refused: $role was never part of the array"; return 2; }
    mountpoint -q "$(role_path "$role")" && { log "rebuild refused: $role is mounted, nothing to rebuild"; return 2; }
    [ "$(lsblk -dno RO "$device" | tr -d ' ')" = 0 ] || { log "rebuild refused: $device is read-only"; return 2; }
    device_is_mounted "$device" && { log "rebuild refused: $device is in use"; return 2; }
    device_holds_array_label "$device" && { log "rebuild refused: $device belongs to the array"; return 2; }
    log "rebuild of $role onto $device: erasing and labelling it $prefix-$role"
    format_device "$device" "$prefix-$role" || { log "rebuild FAILED: formatting $device"; return 1; }
    wait_for_mount "$role" || { log "rebuild FAILED: $prefix-$role was not mounted within ${mount_wait_seconds}s"; return 1; }
    write_config
    local name; name=$(snapraid_name "$role")
    log "rebuild of $role: restoring with snapraid fix -d $name"
    run_snapraid fix -d "$name" || { log "rebuild FAILED: snapraid fix, see the lines above"; return 1; }
    log "rebuild of $role: verifying with snapraid check -d $name"
    run_snapraid check -d "$name" || { log "rebuild FAILED: snapraid check found errors, see the lines above"; return 1; }
    rm -f "$state_dir/snapraid.refused"
    log "rebuild of $role done"
}

# SnapRAID's documented removal: the disk points at an empty directory for one `sync -E`, then leaves the config.
run_remove() {
    local role=${1:-}
    [[ $role =~ ^data[0-9]+$ ]] || { log "remove refused: only a data drive can be removed, not '$role'"; return 2; }
    [ "$role" = data1 ] && { log "remove refused: data1 holds the stack state"; return 2; }
    mountpoint -q "$(role_path "$role")" && { log "remove refused: $role is mounted"; return 2; }
    grep -qxF "$(role_path "$role")" "$state_dir/snapraid.drives" || { log "remove refused: $role is not part of the array"; return 2; }
    log "removing $role from the array; its files are given up"
    echo "$role" >> "$state_dir/snapraid.removing"
    write_config
    if run_snapraid --force-empty sync; then
        forget_drive "$(role_path "$role")"
        forget_role_asset "$role"
        grep -vxF "$role" "$state_dir/snapraid.removing" > "$state_dir/snapraid.removing.new"; mv "$state_dir/snapraid.removing.new" "$state_dir/snapraid.removing"
        rmdir "$(role_path "$role")" 2>/dev/null
        write_config
        rm -f "$state_dir/snapraid.refused"
        set_state_value sync "$(date +%s)"; set_state_value sync-result ok
        log "removed $role from the array"
    else
        log "remove FAILED: snapraid sync -E, see the lines above; $role stays marked for removal"; return 1
    fi
}

# The subshell holds the lock, so it is released when the job ends, also in the scheduler's own shell.
run_job() {
    local job=$1; shift
    write_config || { echo "no parity or no data drive mounted"; return 1; }
    (
        flock -n 9 || { echo "another job is running: $(cat "$job_lock.name" 2>/dev/null)"; exit 1; }
        echo "$job $*" > "$job_lock.name"; write_status
        result=0
        case "$job" in
            sync) run_sync "$@" || result=$? ;;
            scrub) run_scrub || result=$? ;;
            rebuild) run_rebuild "$@" || result=$? ;;
            remove) run_remove "$@" || result=$? ;;
            *) echo "unknown job $job"; result=1 ;;
        esac
        if [ "$job" = rebuild ] || [ "$job" = remove ]; then
            set_state_value action "$job $*"
            if [ $result -eq 0 ]; then set_state_value action-result ok; else set_state_value action-result failed; fi
        fi
        rm -f "$job_lock.name"; write_status
        exit $result
    ) 9> "$job_lock"
}

is_due() { [ $(( $(date +%s) - $(state_value "$1") )) -ge "$2" ]; }

case "${1:-}" in
    run) shift; run_job "$@"; exit $? ;;
    config) write_config || { echo "no parity or no data drive mounted"; exit 1; }; cat "$config"; exit 0 ;;
esac

mkdir -p /status
trap 'exit 0' TERM INT
log "scheduler started: sync every ${SYNC_INTERVAL_HOURS:-24} h, scrub every ${SCRUB_INTERVAL_DAYS:-7} days, first check in ${start_delay} s"
sleep "$start_delay" & wait $!
while true; do
    if write_config; then
        is_due sync "$sync_interval" && run_job sync
        is_due scrub "$scrub_interval" && [ -z "$(state_text refused)" ] && run_job scrub
    fi
    write_status
    sleep 600 & wait $!
done
