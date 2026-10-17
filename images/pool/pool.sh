#!/bin/bash
# Keeps one mergerfs view of every mounted data drive at $STORAGE_ROOT/pool, and changes it when a data
# drive appears or vanishes or the mounter's verdict changes: a failing drive takes no more writes, and
# a stopped array none at all.
set -u

root=${STORAGE_ROOT:-/mnt/storage}
prefix=${ARRAY_PREFIX:-storage}
pool="$root/pool"
array_env=/status/array.env
# epmfs puts a new file on a drive that already holds its folder, so every folder, and so every
# Syncthing folder, stays on one drive and leaves with it as a whole.
options="cache.files=off,category.create=epmfs,moveonenospc=true,dropcacheonclose=true,allow_other,fsname=storage-pool,minfreespace=${POOL_MIN_FREE_SPACE:-4G}"
mergerfs_pid=

log() { echo "$(date -u +%FT%TZ) $*"; }

array_value() { sed -n "s/^$1=//p" "$array_env" 2>/dev/null; }

mounted_data_drives() {
    for target in "$root/$prefix"-data*; do
        [[ $(basename "$target") =~ ^${prefix}-data[0-9]+$ ]] && mountpoint -q "$target" && echo "$target"
    done
}

branch_mode() {   # <drive mount point>
    local readonly_drives
    [ "$(array_value share)" = ro ] && { echo RO; return; }
    readonly_drives=" $(array_value readonly) "
    [[ $readonly_drives == *" $(basename "$1") "* ]] && echo RO || echo RW
}

wanted_branches() {
    local target branches=()
    for target in $(mounted_data_drives); do branches+=("$target=$(branch_mode "$target")"); done
    (IFS=:; echo "${branches[*]}")
}

# A lazily unmounted pool lives on while a file in it is open; mergerfs is stopped so none of them can
# still be written to.
stop_pool() {
    mountpoint -q "$pool" && fusermount3 -u "$pool" 2>/dev/null || umount -l "$pool" 2>/dev/null
    [ -n "$mergerfs_pid" ] && { kill "$mergerfs_pid" 2>/dev/null; wait "$mergerfs_pid" 2>/dev/null; }
    mergerfs_pid=
}

# The branch modes only keep new files off a drive; a stopped array needs the mount itself read-only,
# which FUSE sets only when mounting.
mount_mode() { [ "$(array_value share)" = ro ] && echo ro || echo rw; }

start_pool() {   # <branches> <rw or ro>
    mkdir -p "$pool"
    mergerfs -f -o "$options,$2" "$1" "$pool" &
    mergerfs_pid=$!
    log "pool over $1 ($2)"
    create_service_folders
}

# Kopia writes its repository as root; a read-only pool keeps whatever is there.
create_service_folders() {
    for _ in $(seq 20); do mountpoint -q "$pool" && break; sleep 0.5; done
    mkdir -p "$pool/kopia" 2>/dev/null || true
}

# mergerfs swaps its branches in place through the control file, so open files and shares on the pool
# survive a drive appearing or vanishing.
set_branches_live() {   # <branches>
    mountpoint -q "$pool" && setfattr -n user.mergerfs.branches -v "$1" "$pool/.mergerfs" 2>/dev/null \
        && log "pool now over $1"
}

shut_down() { log "stopping: unmounting the pool"; stop_pool; exit 0; }
trap shut_down TERM INT

current=
current_mode=
while true; do
    wanted=$(wanted_branches)
    mode=$(mount_mode)
    if [ -z "$wanted" ]; then
        [ -n "$current" ] && { stop_pool; log "no data drive mounted; pool is down"; }
    elif ! mountpoint -q "$pool" || [ "$mode" != "$current_mode" ]; then
        stop_pool; start_pool "$wanted" "$mode"
    elif [ "$wanted" != "$current" ]; then
        set_branches_live "$wanted" || { stop_pool; start_pool "$wanted" "$mode"; }
    fi
    current=$wanted
    current_mode=$mode
    sleep 5 & wait $!
done
