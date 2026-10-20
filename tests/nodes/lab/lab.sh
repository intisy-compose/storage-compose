#!/bin/bash
# The nodes test's commands, run inside the lab container by tests/nodes/run.sh. A drive is a loop
# device over an image file in /images and is only ever found by that file.
set -u
images=/images
volumes=/volumes

fail() { echo "lab: $*" >&2; exit 1; }
image_of() { echo "$images/$1.img"; }
loop_of() { losetup -j "$(image_of "$1")" -O NAME --noheadings | head -n 1; }

drive() {   # <label> <size>
    truncate -s "$2" "$(image_of "$1")"
    losetup -f "$(image_of "$1")"
    mkfs.ext4 -q -F -m 0 -L "$1" "$(loop_of "$1")"
    echo "made $1 on $(loop_of "$1")"
}

array() {   # <prefix> <data drives> [data size] [parity size]: and one parity drive
    local index
    mkdir -p "$images"
    for index in $(seq "$2"); do drive "$1-data$index" "${3:-200M}"; done
    drive "$1-parity1" "${4:-260M}"
}

node_file() {   # <path> <id> <name> <kind> <threshold>
    mkdir -p "$1/.storage"
    printf '[node]\nid        = "%s"\nname      = "%s"\nkind      = "%s"\nthreshold = %s\nassigned  = []\n' "$2" "$3" "$4" "$5" > "$1/.storage/node.toml"
}

# A stick holding a folder node, and a disk that is a drive node, mounted where the host's
# automounter would put them.
volumes() {
    drive stick 64M
    drive disk 64M
    mkdir -p "$volumes/stick" "$volumes/disk"
    mount "$(loop_of stick)" "$volumes/stick"
    mount "$(loop_of disk)" "$volumes/disk"
    mkdir -p "$volumes/stick/files" "$volumes/stick/.storage" "$volumes/stick/iso"
    echo 'paths = ["files"]' > "$volumes/stick/.storage/nodes.toml"
    node_file "$volumes/stick/files" 5c1c ventoy-files folder 80
    node_file "$volumes/disk" d15c p53-data drive 30
    chown -R 1000:1000 "$volumes/stick/files" "$volumes/disk"
    echo "mounted the stick and the disk"
}

fill() {   # <mount point> <megabytes>
    mkdir -p "$1/Files"
    head -c "$(( $2 * 1048576 ))" /dev/urandom > "$1/Files/big.bin"
    chown -R 1000:1000 "$1/Files"
}

unmount_volumes() {
    local target
    for target in "$volumes"/*; do mountpoint -q "$target" && umount "$target"; rmdir "$target" 2> /dev/null; done
    return 0
}

remove() {
    local image loop
    unmount_volumes
    for image in "$images"/*.img; do
        [ -f "$image" ] || continue
        for loop in $(losetup -j "$image" -O NAME --noheadings); do losetup -d "$loop"; done
        rm -f "$image"
    done
    echo "removed the test drives"
}

detach() { losetup -d "$(loop_of "$1")" && echo "detached $1"; }

api() {   # <path> [jq filter]
    if [ $# -gt 1 ]; then curl -fsS -m 20 "http://dashboard:8080$1" | jq -r "$2"; else curl -fsS -m 20 "http://dashboard:8080$1"; fi
}

registry() {
    local entry
    for entry in /status/nodes/*.json; do
        [[ ${entry##*/} =~ ^[0-9a-f]{4}\.json$ ]] && jq -r '"\(.id) \(.kind) \(.name)"' "$entry"
    done | sort | tr '\n' ';'
}

watch_job() {   # <array id> <seconds>: the first parity job the API shows, polled several times a second
    local deadline=$(( SECONDS + $2 )) job
    while [ "$SECONDS" -lt "$deadline" ]; do
        job=$(curl -fsS -m 5 http://dashboard:8080/api/nodes | jq -r --arg id "$1" '.nodes[] | select(.id == $id) | .array.parity.job // empty | "\(.kind) \(.progress)"')
        [ -n "$job" ] && { echo "$job"; return 0; }
        sleep 0.3
    done
    return 1
}

post() {   # <path> <json>: the status code and the answer
    curl -sS -m 20 -o /tmp/answer -w '%{http_code}' -H 'Content-Type: application/json' -d "$2" "http://dashboard:8080$1"
    echo " $(cat /tmp/answer)"
}

clean_mount_points() {
    local directory
    for directory in /mnt/storage/*; do
        [ -d "$directory" ] && ! mountpoint -q "$directory" && { chattr -i "$directory" 2> /dev/null; rmdir "$directory" 2> /dev/null; }
    done
    return 0
}

command=${1:-serve}
[ $# -gt 0 ] && shift
case $command in
    serve) exec sleep infinity ;;
    array) array "$@" ;;
    volumes) volumes ;;
    fill) fill "$@" ;;
    detach) detach "$@" ;;
    remove) remove ;;
    unmount-volumes) unmount_volumes ;;
    api) api "$@" ;;
    registry) registry ;;
    watch-job) watch_job "$@" ;;
    post) post "$@" ;;
    clean-mount-points) clean_mount_points ;;
    *) fail "unknown command '$command'" ;;
esac
