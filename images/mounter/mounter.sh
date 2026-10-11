#!/bin/bash
# Mounts every array drive by its ext4 label under $STORAGE_ROOT/<label>, holds the array's lock and
# mirrors the stack state from data1 to data2. Runs until stopped, then releases the lock and unmounts.
set -u

root=${STORAGE_ROOT:-/mnt/storage}
prefix=${ARRAY_PREFIX:-storage}
node=${STORAGE_NODE:?STORAGE_NODE is not set}
lock_timeout=${LOCK_TIMEOUT_SECONDS:-600}
label_pattern="^${prefix}-(data|parity)[0-9]+$"
state_dir="$root/$prefix-data1/.storage"
mirror_dir="$root/$prefix-data2/.storage"
status_file=/status/status.json
ready_file=/run/mounter.ready
service_user_id=1000
secret_names=(samba syncthing-gui kopia-repository kopia-server)

log() { echo "$(date -u +%FT%TZ) $*"; }

array_devices() {
    blkid -t TYPE=ext4 -o device 2>/dev/null | while read -r device; do
        label=$(blkid -o value -s LABEL "$device")
        [[ $label =~ $label_pattern ]] && echo "$device $label"
    done
}

mount_new_drives() {
    array_devices | while read -r device label; do
        target="$root/$label"
        mountpoint -q "$target" && continue
        mkdir -p "$target"
        if mount -o noatime "$device" "$target"; then log "mounted $label from $device"; else log "FAILED to mount $label from $device"; continue; fi
        [[ $label == "$prefix-data"* ]] && chown "$service_user_id:$service_user_id" "$target"
    done
}

is_vanished_mount() { [ ! -b "$1" ]; }

unmount_vanished_drives() {
    findmnt -rn -o TARGET,SOURCE | while read -r target source; do
        [[ $target == "$root/$prefix-"* ]] || continue
        [[ $(basename "$target") =~ $label_pattern ]] || continue
        if is_vanished_mount "$source"; then umount -l "$target" && log "drive behind $target vanished; unmounted"; fi
    done
}

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

write_lock() { mkdir -p "$state_dir" && echo "$node $(date +%s)" > "$state_dir/lock.tmp" && mv "$state_dir/lock.tmp" "$state_dir/lock"; }

mirror_state() {
    mountpoint -q "$root/$prefix-data2" || return 0
    rsync -a --delete "$state_dir/" "$mirror_dir/"
}

write_status() {
    local drives=() label used size
    for target in "$root/$prefix"-*; do
        label=$(basename "$target")
        [[ $label =~ $label_pattern ]] || continue
        if mountpoint -q "$target"; then
            read -r size used < <(df -B1 --output=size,used "$target" | tail -1)
            drives+=("{\"label\":\"$label\",\"mounted\":true,\"size\":$size,\"used\":$used}")
        else
            drives+=("{\"label\":\"$label\",\"mounted\":false}")
        fi
    done
    local joined; joined=$(IFS=,; echo "${drives[*]}")
    echo "{\"node\":\"$node\",\"updated\":\"$(date -u +%FT%TZ)\",\"drives\":[${joined}]}" > "$status_file.tmp" && mv "$status_file.tmp" "$status_file"
}

shut_down() {
    log "stopping: releasing the lock and unmounting"
    rm -f "$ready_file"
    [ -f "$state_dir/lock" ] && read -r holder _ < "$state_dir/lock" && [ "$holder" = "$node" ] && rm -f "$state_dir/lock"
    mirror_state
    for target in "$root/$prefix"-*; do mountpoint -q "$target" && umount "$target" && log "unmounted $(basename "$target")"; done
    exit 0
}
trap shut_down TERM INT

mkdir -p "$root" /status
mount_new_drives
if ! mountpoint -q "$root/$prefix-data1"; then log "no drive labelled $prefix-data1 found; it holds the stack state"; exit 1; fi
if lock_holder_is_live_elsewhere; then
    log "the array is in use by $(cut -d' ' -f1 "$state_dir/lock") (seen less than ${lock_timeout}s ago); refusing"
    for target in "$root/$prefix"-*; do mountpoint -q "$target" && umount "$target"; done
    exit 1
fi
write_lock
ensure_service_state
touch "$ready_file"
log "holding the array as $node"

tick=0
while true; do
    mount_new_drives
    unmount_vanished_drives
    write_status
    if (( tick % 6 == 0 )); then write_lock; mirror_state; fi
    tick=$(( tick + 1 ))
    sleep 10 & wait $!
done
