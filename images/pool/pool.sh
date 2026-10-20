#!/bin/bash
# Keeps one mergerfs view of each array's mounted data drives, the cluster's at $STORAGE_ROOT/pool and
# any other array's at $STORAGE_ROOT/pool-<id>, and changes it when a data drive appears or vanishes
# or the mounter's verdict on that array changes: a failing drive takes no more writes, and a stopped
# array none at all.
set -u

root=${STORAGE_ROOT:-/mnt/storage}
cluster=${ARRAY_PREFIX:-storage}
arrays_status=/status/arrays
# epmfs puts a new file on a drive that already holds its folder, so every folder, and so every
# Syncthing folder, stays on one drive and leaves with it as a whole.
options="cache.files=off,category.create=epmfs,moveonenospc=true,dropcacheonclose=true,allow_other,minfreespace=${POOL_MIN_FREE_SPACE:-4G}"
declare -A mergerfs_pid current current_mode

log() { echo "$(date -u +%FT%TZ) $*"; }

array_value() { sed -n "s/^$2=//p" "$arrays_status/$1/array.env" 2>/dev/null; }   # <id> <name>

pool_of() { if [ "$1" = "$cluster" ]; then echo "$root/pool"; else echo "$root/pool-$1"; fi; }

pool_name() { if [ "$1" = "$cluster" ]; then echo storage-pool; else echo "storage-pool-$1"; fi; }

known_arrays() { local directory; for directory in "$arrays_status"/*/; do [ -f "$directory/array.env" ] && basename "$directory"; done; }

mounted_data_drives() {   # <id>
    local target
    for target in "$root/$1"-data*; do
        [[ $(basename "$target") =~ ^$1-data[0-9]+$ ]] && mountpoint -q "$target" && echo "$target"
    done
}

branch_mode() {   # <id> <drive mount point>
    local readonly_drives
    [ "$(array_value "$1" share)" = ro ] && { echo RO; return; }
    readonly_drives=" $(array_value "$1" readonly) "
    [[ $readonly_drives == *" $(basename "$2") "* ]] && echo RO || echo RW
}

wanted_branches() {   # <id>
    local target branches=()
    for target in $(mounted_data_drives "$1"); do branches+=("$target=$(branch_mode "$1" "$target")"); done
    (IFS=:; echo "${branches[*]}")
}

# A lazily unmounted pool lives on while a file in it is open; mergerfs is stopped so none of them can
# still be written to.
stop_pool() {   # <id>
    local pool pid=${mergerfs_pid[$1]:-}
    pool=$(pool_of "$1")
    mountpoint -q "$pool" && fusermount3 -u "$pool" 2>/dev/null || umount -l "$pool" 2>/dev/null
    [ -n "$pid" ] && { kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; }
    mergerfs_pid[$1]=
}

# The branch modes only keep new files off a drive; a stopped array needs the mount itself read-only,
# which FUSE sets only when mounting.
mount_mode() { [ "$(array_value "$1" share)" = ro ] && echo ro || echo rw; }

start_pool() {   # <id> <branches> <rw or ro>
    local pool
    pool=$(pool_of "$1")
    mkdir -p "$pool"
    mergerfs -f -o "$options,fsname=$(pool_name "$1"),$3" "$2" "$pool" &
    mergerfs_pid[$1]=$!
    log "pool $pool over $2 ($3)"
    [ "$1" = "$cluster" ] && create_service_folders "$pool"
}

# Kopia writes its repository as root; a read-only pool keeps whatever is there.
create_service_folders() {   # <pool>
    for _ in $(seq 20); do mountpoint -q "$1" && break; sleep 0.5; done
    mkdir -p "$1/kopia" 2>/dev/null || true
}

# mergerfs swaps its branches in place through the control file, so open files and shares on the pool
# survive a drive appearing or vanishing.
set_branches_live() {   # <id> <branches>
    local pool
    pool=$(pool_of "$1")
    mountpoint -q "$pool" && setfattr -n user.mergerfs.branches -v "$2" "$pool/.mergerfs" 2>/dev/null \
        && log "pool $pool now over $2"
}

keep_pool() {   # <id>
    local id=$1 wanted mode pool
    wanted=$(wanted_branches "$id")
    mode=$(mount_mode "$id")
    pool=$(pool_of "$id")
    if [ -z "$wanted" ]; then
        [ -n "${current[$id]:-}" ] && { stop_pool "$id"; log "no data drive of $id mounted; its pool is down"; }
    elif ! mountpoint -q "$pool" || [ "$mode" != "${current_mode[$id]:-}" ]; then
        stop_pool "$id"; start_pool "$id" "$wanted" "$mode"
    elif [ "$wanted" != "${current[$id]:-}" ]; then
        set_branches_live "$id" "$wanted" || { stop_pool "$id"; start_pool "$id" "$wanted" "$mode"; }
    fi
    current[$id]=$wanted
    current_mode[$id]=$mode
}

shut_down() {
    local id
    log "stopping: unmounting the pools"
    for id in "${!current[@]}"; do stop_pool "$id"; done
    exit 0
}
trap shut_down TERM INT

while true; do
    for id in $(known_arrays); do keep_pool "$id"; done
    sleep 5 & wait $!
done
