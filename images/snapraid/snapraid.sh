#!/bin/bash
# Keeps each array's SnapRAID config in step with its drives and runs every job that changes an array.
# Every array has its own config, job lock and status in /status/arrays/<id>/; --array picks one, the
# cluster (ARRAY_PREFIX) when it is left out.
#   snapraid.sh                                    the scheduler: sync and scrub every array when due
#   snapraid.sh [--array <id>] run sync [--anyway] run one job now; jobs on one array never overlap,
#   snapraid.sh [--array <id>] run scrub           here or in the dashboard; a sync or scrub waits
#                                                  while the mounter finds a drive away
#   snapraid.sh [--array <id>] run rebuild <role> <device>   erase <device>, label it as <role>, restore onto it
#   snapraid.sh [--array <id>] run remove <role>   drop a missing data drive from the array, losing its files
#   snapraid.sh [--array <id>] run add <device>    erase <device> and add it as the next data drive
#   snapraid.sh [--array <id>] config              write and print the config
set -u

root=${STORAGE_ROOT:-/mnt/storage}
cluster=${ARRAY_PREFIX:-storage}
status_root=/status
empty_dir=/var/lib/snapraid/empty
sync_interval=$(( ${SYNC_INTERVAL_HOURS:-24} * 3600 ))
scrub_interval=$(( ${SCRUB_INTERVAL_DAYS:-7} * 86400 ))
start_delay=${START_DELAY_SECONDS:-300}
max_deleted=${SYNC_MAX_DELETED:-500}
scrub_percent=${SCRUB_PERCENT:-8}
scrub_older_than_days=${SCRUB_OLDER_THAN_DAYS:-10}
outbox=$status_root/outbox
mount_wait_seconds=90

# shellcheck source=../mounter/lib/nodefile.sh
source /usr/local/lib/storage/nodefile.sh

select_array() {   # <id>
    prefix=$1
    state_dir="$root/$prefix-data1/.storage"
    status_dir="$status_root/arrays/$prefix"
    log_file="$state_dir/log/snapraid.log"
    status_file="$status_dir/snapraid.json"
    config="$status_dir/snapraid.conf"
    job_lock="$status_dir/snapraid.job"
    array_env="$status_dir/array.env"
    mkdir -p "$status_dir"
}

log() { local line; line="$(date -u +%FT%TZ) $*"; echo "$line"; mkdir -p "$(dirname "$log_file")" && echo "$line" >> "$log_file"; }

array_name() {
    local name
    name=$(jq -r '.name // empty' "$status_dir/status.json" 2> /dev/null)
    echo "${name:-$prefix}"
}

# The mounter sends what lands in the outbox; the format is its own: title, priority, tags, message.
notify() {   # <title> <message>
    local file
    mkdir -p "$outbox" && file="$outbox/$(date +%s%N)-$$"
    printf '%s\n4\nwarning\n%s\n' "$1" "$2" > "$file.tmp" && mv "$file.tmp" "$file"
}

# A job that fails the same way on every scheduled attempt is announced once, until it succeeds.
notify_once() {   # <title> <message>
    [ "$(state_text notified)" = "$1: $2" ] && return 0
    set_state_value notified "$1: $2"
    notify "$1" "$2"
}

array_value() { sed -n "s/^$1=//p" "$array_env" 2>/dev/null; }

# Parity written while a drive is away would record its files as gone, so sync and scrub wait for
# every drive; the mounter decides that, a missing status counts as not complete.
array_is_complete() { [ "$(array_value complete)" = yes ]; }
array_summary() { local state; state=$(array_value state); echo "not every drive of $(array_name) is present (the array is ${state:-not assessed yet})"; }

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
    local known="$state_dir/snapraid.drives" target
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

mounted_member_files() {
    local target
    for target in "$root/$prefix"-*; do
        [[ ${target##*/} =~ ^$prefix-(data|parity)[0-9]+$ ]] && mountpoint -q "$target" && node_file_of "$target"
    done
}

# Membership changes are written to every mounted member, so any one drive keeps describing the whole
# array; the mounter brings a member that was away up to date when it is back.
change_description() {   # <jq filter> [jq arguments...]
    local filter=$1 json files file
    shift
    is_node_id "$prefix" || return 0
    mapfile -t files < <(mounted_member_files)
    json=$(newest_array_description "$prefix" "${files[@]}") || return 0
    json=$(jq -c "$@" "$filter | .array.revision += 1" <<< "$json") || return 1
    for file in "${files[@]}"; do node_file_write "$file" "$json"; done
    log "description of $prefix is now at revision $(jq -r .array.revision <<< "$json")"
}

# Drops the role's [section] from array.toml, so the dashboard no longer links a removed drive to its asset.
forget_role_asset() {
    local description="$state_dir/array.toml"
    [ -f "$description" ] || return 0
    awk -v section="[$1]" '/^\[/{skip = ($0 == section)} !skip' "$description" > "$description.new" && mv "$description.new" "$description"
}

link_cluster_config() { [ "$prefix" = "$cluster" ] && ln -sfn "$config" /etc/snapraid.conf; return 0; }

write_config() {
    local parity_drives data_drives role drive
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
    link_cluster_config
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
    local anyway=${1:-} deleted disk
    deleted=$(deleted_since_last_sync)
    if [ "$deleted" -gt "$max_deleted" ] && [ "$anyway" != "--anyway" ]; then
        set_state_value refused "$deleted files deleted since the last sync (limit $max_deleted); run 'sync --anyway' to accept"
        log "sync refused: $deleted files deleted since the last sync, limit $max_deleted"
        notify_once "sync refused" "SnapRAID refused to sync $(array_name): $deleted files were deleted since the last sync (limit $max_deleted). Check them, then sync anyway in the dashboard."
        return 3
    fi
    rm -f "$state_dir/snapraid.refused"
    log "sync started ($deleted deleted since the last one)"
    if run_snapraid sync; then
        set_state_value sync "$(date +%s)"; set_state_value sync-result ok; rm -f "$state_dir/snapraid.notified"; log "sync done"
    elif is_emptied_disk_refusal "$snapraid_output"; then
        disk=$(grep -o "present in disk '[^']*'" <<< "$snapraid_output" | head -1 | cut -d"'" -f2)
        set_state_value refused "every file on $disk is missing or rewritten; check that it is mounted, then rebuild it or remove it from the array"
        set_state_value sync-result refused; log "sync refused by SnapRAID: every file on $disk is missing or rewritten"
        notify_once "sync refused" "SnapRAID refused to sync $(array_name): every file on $disk is missing or rewritten. Check that it is mounted, then rebuild it or remove it from the array."
        return 3
    else
        set_state_value sync-result failed; log "sync FAILED, see the lines above"
        notify_once "sync failed" "The SnapRAID sync of $(array_name) failed: $(last_snapraid_line). It runs again once every drive is present; the log is in the dashboard."
        return 1
    fi
}

last_snapraid_line() { grep -v '^[[:space:]]*$' <<< "$snapraid_output" | tail -n 1; }

run_scrub() {
    log "scrub started ($scrub_percent percent, blocks older than $scrub_older_than_days days)"
    if run_snapraid scrub -p "$scrub_percent" -o "$scrub_older_than_days"; then
        set_state_value scrub "$(date +%s)"; set_state_value scrub-result ok; rm -f "$state_dir/snapraid.notified"; log "scrub done"
    elif grep -q "array appears to be empty" <<< "$snapraid_output"; then
        set_state_value scrub "$(date +%s)"; set_state_value scrub-result empty; log "scrub: the array is empty, nothing to check"
    else
        set_state_value scrub-result failed; log "scrub FAILED, see the lines above"
        notify_once "scrub failed" "The SnapRAID scrub of $(array_name) failed: $(last_snapraid_line). Run 'snapraid status' and 'snapraid fix -e' once the cause is clear; the log is in the dashboard."
        return 1
    fi
}

# blkid reads the labels off the disk; lsblk has no udev database to take them from in a container.
device_holds_array_label() {
    local part label
    for part in $(lsblk -lnpo NAME "$1"); do
        label=$(blkid -c /dev/null -o value -s LABEL "$part" 2>/dev/null)
        [[ $label =~ ^([0-9a-f]{4}|$cluster)-(data|parity)[0-9]+$ ]] && return 0
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

request_discovery() { touch "$status_root/discover"; }

wait_for_mount() {
    local path; path=$(role_path "$1")
    request_discovery
    for _ in $(seq $(( mount_wait_seconds / 3 ))); do mountpoint -q "$path" && return 0; sleep 3; done
    return 1
}

device_serial() {   # <device>
    local serial
    serial=$(smartctl -j -i "$1" 2> /dev/null | jq -r '.serial_number // empty' 2> /dev/null)
    [ -n "$serial" ] || serial=$(lsblk -dno SERIAL "$1" 2> /dev/null | tr -d ' ')
    echo "$serial"
}

# The replacement is another drive: its serial and size are recorded and the old drive's asset dropped.
record_replacement() {   # <role> <device>
    local size serial
    size=$(blockdev --getsize64 "$2" 2> /dev/null || echo 0)
    serial=$(device_serial "$2")
    change_description '.array.members |= map(if .role == $role then .serial = $serial | .size = ($size | tonumber) | del(.asset) else . end)' \
        --arg role "$1" --arg serial "$serial" --arg size "$size"
}

run_rebuild() {
    local role=${1:-} device=${2:-} name
    is_role "$role" || { log "rebuild refused: '$role' is not a role"; return 2; }
    [ -b "$device" ] || { log "rebuild refused: $device is not a block device"; return 2; }
    grep -qxF "$(role_path "$role")" "$state_dir/snapraid.drives" || { log "rebuild refused: $role was never part of the array"; return 2; }
    mountpoint -q "$(role_path "$role")" && { log "rebuild refused: $role is mounted, nothing to rebuild"; return 2; }
    [ "$(lsblk -dno RO "$device" | tr -d ' ')" = 0 ] || { log "rebuild refused: $device is read-only"; return 2; }
    device_is_mounted "$device" && { log "rebuild refused: $device is in use"; return 2; }
    device_holds_array_label "$device" && { log "rebuild refused: $device belongs to an array"; return 2; }
    log "rebuild of $role onto $device: erasing and labelling it $prefix-$role"
    format_device "$device" "$prefix-$role" || { log "rebuild FAILED: formatting $device"; return 1; }
    wait_for_mount "$role" || { log "rebuild FAILED: $prefix-$role was not mounted within ${mount_wait_seconds}s"; return 1; }
    record_replacement "$role" "$device"
    write_config
    name=$(snapraid_name "$role")
    log "rebuild of $role: restoring with snapraid fix -d $name"
    run_snapraid fix -d "$name" || { log "rebuild FAILED: snapraid fix, see the lines above"; return 1; }
    log "rebuild of $role: verifying with snapraid check -d $name"
    run_snapraid check -d "$name" || { log "rebuild FAILED: snapraid check found errors, see the lines above"; return 1; }
    rm -f "$state_dir/snapraid.refused"
    log "rebuild of $role done"
}

next_data_role() {
    local highest
    highest=$(grep -oE "/$prefix-data[0-9]+$" "$state_dir/snapraid.drives" | grep -oE '[0-9]+$' | sort -n | tail -n 1)
    echo "data$(( ${highest:-0} + 1 ))"
}

smallest_parity_bytes() {
    local drive size smallest=
    for drive in $(drive_paths parity); do
        mountpoint -q "$drive" || continue
        size=$(df -B1 --output=size "$drive" | tail -n 1 | tr -d ' ')
        [ -z "$smallest" ] || [ "$size" -lt "$smallest" ] && smallest=$size
    done
    echo "${smallest:-0}"
}

# A data drive larger than the smallest parity drive could hold files no parity covers.
run_add() {
    local device=${1:-} role size parity
    [ -b "$device" ] || { log "add refused: $device is not a block device"; return 2; }
    [ "$(lsblk -dno RO "$device" | tr -d ' ')" = 0 ] || { log "add refused: $device is read-only"; return 2; }
    device_is_mounted "$device" && { log "add refused: $device is in use"; return 2; }
    device_holds_array_label "$device" && { log "add refused: $device belongs to an array"; return 2; }
    size=$(blockdev --getsize64 "$device")
    parity=$(smallest_parity_bytes)
    [ "$size" -le "$parity" ] || { log "add refused: $device ($size bytes) is larger than the smallest parity drive ($parity bytes)"; return 2; }
    role=$(next_data_role)
    log "adding $device as $role: erasing and labelling it $prefix-$role"
    format_device "$device" "$prefix-$role" || { log "add FAILED: formatting $device"; return 1; }
    wait_for_mount "$role" || { log "add FAILED: $prefix-$role was not mounted within ${mount_wait_seconds}s"; return 1; }
    write_config
    log "added $role; the next sync covers it"
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
        change_description '.array.members |= map(select(.role != $role))' --arg role "$role"
        grep -vxF "$role" "$state_dir/snapraid.removing" > "$state_dir/snapraid.removing.new"; mv "$state_dir/snapraid.removing.new" "$state_dir/snapraid.removing"
        chattr -i "$(role_path "$role")" 2>/dev/null
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
is_held() { { [ "$1" = sync ] || [ "$1" = scrub ]; } && ! array_is_complete; }

run_job() {
    local job=$1; shift
    if is_held "$job"; then echo "$job waits: $(array_summary)"; return 4; fi
    write_config || { echo "no parity or no data drive of $prefix mounted"; return 1; }
    (
        flock -n 9 || { echo "another job is running on $prefix: $(cat "$job_lock.name" 2>/dev/null)"; exit 1; }
        echo "$job $*" > "$job_lock.name"; write_status
        result=0
        case "$job" in
            sync) run_sync "$@" || result=$? ;;
            scrub) run_scrub || result=$? ;;
            rebuild) run_rebuild "$@" || result=$? ;;
            add) run_add "$@" || result=$? ;;
            remove) run_remove "$@" || result=$? ;;
            *) echo "unknown job $job"; result=1 ;;
        esac
        if [ "$job" = rebuild ] || [ "$job" = remove ] || [ "$job" = add ]; then
            set_state_value action "$job $*"
            if [ $result -eq 0 ]; then set_state_value action-result ok; else set_state_value action-result failed; fi
        fi
        rm -f "$job_lock.name"; write_status
        exit $result
    ) 9> "$job_lock"
}

is_due() { [ $(( $(date +%s) - $(state_value "$1") )) -ge "$2" ]; }

holding_file() { echo "$status_dir/snapraid.holding"; }

schedule_array() {
    if ! array_is_complete; then
        [ -f "$(holding_file)" ] || log "sync and scrub wait: $(array_summary)"
        touch "$(holding_file)"
    elif write_config; then
        [ -f "$(holding_file)" ] && log "every drive of $(array_name) is present again; sync and scrub resume"
        rm -f "$(holding_file)"
        is_due sync "$sync_interval" && run_job sync
        is_due scrub "$scrub_interval" && [ -z "$(state_text refused)" ] && run_job scrub
    fi
    write_status
}

known_arrays() { local directory; for directory in "$status_root"/arrays/*/; do [ -f "$directory/array.env" ] && basename "$directory"; done; }

# A long job on one array never holds back the schedule of another: each array's round runs on its
# own, and a round still running is not started twice.
schedule_all() {
    local id
    for id in $(known_arrays); do
        [ -n "${round_pid[$id]:-}" ] && kill -0 "${round_pid[$id]}" 2> /dev/null && continue
        ( select_array "$id"; schedule_array ) &
        round_pid[$id]=$!
    done
}

array=$cluster
if [ "${1:-}" = --array ]; then array=${2:?--array needs an array id}; shift 2; fi
select_array "$array"
case "${1:-}" in
    run) shift; run_job "$@"; exit $? ;;
    config) write_config || { echo "no parity or no data drive of $prefix mounted"; exit 1; }; cat "$config"; exit 0 ;;
esac

declare -A round_pid
trap 'exit 0' TERM INT
log "scheduler started: sync every ${SYNC_INTERVAL_HOURS:-24} h, scrub every ${SCRUB_INTERVAL_DAYS:-7} days, first check in ${start_delay} s"
sleep "$start_delay" & wait $!
while true; do
    schedule_all
    sleep 600 & wait $!
done
