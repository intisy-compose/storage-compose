#!/bin/bash
# Moves an array from its legacy labels (storage-data1, ...) to labels carrying its own id
# (a3f9-data1, ...), run once in a one-off container while the stack is down. It changes the ext4
# labels and the stack's member files only: SnapRAID names its disks by role, so the config written
# afterwards with the same names keeps every parity block valid. It refuses unless every member is
# present and none is mounted anywhere, keeps snapraid.drives and array.toml as *.before-migration
# beside the new files, moves array.toml's assets and serials into the node file on every member,
# and can be run again after an interruption.
#   migrate-labels.sh [--from <prefix>] [--id <4 hex>] [--name <name>] [--dry-run] [--no-verify]
# The last line of a successful run is "migrated <id>".
set -u

from=${ARRAY_PREFIX:-storage}
id=
name=
dry_run=
verify=yes
work=/run/migrate
root=/mnt/storage
backup_suffix=before-migration
declare -A old_device new_device serial_of size_of asset_of
roles=()

# shellcheck source=../mounter/lib/nodefile.sh
source /usr/local/lib/storage/nodefile.sh

say() { echo "$*"; }
fail() { echo "migrate-labels: $*" >&2; release_mounts; exit 1; }

parse_arguments() {
    while [ $# -gt 0 ]; do
        case $1 in
            --from) from=${2:?--from needs a prefix}; shift 2 ;;
            --id) id=${2:?--id needs 4 lowercase hex digits}; shift 2 ;;
            --name) name=${2:?--name needs a name}; shift 2 ;;
            --dry-run) dry_run=yes; shift ;;
            --no-verify) verify=; shift ;;
            *) fail "unknown argument $1" ;;
        esac
    done
    [ -z "$id" ] || is_node_id "$id" || fail "--id must be 4 lowercase hex digits, not '$id'"
    [ -z "$name" ] || is_node_name "$name" || fail "--name must match [a-z0-9-], not '$name'"
    is_node_id "$from" && fail "the labels already carry the id $from; nothing to migrate"
}

scan_labels() {
    local device label
    while read -r device; do
        label=$(blkid -c /dev/null -o value -s LABEL "$device")
        if [[ $label =~ ^$from-(data|parity)[0-9]+$ ]]; then old_device[${label#"$from-"}]=$device
        elif [[ $label =~ ^[0-9a-f]{4}-(data|parity)[0-9]+$ ]]; then new_device[$label]=$device
        fi
    done < <(blkid -c /dev/null -t TYPE=ext4 -o device 2> /dev/null)
}

# The kernel refuses an exclusive open of a block device that is mounted, in any namespace.
is_in_use() { ! perl -MFcntl -e 'sysopen(my $handle, $ARGV[0], O_RDONLY | O_EXCL) or exit 1' "$1"; }

mounted_here=()
mount_device() {   # <device> <directory> <ro or rw>
    mkdir -p "$2"
    mount -o "$3,noatime" "$1" "$2" || fail "could not mount $1 at $2"
    mounted_here+=("$2")
}

release_mounts() {
    local directory
    for directory in "${mounted_here[@]}"; do mountpoint -q "$directory" && umount "$directory"; done
    mounted_here=()
}

device_of_role() {   # <role>: the member's device under its old label, or its new one after an interruption
    if [ -n "${old_device[$1]:-}" ]; then echo "${old_device[$1]}"
    elif [ -n "$id" ] && [ -n "${new_device[$id-$1]:-}" ]; then echo "${new_device[$id-$1]}"
    fi
}

# After an interruption data1 may already carry the new label; its backup of snapraid.drives tells.
find_state_drive() {   # sets state_device
    local label
    [ -n "${old_device[data1]:-}" ] && { state_device=${old_device[data1]}; return 0; }
    for label in "${!new_device[@]}"; do
        [[ $label == *-data1 ]] || continue
        mount_device "${new_device[$label]}" "$work/probe" ro
        if [ -f "$work/probe/.storage/snapraid.drives.$backup_suffix" ]; then
            [ -n "$id" ] && [ "$id" != "${label%-data1}" ] && fail "$label was being migrated to ${label%-data1}, not to $id"
            id=${label%-data1}
            release_mounts
            state_device=${new_device[$label]}
            return 0
        fi
        release_mounts
    done
    return 1
}

read_state_drive() {   # <data1 device>
    local state="$work/state/.storage" drives existing description_file
    mount_device "$1" "$work/state" ro
    drives="$state/snapraid.drives"
    [ -f "$drives" ] || fail "data1 holds no .storage/snapraid.drives; the array was never set up by this stack"
    [ -s "$state/snapraid.removing" ] && fail "a drive is being removed ($(tr '\n' ' ' < "$state/snapraid.removing")); finish that first"
    mapfile -t roles < <(sed 's|.*-||' "$drives" | grep -E '^(data|parity)[0-9]+$' | sort -V -u)
    [ ${#roles[@]} -gt 0 ] || fail "snapraid.drives lists no member"
    existing=$(node_file_json "$state/node.toml" 2> /dev/null || true)
    if [ -n "$existing" ]; then
        [ -z "$id" ] || [ "$(jq -r .node.id <<< "$existing")" = "$id" ] || fail "data1 already describes the array $(jq -r .node.id <<< "$existing")"
        id=$(jq -r .node.id <<< "$existing")
        name=${name:-$(jq -r .node.name <<< "$existing")}
    fi
    description_file="$state/array.toml"
    [ -f "$description_file" ] || description_file="$state/array.toml.$backup_suffix"
    read_array_toml "$description_file"
    release_mounts
}

read_array_toml() {   # <array.toml>
    local json role
    [ -f "$1" ] || return 0
    json=$(node_file_json "$1") || fail "$1 cannot be read"
    for role in "${roles[@]}"; do
        serial_of[$role]=$(jq -r --arg role "$role" '.[$role].serial // empty' <<< "$json")
        asset_of[$role]=$(jq -r --arg role "$role" '.[$role].asset // empty' <<< "$json")
    done
}

whole_disk() { local parent; parent=$(lsblk -no PKNAME "$1" 2> /dev/null | head -n 1); echo "${parent:+/dev/$parent}"; }

measured_serial() {   # <device>
    local disk serial
    disk=$(whole_disk "$1"); disk=${disk:-$1}
    serial=$(smartctl -j -i "$disk" 2> /dev/null | jq -r '.serial_number // empty' 2> /dev/null)
    [ -n "$serial" ] || serial=$(smartctl -j -i -d sat "$disk" 2> /dev/null | jq -r '.serial_number // empty' 2> /dev/null)
    [ -n "$serial" ] || serial=$(lsblk -dno SERIAL "$disk" 2> /dev/null | tr -d ' ')
    echo "$serial"
}

check_members() {
    local role device missing=() busy=() extra=()
    for role in "${roles[@]}"; do
        device=$(device_of_role "$role")
        if [ -z "$device" ]; then missing+=("$role"); continue; fi
        is_in_use "$device" && busy+=("$role ($device)")
        size_of[$role]=$(blockdev --getsize64 "$device")
        [ -n "${serial_of[$role]:-}" ] || serial_of[$role]=$(measured_serial "$device")
    done
    for role in "${!old_device[@]}"; do [[ " ${roles[*]} " == *" $role "* ]] || extra+=("$from-$role"); done
    [ ${#missing[@]} -eq 0 ] || fail "every member must be present; missing: ${missing[*]}"
    [ ${#busy[@]} -eq 0 ] || fail "the array must be stopped; mounted or in use: ${busy[*]}"
    [ ${#extra[@]} -eq 0 ] || fail "${extra[*]} carry the array's labels but are not in snapraid.drives; sync them into the array or relabel them first"
}

choose_id() {
    local candidate
    if [ -z "$id" ]; then
        for _ in $(seq 50); do
            candidate=$(new_node_id)
            printf '%s\n' "${!new_device[@]}" | grep -q "^$candidate-" || { id=$candidate; break; }
        done
    fi
    [ -n "$id" ] || fail "no free id found"
    name=${name:-private-array}
    for label in "${!new_device[@]}"; do
        [[ $label == "$id-"* ]] || continue
        [[ " ${roles[*]} " == *" ${label#"$id-"} "* ]] || fail "$label already exists outside this array; choose another --id"
    done
}

description_json() {
    local role members='[]'
    for role in "${roles[@]}"; do
        members=$(jq -c --arg role "$role" --arg label "$id-$role" --arg serial "${serial_of[$role]:-}" \
            --arg size "${size_of[$role]}" --arg asset "${asset_of[$role]:-}" \
            '. + [{role: $role, label: $label, serial: $serial, size: ($size | tonumber)} + (if $asset == "" then {} else {asset: $asset} end)]' <<< "$members")
    done
    jq -nc --arg id "$id" --arg name "$name" --argjson members "$members" \
        '{node: {id: $id, name: $name, kind: "array", threshold: 0, assigned: []}, array: {revision: 1, members: $members}}'
}

show_plan() {
    local role
    say "array $from becomes $id (\"$name\"):"
    for role in "${roles[@]}"; do
        say "  $(device_of_role "$role")  $from-$role -> $id-$role  serial ${serial_of[$role]:-unknown}  ${asset_of[$role]:+asset ${asset_of[$role]}}"
    done
}

# The stack state is on data1 and mirrored to data2; both copies are changed, so either one is right.
rewrite_state_folder() {   # <.storage folder>
    local folder=$1 file
    [ -f "$folder/snapraid.drives" ] || return 0
    [ -f "$folder/snapraid.drives.$backup_suffix" ] || cp -p "$folder/snapraid.drives" "$folder/snapraid.drives.$backup_suffix"
    if [ -f "$folder/array.toml" ]; then
        [ -f "$folder/array.toml.$backup_suffix" ] || cp -p "$folder/array.toml" "$folder/array.toml.$backup_suffix"
        rm -f "$folder/array.toml"
    fi
    sed -i -E "s#/$from-((data|parity)[0-9]+)\$#/$id-\\1#" "$folder/snapraid.drives"
    [ -f "$folder/syncthing-folder-drives" ] && sed -i -E "s/(^|[[:space:]])$from-((data|parity)[0-9]+)/\\1$id-\\2/g" "$folder/syncthing-folder-drives"
    for file in "$folder"/smart/"$from"-*.json; do
        [ -f "$file" ] && mv "$file" "$folder/smart/$id-${file##*/"$from"-}"
    done
    return 0
}

write_member_files() {
    local role json
    json=$(description_json)
    for role in "${roles[@]}"; do
        mount_device "$(device_of_role "$role")" "$work/members/$role" rw
        case $role in data1 | data2) rewrite_state_folder "$work/members/$role/.storage" ;; esac
        node_file_write "$(node_file_of "$work/members/$role")" "$json" || fail "could not write the node file on $role"
    done
    sync
    release_mounts
    say "wrote the node file on every member and moved the member files to the new labels"
}

relabel() {
    local role device
    for role in "${roles[@]}"; do
        device=$(device_of_role "$role")
        [ "$(blkid -c /dev/null -o value -s LABEL "$device")" = "$id-$role" ] && continue
        e2label "$device" "$id-$role" || fail "e2label $device failed"
        [ "$(blkid -c /dev/null -o value -s LABEL "$device")" = "$id-$role" ] || fail "$device does not read back as $id-$role"
        say "  $device is $id-$role"
    done
}

# SnapRAID's own view with the new labels: status reads every content file against the config, diff
# compares the disks with it. A sync is never run here.
verify_parity() {
    local role output
    for role in "${roles[@]}"; do mount_device "$(device_of_role "$role")" "$root/$id-$role" rw; done
    mkdir -p /status/arrays/"$id"
    ARRAY_PREFIX=$id snapraid.sh --array "$id" config > /dev/null || fail "no SnapRAID config could be written"
    say "SnapRAID config with the same disk names:"
    sed 's/^/  /' "/status/arrays/$id/snapraid.conf"
    output=$(/usr/bin/snapraid -c "/status/arrays/$id/snapraid.conf" status 2>&1) || { echo "$output"; fail "snapraid status failed"; }
    grep -q "No error detected" <<< "$output" || { echo "$output"; fail "snapraid status reports errors"; }
    say "snapraid status: No error detected."
    output=$(/usr/bin/snapraid -c "/status/arrays/$id/snapraid.conf" diff 2>&1)
    case $? in 0 | 2) ;; *) echo "$output"; fail "snapraid diff failed" ;; esac
    say "snapraid diff: $(grep -E '^ *[0-9]+ (equal|added|removed|updated|moved|copied|restored)' <<< "$output" | tr -s ' ' | paste -sd ',' | sed 's/,/, /g')"
    release_mounts
}

parse_arguments "$@"
trap 'release_mounts' EXIT
mkdir -p "$work"
scan_labels
find_state_drive || fail "no drive labelled $from-data1 found; it holds the member list"
read_state_drive "$state_device"
check_members
choose_id
show_plan
[ -n "$dry_run" ] && { say "dry run: nothing changed"; exit 0; }
write_member_files
say "relabelling:"
relabel
[ -n "$verify" ] && verify_parity
say "migrated $id"
