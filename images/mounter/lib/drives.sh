# shellcheck shell=bash
# Finding, mounting and losing array drives. What the mounter knows about a drive lives in
# $runtime/drives/<label>/, one file per fact.

record_dir() { echo "$runtime/drives/$1"; }
record_get() { cat "$(record_dir "$1")/$2" 2>/dev/null; }
record_set() { mkdir -p "$(record_dir "$1")" && echo "$3" > "$(record_dir "$1")/$2"; }
record_clear() { rm -f "$(record_dir "$1")/$2"; }

mount_point() { echo "$root/$1"; }
is_mounted() { mountpoint -q "$(mount_point "$1")"; }
is_data_label() { [[ $1 =~ ^$prefix-data[0-9]+$ ]]; }

mounted_labels() {
    local target label
    for target in "$root/$prefix"-*; do
        label=${target##*/}
        [[ $label =~ $label_pattern ]] && mountpoint -q "$target" && echo "$label"
    done
}

# blkid's cache would still list a drive that has dropped off, so every lookup reads the disks.
array_devices() {
    local device label
    blkid -c /dev/null -t TYPE=ext4 -o device 2>/dev/null | while read -r device; do
        label=$(blkid -c /dev/null -o value -s LABEL "$device")
        [[ $label =~ $label_pattern ]] && echo "$device $label"
    done
}

kernel_device_dir() {   # <device node>: its directory under /sys/dev/block
    local numbers
    numbers=$(stat -Lc '%t %T' "$1" 2>/dev/null) || return 1
    set -- $numbers
    echo "/sys/dev/block/$((16#$1)):$((16#$2))"
}

whole_disk_dir() {
    local directory
    directory=$(kernel_device_dir "$1") || return 1
    [ -e "$directory/partition" ] && directory=$(readlink -f "$directory/..")
    readlink -f "$directory"
}

whole_disk_node() { local directory; directory=$(whole_disk_dir "$1") && echo "/dev/${directory##*/}"; }

# diskseq grows with every disk the kernel sets up, so a drive that dropped off and came back under
# the same name still reads as a different disk.
diskseq_of() { local directory; directory=$(whole_disk_dir "$1") && cat "$directory/diskseq" 2>/dev/null; }

usb_port_of() { whole_disk_dir "$1" | tr / '\n' | grep -E '^[0-9]+-[0-9.]+$' | tail -n 1 || true; }

remember_device() {   # <label> <device>
    local sequence
    sequence=$(diskseq_of "$2")
    record_set "$1" device "$2"
    record_set "$1" diskseq "$sequence"
    record_set "$1" usb_port "$(usb_port_of "$2")"
    record_set "$1" generation "$sequence-$(date +%s)"
}

still_attached() {
    local device
    device=$(record_get "$1" device)
    [ -b "$device" ] && [ "$(diskseq_of "$device")" = "$(record_get "$1" diskseq)" ]
}

# An empty mount point is made immutable, so nothing written to the pool while its drive is away
# lands on the host's disk underneath it.
prepare_mount_point() { mkdir -p "$1"; chattr +i "$1" 2>/dev/null || true; }

# e2fsck -p makes only the repairs that are always safe; a drive that needs more had more than a drop.
check_filesystem() {   # <label> <device>
    local status=0
    e2fsck -p "$2" >> "$runtime/fsck.log" 2>&1 || status=$?
    [ "$status" -le 1 ] && return 0
    record_set "$1" fsck_failed "$(diskseq_of "$2")"
    log "$1 needs a manual fsck (e2fsck exit $status on $2, see $runtime/fsck.log)"
    return 1
}

failed_check_before() { [ -n "$(record_get "$1" fsck_failed)" ] && [ "$(record_get "$1" fsck_failed)" = "$(diskseq_of "$2")" ]; }
was_away() { [ -n "$(record_get "$1" absent_since)" ]; }
is_usable() { ! was_away "$1" && is_mounted "$1"; }
state_dir_is_writable() { is_usable "$prefix-data1" && ! went_read_only "$prefix-data1"; }

# The dead device can linger under another name with its superblock still cached, label and all.
is_the_lost_disk() {   # <label> <device>
    was_away "$1" && [ "$(diskseq_of "$2")" = "$(record_get "$1" diskseq)" ]
}

note_return() {
    local since
    since=$(record_get "$1" absent_since)
    record_clear "$1" absent_since
    record_clear "$1" power_cycled
    record_clear "$1" fsck_failed
    record_clear "$1" smart_checked
    record_clear "$1" held_read_only
    [ -n "$since" ] && record_set "$1" back_after $(( $(date +%s) - since ))
}

mount_drive() {   # <device> <label>
    local device=$1 label=$2 target
    target=$(mount_point "$label")
    is_the_lost_disk "$label" "$device" && return 1
    failed_check_before "$label" "$device" && return 1
    if was_away "$label"; then check_filesystem "$label" "$device" || return 1; fi
    prepare_mount_point "$target"
    mount -o noatime,errors=remount-ro "$device" "$target" || { log "FAILED to mount $label from $device"; return 1; }
    is_data_label "$label" && chown "$service_user_id:$service_user_id" "$target"
    remember_device "$label" "$device"
    log "mounted $label from $device"
    note_return "$label"
}

mount_found_drives() {
    local device label
    array_devices | while read -r device label; do
        is_mounted "$label" || mount_drive "$device" "$label"
    done
}

# A drive that drops off the bus leaves its mount behind, on a device that is gone. It is unmounted a
# round later: until then the pool answers for it with errors, never with an empty folder, while the
# Syncthing folders it touches are paused.
notice_lost_drives() {
    local label target
    for label in $(mounted_labels); do
        was_away "$label" && continue
        target=$(mount_point "$label")
        [ -n "$(record_get "$label" device)" ] || remember_device "$label" "$(findmnt -no SOURCE "$target")"
        still_attached "$label" && continue
        record_set "$label" absent_since "$(date +%s)"
        log "$label dropped off ($(record_get "$label" device) is gone); waiting for it"
    done
}

unmount_lost_drives() {
    local label
    for label in $(mounted_labels); do
        was_away "$label" && umount -l "$(mount_point "$label")" && log "unmounted $label, which is away"
    done
}

port_switch() {   # <usb port>: its power switch on the hub above it, 2-2.1 is port 1 of hub 2-2
    local port=$1 hub
    case $port in
        *.*) hub=${port%.*}; echo "/sys/bus/usb/devices/$hub:1.0/$hub-port${port##*.}/disable" ;;
        *) hub=${port%%-*}; echo "/sys/bus/usb/devices/$hub-0:1.0/usb$hub-port${port#*-}/disable" ;;
    esac
}

# The kernel gives up on a device that fails to enumerate after a drop; switching its port off and on
# makes it try again. When the hub itself is gone, the port the hub hangs on is switched instead.
power_cycle() {   # <usb port>
    local port=$1 switch
    while [ -n "$port" ]; do
        switch=$(port_switch "$port")
        if [ -e "$switch" ]; then
            log "switching usb port $port off and on"
            { echo 1 > "$switch" && sleep 5 && echo 0 > "$switch"; } 2> /dev/null || true
            return 0
        fi
        case $port in *.*) port=${port%.*} ;; *) port= ;; esac
    done
}

absent_seconds() { local since; since=$(record_get "$1" absent_since); echo $(( $(date +%s) - ${since:-$(date +%s)} )); }

revive_absent_drives() {
    local label
    for label in $(known_labels); do
        was_away "$label" || continue
        [ -z "$(record_get "$label" power_cycled)" ] || continue
        [ "$(absent_seconds "$label")" -ge $(( drop_grace / 2 )) ] || continue
        record_set "$label" power_cycled yes
        power_cycle "$(record_get "$label" usb_port)"
    done
}
