#!/bin/bash
# handoff.sh <node id> <node root> <api url> <api key> <contract file> <result file>: the layered sync's
# hand-off executor for one Linux node (plan call 3), run by the nodes service and, in phase 6, by the
# Linux join's timer. It acts only on files the dashboard's contract names, only while the node's own
# node file says apply = true, and only on a file that is still the confirmed one on disk: it records the
# path as pending in <root>/.storage/handoff-pending.jsonl, appends it to the folder's .stignore-handoff,
# waits until Syncthing reports it ignored, hashes it, then renames it into
# <root>/.storage/handoff-trash/<day>/<folder id>/. A pending path is retried on later runs; its line is
# removed again only while its file is still there and was never moved (it changed, or the retries
# ran out), which brings the file back into normal sync. A moved path's line is never removed. Nothing
# is deleted except what this script moved into the trash, once it is HANDOFF_TRASH_DAYS old and a
# keeper still holds its version; a folder paused here answers no index reads, so a held contract's keeper
# evidence stands in for its own index. It never asks Syncthing to override, revert or delete anything. Open
# files are read from the handoff-probe sidecar's snapshot (HANDOFF_OPEN_SNAPSHOT), never from /proc here.
# Needs bash, jq, curl, flock and GNU coreutils (mv --no-copy, split --filter, basenc).
set -u

node_id=${1:-}
root=${2:-}
api=${3:-}
key=${4:-}
# The key may come from the environment instead (the argument is then `-`), so it is never on a command line.
[ "$key" != - ] || key=${HANDOFF_API_KEY:-}
contract_source=${5:-}
result=${6:-}

trash_days=${HANDOFF_TRASH_DAYS:-7}
quiet_minutes=${HANDOFF_QUIET_MINUTES:-10}
# Two layout rounds of 60 s plus the 120 s a keeper's report may be old when the dashboard decides; an older
# contract may rest on a keeper that has since frozen or lost the file.
contract_max_age=${HANDOFF_CONTRACT_MAX_AGE_SECONDS:-300}
contract_max_ahead=60
ignore_wait=${HANDOFF_IGNORE_WAIT_SECONDS:-60}
pending_attempts=${HANDOFF_PENDING_ATTEMPTS:-10}
snapshot_path=${HANDOFF_OPEN_SNAPSHOT:-}
snapshot_wait=${HANDOFF_SNAPSHOT_WAIT_SECONDS:-15}
stray_limit=${HANDOFF_STRAY_LIMIT:-1000}
kept_log_seconds=86400
cluster_id=${HANDOFF_CLUSTER_ID:-}
proc_root=${HANDOFF_PROC_ROOT:-/proc}
handoff_list=.stignore-handoff
include_line="#include $handoff_list"
list_ignore_line="/$handoff_list"

log() { echo "$(date -u +%FT%TZ) handoff $node_id: $*" >&2; }

now() { echo "${HANDOFF_NOW:-$(date +%s)}"; }

work=$(mktemp -d) || exit 1
trap 'rm -rf "$work"' EXIT
: > "$work/results"
: > "$work/notes"
: > "$work/trash"
: > "$work/awaiting"
contract=$work/contract.json
purged=0
snapshot_loaded=
snapshot_problem=
declare -A open_files=()
declare -A paused_folders=()

record() {   # <folder id> <path> <outcome> <reason> [trash path]
    jq -cn --arg folderId "$1" --arg path "$2" --arg outcome "$3" --arg reason "$4" --arg trash "${5:-}" \
        '{folderId: $folderId, path: $path, outcome: $outcome, reason: $reason} + (if $trash == "" then {} else {trash: $trash} end)' >> "$work/results"
    [ "$3" = moved ] || log "$1/$2: $3: $4"
}

note() { grep -Fxq -- "$1" "$work/notes" || printf '%s\n' "$1" >> "$work/notes"; }

write_result() {   # [refusal]
    [ -n "$result" ] || return 0
    local written_at=
    [ -f "$contract" ] && written_at=$(jq -r '.writtenAt? // "" | strings' "$contract" 2> /dev/null)
    jq -n --arg nodeId "$node_id" --arg contractWrittenAt "$written_at" --arg finishedAt "$(date -u -d "@$(now)" +%FT%TZ)" \
        --arg refused "${1:-}" --argjson purged "$purged" --slurpfile results "$work/results" --slurpfile trash "$work/trash" --slurpfile awaiting "$work/awaiting" \
        --rawfile notes "$work/notes" --argjson trashBytes "${trash_bytes:-null}" \
        '{schema: 1, nodeId: $nodeId, contractWrittenAt: $contractWrittenAt, finishedAt: $finishedAt,
          refused: (if $refused == "" then null else $refused end), results: $results, trash: ($trash | unique_by(.trash)),
          notes: ($notes | split("\n") | map(select(. != ""))), purged: $purged, awaitingKeeperEvidence: $awaiting}
          + (if $trashBytes == null then {} else {trashBytes: $trashBytes} end)' > "$result.new" \
        && mv -f "$result.new" "$result"
}

refuse_whole() {   # <reason>: the run acts on nothing
    log "nothing handed off: $1"
    write_result "$1"
    exit 0
}

api_get() { printf 'header = "X-API-Key: %s"\n' "$key" | curl -fsS -m 10 -K - "$api$1"; }
api_post() { printf 'header = "X-API-Key: %s"\n' "$key" | curl -fsS -m 30 -X POST -K - "$api$1" > /dev/null; }
uri() { jq -rn --arg value "$1" '$value | @uri'; }

# Appends one line, first ending a last line that a torn write left without its newline.
append_line() {   # <file> <line>
    if [ -s "$1" ] && [ -n "$(tail -c 1 -- "$1")" ]; then printf '\n' >> "$1"; fi
    printf '%s\n' "$2" >> "$1"
}

json_lines() { jq -cR 'fromjson? // empty' "$1" 2> /dev/null; }
field() { jq -r "$2" <<< "$1"; }

# [node] values of the node's own .storage/node.toml, one table level deep, as the joins write it.
node_value() {   # <key>
    awk -v wanted="$1" '
        /^[[:space:]]*\[/ { in_node = ($0 ~ /^[[:space:]]*\[node\][[:space:]]*(#.*)?$/); next }
        in_node {
            line = $0; sub(/#.*/, "", line)
            if (match(line, /^[[:space:]]*[A-Za-z0-9_-]+[[:space:]]*=/)) {
                name = line; sub(/[[:space:]]*=.*/, "", name); gsub(/[[:space:]]/, "", name)
                if (name != wanted) next
                value = line; sub(/^[^=]*=[[:space:]]*/, "", value); sub(/[[:space:]]+$/, "", value)
                gsub(/^"|"$/, "", value); print value; exit
            }
        }' "$root/.storage/node.toml"
}

is_inside() {   # <ancestor> <path>, both already resolved
    [ "$2" = "$1" ] || [ "${2#"$1"/}" != "$2" ]
}

# A path an ignore line can name exactly and that cannot leave its folder: no empty, . or .. segment, no
# segment with leading or trailing whitespace, no backslash, glob, escape or control character.
is_plain_relative() {   # <path>
    local path=$1 segment
    [ -n "$path" ] && [ "${path#/}" = "$path" ] || return 1
    case $path in *'\'* | *'*'* | *'?'* | *'['* | *']'* | *'{'* | *'}'* | *'//'*) return 1 ;; esac
    [[ $path =~ [[:cntrl:]] ]] && return 1
    local IFS=/
    for segment in $path; do
        [ -n "$segment" ] && [ "$segment" != . ] && [ "$segment" != .. ] || return 1
        [[ $segment =~ ^[[:space:]] || $segment =~ [[:space:]]$ ]] && return 1
    done
    [ "${path%/}" = "$path" ]
}

# Every directory from the folder down to the file is a real directory and the file a regular file, none
# of them a link, so the path resolves to exactly itself.
is_plain_file() {   # <folder> <relative path>
    local current=$1 rest=$2 segment
    while [ "${rest#*/}" != "$rest" ]; do
        segment=${rest%%/*}
        rest=${rest#*/}
        current=$current/$segment
        [ -d "$current" ] && [ ! -L "$current" ] || return 1
    done
    current=$current/$rest
    [ -f "$current" ] && [ ! -L "$current" ] && [ "$(realpath -e -- "$current" 2> /dev/null)" = "$current" ]
}

# Syncthing's block size for a file: the smallest power of two from 128 KiB to 16 MiB that splits it
# into the block count its index reports.
block_size_for() {   # <size> <block count>
    local size=$1 count=$2 block_size=131072
    if [ "$size" -eq 0 ]; then [ "$count" -eq 1 ] && echo "$block_size"; return; fi
    while [ "$block_size" -le 16777216 ]; do
        [ $(( (size + block_size - 1) / block_size )) -eq "$count" ] && { echo "$block_size"; return 0; }
        block_size=$((block_size * 2))
    done
    return 1
}

# Syncthing's blocksHash: base64 of SHA-256 over the concatenated SHA-256 of each block.
blocks_hash() {   # <file> <size> <block count>
    local block_size
    block_size=$(block_size_for "$2" "$3") || return 1
    { if [ "$2" -eq 0 ]; then printf '' | sha256sum; else split -b "$block_size" --filter='sha256sum' -- "$1"; fi; } \
        | cut -d' ' -f1 | tr -d '\n' | tr a-f A-F | basenc --base16 -d | sha256sum | cut -d' ' -f1 | tr a-f A-F | basenc --base16 -d | base64 -w0
}

# Reads the probe's snapshot once per run, waiting up to HANDOFF_SNAPSHOT_WAIT_SECONDS for one taken at or
# after this run's start; an older or missing one leaves `snapshot_problem` set, and nothing moves. The
# nodes container's own processes (its Syncthings, which only read) share its mount namespace and are left
# out. Processes the probe could not read make the check advisory, said in the result's notes.
load_snapshot() {
    local deadline=$((SECONDS + snapshot_wait)) own header at unreadable key namespace
    snapshot_loaded=yes
    [ -n "$snapshot_path" ] || { snapshot_problem="no open-file snapshot is configured"; return; }
    own=${HANDOFF_OWN_MOUNT_NAMESPACE:-$(readlink /proc/self/ns/mnt)}
    while true; do
        snapshot_problem="the open-file snapshot is missing"
        if cp -- "$snapshot_path" "$work/open.txt" 2> /dev/null; then
            read -r header < "$work/open.txt"
            at=$(awk '$1 == "at" && $2 ~ /^[0-9]+$/ { print $2 }' <<< "$header")
            if [ -z "$at" ]; then snapshot_problem="the open-file snapshot cannot be read"
            elif [ "$at" -lt "$run_start" ]; then snapshot_problem="the open-file snapshot is $((run_start - at)) s older than this run"
            elif [ "$at" -gt $((run_start + contract_max_ahead + snapshot_wait)) ]; then snapshot_problem="the open-file snapshot was taken ahead of this host's clock"
            else snapshot_problem=; break; fi
        fi
        [ "$SECONDS" -lt "$deadline" ] || return
        sleep 1
    done
    unreadable=$(awk '{ for (i = 1; i < NF; i++) if ($i == "unreadable") print $(i + 1) }' <<< "$header")
    [ "${unreadable:-0}" -eq 0 ] || note "the open-file probe could not read $unreadable processes; the size, modification time, hash and quiet period are the guard"
    while read -r key namespace; do
        [ -n "$key" ] && [ "$namespace" != "$own" ] && open_files[$key]=1
    done < <(tail -n +2 "$work/open.txt")
}

is_open() {   # <file>: 0 open, 1 not open, 2 unknown (snapshot_problem says why)
    [ -n "$snapshot_loaded" ] || load_snapshot
    [ -z "$snapshot_problem" ] || return 2
    local key
    key=$(stat -L -c %d:%i -- "$1") || return 2
    [ -n "${open_files[$key]:-}" ]
}

# Why the file on disk does not have the confirmed size and modification time, or nothing; no hash yet.
metadata_difference() {   # <file> <entry json>
    local file=$1 entry=$2 size modified
    is_plain_file "$folder_real" "$(field "$entry" .path)" || { echo "it is not a regular file inside the folder"; return; }
    size=$(stat -c %s -- "$file") || { echo "it cannot be read"; return; }
    [ "$size" = "$(field "$entry" .size)" ] || { echo "its size is $size, not the confirmed $(field "$entry" .size)"; return; }
    modified=$(stat -c %Y -- "$file")
    [ "$modified" = "$(field "$entry" .modifiedSeconds)" ] || { echo "it was modified at $modified, not at the confirmed $(field "$entry" .modifiedSeconds)"; return; }
    [ $(( $(now) - modified )) -ge $((quiet_minutes * 60)) ] || echo "it changed within the last $quiet_minutes minutes"
}

content_difference() {   # <file> <entry json>
    local hash
    hash=$(blocks_hash "$1" "$(field "$2" .size)" "$(field "$2" .numBlocks)") || { echo "its blocks cannot be hashed"; return; }
    [ "$hash" = "$(field "$2" .blocksHash)" ] || echo "its content is not the confirmed content"
}

# Why the node's own Syncthing does not show the confirmed version held by the keeper, or nothing when it
# does; `ignored` is what the entry must read: false before the ignore line, true for a pending retry.
index_difference() {   # <entry json> <ignored>
    local entry=$1 report
    report=$(api_get "/rest/db/file?folder=$(uri "$folder_id")&file=$(uri "$(field "$entry" .path)")") || { echo "its index entry cannot be read"; return; }
    jq -r --argjson entry "$entry" --argjson ignored "$2" '
        if (.local | not) then "it has no entry in the index"
        elif $ignored then (if (.local.ignored == true and .local.version == $entry.version) then empty else "its index entry is not the ignored confirmed version" end)
        elif .local.deleted or .local.ignored or .local.invalid then "its index entry is deleted, ignored or invalid"
        elif .local.version != $entry.version or .local.size != $entry.size or .local.blocksHash != $entry.blocksHash then "its index entry is not the confirmed version"
        else empty end
        // (if .global.version != $entry.version then "the global version is not the confirmed one"
        elif ([.availability[]? | select(.id == $entry.keeperDevice and (.fromTemporary | not))] | length) == 0 then "the keeper does not hold the confirmed version, as this node sees it"
        else empty end)' <<< "$report" | head -1
}

reports_ignored() {   # <path>
    api_get "/rest/db/file?folder=$(uri "$folder_id")&file=$(uri "$1")" 2> /dev/null | jq -e '.local.ignored == true' > /dev/null 2>&1
}

has_line() { grep -Fxq -- "$2" "$1" 2> /dev/null; }

# Why the folder cannot hand anything off here, or nothing: its Syncthing path must be the given one and resolve to itself.
folder_difference() {   # <folder path>
    local config type path real
    config=$(api_get "/rest/config/folders/$(uri "$folder_id")") || { echo "the folder's config cannot be read"; return; }
    type=$(jq -r '.type // ""' <<< "$config")
    path=$(jq -r '.path // ""' <<< "$config")
    path=${path%/}
    [ "$type" = sendonly ] || { echo "the folder is $type here, not send-only"; return; }
    [ "$path" = "${1%/}" ] || { echo "the folder is at $path here, not at the contract's ${1%/}"; return; }
    real=$(realpath -e -- "$path" 2> /dev/null) || { echo "the folder's path does not exist"; return; }
    [ "$real" = "$path" ] || { echo "the folder's path goes through a link"; return; }
    [ "$real" != "$root_real" ] && is_inside "$root_real" "$real" || { echo "the folder is not inside the node's root"; return; }
    has_line "$real/.stignore" "$include_line" && has_line "$real/.stignore" "$list_ignore_line" || { echo "the folder's .stignore does not include the hand-off list yet"; return; }
    [ -f "$real/$handoff_list" ] && [ ! -L "$real/$handoff_list" ] || echo "the folder has no regular $handoff_list"
}

pending_record() {   # <folder id> <path>
    json_lines "$pending_file" | jq -c --arg folder "$1" --arg path "$2" 'select(.folderId == $folder and .path == $path)' | head -1
}

is_pending() { [ -n "$(pending_record "$1" "$2")" ]; }

# Lines of the pending file that are not JSON (a torn write) go to a side file, so the rest still reads.
quarantine_pending() {
    local bad
    bad=$(jq -rR 'select((fromjson? // null) | type != "object")' "$pending_file" 2> /dev/null)
    [ -n "$bad" ] || return 0
    printf '%s\n' "$bad" >> "$pending_file.bad"
    json_lines "$pending_file" > "$pending_file.new" && mv -f -- "$pending_file.new" "$pending_file"
    note "$(grep -c . <<< "$bad") unreadable lines of the pending file were moved to $(basename -- "$pending_file").bad"
}

# Written before the ignore line, so a run that dies in between still knows the path is its own.
pending_add() {   # <entry json>
    is_pending "$folder_id" "$(field "$1" .path)" && return 0
    append_line "$pending_file" "$(jq -cn --argjson entry "$1" --argjson since "$(now)" \
        '{folderId: $entry.folderId, folderPath: $entry.folderPath, path: $entry.path, entry: $entry, since: $since, attempts: 0}')"
}

pending_rewrite() {   # <jq filter over one pending line>
    json_lines "$pending_file" | jq -c --arg folder "$folder_id" --arg path "$current_path" "$1" > "$pending_file.new" && mv -f -- "$pending_file.new" "$pending_file"
}

pending_remove() {   # <path>
    current_path=$1 pending_rewrite 'select((.folderId == $folder and .path == $path) | not)'
}

pending_attempt() {   # <path>: counts one more retry and prints how many there were
    current_path=$1 pending_rewrite 'if .folderId == $folder and .path == $path then .attempts += 1 else . end'
    pending_record "$folder_id" "$1" | jq -r '.attempts'
}

# The intent before the rename: a run that dies between the rename and its manifest line leaves a record
# that reads as moved, so nothing can release its line.
pending_moving() {   # <path> <trash relative, or empty to clear>
    current_path=$1 trash_path=$2 pending_rewrite_moving
}

pending_rewrite_moving() {
    json_lines "$pending_file" | jq -c --arg folder "$folder_id" --arg path "$current_path" --arg trash "$trash_path" \
        'if .folderId == $folder and .path == $path then (if $trash == "" then del(.moving, .trash) else . + {moving: true, trash: $trash} end) else . end' \
        > "$pending_file.new" && mv -f -- "$pending_file.new" "$pending_file"
}

was_moved() {   # <folder id> <path>
    json_lines "$manifest" | jq -e --arg folder "$1" --arg path "$2" 'select(.folderId == $folder and .path == $path)' > /dev/null 2>&1 && return 0
    [ "$(pending_record "$1" "$2" | jq -r '.moving // false')" = true ]
}

# The one way a line leaves .stignore-handoff: the path is this script's pending one, its file is still
# there, and it was never moved, so removing the line puts a file that is still on the node back into sync.
release() {   # <path> <reason>
    local path=$1 list=$folder_real/$handoff_list
    if [ "$(realpath -e -- "$folder_real" 2> /dev/null)" != "$folder_real" ] || ! is_inside "$root_real" "$folder_real" || [ ! -f "$list" ] || [ -L "$list" ]; then
        record "$folder_id" "$path" ignored-not-moved "$2; its line stays, since its folder is not a plain one inside the node's root"
        return
    fi
    if ! is_pending "$folder_id" "$path" || was_moved "$folder_id" "$path" || [ ! -e "$folder_real/$path" ]; then
        record "$folder_id" "$path" ignored-not-moved "$2; its line stays, since its file is not a pending one still on the node"
        return
    fi
    { grep -Fxv -- "/$path" "$list" || true; } > "$list.new" && chown --reference="$list" "$list.new" 2> /dev/null
    chmod --reference="$list" "$list.new" && mv -f -- "$list.new" "$list" || { record "$folder_id" "$path" ignored-not-moved "$2; its line could not be removed"; return; }
    pending_remove "$path"
    api_post "/rest/db/scan?folder=$(uri "$folder_id")&sub=$(uri "$path")" || log "$folder_id/$path: the rescan was not accepted; Syncthing's own picks it up"
    record "$folder_id" "$path" released "$2; its ignore line was removed, so it syncs again"
}

# Prints the trash path relative to the trash root, or the reason with exit 1 when the file stayed at its path,
# or with exit 2 when it changed during the rename and was put back, or with exit 3 when it is in the trash
# and could not be put back.
move_to_trash() {   # <entry json>
    local entry=$1 path file day target directory relative
    path=$(field "$entry" .path)
    file=$folder_real/$path
    day=$(date -u -d "@$(now)" +%F)
    relative=$day/$folder_id/$path
    target=$trash_root/$relative
    directory=$(dirname -- "$target")
    [ ! -e "$target" ] && [ ! -L "$target" ] || { echo "a file of that name is in the trash already"; return 1; }
    mkdir -p -- "$directory" || { echo "the trash folder cannot be made"; return 1; }
    [ "$(stat -c %d -- "$file")" = "$(stat -c %d -- "$directory")" ] || { echo "the trash is on another filesystem"; return 1; }
    pending_moving "$path" "$relative" || { echo "its intent to move could not be recorded"; return 1; }
    if ! mv -n --no-copy -T -- "$file" "$target" 2> /dev/null || [ -e "$file" ] || [ ! -f "$target" ]; then
        [ -e "$file" ] && [ ! -e "$target" ] && pending_moving "$path" ""
        echo "it could not be renamed into the trash"
        return 1
    fi
    if [ "$(stat -c %s:%Y -- "$target")" != "$(jq -r '"\(.size):\(.modifiedSeconds)"' <<< "$entry")" ]; then
        if mv -n --no-copy -T -- "$target" "$file" 2> /dev/null && [ -f "$file" ] && [ ! -e "$target" ]; then
            pending_moving "$path" ""
            echo "it changed while it was moved and was put back"
            return 2
        fi
        append_line "$trash_root/unlisted.jsonl" "$(jq -cn --argjson at "$(now)" --arg trash "$relative" --argjson entry "$entry" \
            '{at: $at, trash: $trash, folderId: $entry.folderId, path: $entry.path, reason: "changed while it was moved and could not be put back"}')"
        echo "$relative"
        return 3
    fi
    record_moved "$entry" "$relative"
    echo "$relative"
}

record_moved() {   # <entry json> <trash relative>
    append_line "$manifest" "$(jq -cn --argjson movedAt "$(now)" --arg trash "$2" --argjson entry "$1" \
        '{movedAt: $movedAt, trash: $trash, folderId: $entry.folderId, folderPath: $entry.folderPath, path: $entry.path, version: $entry.version,
          size: $entry.size, modifiedSeconds: $entry.modifiedSeconds, blocksHash: $entry.blocksHash, keeper: $entry.keeper, keeperDevice: $entry.keeperDevice}')"
}

# After Syncthing reports the path ignored: open, hash, rename. Prints nothing; records the outcome.
finish_path() {   # <entry json>
    local entry=$1 path problem relative status attempts
    path=$(field "$entry" .path)
    problem=$(metadata_difference "$folder_real/$path" "$entry")
    if [ -z "$problem" ]; then
        is_open "$folder_real/$path"
        case $? in
            0) attempts=$(pending_attempt "$path")
               if [ "$attempts" -ge "$pending_attempts" ]; then release "$path" "it was open on $attempts runs"
               else record "$folder_id" "$path" ignored-not-moved "it is open; it is retried next run"; fi
               return ;;
            2) record "$folder_id" "$path" ignored-not-moved "whether it is open cannot be told ($snapshot_problem); it is retried next run"
               return ;;
        esac
    fi
    [ -z "$problem" ] && problem=$(content_difference "$folder_real/$path" "$entry")
    if [ -n "$problem" ]; then release "$path" "$problem after its ignore was written"; return; fi
    relative=$(move_to_trash "$entry")
    status=$?
    case $status in
        0) pending_remove "$path"; record "$folder_id" "$path" moved "" "$relative" ;;
        2) release "$path" "$relative" ;;
        3) pending_remove "$path"; record "$folder_id" "$path" in-trash-unlisted "it changed while it was moved and could not be put back; the trash copy is never emptied" "$relative" ;;
        *) attempts=$(pending_attempt "$path")
           if [ "$attempts" -ge "$pending_attempts" ]; then release "$path" "$relative on $attempts runs"
           else record "$folder_id" "$path" ignored-not-moved "$relative; it is retried next run"; fi ;;
    esac
}

# A record marked `moving` from a run that ended mid-move: the copy in the trash and none at the path means
# the rename happened, so its manifest line is written now; a file at the path and none in the trash means it
# did not, so the mark is cleared and the path retried as usual; anything else stays as it is, reported.
recover_moving() {   # <entry json>
    local entry=$1 path relative target file
    path=$(field "$entry" .path)
    relative=$(pending_record "$folder_id" "$path" | jq -r '.trash // ""')
    target=$trash_root/$relative
    file=$folder_real/$path
    if [ -n "$relative" ] && is_plain_relative "$relative" && is_plain_file "$trash_root" "$relative" && [ ! -e "$file" ] \
        && [ "$(stat -c %s:%Y -- "$target")" = "$(jq -r '"\(.size):\(.modifiedSeconds)"' <<< "$entry")" ]; then
        record_moved "$entry" "$relative"
        pending_remove "$path"
        record "$folder_id" "$path" moved "a run ended between its rename and its manifest line; the line is written now" "$relative"
    elif [ -e "$file" ] && { [ -z "$relative" ] || [ ! -e "$target" ]; }; then
        pending_moving "$path" ""
    else
        record "$folder_id" "$path" ignored-not-moved "a run ended while it was moved and neither its path nor its trash copy is as recorded; it is left as it is"
    fi
}

iso_time='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'

# GNU date also takes now, @seconds, relative phrases and an empty string, none of which say when anything happened.
unix_seconds_of() {   # <RFC 3339 time>
    [[ $1 =~ $iso_time ]] && date -d "$1" +%s 2> /dev/null
}

contract_age_problem() {
    local written age
    written=$(unix_seconds_of "$(jq -r '.writtenAt // ""' "$contract")") || { echo "the contract has no time it was written"; return; }
    age=$(( $(now) - written ))
    [ "$age" -le "$contract_max_age" ] || { echo "the contract is $age s old, more than $contract_max_age s"; return; }
    [ "$age" -ge $(( -contract_max_ahead )) ] || echo "the contract was written $(( -age )) s ahead of this host's clock"
}

# A pending path from an earlier run: its file must still be the record's and Syncthing must still show it ignored at that version.
retry_check() {   # <entry json>: prints `wait` to poll it, `finish` when it is ignored, or nothing when it was settled here
    local entry=$1 path problem attempts
    path=$(field "$entry" .path)
    if [ "$(pending_record "$folder_id" "$path" | jq -r '.moving // false')" = true ]; then
        recover_moving "$entry"
        [ "$(pending_record "$folder_id" "$path" | jq -r '.moving // false')" = true ] && return
        is_pending "$folder_id" "$path" || return
    fi
    if [ ! -e "$folder_real/$path" ] && [ ! -L "$folder_real/$path" ]; then
        pending_remove "$path"
        record "$folder_id" "$path" refused "it is gone from the node without being moved; its ignore line stays"
        return
    fi
    problem=$(metadata_difference "$folder_real/$path" "$entry")
    if [ -n "$problem" ]; then release "$path" "$problem after its ignore was written"; return; fi
    if ! reports_ignored "$path"; then echo wait; return; fi
    problem=$(index_difference "$entry" true)
    if [ -n "$problem" ]; then
        attempts=$(pending_attempt "$path")
        if [ "$attempts" -ge "$pending_attempts" ]; then release "$path" "$problem on $attempts runs"
        else record "$folder_id" "$path" ignored-not-moved "$problem; it is retried next run"; fi
        return
    fi
    echo finish
}

# One folder: earlier pending paths retried, then the contract's entries checked against the index and the
# file's size and time (no hash yet), recorded as pending, ignored together with one rescan of their paths,
# and each, once Syncthing reports it ignored, hashed and moved. A failure leaves that path to its outcome
# and the others go on. The folder has its own deadline, checked before each path.
hand_off_folder() {   # <folder id> <folder path>
    folder_id=$1
    folder_real=${2%/}
    local entries=() pending=() entry path problem waiting=() subs= deadline still action attempts
    local -A retrying=()
    mapfile -t entries < <(jq -c --arg folder "$folder_id" '.entries[] | select(.folderId == $folder)' "$contract")
    mapfile -t pending < <(json_lines "$pending_file" | jq -c --arg folder "$folder_id" 'select(.folderId == $folder) | .entry')
    problem=$(contract_age_problem)
    [ -n "$problem" ] && problem="$problem by this folder's turn"
    [ -z "$problem" ] && problem=$(folder_difference "$folder_real")
    if [ -n "$problem" ]; then
        for entry in "${entries[@]+"${entries[@]}"}"; do record "$folder_id" "$(field "$entry" .path)" refused "$problem"; done
        for entry in "${pending[@]+"${pending[@]}"}"; do
            path=$(field "$entry" .path)
            attempts=$(pending_attempt "$path")
            if [ "$attempts" -ge "$pending_attempts" ]; then release "$path" "$problem on $attempts runs"
            else record "$folder_id" "$path" ignored-not-moved "$problem; it is retried next run"; fi
        done
        return
    fi
    for entry in "${pending[@]+"${pending[@]}"}"; do
        action=$(retry_check "$entry")
        retrying[$(field "$entry" .path)]=1
        [ "$action" = wait ] && subs+="&sub=$(uri "$(field "$entry" .path)")"
        [ -n "$action" ] && waiting+=("$entry")
    done
    for entry in "${entries[@]+"${entries[@]}"}"; do
        path=$(field "$entry" .path)
        if is_pending "$folder_id" "$path"; then continue; fi
        if ! is_plain_relative "$path" || [ "$(field "$entry" .type)" != FILE_INFO_TYPE_FILE ]; then record "$folder_id" "$path" refused "the path is not a plain file path inside the folder"; continue; fi
        if ! is_plain_file "$folder_real" "$path"; then record "$folder_id" "$path" refused "it is not a regular file inside the folder, or a link is on its way"; continue; fi
        problem=$(index_difference "$entry" false)
        [ -z "$problem" ] && problem=$(metadata_difference "$folder_real/$path" "$entry")
        if [ -z "$problem" ]; then
            is_open "$folder_real/$path"
            case $? in
                0) problem="it is open" ;;
                2) problem="whether it is open cannot be told: $snapshot_problem" ;;
            esac
        fi
        if [ -n "$problem" ]; then record "$folder_id" "$path" refused "$problem"; continue; fi
        pending_add "$entry" || { record "$folder_id" "$path" refused "it could not be recorded as pending"; continue; }
        has_line "$folder_real/$handoff_list" "/$path" || append_line "$folder_real/$handoff_list" "/$path"
        subs+="&sub=$(uri "$path")"
        waiting+=("$entry")
    done
    [ -z "$subs" ] || api_post "/rest/db/scan?folder=$(uri "$folder_id")$subs" || log "$folder_id: the rescan was not accepted; waiting for Syncthing's own"
    deadline=$(( SECONDS + ignore_wait ))
    while [ ${#waiting[@]} -gt 0 ]; do
        still=()
        for entry in "${waiting[@]}"; do
            path=$(field "$entry" .path)
            if [ "$SECONDS" -ge "$deadline" ]; then
                attempts=0
                [ -n "${retrying[$path]:-}" ] && attempts=$(pending_attempt "$path")
                if [ "$attempts" -ge "$pending_attempts" ]; then release "$path" "Syncthing did not report it ignored on $attempts runs"
                else record "$folder_id" "$path" ignored-not-moved "Syncthing did not report it ignored within $ignore_wait s; it is retried next run"; fi
                continue
            fi
            if reports_ignored "$path"; then finish_path "$entry"; else still+=("$entry"); fi
        done
        waiting=("${still[@]+"${still[@]}"}")
        [ ${#waiting[@]} -gt 0 ] && sleep 1
    done
    report_strays
}

# A file at a path the list ignores that is not pending and is newer than its hand-off is on this node only.
# At most HANDOFF_STRAY_LIMIT lines per folder and run, from where the last run stopped, so a long list is
# covered over several runs.
report_strays() {
    local line path modified moved offset total offsets=$root_real/.storage/handoff-strays.json
    [ -f "$offsets" ] || echo '{}' > "$offsets"
    total=$(grep -c '' "$folder_real/$handoff_list")
    offset=$(jq -r --arg folder "$folder_id" '.[$folder] // 0 | numbers' "$offsets" 2> /dev/null)
    [ -n "$offset" ] && [ "$offset" -lt "$total" ] || offset=0
    jq --arg folder "$folder_id" --argjson next "$(( offset + stray_limit < total ? offset + stray_limit : 0 ))" '.[$folder] = $next' "$offsets" > "$offsets.new" 2> /dev/null \
        && mv -f -- "$offsets.new" "$offsets" || echo '{}' > "$offsets"
    while IFS= read -r line; do
        path=${line#/}
        [ "$line" != "$path" ] && is_plain_relative "$path" && is_plain_file "$folder_real" "$path" || continue
        is_pending "$folder_id" "$path" && continue
        modified=$(stat -c %Y -- "$folder_real/$path")
        moved=$(json_lines "$manifest" | jq -r --arg folder "$folder_id" --arg path "$path" 'select(.folderId == $folder and .path == $path) | .movedAt' | tail -1)
        if [ -z "$moved" ]; then
            record "$folder_id" "$path" unsynced-at-handed-off-path "a file is at a path the hand-off list ignores, with no record of its hand-off, so it is on this node only"
        elif [ "$modified" -gt "$moved" ]; then
            record "$folder_id" "$path" unsynced-at-handed-off-path "a file newer than its hand-off is at a path the hand-off list ignores, so it is on this node only"
        fi
    done < <(sed -n "$((offset + 1)),$((offset + stray_limit))p" "$folder_real/$handoff_list")
}

# A version descends from the recorded one when every recorded counter is at least as large in it, so a
# keeper's later edit still holds the content handed off.
descends_filter='def counters: map(split(":") | {(.[0]): (.[1] | tonumber? // -1)}) | add // {};
    def descends_from($recorded): counters as $later | [$recorded | counters | to_entries[] | select(($later[.key] // -1) < .value)] | length == 0;'

# Only a held contract may let keeper evidence stand in for the node's own index, and only for a folder this
# node's own Syncthing says is paused: a read that fails for any other reason must keep the copy.
load_paused_folders() {
    jq -e '.apply == false and .trashOnly == true and .entries == []' "$contract" > /dev/null || return 0
    local folder config
    while IFS= read -r folder; do
        config=$(api_get "/rest/config/folders/$(uri "$folder")") || continue
        [ "$(jq -r '.paused == true' <<< "$config" 2> /dev/null)" = true ] && paused_folders[$folder]=1
    done < <(json_lines "$manifest" | jq -r '.folderId | strings' | sort -u)
}

evidence_of() {   # <manifest line>: the contract's evidence from the line's own recorded keeper, or nothing
    jq -c --argjson line "$1" 'first(.trashEvidence[]? | select(.folderId == $line.folderId and .path == $line.path and .keeperDevice == $line.keeperDevice)) // empty' "$contract"
}

# Why the evidence is not recent enough to stand for "the keeper holds it now", or nothing.
evidence_age_problem() {   # <evidence json>
    local observed age
    observed=$(unix_seconds_of "$(jq -r '.observedAt // ""' <<< "$1")") || { echo stale; return; }
    age=$(( $(now) - observed ))
    [ "$age" -le "$contract_max_age" ] && [ "$age" -ge $(( -contract_max_ahead )) ] || echo stale
}

# Why the keeper's own index, as the dashboard read it, does not show the line's version or a later one. Prints
# ok on success, so an answer jq cannot read is a problem like any other.
evidence_verdict() {   # <manifest line> <evidence json>
    jq -r --argjson line "$1" "$descends_filter"'
        if ((.version | type) != "array" or (.globalVersion | type) != "array" or ([.deleted, .ignored, .invalid, .globalDeleted] | map(type) | unique) != ["boolean"]) then "the keeper evidence cannot be read"
        elif .globalDeleted then "the network has its deletion"
        elif (.globalVersion | descends_from($line.version) | not) then "the network no longer has its version or a later one"
        elif .deleted or .ignored or .invalid then "its keeper does not hold it, as its own index says"
        elif (.version | descends_from($line.version) | not) then "its keeper does not hold that version or a later one"
        else "ok" end' <<< "$2" 2> /dev/null
}

evidence_problem() {   # <manifest line>: why the evidence does not stand in for the node's paused index, or nothing
    local evidence verdict
    evidence=$(evidence_of "$1")
    [ -n "$evidence" ] || { echo "its folder is paused here and no keeper evidence names it"; return; }
    [ -z "$(evidence_age_problem "$evidence")" ] || { echo "its folder is paused here and the keeper evidence is stale"; return; }
    verdict=$(evidence_verdict "$1" "$evidence")
    [ "$verdict" = ok ] || echo "${verdict:-the keeper evidence cannot be read}"
}

# Why the recorded keeper may no longer hold the manifest line's version, or nothing. It must be connected to
# this node now (a keeper last seen hours ago may have lost the file since), be in the path's availability
# not from a temporary file, and the global version must be the recorded one or descend from it, not deleted.
keeper_problem() {   # <manifest line>
    local line=$1 report device verdict
    jq -e '.version | arrays | length > 0' <<< "$line" > /dev/null 2>&1 || { echo "no version was recorded with it"; return; }
    device=$(jq -r '.keeperDevice // "" | strings' <<< "$line")
    [ -n "$device" ] || { echo "no keeper was recorded with it"; return; }
    [ -n "${connections+set}" ] || connections=$(api_get /rest/system/connections 2> /dev/null || echo '{}')
    jq -e --arg device "$device" '.connections[$device].connected == true' <<< "$connections" > /dev/null 2>&1 || { echo "its keeper is not connected to this node"; return; }
    if [ -n "${paused_folders[$(field "$line" .folderId)]:-}" ]; then evidence_problem "$line"; return; fi
    report=$(api_get "/rest/db/file?folder=$(uri "$(field "$line" .folderId)")&file=$(uri "$(field "$line" .path)")") || { echo "its index entry cannot be read"; return; }
    verdict=$(jq -r --argjson line "$line" --arg device "$device" "$descends_filter"'
        if (.global.deleted // false) then "the network has its deletion"
        elif (.global.version // [] | descends_from($line.version) | not) then "the network no longer has its version or a later one"
        elif ([.availability[]? | select(.id == $device and (.fromTemporary | not))] | length) == 0 then "its keeper does not hold it, as this node sees it"
        else "ok" end' <<< "$report" 2> /dev/null)
    [ "$verdict" = ok ] || echo "${verdict:-its index entry cannot be read}"
}

# Tells the dashboard which due copies of a paused folder need the keeper's own index read for them.
ask_for_evidence() {   # <manifest line>
    [ -n "${paused_folders[$(field "$1" .folderId)]:-}" ] || return 0
    jq -c '{folderId, path, keeperDevice}' <<< "$1" >> "$work/awaiting"
}

# The result lists a kept copy once per run; the log says it again only when the reason changes or a day passed.
kept_in_trash() {   # <relative> <manifest line> <reason>: prints the manifest line to keep
    jq -cn --arg trash "$1" --argjson line "$2" --arg reason "$3" '{trash: $trash, folderId: $line.folderId, path: $line.path, reason: $reason}' >> "$work/trash"
    if [ "$(jq -r '.keptReason // ""' <<< "$2")" != "$3" ] || [ $(( $(jq -r '.keptAt // 0' <<< "$2") + kept_log_seconds )) -le "$(now)" ]; then
        log "kept $1 in the trash: $3"
        jq -c --arg reason "$3" --argjson at "$(now)" '. + {keptReason: $reason, keptAt: $at}' <<< "$2"
    else
        printf '%s\n' "$2"
    fi
}

# Empties what this script moved into the trash HANDOFF_TRASH_DAYS ago or earlier, by its own manifest: a
# file it did not move there, one changed since, one outside the trash or behind a link, and one whose
# version no keeper holds any more are never deleted (RULES.md section 6).
purge_trash() {
    local line moved relative target directory problem
    [ -f "$manifest" ] && [ ! -L "$manifest" ] || return 0
    : > "$work/kept"
    load_paused_folders
    while IFS= read -r line; do
        moved=$(jq -r '.movedAt | numbers' <<< "$line" 2> /dev/null)
        relative=$(jq -r '.trash | strings' <<< "$line" 2> /dev/null)
        if [ -z "$moved" ] || [ -z "$relative" ] || [ $(( moved + trash_days * 86400 )) -gt "$(now)" ]; then
            printf '%s\n' "$line" >> "$work/kept"
            continue
        fi
        target=$trash_root/$relative
        if ! is_plain_relative "$relative"; then
            kept_in_trash "$relative" "$line" "its manifest line points outside the trash" >> "$work/kept"
            continue
        fi
        if [ ! -e "$target" ] && [ ! -L "$target" ]; then continue; fi
        if ! is_plain_file "$trash_root" "$relative" || [ "$(stat -c %s:%Y -- "$target")" != "$(jq -r '"\(.size):\(.modifiedSeconds)"' <<< "$line")" ]; then
            kept_in_trash "$relative" "$line" "it is not the file this script moved there" >> "$work/kept"
            continue
        fi
        problem=$(keeper_problem "$line")
        if [ -n "$problem" ]; then
            ask_for_evidence "$line"
            kept_in_trash "$relative" "$line" "$problem" >> "$work/kept"
            continue
        fi
        rm -f -- "$target" && purged=$((purged + 1))
        directory=$(dirname -- "$target")
        while [ "$directory" != "$trash_root" ] && is_inside "$trash_root" "$directory" && rmdir -- "$directory" 2> /dev/null; do directory=$(dirname -- "$directory"); done
    done < "$manifest"
    cp -- "$work/kept" "$manifest.new" && mv -f -- "$manifest.new" "$manifest"
}

report_unlisted() {
    [ -f "$trash_root/unlisted.jsonl" ] || return 0
    local line
    while IFS= read -r line; do
        jq -c '{trash, folderId, path, reason: "in the trash outside the manifest, never emptied: \(.reason)"}' <<< "$line" >> "$work/trash" 2> /dev/null
    done < "$trash_root/unlisted.jsonl"
}

contract_problem() {
    jq -e . "$contract" > /dev/null 2>&1 || { echo "the contract cannot be read"; return; }
    jq -e '.schema == 1' "$contract" > /dev/null || { echo "the contract is not schema 1"; return; }
    jq -e --arg id "$node_id" '.nodeId == $id' "$contract" > /dev/null || { echo "the contract names another node"; return; }
    jq -e '.cluster == false' "$contract" > /dev/null || { echo "the contract is the cluster's, which never hands off"; return; }
    jq -e '.apply == true or (.trashOnly == true and .entries == [])' "$contract" > /dev/null || { echo "the contract is not in apply mode"; return; }
    jq -e '.entries | type == "array"' "$contract" > /dev/null || { echo "the contract has no list of entries"; return; }
    contract_age_problem
}

# Every folder the run looks at, with its path: the contract's, then the pending and moved paths' own.
folders_of_run() {
    { jq -c '.entries[] | {folderId, folderPath}' "$contract"
      json_lines "$pending_file" | jq -c '{folderId, folderPath}'
      json_lines "$manifest" | jq -c 'select(.folderPath) | {folderId, folderPath}' 
    } | jq -rs 'group_by(.folderId) | .[] | "\(.[0].folderId)\t\(.[0].folderPath)"'
}

main() {
    [[ $node_id =~ ^[0-9a-f]{4}$ ]] && [ -n "$api" ] && [ -n "$key" ] && [ -n "$contract_source" ] && [ -n "$result" ] \
        || { echo "usage: handoff.sh <node id> <node root> <api url> <api key> <contract file> <result file>" >&2; exit 2; }
    root_real=$(realpath -e -- "$root" 2> /dev/null) && [ -d "$root_real" ] || refuse_whole "the node's root $root does not exist"
    [ -d "$root_real/.storage" ] && [ ! -L "$root_real/.storage" ] || refuse_whole "the node's root has no .storage folder"
    exec 9<> "$root_real/.storage/handoff.lock" || refuse_whole "the lock file cannot be opened"
    flock -n 9 || { log "another hand-off run holds the lock; this run does nothing"; exit 0; }
    printf '%s %s\n' "$$" "$(date -u +%FT%TZ)" > "$root_real/.storage/handoff.lock"
    [ "$(node_value id)" = "$node_id" ] || refuse_whole "the node file is not node $node_id's"
    [ "$(node_value kind)" != array ] || refuse_whole "an array never hands off"
    [ "$node_id" != "$cluster_id" ] || refuse_whole "the cluster never hands off"
    run_start=$(now)
    cp -- "$contract_source" "$contract" 2> /dev/null || refuse_whole "the contract cannot be read"
    local problem
    problem=$(contract_problem)
    [ -z "$problem" ] || refuse_whole "$problem"
    # A held trash-only contract names no file and only empties the trash under its own checks, so it needs no apply in the node file.
    if jq -e '.apply == true' "$contract" > /dev/null; then
        [ "$(node_value apply)" = true ] || refuse_whole "the node file does not say apply = true"
    fi
    trash_root=$root_real/.storage/handoff-trash
    manifest=$trash_root/manifest.jsonl
    pending_file=$root_real/.storage/handoff-pending.jsonl
    mkdir -p -- "$trash_root" && [ ! -L "$trash_root" ] || refuse_whole "the trash folder cannot be made"
    [ ! -L "$pending_file" ] || refuse_whole "the pending file is a link"
    touch -- "$pending_file" || refuse_whole "the pending file cannot be made"
    if jq -e '.apply == true' "$contract" > /dev/null; then
        quarantine_pending
        local folder path
        while IFS=$'\t' read -r folder path; do
            [ -n "$folder" ] && hand_off_folder "$folder" "$path"
        done < <(folders_of_run)
    else
        note "the contract holds every hand-off: only the trash is emptied"
    fi
    purge_trash
    report_unlisted
    trash_bytes=$(json_lines "$manifest" | jq -s --slurpfile kept "$work/trash" '[$kept[].trash] as $held | map(select(.trash as $t | $held | index($t) | not) | .size | numbers) | add // 0')
    write_result
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main; fi
