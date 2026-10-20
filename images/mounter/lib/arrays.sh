# shellcheck shell=bash
# Which arrays this host has, and switching the mounter between them. Each array has its own lock on
# its data1, its own status in /status/arrays/<id>/ and its own runtime notes; the cluster's status is
# also linked at /status/, where the services that serve it read it.

select_array() {   # <id>
    prefix=$1
    label_pattern="^${prefix}-(data|parity)[0-9]+$"
    state_dir="$root/$prefix-data1/.storage"
    mirror_dir="$root/$prefix-data2/.storage"
    status_dir="$status_root/arrays/$prefix"
    array_runtime="$runtime/arrays/$prefix"
    mkdir -p "$status_dir" "$array_runtime"
}

devices_file() { echo "$runtime/devices"; }

probes_file() { echo "$runtime/probes"; }

# diskseq grows with every disk the kernel sets up, a partition takes its disk's; with the size it
# tells a device that is new or changed from one already probed.
device_key() {   # <sysfs block directory>
    local directory sequence
    directory=$(readlink -f "$1")
    sequence=$(cat "$directory/diskseq" 2> /dev/null || cat "$directory/../diskseq" 2> /dev/null)
    echo "$(cat "$directory/size" 2> /dev/null)-${sequence:-0}"
}

# A device-mapper device is named by its mapper path, which goes when the device is renamed away,
# as the kernel's dm-N name does not.
device_path() {   # <sysfs block directory>
    local mapper_name
    mapper_name=$(cat "$1/dm/name" 2> /dev/null)
    if [ -n "$mapper_name" ]; then echo "/dev/mapper/$mapper_name"; else echo "/dev/${1##*/}"; fi
}

ext4_labels_of() {   # <device>...: "<device> <label>" for each that holds ext4, probed in one call
    [ $# -gt 0 ] || return 0
    blkid -c /dev/null -o export -s TYPE -s LABEL "$@" 2> /dev/null | awk -F= '
        /^DEVNAME=/ {device = $2; type = ""; label = ""}
        /^TYPE=/ {type = $2}
        /^LABEL=/ {label = substr($0, 7)}
        /^$/ {if (type == "ext4" && device != "") print device, label; device = ""}
        END {if (type == "ext4" && device != "") print device, label}'
}

# Probing reads each device, which is slow on a host with many or slow ones, so a scan probes only
# the devices that are new or changed since the last one; the safety poll probes them all, which
# also catches a label changed in place. blkid's own cache would still list a drive that has dropped
# off, so it is never used.
scan_devices() {   # [all]
    local directory name key path label index
    declare -A known_key known_label probed_label
    local changed=() names=() keys=() paths=()
    [ -f "$(probes_file)" ] && while read -r name key path label; do known_key[$name]=$key; known_label[$name]=$label; done < "$(probes_file)"
    for directory in /sys/class/block/*; do
        name=${directory##*/}
        path=$(device_path "$directory")
        key="$(device_key "$directory")-${path##*/}"
        [[ $key == 0-* ]] && continue
        names+=("$name"); keys+=("$key"); paths+=("$path")
        if [ "${1:-}" = all ] || [ "${known_key[$name]:-}" != "$key" ]; then changed+=("$path"); fi
    done
    while read -r path label; do probed_label[$path]=$label; done < <(ext4_labels_of "${changed[@]}")
    for index in "${!names[@]}"; do
        name=${names[$index]} path=${paths[$index]}
        if [[ " ${changed[*]} " == *" $path "* ]]; then label=${probed_label[$path]:-}; else label=${known_label[$name]:-}; fi
        echo "$name ${keys[$index]} $path $label"
    done > "$(probes_file).new"
    mv "$(probes_file).new" "$(probes_file)"
    while read -r name key path label; do
        [[ ${label:-} =~ $any_array_label ]] && echo "$path $label"
    done < "$(probes_file)" > "$(devices_file).new"
    mv "$(devices_file).new" "$(devices_file)"
}

# The cluster first; an array stays known for the session once seen, so its drives can be missed.
known_arrays() {
    { echo "$cluster"; sed -E 's/^[^ ]+ (.+)-(data|parity)[0-9]+$/\1/' "$(devices_file)" 2> /dev/null; ls "$runtime/arrays" 2> /dev/null; } |
        awk 'NF && !seen[$0]++'
}

lock_holder_is_live_elsewhere() {
    local lock="$state_dir/lock" holder seen
    [ -f "$lock" ] || return 1
    read -r holder seen < "$lock"
    [ "$holder" != "$node" ] && [ $(( $(date +%s) - seen )) -lt "$lock_timeout" ]
}

write_lock() {
    state_dir_is_writable || return 0
    mkdir -p "$state_dir" && echo "$node $(date +%s)" > "$state_dir/lock.tmp" && mv "$state_dir/lock.tmp" "$state_dir/lock"
}

release_lock() {
    local holder
    [ -f "$state_dir/lock" ] && read -r holder _ < "$state_dir/lock" && [ "$holder" = "$node" ] && rm -f "$state_dir/lock"
}

mirror_state() {
    state_dir_is_writable && is_usable "$prefix-data2" || return 0
    rsync -a --delete "$state_dir/" "$mirror_dir/"
}

unmount_all() {
    local target
    for target in "$root/$prefix"-*; do
        [[ ${target##*/} =~ $label_pattern ]] && mountpoint -q "$target" && umount "$target" && log "unmounted ${target##*/}"
    done
}

is_held_elsewhere() { [ -s "$array_runtime/held_by" ]; }

write_held_status() {   # <holder>
    jq -n --arg id "$prefix" --arg node "$node" --arg updated "$(date -u +%FT%TZ)" --arg holder "$1" \
        '{id: $id, name: $id, node: $node, updated: $updated, state: "stopped", since: $updated, complete: false, present: false,
          reasons: ["in use by \($holder)"], drives: [], splitFolders: [], pausedFolders: [], description: null}' |
        write_atomically "$status_dir/status.json"
    printf 'state=stopped\ncomplete=no\nshare=ro\nreadonly=\ngeneration=\n' | write_atomically "$status_dir/array.env"
}

# Another host's live lock means the drives moved here without a clean stop; this host leaves the
# whole array alone until the lock expires. The cluster is checked once, at the start.
claim_array() {
    local holder
    [ "$prefix" = "$cluster" ] && return 0
    is_mounted "$prefix-data1" || return 0
    if ! lock_holder_is_live_elsewhere; then write_lock; return 0; fi
    holder=$(cut -d' ' -f1 "$state_dir/lock")
    log "array $prefix is in use by $holder (seen less than ${lock_timeout}s ago); leaving it alone"
    echo "$holder" > "$array_runtime/held_by"
    unmount_all
    write_held_status "$holder"
    return 1
}

link_cluster_status() {
    local name
    for name in status.json array.env syncthing.pause snapraid.json; do
        ln -sfn "arrays/$cluster/$name" "$status_root/$name"
    done
}

description_file() { echo "$array_runtime/description.json"; }
array_description() { cat "$(description_file)" 2> /dev/null; }

array_display_name() {
    local name
    name=$(jq -r '.node.name // empty' "$(description_file)" 2> /dev/null)
    if [ -n "$name" ]; then echo "$name"; elif [ "$prefix" = "$cluster" ]; then echo storage; else echo "$prefix"; fi
}

new_array_description() {
    jq -nc --arg id "$prefix" '{node: {id: $id, name: $id, kind: "array", threshold: 0, assigned: []}, array: {revision: 0, members: []}}'
}

drive_size() { blockdev --getsize64 "$(record_get "$1" device)" 2> /dev/null; }

# A drive mounted for the first time joins the description; a member's size is kept current and its
# serial filled in once known, never overwritten, so a replaced drive shows as a different one until
# a rebuild records it.
with_mounted_members() {   # <description json>
    local json=$1 label size serial
    for label in $(mounted_labels); do
        size=$(drive_size "$label")
        serial=$(record_get "$label" serial)
        json=$(jq -c --arg label "$label" --arg role "${label#"$prefix-"}" --arg size "${size:-}" --arg serial "${serial:-}" '
            ($size | tonumber? // null) as $size
            | (.array.members | map(.label) | index($label)) as $at
            | if $at == null then .array.members += [{role: $role, label: $label, serial: $serial, size: $size}] | .changed = true
              else (.array.members[$at]) as $member
                | (if $size != null and $member.size != $size then .array.members[$at].size = $size | .changed = true else . end)
                | (if ($member.serial // "") == "" and $serial != "" then .array.members[$at].serial = $serial | .changed = true else . end)
              end' <<< "$json")
    done
    jq -c 'if .changed then .array.revision += 1 else . end | del(.changed) | .array.members |= sort_by(.role | [(if startswith("parity") then 1 else 0 end), (ltrimstr("data") | ltrimstr("parity") | tonumber? // 0)])' <<< "$json"
}

member_node_files() {
    local label
    for label in $(mounted_labels); do
        is_usable "$label" && ! went_read_only "$label" && node_file_of "$(mount_point "$label")"
    done
}

# Every member carries the whole description and the newest copy wins; it is written back to every
# member whose copy is older or missing. An array with the legacy prefix gets its first description
# from migrate-labels instead.
keep_array_description() {
    local files json file
    mapfile -t files < <(member_node_files)
    if ! is_node_id "$prefix"; then
        rm -f "$(description_file)"
        return 0
    fi
    [ ${#files[@]} -gt 0 ] || return 0
    json=$(newest_array_description "$prefix" "${files[@]}") || json=$(new_array_description)
    json=$(with_mounted_members "$json")
    for file in "${files[@]}"; do
        [ "$(node_file_json "$file" 2> /dev/null)" = "$json" ] && continue
        node_file_write "$file" "$json" && log "wrote the description of $prefix (revision $(jq -r .array.revision <<< "$json")) to ${file%/.storage/node.toml}"
    done
    echo "$json" | write_atomically "$(description_file)"
}

start_event_watchers() {
    mkfifo "$events"
    exec 3<> "$events"
    inotifywait -m -q -e create,delete --format '%f' /dev /dev/mapper 2> /dev/null >&3 &
    findmnt --poll -n -r -o TARGET 2> /dev/null | grep --line-buffered "^$node_volumes" >&3 &
}

stop_event_watchers() { local job; for job in $(jobs -p); do kill "$job" 2> /dev/null; done; }

# A disk brings several nodes at once (the disk, its partitions, a mapper name), so the events of one
# arrival are taken together.
wait_for_event() {   # <seconds>: whether a device or mount event came within them
    read -r -t "$1" -u 3 _ || return 1
    while read -r -t 1 -u 3 _; do :; done
    return 0
}

# The cluster's pool keeps the path its Samba share, Syncthing folders and Kopia repository use.
pool_path() { if [ "$prefix" = "$cluster" ]; then echo "$root/pool"; else echo "$root/pool-$prefix"; fi; }

# A drive formatted in place (rebuild, add) brings no device event, so the job asks for a discovery.
take_discovery_request() { [ -e "$status_root/discover" ] && rm -f "$status_root/discover"; }

# The dashboard cannot run commands here, so it leaves the role in a request file.
take_accept_smart_request() {
    local request="$status_dir/accept-smart.request" role
    [ -f "$request" ] || return 0
    role=$(head -n 1 "$request")
    rm -f "$request"
    is_data_label "$prefix-$role" || [[ $role =~ ^parity[0-9]+$ ]] || return 0
    log "$(accept_smart "$role")"
}

# A loop device being attached, or a disk resized, brings no device node and so no event; the sizes
# the kernel lists in sysfs show it without reading any disk.
block_devices_changed() {
    local signature
    signature=$(cat /sys/class/block/*/size 2> /dev/null | md5sum)
    [ "$signature" = "${last_block_signature:-}" ] && return 1
    last_block_signature=$signature
    return 0
}
