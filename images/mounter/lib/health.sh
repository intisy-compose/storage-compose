# shellcheck shell=bash
# Whether a mounted drive still deserves writes: its filesystem has not gone read-only after an error,
# and its SMART counts have not risen since its first check.

# ext4 reports errors=remount-ro as emergency_ro on newer kernels, as ro on older ones.
went_read_only() { findmnt -no OPTIONS "$(mount_point "$1")" | grep -qE '(^|,)(ro|emergency_ro)(,|$)'; }

# -n standby leaves a sleeping drive asleep; it is checked at the next round instead.
smart_report() {   # <disk node>: smartctl's JSON from the first device type that answers
    local type output
    for type in auto sat; do
        output=$(smartctl -j -n standby -i -H -A -d "$type" "$1" 2> /dev/null)
        jq -e '.smart_status' <<< "$output" > /dev/null 2>&1 && { echo "$output"; return 0; }
    done
    return 1
}

smart_values() {
    jq -c '
        def attribute($id): [.ata_smart_attributes.table[]? | select(.id == $id) | .raw.value][0];
        { serial: .serial_number, passed: .smart_status.passed,
          reallocated: attribute(5), pending: attribute(197), uncorrectable: attribute(198),
          media_errors: .nvme_smart_health_information_log.media_errors }'
}

smart_rises() {   # <values> <baseline>: the counts that rose, as text
    jq -rn --argjson now "$1" --argjson base "$2" '
        ["reallocated", "pending", "uncorrectable", "media_errors"]
        | map(select(($now[.] // 0) > ($base[.] // 0)) | "\(.) \($base[.] // 0) to \($now[.])")
        | join(", ")'
}

smart_baseline_file() { echo "$state_dir/smart/$1.json"; }

serial_or_label() {   # <values> <label>: bridges that hide the serial key the baseline by the role
    local serial
    serial=$(jq -r '.serial // empty' <<< "$1")
    echo "${serial:-$2}"
}

# The values at a drive's first check are its baseline, so a drive that came with bad sectors is
# judged by change, not by the absolute number.
judge_smart() {   # <label> <values>: why the drive is failing, or nothing
    local baseline_file rises reason=
    baseline_file=$(smart_baseline_file "$(serial_or_label "$2" "$1")")
    [ -s "$baseline_file" ] || { mkdir -p "${baseline_file%/*}" && echo "$2" > "$baseline_file"; }
    [ "$(jq -r '.passed' <<< "$2")" = false ] && reason="SMART health check failed"
    rises=$(smart_rises "$2" "$(cat "$baseline_file")")
    [ -n "$rises" ] && reason="${reason:+$reason; }SMART $rises"
    echo "$reason"
}

check_smart() {   # <label>
    local report
    record_set "$1" smart_checked "$(date +%s)"
    report=$(smart_report "$(whole_disk_node "$(record_get "$1" device)")") || return 0
    record_set "$1" smart_reason "$(judge_smart "$1" "$(smart_values <<< "$report")")"
}

smart_is_due() {
    local checked
    checked=$(record_get "$1" smart_checked)
    [ -z "$checked" ] || [ $(( $(date +%s) - checked )) -ge "$smart_interval" ]
}

check_due_smart() {
    local label
    state_dir_is_writable || return 0
    for label in $(mounted_labels); do
        is_usable "$label" && smart_is_due "$label" && check_smart "$label"
    done
}

# The pool can keep new files off a failing drive but not writes into the files already on it;
# only the filesystem itself can refuse those.
hold_failing_drives_read_only() {
    local label target
    for label in $(mounted_labels); do
        is_usable "$label" || continue
        target=$(mount_point "$label")
        if [ -n "$(record_get "$label" smart_reason)" ]; then
            [ -n "$(record_get "$label" held_read_only)" ] && continue
            mount -o remount,ro "$target" && record_set "$label" held_read_only yes && log "$label is failing; remounted read-only"
        elif [ -n "$(record_get "$label" held_read_only)" ]; then
            mount -o remount,rw "$target" && record_clear "$label" held_read_only && log "$label is healthy again; remounted read-write"
        fi
    done
}

accept_smart() {   # <role>: the drive's current values become its baseline
    local label="$prefix-$1" report values
    is_mounted "$label" || { echo "$label is not mounted"; return 1; }
    report=$(smart_report "$(whole_disk_node "$(findmnt -no SOURCE "$(mount_point "$label")")")") ||
        { echo "$label answers no SMART query"; return 1; }
    values=$(smart_values <<< "$report")
    echo "$values" > "$(smart_baseline_file "$(serial_or_label "$values" "$label")")"
    record_clear "$label" smart_checked
    echo "$label: SMART baseline is now $values"
}
