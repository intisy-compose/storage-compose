#!/bin/bash
# Keeps SnapRAID's config in step with the mounted drives and runs sync and scrub when they are due.
# `snapraid.sh run sync|scrub [--anyway]` runs one job now, `snapraid.sh config` writes and prints the
# config; without arguments it is the scheduler.
set -u

root=${STORAGE_ROOT:-/mnt/storage}
prefix=${ARRAY_PREFIX:-storage}
state_dir="$root/$prefix-data1/.storage"
log_file="$state_dir/log/snapraid.log"
status_file=/status/snapraid.json
config=/etc/snapraid.conf
job_lock=/run/snapraid.job
sync_interval=$(( ${SYNC_INTERVAL_HOURS:-24} * 3600 ))
scrub_interval=$(( ${SCRUB_INTERVAL_DAYS:-7} * 86400 ))
start_delay=${START_DELAY_SECONDS:-300}
max_deleted=${SYNC_MAX_DELETED:-500}

log() { local line; line="$(date -u +%FT%TZ) $*"; echo "$line"; mkdir -p "$(dirname "$log_file")" && echo "$line" >> "$log_file"; }

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

write_config() {
    local parity_drives data_drives
    mapfile -t parity_drives < <(drive_paths parity)
    mapfile -t data_drives < <(drive_paths data)
    if [ ${#parity_drives[@]} -eq 0 ] || [ ${#data_drives[@]} -eq 0 ]; then return 1; fi
    {
        local index=1
        for drive in "${parity_drives[@]}"; do
            if [ $index -eq 1 ]; then echo "parity $drive/snapraid.parity"; else echo "$index-parity $drive/snapraid.parity"; fi
            echo "content $drive/snapraid.content"
            index=$(( index + 1 ))
        done
        for drive in "${data_drives[@]}"; do
            echo "content $drive/.snapraid.content"
            echo "data ${drive##*-} $drive/"
        done
        echo "exclude /.storage/"
        echo "exclude /lost+found/"
        echo "exclude /.snapraid.content"
        echo "exclude *.tmp"
        echo "autosave 500"
    } > "$config.new" && mv "$config.new" "$config"
}

state_value() { cat "$state_dir/snapraid.$1" 2>/dev/null || echo 0; }
set_state_value() { echo "$2" > "$state_dir/snapraid.$1"; }

write_status() {
    local refusal; refusal=$(cat "$state_dir/snapraid.refused" 2>/dev/null)
    printf '{"lastSync":%s,"lastSyncResult":"%s","lastScrub":%s,"lastScrubResult":"%s","refused":"%s","running":"%s"}\n' \
        "$(state_value sync)" "$(cat "$state_dir/snapraid.sync-result" 2>/dev/null)" \
        "$(state_value scrub)" "$(cat "$state_dir/snapraid.scrub-result" 2>/dev/null)" \
        "$refusal" "$(cat "$job_lock.name" 2>/dev/null)" > "$status_file.tmp" && mv "$status_file.tmp" "$status_file"
}

deleted_since_last_sync() { snapraid -c "$config" diff 2>/dev/null | awk '$2=="removed"{count=$1} END{print count+0}'; }

# A mass deletion, or a data drive that mounted empty, would otherwise be written into parity for good.
run_sync() {
    local anyway=$1 deleted
    deleted=$(deleted_since_last_sync)
    if [ "$deleted" -gt "$max_deleted" ] && [ "$anyway" != "--anyway" ]; then
        echo "$deleted files deleted since the last sync (limit $max_deleted); run 'sync --anyway' to accept" > "$state_dir/snapraid.refused"
        log "sync refused: $deleted files deleted since the last sync, limit $max_deleted"
        return 3
    fi
    rm -f "$state_dir/snapraid.refused"
    log "sync started ($deleted deleted since the last one)"
    local output; output=$(snapraid -c "$config" sync 2>&1)
    local result=$?
    echo "$output" >> "$log_file"
    if [ $result -eq 0 ]; then
        set_state_value sync "$(date +%s)"; set_state_value sync-result ok; log "sync done"
    elif is_emptied_disk_refusal "$output"; then
        local disk; disk=$(grep -o "present in disk '[^']*'" <<< "$output" | head -1 | cut -d"'" -f2)
        echo "every file on $disk is missing or rewritten; check that it is mounted, then 'snapraid --force-empty sync' to accept" > "$state_dir/snapraid.refused"
        set_state_value sync-result refused; log "sync refused by SnapRAID: every file on $disk is missing or rewritten"
        return 3
    else
        set_state_value sync-result failed; log "sync FAILED, see the lines above"; return 1
    fi
}

# --anyway never adds --force-empty: on a drive that is only unplugged, that would discard its parity.
is_emptied_disk_refusal() { grep -q "use 'snapraid --force-empty sync'" <<< "$1"; }

run_scrub() {
    log "scrub started (8 percent, blocks older than 10 days)"
    local output; output=$(snapraid -c "$config" scrub -p 8 -o 10 2>&1)
    local result=$?
    echo "$output" >> "$log_file"
    if [ $result -eq 0 ]; then
        set_state_value scrub "$(date +%s)"; set_state_value scrub-result ok; log "scrub done"
    elif grep -q "array appears to be empty" <<< "$output"; then
        set_state_value scrub "$(date +%s)"; set_state_value scrub-result empty; log "scrub: the array is empty, nothing to check"
    else
        set_state_value scrub-result failed; log "scrub FAILED, see the lines above"; return 1
    fi
}

# The subshell holds the lock, so it is released when the job ends, also in the scheduler's own shell.
run_job() {
    local job=$1 anyway=${2:-}
    write_config || { echo "no parity or no data drive mounted"; return 1; }
    (
        flock -n 9 || { echo "another job is running: $(cat "$job_lock.name" 2>/dev/null)"; exit 1; }
        echo "$job" > "$job_lock.name"; write_status
        result=0
        case "$job" in
            sync) run_sync "$anyway" || result=$? ;;
            scrub) run_scrub || result=$? ;;
            *) echo "unknown job $job"; result=1 ;;
        esac
        rm -f "$job_lock.name"; write_status
        exit $result
    ) 9> "$job_lock"
}

is_due() { [ $(( $(date +%s) - $(state_value "$1") )) -ge "$2" ]; }

if [ "${1:-}" = run ]; then shift; run_job "$@"; exit $?; fi
if [ "${1:-}" = config ]; then write_config || { echo "no parity or no data drive mounted"; exit 1; }; cat "$config"; exit 0; fi

mkdir -p /status
trap 'exit 0' TERM INT
log "scheduler started: sync every ${SYNC_INTERVAL_HOURS:-24} h, scrub every ${SCRUB_INTERVAL_DAYS:-7} days, first check in ${start_delay} s"
sleep "$start_delay" & wait $!
while true; do
    if write_config; then
        is_due sync "$sync_interval" && run_job sync
        is_due scrub "$scrub_interval" && [ -z "$(cat "$state_dir/snapraid.refused" 2>/dev/null)" ] && run_job scrub
    fi
    write_status
    sleep 600 & wait $!
done
