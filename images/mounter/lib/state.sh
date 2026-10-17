# shellcheck shell=bash
# The array's state, decided every round from the condition of each known drive, and written to the
# status volume for every other service:
#   status.json      everything, for the dashboard
#   array.env        state, complete, share, readonly, generation; for the pool, SnapRAID, Kopia and
#                    Syncthing's guard
#   syncthing.pause  the Syncthing folders to pause, one id per line

declare -A condition detail

members_file() {
    local label
    for label in "$prefix-data1" "$prefix-data2"; do
        is_usable "$label" && [ -f "$root/$label/.storage/snapraid.drives" ] && { echo "$root/$label/.storage/snapraid.drives"; return 0; }
    done
    return 1
}

# A drive belongs to the array from its first mount until SnapRAID removes it, so a missing one stays
# known; SnapRAID keeps the same list for its config.
register_mounted_drives() {
    local members="$state_dir/snapraid.drives" label
    state_dir_is_writable || return 0
    touch "$members"
    for label in $(mounted_labels); do
        grep -qxF "$root/$label" "$members" || echo "$root/$label" >> "$members"
    done
}

known_labels() {
    { mounted_labels; members_file > /dev/null && sed 's|.*/||' "$(members_file)"; } |
        grep -E "$label_pattern" | sort -uV
}

forget_unknown_records() {
    local directory label known
    known=" $(known_labels | tr '\n' ' ') "
    for directory in "$runtime/drives"/*; do
        label=${directory##*/}
        [ -d "$directory" ] && [[ $known != *" $label "* ]] && rm -rf "$directory"
    done
}

assess_drive() {   # <label>: sets condition and detail
    local label=$1 reason away
    if ! was_away "$label" && is_mounted "$label"; then
        reason=$(record_get "$label" smart_reason)
        if [ -n "$reason" ]; then condition[$label]=failing; detail[$label]=$reason
        elif went_read_only "$label"; then condition[$label]=failing; detail[$label]="read-only after a filesystem error"
        else condition[$label]=present; detail[$label]=""
        fi
        return
    fi
    if [ -n "$(record_get "$label" fsck_failed)" ]; then
        condition[$label]=failing; detail[$label]="its filesystem needs a manual check (e2fsck)"; return
    fi
    was_away "$label" || record_set "$label" absent_since "$(date +%s)"
    away=$(absent_seconds "$label")
    if [ "$away" -lt "$drop_grace" ]; then condition[$label]=dropped; detail[$label]="away for $away s"
    else condition[$label]=missing; detail[$label]="away since $(date -u -d "@$(record_get "$label" absent_since)" +%FT%TZ)"
    fi
}

labels_in() {   # <condition>...: the known drives in one of them
    local label wanted
    for label in "${!condition[@]}"; do
        for wanted in "$@"; do [ "${condition[$label]}" = "$wanted" ] && echo "$label"; done
    done | sort -V
}

count_lines() { sed '/^$/d' | wc -l; }

# A failing drive counts as lost: it is the one about to be rebuilt. data1 holds the stack state, so
# without it, or with it read-only, nothing that keeps state can work.
decide_state() {
    local parity_drives lost data1="$prefix-data1"
    parity_drives=$(known_labels | grep -c -- '-parity')
    lost=$(labels_in missing failing | count_lines)
    if [ "${condition[$data1]:-missing}" = missing ] || { is_usable "$data1" && went_read_only "$data1"; }; then echo stopped
    elif [ "$lost" -gt "$parity_drives" ]; then echo stopped
    elif [ "$lost" -gt 0 ]; then echo degraded
    else echo healthy
    fi
}

state_reasons() {   # "<label> is <condition> (<detail>)" for every drive that is not present
    local label
    for label in $(labels_in dropped missing failing); do
        echo "$(drive_name "$label") is ${condition[$label]}${detail[$label]:+ (${detail[$label]})}"
    done
}

drive_json() {   # <label>
    local label=$1 size= used=
    is_mounted "$label" && read -r size used < <(df -B1 --output=size,used "$(mount_point "$label")" | tail -1)
    jq -nc --arg label "$label" --arg role "${label#"$prefix-"}" --arg condition "${condition[$label]}" \
        --arg detail "${detail[$label]}" --arg asset "$(asset_of "$label")" --arg size "$size" --arg used "$used" \
        --argjson mounted "$(is_mounted "$label" && echo true || echo false)" \
        '{label: $label, role: $role, condition: $condition, detail: $detail, asset: (if $asset == "" then null else $asset end),
          mounted: $mounted, size: ($size | tonumber? // null), used: ($used | tonumber? // null)}'
}

split_folders_json() {
    split_folders | jq -Rsc 'split("\n") | map(select(. != "") | split("\t") | {id: .[0], drives: (.[1] | split(" "))})'
}

lines_json() { jq -Rsc 'split("\n") | map(select(. != ""))'; }

write_atomically() { cat > "$1.tmp" && mv "$1.tmp" "$1"; }

write_status_json() {   # <state> <since> <complete> <paused folders>
    local label drives=()
    for label in $(known_labels); do drives+=("$(drive_json "$label")"); done
    jq -n --arg node "$node" --arg updated "$(date -u +%FT%TZ)" --arg state "$1" --arg since "$2" \
        --argjson complete "$([ "$3" = yes ] && echo true || echo false)" \
        --argjson reasons "$(state_reasons | lines_json)" \
        --argjson drives "$(printf '%s\n' "${drives[@]}" | jq -sc '.')" \
        --argjson splitFolders "$(split_folders_json)" --argjson pausedFolders "$(printf '%s' "$4" | lines_json)" \
        '{node: $node, updated: $updated, state: $state, since: $since, complete: $complete, reasons: $reasons,
          drives: $drives, splitFolders: $splitFolders, pausedFolders: $pausedFolders}' |
        write_atomically "$status_dir/status.json"
}

write_array_env() {   # <state> <complete>
    {
        echo "state=$1"
        echo "complete=$2"
        echo "share=$([ "$1" = stopped ] && echo ro || echo rw)"
        echo "readonly=$(labels_in failing | tr '\n' ' ' | sed 's/ $//')"
        is_usable "$prefix-data1" && echo "generation=$(record_get "$prefix-data1" generation)" || echo "generation="
    } | write_atomically "$status_dir/array.env"
}

state_since() {   # <state>
    [ "$(cat "$runtime/state" 2>/dev/null)" = "$1" ] || { echo "$1" > "$runtime/state"; date -u +%FT%TZ > "$runtime/state.since"; }
    cat "$runtime/state.since"
}

pool_branch_labels() {
    getfattr --only-values -n user.mergerfs.branches "$root/pool/.mergerfs" 2> /dev/null | tr ':' '\n' | sed -e 's/=.*//' -e 's|.*/||'
}

# A drive that is mounted again is back for Syncthing only once the pool shows its files; resuming a
# folder before that would let a scan read them as deleted.
drives_outside_pool() {
    local label branches
    branches=" $(pool_branch_labels | tr '\n' ' ') "
    for label in $(mounted_labels); do
        is_data_label "$label" && [[ $branches != *" $label "* ]] && echo "$label"
    done
}

assess_array() {
    local label state complete=no not_present paused outside_pool
    condition=(); detail=()
    forget_unknown_records
    for label in $(known_labels); do assess_drive "$label"; done
    state=$(decide_state)
    outside_pool=$(drives_outside_pool)
    [ "$state" = healthy ] && [ -z "$(labels_in dropped)" ] && [ -z "$outside_pool" ] && complete=yes
    update_folder_locations "$complete"
    not_present=$({ labels_in dropped missing failing; echo "$outside_pool"; } | sed '/^$/d' | sort -uV | tr '\n' ' ' | sed 's/ $//')
    paused=$(folders_to_pause "$state" "$not_present")
    printf '%s\n' "$paused" | sed '/^$/d' | write_atomically "$status_dir/syncthing.pause"
    write_array_env "$state" "$complete"
    write_status_json "$state" "$(state_since "$state")" "$complete" "$paused"
    array_state=$state
}
