#!/bin/bash
# Runs inside a privileged container of the SnapRAID image, for tests/nodes/migrate.sh: builds the real
# array's layout on loop devices over image files in /images, and checks it before and after the label
# migration. A loop device is only ever found by its own image file, so nothing else is touched.
set -u
images=/images
root=/mnt/storage
roles=(data1 data2 data3 data4 data5 parity1 parity2)

fail() { echo "lab: $*" >&2; exit 1; }
image_of() { echo "$images/$1.img"; }
loop_of() { losetup -j "$(image_of "$1")" -O NAME --noheadings | head -n 1; }
size_of() { case $1 in parity*) echo 400M ;; *) echo 300M ;; esac; }

refuse_real_labels() {
    local found
    found=$(blkid -c /dev/null -o value -s LABEL 2> /dev/null | grep -E '^storage-(data|parity)[0-9]+$' || true)
    [ -z "$found" ] || fail "drives labelled $(echo "$found" | tr '\n' ' ')are attached; this test needs those labels for itself"
}

create() {
    local role
    refuse_real_labels
    mkdir -p "$images"
    for role in "${roles[@]}"; do
        truncate -s "$(size_of "$role")" "$(image_of "$role")"
        losetup -f "$(image_of "$role")"
        mkfs.ext4 -q -F -m 0 -L "storage-$role" "$(loop_of "$role")"
    done
    echo "created ${roles[*]} as storage-*"
}

mount_by_label() {   # <prefix>
    local role
    for role in "${roles[@]}"; do
        mkdir -p "$root/$1-$role"
        mount "$(blkid -c /dev/null -L "$1-$role")" "$root/$1-$role" || fail "no drive labelled $1-$role"
    done
}

fill() {
    local role index
    mount_by_label storage
    for role in data1 data2 data3 data4 data5; do
        mkdir -p "$root/storage-$role/Files/$role"
        for index in 1 2 3 4; do head -c $(( (index * 7919 + ${role#data} * 104729) % 9000000 + 1000000 )) /dev/urandom > "$root/storage-$role/Files/$role/file$index.bin"; done
    done
    mkdir -p "$root/storage-data1/.storage/smart" "$root/storage-data2/.storage"
    for role in "${roles[@]}"; do echo "$root/storage-$role"; done > "$root/storage-data1/.storage/snapraid.drives"
    printf 'documents\tstorage-data2\nmusic\tstorage-data2 storage-data3\n' > "$root/storage-data1/.storage/syncthing-folder-drives"
    echo '{"serial":"none"}' > "$root/storage-data1/.storage/smart/storage-data4.json"
    {
        echo 'inventory_item_url = "https://inventree.example.ts.net/web/stock/item/"'
        for role in "${roles[@]}"; do printf '\n[%s]\nasset = "SAM-%04d"\nitem = %d\nserial = "SERIAL-%s"\n' "$role" "${#role}${role: -1}" "${role: -1}" "$role"; done
    } > "$root/storage-data1/.storage/array.toml"
    cp -a "$root/storage-data1/.storage/." "$root/storage-data2/.storage/"
    ARRAY_PREFIX=storage snapraid.sh config > /dev/null || fail "no config"
    /usr/bin/snapraid -c /status/arrays/storage/snapraid.conf sync > /tmp/sync.log 2>&1 || { tail -5 /tmp/sync.log; fail "the first sync failed"; }
    echo "synced $(find "$root"/storage-data*/Files -type f | wc -l) files: $(tail -n 1 /tmp/sync.log)"
    /usr/bin/snapraid -c /status/arrays/storage/snapraid.conf status 2>&1 | grep -E "No error detected|error" | head -3
    find "$root"/storage-data*/Files -type f -exec md5sum {} + | sed "s|$root/storage-||" | sort > "$images/checksums.before"
}

after() {   # <id>
    local id=$1 role output
    mount_by_label "$id"
    echo "--- labels"
    for role in "${roles[@]}"; do printf '%s ' "$(blkid -c /dev/null -o value -s LABEL "$(loop_of "$role")")"; done; echo
    echo "--- node.toml on every member"
    for role in "${roles[@]}"; do
        output=$(sed -n 's/^revision = //p; s/^name *= //p' "$root/$id-$role/.storage/node.toml" 2> /dev/null | tr '\n' ' ')
        echo "$role: ${output:-MISSING} members $(grep -c '^\[\[array.members\]\]' "$root/$id-$role/.storage/node.toml" 2> /dev/null)"
    done
    echo "--- data1 member of the description"
    sed -n '/role   = "data1"/,/^$/p' "$root/$id-data1/.storage/node.toml"
    echo "--- state files on data1"
    ls "$root/$id-data1/.storage" | tr '\n' ' '; echo
    echo "snapraid.drives: $(tr '\n' ' ' < "$root/$id-data1/.storage/snapraid.drives")"
    echo "syncthing-folder-drives: $(tr '\n' ';' < "$root/$id-data1/.storage/syncthing-folder-drives")"
    cmp -s "$root/$id-data1/.storage/snapraid.drives" "$root/$id-data2/.storage/snapraid.drives" && echo "data2's copy matches data1's"
    echo "--- files"
    find "$root/$id"-data*/Files -type f -exec md5sum {} + | sed "s|$root/$id-||" | sort > "$images/checksums.after"
    cmp -s "$images/checksums.before" "$images/checksums.after" && echo "every file reads as before ($(wc -l < "$images/checksums.after") files)" || echo "FILES DIFFER"
    echo "--- SnapRAID with the regenerated config"
    ARRAY_PREFIX=$id snapraid.sh --array "$id" config | grep -E '^(parity|2-parity|data) '
    /usr/bin/snapraid -c "/status/arrays/$id/snapraid.conf" status 2>&1 | grep -E "No error detected|rror" | head -3
    /usr/bin/snapraid -c "/status/arrays/$id/snapraid.conf" diff 2>&1 | grep -E "No differences|equal|removed|added" | head -4
    /usr/bin/snapraid -c "/status/arrays/$id/snapraid.conf" check 2>&1 | tail -n 3
}

hold() { mkdir -p /mnt/hold && mount "$(loop_of "$1")" /mnt/hold && echo "holding $1" && sleep "$2"; }

detach() { losetup -d "$(loop_of "$1")" && echo "detached $1"; }
attach() { losetup -f "$(image_of "$1")" && echo "attached $1 again"; }

remove() {
    local role loop
    for role in "${roles[@]}"; do
        for loop in $(losetup -j "$(image_of "$role")" -O NAME --noheadings); do losetup -d "$loop"; done
    done
    rm -rf "$images"/*
    echo "removed the test drives"
}

command=$1; shift
case $command in
    create) create ;;
    fill) fill ;;
    after) after "$@" ;;
    hold) hold "$@" ;;
    detach) detach "$@" ;;
    attach) attach "$@" ;;
    remove) remove ;;
    *) fail "unknown command $command" ;;
esac
