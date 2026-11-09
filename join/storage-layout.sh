#!/bin/bash
# storage-layout: the layered sync's side of a joined Linux device, installed beside the connections step.
#   storage-layout start <syncthing home> <root> <node id>
#       the unit's ExecStartPre: applies the changes the last tick kept, while Syncthing is down, into config.xml
#       and each folder's .stignore. Always exits 0, so it never stops the start.
#   storage-layout tick <dashboard> <node id> <syncthing home> <root> <gui port>
#       the timer's job, as root: reports this node to the dashboard's POST /api/layered/node/<id>, follows the
#       node file's policy, keeps the hand-off contract, restarts the unit when the answer holds changes to
#       make (specs/2026-11-05-layered-sync-plan.md, call 5), and runs handoff.sh on the contract.
# A move or a write needs the dashboard's apply and the node file's apply = true; the executor's own checks
# are handoff.sh's. A dashboard that does not answer takes apply back out of the node file.
set -u

readonly UNIT_NAME="storage-syncthing.service"
readonly OPS_MAX_AGE_SECONDS=300
readonly RESTART_BACKOFF_SECONDS=1800
readonly RESTART_FAILED_BACKOFF_SECONDS=300
readonly HANDOFF_RUN_SECONDS=${STORAGE_LAYOUT_HANDOFF_SECONDS:-3600}
readonly LISTING_SECONDS=120
readonly FILES_LIMIT=200
readonly QUIET_MINUTES=${HANDOFF_QUIET_MINUTES:-10}
readonly HANDOFF_LIST=.stignore-handoff
step_folder=$(dirname "$(readlink -f "$0")")

log() { echo "storage-layout: $*" >&2; }

now() { echo "${STORAGE_LAYOUT_NOW:-$(date +%s)}"; }

api_key() { sed -n 's:.*<apikey>\(.*\)</apikey>.*:\1:p' "$syncthing_home/config.xml" | head -n 1; }

# The API key goes to curl on standard input, never on its command line.
api() {
    printf 'header = "X-API-Key: %s"\n' "$(api_key)" | curl -fsS -m 15 -K - "$gui$1"
}

uri() { jq -rn --arg value "$1" '$value | @uri'; }

ops_file() { printf '%s/layered-ops.json' "$syncthing_home"; }

node_file() { printf '%s/.storage/node.toml' "$root"; }

node_value() {   # <key>
    awk -v wanted="$1" '
        /^[[:space:]]*\[/ { in_node = ($0 ~ /^[[:space:]]*\[node\][[:space:]]*(#.*)?$/); next }
        in_node {
            line = $0; sub(/#.*/, "", line)
            if (match(line, /^[[:space:]]*"?[A-Za-z0-9_-]+"?[[:space:]]*=/)) {
                name = line; sub(/[[:space:]]*=.*/, "", name); gsub(/[[:space:]"]/, "", name)
                if (name != wanted) next
                value = line; sub(/^[^=]*=[[:space:]]*/, "", value); sub(/[[:space:]]+$/, "", value)
                gsub(/^"|"$/, "", value); print value; exit
            }
        }' "$(node_file)"
}

# True only for a plain regular node file on a plain .storage folder, never an array's.
may_edit_node_file() {
    local storage="$root/.storage" file
    file=$(node_file)
    [ -d "$storage" ] && [ ! -L "$storage" ] && [ -f "$file" ] && [ ! -L "$file" ] || return 1
    ! grep -Eqi '^[[:space:]]*kind[[:space:]]*=[[:space:]]*"array"' "$file" && ! grep -Eq '^[[:space:]]*\[array\]' "$file"
}

replace_node_file() {   # <new text file>
    local file
    file=$(node_file)
    if cmp -s "$1" "$file"; then rm -f "$1"; return 1; fi
    chown --reference="$file" "$1" 2> /dev/null
    chmod --reference="$file" "$1" 2> /dev/null
    mv -f "$1" "$file"
}

# The keys the layered sync owns in [node]; a key's value spread over several lines (a multi-line assigned) is
# replaced whole, every other line is kept as it was.
edit_node_keys() {   # <remove keys, space separated> <lines to add, newline separated>
    local new
    new=$(mktemp "$(dirname "$(node_file)")/.node-edit.XXXXXX") || return 1
    AWK_REMOVE=" $1 " AWK_ADD=$2 awk '
        BEGIN { remove = ENVIRON["AWK_REMOVE"]; add = ENVIRON["AWK_ADD"] }
        function flush_add() { if (!added && add != "") { print add; added = 1 } }
        /^[[:space:]]*\[/ {
            if (in_node) flush_add()
            in_node = ($0 ~ /^[[:space:]]*\[node\][[:space:]]*(#.*)?$/)
            print; skipping = 0; next
        }
        !in_node { print; next }
        skipping { if ($0 ~ /\]/) skipping = 0; next }
        {
            line = $0; sub(/#.*/, "", line)
            if (match(line, /^[[:space:]]*"?[A-Za-z0-9_-]+"?[[:space:]]*=/)) {
                name = line; sub(/[[:space:]]*=.*/, "", name); gsub(/[[:space:]"]/, "", name)
                if (index(remove, " " name " ")) {
                    value = line; sub(/^[^=]*=/, "", value)
                    if (index(value, "[") && !index(value, "]")) skipping = 1
                    next
                }
            }
            print
        }
        END { if (in_node) flush_add() }' "$(node_file)" > "$new" && replace_node_file "$new"
}

withdraw_apply() {
    may_edit_node_file || return 0
    grep -Eq '^[[:space:]]*"?apply"?[[:space:]]*=' "$(node_file)" || return 0
    edit_node_keys "apply" "" && log "apply taken out of the node file"
}

follow_policy() {   # <policy object>
    may_edit_node_file || return 0
    local policy=$1 lines assigned threshold access
    threshold=$(jq -er '.threshold | numbers' <<< "$policy" 2> /dev/null) || { log "the policy's threshold is no number; the node file stays"; return 0; }
    assigned=$(jq -c '.assigned // [] | map(tostring)' <<< "$policy" | sed 's/,/, /g')
    access=$(jq -c '.access | tostring' <<< "$policy")
    lines="threshold = $threshold
assigned = $assigned
access = $access
apply = true"
    edit_node_keys "threshold assigned access apply" "$lines"
}

report_folder() {   # <config object>
    local id ignores status
    id=$(jq -r .id <<< "$1")
    ignores=$(api "/rest/db/ignores?folder=$(uri "$id")" | jq -c 'if .error != null and .ignore == null then null else .ignore // [] end' 2> /dev/null) || ignores=null
    [ -n "$ignores" ] || ignores=null
    status=$(api "/rest/db/status?folder=$(uri "$id")" 2> /dev/null) || status=null
    [ -n "$status" ] || status=null
    jq -c --argjson ignores "$ignores" --argjson status "$status" \
        '{id, path, type, label, paused, devices: [.devices[].deviceID], versioning, ignores: $ignores, status: $status}' <<< "$1"
}

# Up to <limit> settled files of a send-only folder, the only ones that can hand off, walked one directory level per
# request from where the last report stopped; a listing that fails or runs out of time is a problem of the node, and
# what was gathered before it is still offered.
report_files() {   # <folder id> <limit>
    local folder=$1 limit=$2 count=0 seen=0 skip=0 cursor item path name modified modified_seconds age entry listing prefix browse deadline=$((SECONDS + LISTING_SECONDS)) queue=("")
    cursor="$syncthing_home/layered-cursor-$(printf '%s' "$folder" | sha256sum | cut -c1-16)"
    [ ! -f "$cursor" ] || skip=$(cat "$cursor")
    listing=$(mktemp) || return 0
    while [ "${#queue[@]}" -gt 0 ]; do
        if [ "$SECONDS" -ge "$deadline" ]; then
            printf '%s: the listing ran out of its time with %s directories unread\n' "$folder" "${#queue[@]}" >> "$listing_problems"
            echo "$seen" > "$cursor"
            rm -f "$listing"
            return 0
        fi
        prefix=${queue[0]}
        queue=("${queue[@]:1}")
        browse="/rest/db/browse?folder=$(uri "$folder")&levels=0"
        [ -z "$prefix" ] || browse="$browse&prefix=$(uri "$prefix")"
        if ! api "$browse" > "$listing" 2> /dev/null || ! jq -e 'type == "array" or . == null' "$listing" > /dev/null 2>&1; then
            printf '%s: it could not be listed\n' "$folder" >> "$listing_problems"
            rm -f "$listing"
            return 0
        fi
        while IFS= read -r item; do
            name=$(jq -r .name <<< "$item")
            path=${prefix:+$prefix/}$name
            case $(jq -r .type <<< "$item") in
                FILE_INFO_TYPE_DIRECTORY) queue+=("$path"); continue ;;
                FILE_INFO_TYPE_FILE) ;;
                *) continue ;;
            esac
            modified=$(jq -r '.modTime // ""' <<< "$item")
            modified_seconds=$(date -d "$modified" +%s 2> /dev/null) || continue
            age=$(( $(now) - modified_seconds ))
            [ "$age" -ge $((QUIET_MINUTES * 60)) ] || continue
            seen=$((seen + 1))
            [ "$seen" -gt "$skip" ] || continue
            entry=$(api "/rest/db/file?folder=$(uri "$folder")&file=$(uri "$path")" | jq -c '.local // empty' 2> /dev/null) || continue
            [ -z "$entry" ] || jq -cn --arg folderId "$folder" --arg path "$path" --arg modified "$modified" --argjson entry "$entry" '{folderId: $folderId, path: $path, modified: $modified, entry: $entry}'
            count=$((count + 1))
            if [ "$count" -ge "$limit" ]; then
                echo "$seen" > "$cursor"
                rm -f "$listing"
                return 0
            fi
        done < <(jq -c '.[]?' "$listing" 2> /dev/null)
    done
    echo 0 > "$cursor"
    rm -f "$listing"
}

# The whole report in a temporary file, as one JSON object; every part this device cannot read is left out,
# which the dashboard decides as "unknown" and hands nothing off.
write_report() {   # <file>
    local folders files=() folder config_id remaining device_id devices space size avail name kind threshold
    listing_problems=$1.problems
    : > "$listing_problems"
    folders=$(api /rest/config/folders) || return 1
    device_id=$(api /rest/system/status | jq -r .myID) || return 1
    devices=$(api /rest/config/devices | jq -c '[.[].deviceID]') || return 1
    local folder_reports=() line
    while IFS= read -r line; do folder_reports+=("$(report_folder "$line")"); done < <(jq -c '.[]' <<< "$folders")
    local sending slice
    sending=$(jq '[.[] | select(.type == "sendonly")] | length' <<< "$folders")
    slice=$(( sending > 0 ? FILES_LIMIT / sending : FILES_LIMIT ))
    [ "$slice" -ge 20 ] || slice=20
    remaining=$FILES_LIMIT
    while IFS= read -r config_id; do
        [ "$remaining" -gt 0 ] || break
        mapfile -t -O "${#files[@]}" files < <(report_files "$config_id" "$(( remaining < slice ? remaining : slice ))")
        remaining=$((FILES_LIMIT - ${#files[@]}))
    done < <(jq -r '.[] | select(.type == "sendonly") | .id' <<< "$folders")
    if [ -f "$(restart_record)" ] && [ "$(jq -r '.told // false' "$(restart_record)" 2> /dev/null)" = true ]; then
        printf 'changes were already tried and are still asked for; they are tried again after a back-off\n' >> "$listing_problems"
    fi
    size=$(df -B1 --output=size "$root" | tail -n 1 | tr -d ' ')
    avail=$(df -B1 --output=avail "$root" | tail -n 1 | tr -d ' ')
    space=$(jq -cn --argjson size "${size:-0}" --argjson avail "${avail:-0}" '{totalBytes: $size, freeBytes: $avail}') || space=null
    name=$(node_value name); kind=$(node_value kind); threshold=$(node_value threshold)
    local result=null
    [ ! -f "$result_file" ] || result=$(jq -c . "$result_file" 2> /dev/null) || result=null
    printf '%s\n' "${folder_reports[@]}" | jq -cs '.' > "$1.folders"
    printf '%s\n' "${files[@]+"${files[@]}"}" | jq -cs 'map(select(type == "object"))' > "$1.files"
    local problems
    problems=$(jq -Rs 'split("\n") | map(select(length > 0))' "$listing_problems")
    jq -n --arg name "$name" --arg kind "$kind" --argjson threshold "${threshold:-0}" --arg root "$root" --arg deviceId "$device_id" --argjson knownDevices "$devices" \
        --argjson space "$space" --argjson result "${result:-null}" --argjson listingProblems "$problems" --slurpfile folders "$1.folders" --slurpfile files "$1.files" \
        '{schema: 1, name: $name, kind: $kind, threshold: $threshold, root: $root, os: "linux", deviceId: $deviceId, knownDevices: $knownDevices, folders: $folders[0], files: $files[0], space: $space, result: $result, listingProblems: $listingProblems}' > "$1"
    rm -f "$1.folders" "$1.files" "$listing_problems"
}

ask_dashboard() {   # <report file> <answer file>
    curl -fsS -m 30 -o "$2" -X POST -H "Content-Type: application/json" --data-binary "@$1" "$dashboard/api/layered/node/$node" 2> /dev/null \
        && jq -e --arg node "$node" '.schema == 1 and .nodeId == $node' "$2" > /dev/null 2>&1
}

handoff_folder() { printf '%s/handoff' "$syncthing_home"; }

own() { chown --reference="$syncthing_home" "$@" 2> /dev/null || true; }

run_handoff() {   # <contract file>
    local contract=$1 probe_dir="$syncthing_home/handoff-probe" probe_pid="" owner
    [ -f "$contract" ] || return 0
    owner=$(stat -c %U "$root")
    mkdir -p "$probe_dir"
    HANDOFF_PROBE_INTERVAL_SECONDS=2 bash "$step_folder/handoff-probe.sh" "$probe_dir" &
    probe_pid=$!
    HANDOFF_API_KEY=$(api_key) HANDOFF_OPEN_SNAPSHOT="$probe_dir/open.txt" as_user "$owner" bash "$step_folder/handoff.sh" "$node" "$root" "$gui" - "$contract" "$result_file" \
        || log "the hand-off run ended with $? (a run past ${HANDOFF_RUN_SECONDS} s is cut off; its pending paths are picked up next round)"
    kill "$probe_pid" 2> /dev/null
    wait "$probe_pid" 2> /dev/null
}

# runuser and timeout keep the environment, so the key stays off the command line.
as_user() {   # <user> <command...>
    local user=$1
    shift
    if [ "$(id -un)" = "$user" ]; then timeout --kill-after=10 "$HANDOFF_RUN_SECONDS" "$@"
    else timeout --kill-after=10 "$HANDOFF_RUN_SECONDS" runuser -u "$user" -- "$@"; fi
}

keep_ops() {   # <answer file> <when the dashboard answered>
    local ops
    ops=$(ops_file)
    jq -c --arg at "$2" '{keptAt: ($at | tonumber), ops: .ops}' "$1" > "$ops.new" && own "$ops.new" && mv -f "$ops.new" "$ops"
}

restart_record() { printf '%s/layered-restart.json' "$syncthing_home"; }

# The same changes, tried and still asked for, are retried only after RESTART_BACKOFF_SECONDS, so a change that fails
# does not restart Syncthing every minute; a different change restarts at once.
restart_is_due() {   # <signature>
    local signature=$1 file last at told age backoff
    file=$(restart_record)
    if [ -f "$file" ]; then
        last=$(jq -r '.signature // ""' "$file" 2> /dev/null)
        at=$(jq -r '.at // 0' "$file" 2> /dev/null)
        told=$(jq -r '.told // false' "$file" 2> /dev/null)
        age=$(( $(now) - at ))
        backoff=$RESTART_BACKOFF_SECONDS
        [ "$(jq -r '.failed // false' "$file" 2> /dev/null)" != true ] || backoff=$RESTART_FAILED_BACKOFF_SECONDS
        if [ "$last" = "$signature" ] && [ "$age" -lt "$backoff" ]; then
            if [ "$told" != true ]; then
                log "these changes were already tried $age s ago and are still asked for; not restarting again before $backoff s have passed"
                jq '.told = true' "$file" > "$file.new" && mv -f "$file.new" "$file"
            fi
            return 1
        fi
    fi
}

record_restart() {   # <signature> <whether the restart failed>
    local file
    file=$(restart_record)
    jq -cn --arg signature "$1" --argjson at "$(now)" --argjson failed "$2" '{signature: $signature, at: $at, told: false, failed: $failed}' > "$file.new" && mv -f "$file.new" "$file"
    own "$file"
}

# Waits for the API after a restart, so the hand-off run that follows has a Syncthing to check against.
wait_for_gui() {
    for _ in $(seq 1 30); do api /rest/system/status > /dev/null 2>&1 && return 0; sleep 2; done
    return 1
}

apply_the_answer() {   # <answer file> <when the dashboard answered>
    local signature
    if ! jq -e '.apply == true and (.ops | length) > 0' "$1" > /dev/null || [ "$(node_value apply)" != true ]; then
        rm -f "$(restart_record)"
        return 0
    fi
    signature=$(jq -cS '.ops' "$1" | sha256sum | cut -d' ' -f1)
    restart_is_due "$signature" || return 0
    keep_ops "$1" "$2"
    log "restarting $UNIT_NAME to apply $(jq '.ops | length' "$1") change(s)"
    if ! systemctl restart "$UNIT_NAME"; then
        log "$UNIT_NAME did not restart"
        record_restart "$signature" true
        return 0
    fi
    if [ -f "$(ops_file)" ]; then
        log "the restart did not take the changes up"
        record_restart "$signature" true
        return 0
    fi
    record_restart "$signature" false
    wait_for_gui || log "Syncthing did not answer after the restart"
}

tick() {
    dashboard=${1%/}; node=$2; syncthing_home=$3; root=$4; gui=http://127.0.0.1:$5
    result_file="$(handoff_folder)/$node.result.json"
    mkdir -p "$(handoff_folder)"
    own "$(handoff_folder)"
    local work report answer answered_at
    work=$(mktemp -d) || exit 1
    report=$work/report.json
    answer=$work/answer.json
    if ! write_report "$report" || ! ask_dashboard "$report" "$answer"; then
        withdraw_apply
        log "no answer from $dashboard; apply is withdrawn until it comes back"
        rm -rf "$work"
        return 0
    fi
    answered_at=$(now)
    if jq -e '.nodeFile.action == "follow"' "$answer" > /dev/null; then follow_policy "$(jq -c '.nodeFile.policy' "$answer")" || true
    else withdraw_apply; fi
    if jq -e '.contract != null' "$answer" > /dev/null; then
        jq '.contract' "$answer" > "$work/contract.json" && own "$work/contract.json" && mv -f "$work/contract.json" "$(handoff_folder)/$node.json"
    else
        rm -f "$(handoff_folder)/$node.json"
    fi
    apply_the_answer "$answer" "$answered_at"
    run_handoff "$(handoff_folder)/$node.json"
    rm -rf "$work"
}

xml_escape() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"; }

# Each op edits config.xml with one pass over it, in the order given.
edit_config() {   # <awk program as a file>, its values in AWK_* so awk reads them without escape processing
    local program=$1 edited config=$syncthing_home/config.xml
    edited=$(mktemp "$syncthing_home/.config.XXXXXX") || return 1
    if awk -f "$program" "$config" > "$edited" && grep -q '</configuration>' "$edited"; then
        cmp -s "$edited" "$config" || { chmod --reference="$config" "$edited" 2> /dev/null; mv -f "$edited" "$config"; return 0; }
    fi
    rm -f "$edited"
}

xml_value() { printf '%s' "$1" | xml_escape; }

folder_path() {   # <folder id>: its path in config.xml, xml-unescaped
    AWK_WANTED=$(xml_value "$1") awk 'BEGIN { wanted = ENVIRON["AWK_WANTED"] } /<folder / { id = $0; sub(/.* id="/, "", id); sub(/".*/, "", id); if (id == wanted) { path = $0; sub(/.* path="/, "", path); sub(/".*/, "", path); print path; exit } }' "$syncthing_home/config.xml" \
        | sed -e "s/&apos;/'/g" -e 's/&quot;/"/g' -e 's/&lt;/</g' -e 's/&gt;/>/g' -e 's/&amp;/\&/g'
}

# True only for a path that resolves inside the node's root, so an answer can never make the step write elsewhere.
inside_root() {   # <path>
    local real
    real=$(realpath -m -- "$1" 2> /dev/null) || return 1
    case $real in "$root"/*) return 0 ;; *) return 1 ;; esac
}

write_ignores() {   # <folder path> <lines as a JSON array>
    local path=$1 lines=$2 new
    inside_root "$path" && [ -d "$path" ] || { log "not writing $path/.stignore: the folder is not inside the node's root"; return 1; }
    new=$(mktemp "$path/.stignore.XXXXXX") || return 1
    jq -r '.[]' <<< "$lines" > "$new"
    mv -f "$new" "$path/.stignore"
}

ensure_list() {   # <folder path>
    local path=$1 list
    inside_root "$path" && [ -d "$path" ] || { log "no list in $path: the folder is not inside the node's root"; return 1; }
    list="$path/$HANDOFF_LIST"
    if [ -e "$list" ] || [ -L "$list" ]; then
        [ -f "$list" ] && [ ! -L "$list" ] || { log "$list is not a regular file"; return 1; }
        return 0
    fi
    grep -qFx "/$HANDOFF_LIST" "$path/.stignore" 2> /dev/null || { log "$path does not ignore the list yet"; return 1; }
    : > "$list"
}

write_folder_ignores() {   # <path> <lines JSON>: a new folder's: ignored first, then the list, then the include, so no first scan sees the list as a file
    local path=$1 lines=$2
    [ -e "$path/.stignore" ] && return 0
    mkdir -p "$path"
    write_ignores "$path" "$(jq -c 'map(select(. != "#include '"$HANDOFF_LIST"'"))' <<< "$lines")" || return 1
    ensure_list "$path" || return 1
    write_ignores "$path" "$lines"
}

config_program() {   # <op>: prints the program name; each lives in its own file below
    printf '%s' "$work_dir/$1.awk"
}

write_programs() {
    cat > "$work_dir/set-folder-attr.awk" << 'AWK'
BEGIN { wanted = ENVIRON["AWK_WANTED"]; attr = ENVIRON["AWK_ATTR"]; value = ENVIRON["AWK_VALUE"] }
/<folder / {
    id = $0; sub(/.* id="/, "", id); sub(/".*/, "", id)
    if (id == wanted) { pattern = " " attr "=\"[^\"]*\""; sub(pattern, " " attr "=\"" value "\"") }
}
{ print }
AWK
    cat > "$work_dir/set-folder-child.awk" << 'AWK'
BEGIN { wanted = ENVIRON["AWK_WANTED"]; name = ENVIRON["AWK_NAME"]; value = ENVIRON["AWK_VALUE"] }
/<folder / { id = $0; sub(/.* id="/, "", id); sub(/".*/, "", id); inside = (id == wanted); seen = 0 }
inside && index($0, "<" name ">") && !seen { indent = $0; sub(/<.*/, "", indent); print indent value; seen = 1; next }
/<\/folder>/ { inside = 0 }
{ print }
AWK
    cat > "$work_dir/set-folder-block.awk" << 'AWK'
BEGIN { wanted = ENVIRON["AWK_WANTED"]; name = ENVIRON["AWK_NAME"]; text = ENVIRON["AWK_TEXT"] }
/<folder / { id = $0; sub(/.* id="/, "", id); sub(/".*/, "", id); inside = (id == wanted) }
inside && !done && $0 ~ "<" name "[ >]" {
    indent = $0; sub(/<.*/, "", indent); print indent text; done = 1
    if ($0 !~ "</" name ">") { skipping = 1 } else { inside = 0 }
    next
}
skipping { if ($0 ~ "</" name ">") { skipping = 0; inside = 0 } next }
/<\/folder>/ { inside = 0 }
{ print }
AWK
    cat > "$work_dir/set-folder-devices.awk" << 'AWK'
BEGIN { wanted = ENVIRON["AWK_WANTED"]; lines = ENVIRON["AWK_TEXT"] }
/<folder / { id = $0; sub(/.* id="/, "", id); sub(/".*/, "", id); inside = (id == wanted); added = 0 }
inside && /<device / {
    if (!added) { indent = $0; sub(/<.*/, "", indent); n = split(lines, list, "\n"); for (i = 1; i <= n; i++) print indent list[i]; added = 1 }
    if ($0 !~ /<\/device>/ && $0 !~ /\/>/) skipping = 1
    next
}
skipping { if ($0 ~ /<\/device>/) skipping = 0; next }
/<\/folder>/ { inside = 0 }
{ print }
AWK
    cat > "$work_dir/insert-before-end.awk" << 'AWK'
BEGIN { text = ENVIRON["AWK_TEXT"] }
/<\/configuration>/ { n = split(text, list, "\n"); for (i = 1; i <= n; i++) print "    " list[i] }
{ print }
AWK
}

versioning_text() {   # <versioning object>
    jq -r 'def esc: tostring | gsub("&"; "&amp;") | gsub("\""; "&quot;") | gsub("<"; "&lt;") | gsub(">"; "&gt;");
        "<versioning type=\"\(.type | esc)\">" + ((.params // {}) | to_entries | map("<param key=\"\(.key | esc)\" val=\"\(.value | esc)\"></param>") | join("")) + "<cleanupIntervalS>\(.cleanupIntervalS // 3600)</cleanupIntervalS><fsPath>\(.fsPath // "" | esc)</fsPath><fsType>\(.fsType // "basic" | esc)</fsType></versioning>"' <<< "$1"
}

folder_device_elements() {   # <device ids JSON>
    jq -r '.[] | "<device id=\"\(. | @html)\" introducedBy=\"\"><encryptionPassword></encryptionPassword></device>"' <<< "$1"
}

apply_op() {   # <op object>
    local op=$1 kind folder id value path type
    kind=$(jq -r .op <<< "$op")
    folder=$(xml_value "$(jq -r '.folderId // empty' <<< "$op")")
    case $kind in
        type)
            type=$(jq -r .type <<< "$op")
            case $type in sendreceive | sendonly | receiveonly | receiveencrypted) ;; *) log "type $type is not one this step writes"; return 1 ;; esac
            AWK_WANTED=$folder AWK_ATTR=type AWK_VALUE=$type edit_config "$(config_program set-folder-attr)" ;;
        paused)
            value=$(jq -r 'if .paused == true then "true" else "false" end' <<< "$op")
            AWK_WANTED=$folder AWK_NAME=paused AWK_VALUE="<paused>$value</paused>" edit_config "$(config_program set-folder-child)" ;;
        versioning) AWK_WANTED=$folder AWK_NAME=versioning AWK_TEXT="$(versioning_text "$(jq -c .versioning <<< "$op")")" edit_config "$(config_program set-folder-block)" ;;
        devices) AWK_WANTED=$folder AWK_TEXT="$(folder_device_elements "$(jq -c .devices <<< "$op")")" edit_config "$(config_program set-folder-devices)" ;;
        ignores)
            path=$(folder_path "$(jq -r .folderId <<< "$op")")
            [ -n "$path" ] || { log "no folder $folder in config.xml"; return 1; }
            write_ignores "$path" "$(jq -c .lines <<< "$op")" ;;
        ensureList)
            path=$(folder_path "$(jq -r .folderId <<< "$op")")
            [ -n "$path" ] || { log "no folder $folder in config.xml"; return 1; }
            ensure_list "$path" ;;
        addDevice)
            id=$(jq -r .deviceId <<< "$op" | xml_escape)
            grep -qF "<device id=\"$id\"" "$syncthing_home/config.xml" && return 0
            value=$(jq -r '.name' <<< "$op" | xml_escape)
            AWK_TEXT="<device id=\"$id\" name=\"$value\" compression=\"metadata\" introducer=\"false\" skipIntroductionRemovals=\"false\" introducedBy=\"\"><address>dynamic</address></device>" edit_config "$(config_program insert-before-end)" ;;
        addFolder) add_folder "$op" ;;
        *) log "unknown change $kind"; return 1 ;;
    esac
}

add_folder() {   # <op object>
    local op=$1 id path escaped_path label type devices
    id=$(jq -r .id <<< "$op" | xml_escape)
    path=$(jq -r .path <<< "$op")
    inside_root "$path" || { log "folder $id: $path is not inside the node's root"; return 1; }
    grep -qF "<folder id=\"$id\"" "$syncthing_home/config.xml" && return 0
    write_folder_ignores "$path" "$(jq -c .ignores <<< "$op")" || return 1
    escaped_path=$(printf '%s' "$path" | xml_escape)
    label=$(jq -r .label <<< "$op" | xml_escape)
    type=$(jq -r .type <<< "$op" | xml_escape)
    devices=$(folder_device_elements "$(jq -c .devices <<< "$op")")
    AWK_TEXT="<folder id=\"$id\" label=\"$label\" path=\"$escaped_path\" type=\"$type\">
$devices
</folder>" edit_config "$(config_program insert-before-end)"
}

# A kept change is applied only soon after the tick that kept it, under this node file's own apply.
start() {
    syncthing_home=$1; root=$2; node=$3
    local ops
    ops=$(ops_file)
    [ -f "$ops" ] || return 0
    work_dir=$(mktemp -d) || return 0
    trap 'rm -rf "$work_dir"' EXIT
    local kept age
    kept=$(jq -r '.keptAt // 0' "$ops" 2> /dev/null)
    age=$(( $(now) - ${kept:-0} ))
    if [ "$age" -gt "$OPS_MAX_AGE_SECONDS" ] || [ "$age" -lt -60 ]; then
        log "the kept changes are $age s old; dropped"
        rm -f "$ops"
        return 0
    fi
    if [ "$(node_value apply)" != true ]; then
        log "the node file does not say apply = true; the kept changes are dropped"
        rm -f "$ops"
        return 0
    fi
    write_programs
    local op
    while IFS= read -r op; do
        apply_op "$op" || { log "stopped at the change $(jq -r .op <<< "$op")"; break; }
    done < <(jq -c '.ops[]' "$ops")
    rm -f "$ops"
}

main() {
    local mode=${1:-}
    shift || true
    case $mode in
        start) start "$@"; exit 0 ;;
        tick) tick "$@" ;;
        *) echo "usage: storage-layout start|tick ..." >&2; exit 2 ;;
    esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
