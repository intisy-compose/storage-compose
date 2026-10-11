#!/bin/bash
# Keeps one mergerfs view of every mounted data drive at $STORAGE_ROOT/pool, and remounts it when a
# data drive appears or vanishes.
set -u

root=${STORAGE_ROOT:-/mnt/storage}
prefix=${ARRAY_PREFIX:-storage}
pool="$root/pool"
options="cache.files=off,category.create=mfs,moveonenospc=true,dropcacheonclose=true,allow_other,fsname=storage-pool,minfreespace=${POOL_MIN_FREE_SPACE:-4G}"
mergerfs_pid=

log() { echo "$(date -u +%FT%TZ) $*"; }

mounted_data_drives() {
    for target in "$root/$prefix"-data*; do
        [[ $(basename "$target") =~ ^${prefix}-data[0-9]+$ ]] && mountpoint -q "$target" && echo "$target"
    done
}

stop_pool() {
    mountpoint -q "$pool" && fusermount3 -u "$pool" 2>/dev/null || umount -l "$pool" 2>/dev/null
    [ -n "$mergerfs_pid" ] && wait "$mergerfs_pid" 2>/dev/null
    mergerfs_pid=
}

start_pool() {
    local branches; branches=$(IFS=:; echo "$*")
    mkdir -p "$pool"
    mergerfs -f -o "$options" "$branches" "$pool" &
    mergerfs_pid=$!
    log "pool over $*"
    create_service_folders
}

# Syncthing and Samba run as uid 1000; Kopia writes its repository as root.
create_service_folders() {
    for _ in $(seq 20); do mountpoint -q "$pool" && break; sleep 0.5; done
    mkdir -p "$pool/sync" "$pool/kopia"
    chown 1000:1000 "$pool/sync"
}

# mergerfs swaps its branches in place through the control file, so open files and shares on the pool
# survive a drive appearing or vanishing.
set_branches_live() {
    local branches; branches=$(IFS=:; echo "$*")
    mountpoint -q "$pool" && setfattr -n user.mergerfs.branches -v "$branches" "$pool/.mergerfs" 2>/dev/null \
        && log "pool now over $*"
}

shut_down() { log "stopping: unmounting the pool"; stop_pool; exit 0; }
trap shut_down TERM INT

current=
while true; do
    wanted=$(mounted_data_drives | tr '\n' ' ')
    if [ -z "$wanted" ]; then
        [ -n "$current" ] && { stop_pool; log "no data drive mounted; pool is down"; }
    elif ! mountpoint -q "$pool"; then
        stop_pool; start_pool $wanted
    elif [ "$wanted" != "$current" ]; then
        set_branches_live $wanted || { stop_pool; start_pool $wanted; }
    fi
    current=$wanted
    sleep 10 & wait $!
done
