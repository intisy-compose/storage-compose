# shellcheck shell=bash
# Notifications go through an outbox on the status volume, which SnapRAID's jobs write to as well; the
# mounter alone sends them to ntfy, in order, and keeps whatever could not be sent for the next round.
# An outbox file holds the title, the priority (1 to 5), the tags and then the message.

outbox="$status_dir/outbox"
reminder_seconds=86400

queue_notification() {   # <priority> <tags> <title> <message>
    local file
    mkdir -p "$outbox"
    file="$outbox/$(date +%s%N)-$$"
    printf '%s\n%s\n%s\n%s\n' "$3" "$1" "$2" "$4" > "$file.tmp" && mv "$file.tmp" "$file"
    log "notify: $3: $4"
}

post_notification() {   # <outbox file>
    curl -fsS -m 20 -o /dev/null -H "Title: $(sed -n 1p "$1")" -H "Priority: $(sed -n 2p "$1")" \
        -H "Tags: $(sed -n 3p "$1")" --data-binary "$(tail -n +4 "$1")" "${ntfy_url%/}/$ntfy_topic"
}

send_notifications() {
    local file
    for file in $(find "$outbox" -maxdepth 1 -type f ! -name '*.tmp' 2> /dev/null | sort); do
        if [ -n "$ntfy_topic" ]; then post_notification "$file" || return 0; fi
        rm -f "$file"
    done
}

asset_of() {   # <label>: the role's asset id from array.toml
    awk -v section="[${1#"$prefix-"}]" '/^\[/ {inside = ($0 == section)} inside && /^asset *=/ {gsub(/.*= *"|".*/, ""); print; exit}' \
        "$state_dir/array.toml" 2> /dev/null
}

drive_name() { local asset; asset=$(asset_of "$1"); echo "$1${asset:+ ($asset)}"; }

is_parity_label() { [[ $1 == "$prefix-parity"* ]]; }

missing_message() {   # <label>
    local name; name=$(drive_name "$1")
    if [ "$1" = "$prefix-data1" ]; then echo "$name is missing: it holds the stack state, so the array has stopped. Plug it back in."
    elif is_parity_label "$1"; then echo "$name is missing: the share keeps working, parity syncs wait and one fewer drive may fail. Plug it back in or rebuild it in the dashboard."
    else echo "$name is missing: the share keeps working without its files, parity syncs wait. Plug it back in or rebuild it in the dashboard."
    fi
}

failing_message() { echo "$(drive_name "$1") is failing ($2): it takes no more writes, its files stay readable. Unplug it and rebuild it onto a replacement in the dashboard."; }

# What is announced for a drive is its condition, and for a failing drive also why, so a SMART count
# that rises again is announced again.
announcement_key() { [ "${condition[$1]}" = failing ] && echo "failing: ${detail[$1]}" || echo "${condition[$1]}"; }

announce_drive() {   # <label> <before> <now>
    local label=$1 before=$2 now=$3 name
    name=$(drive_name "$label")
    case $now in
        dropped) [ "$before" = present ] &&
            queue_notification 3 warning "$label dropped" "$name dropped off. Waiting up to $drop_grace s for it to come back; the share keeps working without its files meanwhile." ;;
        present) case $before in
            dropped | missing) queue_notification 2 white_check_mark "$label is back" "$name is back after $(record_get "$label" back_after) s, checked and mounted again." ;;
            failing*) queue_notification 3 white_check_mark "$label is healthy" "$name is healthy again." ;;
        esac ;;
        missing) queue_notification 4 rotating_light "$label is missing" "$(missing_message "$label")" ;;
        failing*) if [[ $before == failing* ]]; then
                queue_notification 4 rotating_light "$label changed" "$name: ${detail[$label]} (before: ${before#failing: })."
            else
                queue_notification 4 rotating_light "$label is failing" "$(failing_message "$label" "${detail[$label]}")"
            fi ;;
    esac
}

announce_drives() {
    local label before now
    for label in "${!condition[@]}"; do
        now=$(announcement_key "$label")
        before=$(record_get "$label" announced)
        [ "$now" = "$before" ] && continue
        [ -z "$before" ] && [ "$now" = dropped ] || announce_drive "$label" "$before" "$now"
        record_set "$label" announced "$now"
    done
}

state_message() {   # <state> <reasons>
    case $1 in
        healthy) echo "The array is healthy again: every drive is back. Parity syncs, scrubs and Kopia resume." ;;
        degraded) echo "The array is degraded: $2. The share keeps working without the missing files; Kopia and parity syncs wait." ;;
        stopped) echo "The array has stopped: $2. The share is read-only, Syncthing and Kopia are paused until enough drives are back." ;;
    esac
}

state_priority() { case $1 in healthy) echo 3 ;; degraded) echo 4 ;; *) echo 5 ;; esac; }

announce_state() {   # <state>
    local before reasons last_reminder
    before=$(cat "$runtime/announced_state" 2> /dev/null)
    reasons=$(state_reasons | sed '/ is dropped /d' | paste -sd ';' | sed 's/;/; /g')
    if [ "$1" != "$before" ]; then
        echo "$1" > "$runtime/announced_state"
        date +%s > "$runtime/reminded"
        [ -z "$before" ] && [ "$1" = healthy ] && return 0
        queue_notification "$(state_priority "$1")" "$([ "$1" = healthy ] && echo white_check_mark || echo rotating_light)" \
            "storage is $1" "$(state_message "$1" "$reasons")"
        return 0
    fi
    [ "$1" = healthy ] && return 0
    last_reminder=$(cat "$runtime/reminded" 2> /dev/null || echo 0)
    [ $(( $(date +%s) - last_reminder )) -ge "$reminder_seconds" ] || return 0
    date +%s > "$runtime/reminded"
    queue_notification "$(state_priority "$1")" rotating_light "storage is still $1" "Still $1 since $(cat "$runtime/state.since"): $reasons."
}

announce_split_folders() {
    local id drives path announced="$runtime/announced_splits"
    touch "$announced"
    while IFS=$'\t' read -r id drives; do
        [ -n "$id" ] || continue
        grep -qxF "$id" "$announced" && continue
        echo "$id" >> "$announced"
        path=$(syncthing_folders | awk -F'\t' -v id="$id" '$1 == id {print $2}')
        queue_notification 4 warning "folder $id is split" "Syncthing folder $id ($path) lies on $drives; losing one of them would take part of it while the rest keeps syncing. Move it onto one drive."
    done < <(split_folders)
}

announce_changes() {
    announce_drives
    announce_state "$array_state"
    announce_split_folders
}
