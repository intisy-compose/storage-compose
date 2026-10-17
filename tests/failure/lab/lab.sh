#!/bin/bash
# The test bench's commands, run inside the lab container by tests/failure/run.sh. A drive is a loop
# device over an image file with a device-mapper target on top, so a fault is a change of target: a
# drop is the device turning to errors and its node vanishing, as when a USB bridge resets; a return
# is a new device with the same filesystem.
set -u
export DM_DISABLE_UDEV=1

prefix=${ARRAY_PREFIX:?}
root=/mnt/storage
images=/images
status=/status/status.json
capture_log=/var/log/ntfy-capture.log
offset_sectors=2048
storage_api=http://127.0.0.1:8385/rest
peer_api=http://peer:8384/rest
peer_key=${PEER_API_KEY:?}
roles=(data1 data2 data3 parity1)

fail() { echo "lab: $*" >&2; exit 1; }

image_of() { echo "$images/$1.img"; }
loop_of() { losetup -j "$(image_of "$1")" -O NAME --noheadings | head -n 1; }
mapper_name() { echo "$prefix-$1"; }
size_of() { case $1 in parity*) echo 1600M ;; *) echo 1G ;; esac; }
sectors_of() { echo $(( $(blockdev --getsz "$(loop_of "$1")") - offset_sectors )); }
linear_table() { echo "0 $(sectors_of "$1") linear $(loop_of "$1") $offset_sectors"; }

# The filesystem starts past the loop device's first MiB, so only the mapper device carries the label.
create_drives() {
    local role
    mkdir -p "$images"
    for role in "${roles[@]}"; do
        rm -f "$(image_of "$role")"
        truncate -s "$(size_of "$role")" "$(image_of "$role")"
        losetup -f "$(image_of "$role")"
        dmsetup create "$(mapper_name "$role")" --table "$(linear_table "$role")"
        mkfs.ext4 -q -F -m 0 -L "$prefix-$role" "/dev/mapper/$(mapper_name "$role")"
    done
    echo "created ${roles[*]}"
}

dead_names() { dmsetup ls 2> /dev/null | awk -v name="$prefix-$1-dead" 'index($1, name) == 1 {print $1}'; }

swap_table() {   # <mapper name> <table>
    dmsetup reload "$1" --table "$2" && dmsetup resume "$1"
}

drop_drive() {   # <role>: its I/O fails and its device node goes, as a USB drive's does
    local name; name=$(mapper_name "$1")
    swap_table "$name" "0 $(sectors_of "$1") error"
    dmsetup rename "$name" "$name-dead-$(date +%s%N)"
    echo "dropped $1"
}

return_drive() {   # <role>: the same disk comes back as a new device
    local dead
    for dead in $(dead_names "$1"); do dmsetup remove --deferred "$dead" 2> /dev/null; done
    dmsetup create "$(mapper_name "$1")" --table "$(linear_table "$1")"
    echo "returned $1 as $(dm_node "$1")"
}

remove_drives() {
    local name role loop
    for name in $(dmsetup ls 2> /dev/null | awk -v prefix="$prefix-" 'index($1, prefix) == 1 {print $1}'); do
        dmsetup remove --force "$name" 2> /dev/null || dmsetup remove --deferred "$name" 2> /dev/null
    done
    for role in "${roles[@]}"; do
        for loop in $(losetup -j "$(image_of "$role")" -O NAME --noheadings); do losetup -d "$loop"; done
        rm -f "$(image_of "$role")"
    done
    echo "removed the test drives"
}

dm_node() { echo "/dev/dm-$(dmsetup info -c --noheadings -o minor "$(mapper_name "$1")" | tr -d ' ')"; }

# The fake smartctl in the mounter answers with /status/fake-smart/<kernel name>.json.
fake_smart() {   # <role> <pending> <reallocated>
    mkdir -p /status/fake-smart
    jq -n --arg serial "FAKE-$1" --argjson pending "$2" --argjson reallocated "$3" \
        '{serial_number: $serial, model_name: "Fake Disk", smart_status: {passed: true},
          ata_smart_attributes: {table: [{id: 5, raw: {value: $reallocated}}, {id: 197, raw: {value: $pending}}, {id: 198, raw: {value: 0}}]}}' \
        > "/status/fake-smart/$(basename "$(dm_node "$1")").json"
    echo "fake SMART for $1: pending $2, reallocated $3"
}

clear_fake_smart() { rm -rf /status/fake-smart; }

wait_for() {   # <jq condition on status.json> <timeout seconds>: prints the seconds it took
    local started=$SECONDS
    while [ $(( SECONDS - started )) -lt "$2" ]; do
        jq -e "$1" "$status" > /dev/null 2>&1 && { echo $(( SECONDS - started )); return 0; }
        sleep 1
    done
    echo "timeout"
    return 1
}

show_state() { jq -c '{state, complete, drives: [.drives[] | select(.condition != "present") | "\(.label) \(.condition) \(.detail)"], paused: .pausedFolders, split: [.splitFolders[].id]}' "$status"; }

write_result() {   # <shell command>: ok, or the error it ends with
    local output
    if output=$(sh -c "$1" 2>&1); then echo ok; else echo "${output##*: }"; fi
}

# A new file each time, removed again, so a retry never just rewrites what an earlier one created.
try_write() {   # <directory>
    local file
    file="$1/probe-$(date +%s%N)"
    write_result "echo test > '$file' && rm '$file'"
}

try_append() { write_result "echo test >> '$1'"; }   # <existing file>

storage_key() { sed -n 's:.*<apikey>\(.*\)</apikey>.*:\1:p' "$root/$prefix-data1/.storage/syncthing/config.xml"; }

storage_request() {   # <method> <path> [body]
    curl -fsS -m 10 -X "$1" -H "X-API-Key: $(storage_key)" -H 'Content-Type: application/json' ${3:+-d "$3"} "$storage_api$2"
}

peer_request() {
    curl -fsS -m 10 -X "$1" -H "X-API-Key: $peer_key" -H 'Content-Type: application/json' ${3:+-d "$3"} "$peer_api$2"
}

quiet_options='{"globalAnnounceEnabled":false,"localAnnounceEnabled":false,"relaysEnabled":false,"natEnabled":false,"urAccepted":-1,"crashReportingEnabled":false}'

write_files() {   # <directory> <count> <name prefix>
    local index
    mkdir -p "$1"
    for index in $(seq "$2"); do head -c 4096 /dev/urandom > "$1/$3$index.bin"; done
}

# Documents and its nested GitHub folder live on data2, Videos on data3, Music on both (a split
# folder), Backups on data1, Scratch on data2 and Spare on data3 outside Syncthing.
create_content() {
    write_files "$root/$prefix-data2/Documents" 3 doc
    write_files "$root/$prefix-data2/Documents/GitHub" 2 code
    write_files "$root/$prefix-data3/Videos" 2 video
    write_files "$root/$prefix-data2/Music" 1 song
    write_files "$root/$prefix-data3/Music" 1 tune
    write_files "$root/$prefix-data1/Backups" 2 backup
    mkdir -p "$root/$prefix-data2/Scratch" "$root/$prefix-data3/Spare"
    head -c 1048576 /dev/urandom > "$root/$prefix-data2/Scratch/rot.bin"
    chown -R 1000:1000 "$root/$prefix"-data*/{Documents,Videos,Music,Backups,Scratch,Spare} 2> /dev/null
    echo "content written"
}

folder_json() {   # <id> <path> <device id>
    jq -nc --arg id "$1" --arg path "$2" --arg device "$3" \
        '{id: $id, label: $id, path: $path, type: "sendreceive", rescanIntervalS: 3600, devices: [{deviceID: $device}]}'
}

device_json() { jq -nc --arg id "$1" --arg name "$2" --arg address "$3" '{deviceID: $id, name: $name, addresses: [$address]}'; }

storage_folders=(documents:Documents github:Documents/GitHub videos:Videos music:Music)

setup_syncthing() {
    local storage_id peer_id entry id path
    storage_id=$(storage_request GET /system/status | jq -r .myID) || fail "the array's Syncthing is not answering"
    peer_id=$(peer_request GET /system/status | jq -r .myID) || fail "the peer is not answering"
    storage_request PATCH /config/options "$quiet_options" > /dev/null
    peer_request PATCH /config/options "$quiet_options" > /dev/null
    storage_request POST /config/devices "$(device_json "$peer_id" peer tcp://peer:22000)" > /dev/null
    peer_request POST /config/devices "$(device_json "$storage_id" storage tcp://lab:22000)" > /dev/null
    for entry in "${storage_folders[@]}"; do
        id=${entry%%:*} path=${entry#*:}
        storage_request POST /config/folders "$(folder_json "$id" "$root/pool/$path" "$peer_id")" > /dev/null
        peer_request POST /config/folders "$(folder_json "$id" "/var/syncthing/$id" "$storage_id")" > /dev/null
    done
    storage_request POST "/db/ignores?folder=documents" '{"ignore":["/GitHub"]}' > /dev/null
    echo "syncthing set up: storage $storage_id, peer $peer_id"
}

folder_summary() {   # <api function> <folder>
    "$1" GET "/db/status?folder=$2" | jq -r '"\(.globalFiles) files, \(.globalDeleted) deleted, \(.needFiles) needed, \(.state)"'
}

peer_counts() {   # every folder: files on the peer's disk, and the peer's global index
    local entry id
    for entry in "${storage_folders[@]}"; do
        id=${entry%%:*}
        echo "$id: $(peer_file_count "$id") files on disk; index $(folder_summary peer_request "$id")"
    done
}

peer_file_count() { find "/peer/$1" -type f ! -path '*/.st*' 2> /dev/null | wc -l; }

wait_synced() {   # <timeout seconds>: until the peer holds every folder's files
    local started=$SECONDS entry id needed
    while [ $(( SECONDS - started )) -lt "$1" ]; do
        needed=0
        for entry in "${storage_folders[@]}"; do
            id=${entry%%:*}
            [ "$(peer_request GET "/db/status?folder=$id" 2> /dev/null | jq -r '.needFiles + (if .state == "idle" then 0 else 1 end) + (if .globalFiles > 0 then 0 else 1 end)')" = 0 ] || needed=1
        done
        [ "$needed" = 0 ] && { echo $(( SECONDS - started )); return 0; }
        sleep 2
    done
    echo timeout
    return 1
}

scan_all() {
    local entry
    for entry in "${storage_folders[@]}"; do
        storage_request POST "/db/scan?folder=${entry%%:*}" > /dev/null 2>&1 && echo "${entry%%:*} scanned" || echo "${entry%%:*} refused the scan"
    done
}

storage_paused() { storage_request GET /config/folders | jq -r '[.[] | select(.paused) | .id] | sort | join(" ")'; }

kopia_answers() { curl -sk -m 5 -o /dev/null -w '%{http_code}' https://kopia:51515/ 2> /dev/null | grep -qv '^000$' && echo running || echo paused; }

notifications_since() { awk -v since="$1" '$1 >= since' "$capture_log" 2> /dev/null | cut -d' ' -f3-; }

# Rewrites one block of a file on the disk itself, under the filesystem, as bit rot would.
corrupt_file() {   # <role> <path on the drive>
    local device block block_size
    device="/dev/mapper/$(mapper_name "$1")"
    block_size=$(dumpe2fs -h "$device" 2> /dev/null | awk -F: '/^Block size/ {gsub(/ /, "", $2); print $2}')
    block=$(debugfs -R "bmap /$2 0" "$device" 2> /dev/null | tail -n 1)
    echo 3 > /proc/sys/vm/drop_caches
    head -c 512 /dev/urandom | dd of="$device" bs=512 seek=$(( block * block_size / 512 )) conv=notrunc oflag=direct status=none
    echo 3 > /proc/sys/vm/drop_caches
    echo "corrupted 512 bytes of /$2 on $1 (block $block)"
}

dashboard_state() { curl -fsS -m 10 http://dashboard:8080/api/state | jq -r '.array.state'; }

checksum() { echo 3 > /proc/sys/vm/drop_caches; md5sum < "$1" | cut -d' ' -f1; }

clean_mount_points() {
    local directory
    for directory in "$root/$prefix"-*; do
        [ -d "$directory" ] && ! mountpoint -q "$directory" && chattr -i "$directory" 2> /dev/null; rmdir "$directory" 2> /dev/null
    done
    rmdir "$root/pool" 2> /dev/null
    echo "mount points removed"
}

serve() {
    touch "$capture_log"
    exec socat TCP-LISTEN:8080,fork,reuseaddr EXEC:/usr/local/bin/capture.sh
}

command=${1:-}
[ $# -gt 0 ] && shift
case $command in
    serve) serve ;;
    create-drives) create_drives ;;
    remove-drives) remove_drives ;;
    drop) drop_drive "$1" ;;
    return) return_drive "$1" ;;
    error) swap_table "$(mapper_name "$1")" "0 $(sectors_of "$1") error" && echo "$1 now returns I/O errors" ;;
    delay) swap_table "$(mapper_name "$1")" "0 $(sectors_of "$1") delay $(loop_of "$1") $offset_sectors $2" && echo "$1 delayed by $2 ms" ;;
    linear) swap_table "$(mapper_name "$1")" "$(linear_table "$1")" && echo "$1 back to normal" ;;
    dm-node) dm_node "$1" ;;
    fake-smart) fake_smart "$@" ;;
    clear-fake-smart) clear_fake_smart ;;
    wait) wait_for "$1" "$2" ;;
    state) show_state ;;
    try-write) try_write "$1" ;;
    try-append) try_append "$1" ;;
    content) create_content ;;
    setup-syncthing) setup_syncthing ;;
    wait-synced) wait_synced "$1" ;;
    peer-counts) peer_counts ;;
    storage-summary) for entry in "${storage_folders[@]}"; do echo "${entry%%:*}: $(folder_summary storage_request "${entry%%:*}")"; done ;;
    scan-all) scan_all ;;
    storage-paused) storage_paused ;;
    kopia) kopia_answers ;;
    notifications-since) notifications_since "$1" ;;
    corrupt) corrupt_file "$1" "$2" ;;
    now) date +%s ;;
    query) jq -r "$1" "$status" ;;
    dashboard-state) dashboard_state ;;
    checksum) checksum "$1" ;;
    clean-mount-points) clean_mount_points ;;
    *) fail "unknown command '$command'" ;;
esac
