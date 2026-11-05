#!/bin/bash
# handoff.sh <node id> <node root> <api url> <api key> <contract file> <result file>: the layered sync's
# hand-off executor for one Linux node (plan call 3), run by the nodes service and, in phase 6, by the
# Linux join's timer. It acts only on files the dashboard's contract names, only while the node's own
# node file says apply = true, and only on a file that is still the confirmed one on disk: it appends
# the path to the folder's .stignore-handoff, waits until Syncthing reports it ignored, then renames it
# into <root>/.storage/handoff-trash/<day>/<folder id>/. Nothing is deleted except what this script
# moved into that trash, once it is HANDOFF_TRASH_DAYS old. It never removes a .stignore-handoff line
# and never asks Syncthing to override, revert or delete anything. Needs bash, jq, curl, flock and
# GNU coreutils (mv --no-copy, split --filter, basenc).
set -u

node_id=${1:-}
root=${2:-}
api=${3:-}
key=${4:-}
contract=${5:-}
result=${6:-}

trash_days=${HANDOFF_TRASH_DAYS:-7}
quiet_minutes=${HANDOFF_QUIET_MINUTES:-10}
# Two layout rounds of 60 s plus the 120 s a keeper's report may be old when the dashboard decides; an older
# contract may rest on a keeper that has since frozen or lost the file.
contract_max_age=${HANDOFF_CONTRACT_MAX_AGE_SECONDS:-300}
contract_max_ahead=60
ignore_wait=${HANDOFF_IGNORE_WAIT_SECONDS:-60}
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
purged=0

# One line per path the contract named: what happened to it and why.
record() {   # <folder id> <path> <outcome> <reason> [trash path]
    jq -cn --arg folderId "$1" --arg path "$2" --arg outcome "$3" --arg reason "$4" --arg trash "${5:-}" \
        '{folderId: $folderId, path: $path, outcome: $outcome, reason: $reason} + (if $trash == "" then {} else {trash: $trash} end)' >> "$work/results"
    [ "$3" = moved ] || log "$1/$2: $3: $4"
}

write_result() {   # [refusal]
    [ -n "$result" ] || return 0
    local written_at=
    [ -f "$contract" ] && written_at=$(jq -r '.writtenAt? // "" | strings' "$contract" 2> /dev/null)
    jq -n --arg nodeId "$node_id" --arg contractWrittenAt "$written_at" --arg finishedAt "$(date -u -d "@$(now)" +%FT%TZ)" \
        --arg refused "${1:-}" --argjson purged "$purged" --slurpfile results "$work/results" \
        '{schema: 1, nodeId: $nodeId, contractWrittenAt: $contractWrittenAt, finishedAt: $finishedAt,
          refused: (if $refused == "" then null else $refused end), results: $results, purged: $purged}' > "$result.new" \
        && mv -f "$result.new" "$result"
}

refuse_whole() {   # <reason>: the run acts on nothing
    log "nothing handed off: $1"
    write_result "$1"
    exit 0
}

api_get() { curl -fsS -m 10 -H "X-API-Key: $key" "$api$1"; }
api_post() { curl -fsS -m 30 -X POST -H "X-API-Key: $key" "$api$1" > /dev/null; }
uri() { jq -rn --arg value "$1" '$value | @uri'; }

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
# backslash, no glob or escape character and no control character.
is_plain_relative() {   # <path>
    local path=$1 segment
    [ -n "$path" ] && [ "${path#/}" = "$path" ] || return 1
    case $path in *'\'* | *'*'* | *'?'* | *'['* | *']'* | *'{'* | *'}'* | *'//'*) return 1 ;; esac
    [[ $path =~ [[:cntrl:]] ]] && return 1
    local IFS=/
    for segment in $path; do
        [ -n "$segment" ] && [ "$segment" != . ] && [ "$segment" != .. ] || return 1
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

is_open() {   # <file>
    local descriptor
    for descriptor in "$proc_root"/[0-9]*/fd/*; do
        [ "$(readlink "$descriptor" 2> /dev/null)" = "$1" ] && return 0
    done
    return 1
}

# Why the file on disk is not the confirmed one, or nothing when it is.
disk_difference() {   # <file> <entry json>
    local file=$1 entry=$2 size modified hash
    is_plain_file "$folder_real" "$(jq -r .path <<< "$entry")" || { echo "it is not a regular file inside the folder"; return; }
    size=$(stat -c %s -- "$file") || { echo "it cannot be read"; return; }
    [ "$size" = "$(jq -r .size <<< "$entry")" ] || { echo "its size is $size, not the confirmed $(jq -r .size <<< "$entry")"; return; }
    modified=$(stat -c %Y -- "$file")
    [ "$modified" = "$(jq -r .modifiedSeconds <<< "$entry")" ] || { echo "it was modified at $modified, not at the confirmed $(jq -r .modifiedSeconds <<< "$entry")"; return; }
    [ $(( $(now) - modified )) -ge $((quiet_minutes * 60)) ] || { echo "it changed within the last $quiet_minutes minutes"; return; }
    is_open "$file" && { echo "it is open"; return; }
    hash=$(blocks_hash "$file" "$size" "$(jq -r .numBlocks <<< "$entry")") || { echo "its blocks cannot be hashed"; return; }
    [ "$hash" = "$(jq -r .blocksHash <<< "$entry")" ] || echo "its content is not the confirmed content"
}

# Why the node's own Syncthing does not show the confirmed version held by the keeper, or nothing when it does.
index_difference() {   # <entry json>
    local entry=$1 report
    report=$(api_get "/rest/db/file?folder=$(uri "$folder_id")&file=$(uri "$(jq -r .path <<< "$entry")")") || { echo "its index entry cannot be read"; return; }
    jq -r --argjson entry "$entry" '
        if (.local | not) then "it has no entry in the index"
        elif .local.deleted or .local.ignored or .local.invalid then "its index entry is deleted, ignored or invalid"
        elif .local.version != $entry.version or .local.size != $entry.size or .local.blocksHash != $entry.blocksHash then "its index entry is not the confirmed version"
        elif .global.version != $entry.version then "the global version is not the confirmed one"
        elif ([.availability[]? | select(.id == $entry.keeperDevice and (.fromTemporary | not))] | length) == 0 then "the keeper does not hold the confirmed version, as this node sees it"
        else empty end' <<< "$report"
}

reports_ignored() {   # <path>
    api_get "/rest/db/file?folder=$(uri "$folder_id")&file=$(uri "$1")" 2> /dev/null | jq -e '.local.ignored == true' > /dev/null 2>&1
}

has_line() { grep -Fxq -- "$2" "$1" 2> /dev/null; }

# Why the folder cannot hand anything off here, or nothing: its Syncthing path must be the contract's and resolve to itself.
folder_difference() {   # <contract folder path>
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

move_to_trash() {   # <entry json>: prints the trash path relative to the trash root, or fails with the reason
    local entry=$1 path file day target directory relative
    path=$(jq -r .path <<< "$entry")
    file=$folder_real/$path
    day=$(date -u -d "@$(now)" +%F)
    relative=$day/$folder_id/$path
    target=$trash_root/$relative
    directory=$(dirname -- "$target")
    [ ! -e "$target" ] && [ ! -L "$target" ] || { echo "a file of that name is in the trash already"; return 1; }
    mkdir -p -- "$directory" || { echo "the trash folder cannot be made"; return 1; }
    [ "$(stat -c %d -- "$file")" = "$(stat -c %d -- "$directory")" ] || { echo "the trash is on another filesystem"; return 1; }
    mv -n --no-copy -T -- "$file" "$target" 2> /dev/null && [ ! -e "$file" ] && [ -f "$target" ] || { echo "it could not be renamed into the trash"; return 1; }
    if [ "$(stat -c %s:%Y -- "$target")" != "$(jq -r '"\(.size):\(.modifiedSeconds)"' <<< "$entry")" ]; then
        mv -n --no-copy -T -- "$target" "$file" 2> /dev/null
        echo "it changed while it was moved, so it was put back"
        return 1
    fi
    jq -cn --argjson movedAt "$(now)" --arg trash "$relative" --argjson entry "$entry" \
        '{movedAt: $movedAt, trash: $trash, folderId: $entry.folderId, path: $entry.path, size: $entry.size, modifiedSeconds: $entry.modifiedSeconds, blocksHash: $entry.blocksHash, keeper: $entry.keeper}' \
        >> "$trash_root/manifest.jsonl"
    echo "$relative"
}

# One folder's entries: each checked against its index and its disk, the passing ones ignored together,
# then each checked again and moved. A failure leaves that path as it is and the others go on.
hand_off_folder() {   # <folder id>
    folder_id=$1
    local entries entry path problem passed=() waiting deadline relative
    mapfile -t entries < <(jq -c --arg folder "$folder_id" '.entries[] | select(.folderId == $folder)' "$contract")
    folder_real=$(jq -r .folderPath <<< "${entries[0]}")
    folder_real=${folder_real%/}
    problem=$(folder_difference "$folder_real")
    if [ -n "$problem" ]; then
        for entry in "${entries[@]}"; do record "$folder_id" "$(jq -r .path <<< "$entry")" refused "$problem"; done
        return
    fi
    for entry in "${entries[@]}"; do
        path=$(jq -r .path <<< "$entry")
        if ! is_plain_relative "$path" || [ "$(jq -r .type <<< "$entry")" != FILE_INFO_TYPE_FILE ]; then record "$folder_id" "$path" refused "the path is not a plain file path inside the folder"; continue; fi
        if ! is_plain_file "$folder_real" "$path"; then record "$folder_id" "$path" refused "it is not a regular file inside the folder, or a link is on its way"; continue; fi
        problem=$(index_difference "$entry")
        [ -z "$problem" ] && problem=$(disk_difference "$folder_real/$path" "$entry")
        if [ -n "$problem" ]; then record "$folder_id" "$path" refused "$problem"; continue; fi
        passed+=("$entry")
    done
    [ ${#passed[@]} -gt 0 ] || return
    for entry in "${passed[@]}"; do
        path=$(jq -r .path <<< "$entry")
        has_line "$folder_real/$handoff_list" "/$path" || printf '/%s\n' "$path" >> "$folder_real/$handoff_list"
    done
    api_post "/rest/db/scan?folder=$(uri "$folder_id")" || log "$folder_id: the rescan was not accepted; waiting for Syncthing's own"
    waiting=("${passed[@]}")
    deadline=$(( SECONDS + ignore_wait ))
    while [ ${#waiting[@]} -gt 0 ]; do
        local still=()
        for entry in "${waiting[@]}"; do
            path=$(jq -r .path <<< "$entry")
            if ! reports_ignored "$path"; then still+=("$entry"); continue; fi
            problem=$(disk_difference "$folder_real/$path" "$entry")
            if [ -n "$problem" ]; then record "$folder_id" "$path" ignored-not-moved "$problem after its ignore was written; it stays on the node"; continue; fi
            if relative=$(move_to_trash "$entry"); then record "$folder_id" "$path" moved "" "$relative"
            else record "$folder_id" "$path" ignored-not-moved "$relative; it stays on the node"; fi
        done
        waiting=("${still[@]+"${still[@]}"}")
        [ ${#waiting[@]} -gt 0 ] || break
        [ "$SECONDS" -ge "$deadline" ] && break
        sleep 1
    done
    for entry in "${waiting[@]+"${waiting[@]}"}"; do
        record "$folder_id" "$(jq -r .path <<< "$entry")" ignored-not-moved "Syncthing does not report it ignored within $ignore_wait s; it stays on the node"
    done
}

# Empties what this script moved into the trash HANDOFF_TRASH_DAYS ago or earlier, by its own manifest: a
# file it did not move there, or one changed since, is never deleted.
purge_trash() {
    local manifest=$trash_root/manifest.jsonl line moved relative target directory
    [ -f "$manifest" ] && [ ! -L "$manifest" ] || return 0
    : > "$work/kept"
    while IFS= read -r line; do
        moved=$(jq -r '.movedAt | numbers' <<< "$line" 2> /dev/null)
        relative=$(jq -r '.trash | strings' <<< "$line" 2> /dev/null)
        if [ -z "$moved" ] || [ -z "$relative" ] || ! is_plain_relative "$relative" || [ $(( moved + trash_days * 86400 )) -gt "$(now)" ]; then
            printf '%s\n' "$line" >> "$work/kept"
            continue
        fi
        target=$trash_root/$relative
        if [ ! -e "$target" ] && [ ! -L "$target" ]; then continue; fi
        if ! is_plain_file "$trash_root" "$relative" || [ "$(stat -c %s:%Y -- "$target")" != "$(jq -r '"\(.size):\(.modifiedSeconds)"' <<< "$line")" ]; then
            log "kept $relative in the trash: it is not the file this script moved there"
            printf '%s\n' "$line" >> "$work/kept"
            continue
        fi
        rm -f -- "$target" && purged=$((purged + 1))
        directory=$(dirname -- "$target")
        while [ "$directory" != "$trash_root" ] && is_inside "$trash_root" "$directory" && rmdir -- "$directory" 2> /dev/null; do directory=$(dirname -- "$directory"); done
    done < "$manifest"
    cp -- "$work/kept" "$manifest.new" && mv -f -- "$manifest.new" "$manifest"
}

contract_problem() {
    local written age
    jq -e . "$contract" > /dev/null 2>&1 || { echo "the contract cannot be read"; return; }
    jq -e '.schema == 1' "$contract" > /dev/null || { echo "the contract is not schema 1"; return; }
    jq -e --arg id "$node_id" '.nodeId == $id' "$contract" > /dev/null || { echo "the contract names another node"; return; }
    jq -e '.cluster == false' "$contract" > /dev/null || { echo "the contract is the cluster's, which never hands off"; return; }
    jq -e '.apply == true' "$contract" > /dev/null || { echo "the contract is not in apply mode"; return; }
    jq -e '.entries | type == "array"' "$contract" > /dev/null || { echo "the contract has no list of entries"; return; }
    written=$(date -d "$(jq -r '.writtenAt // ""' "$contract")" +%s 2> /dev/null) || { echo "the contract has no time it was written"; return; }
    age=$(( $(now) - written ))
    [ "$age" -le "$contract_max_age" ] || { echo "the contract is $age s old, more than $contract_max_age s"; return; }
    [ "$age" -ge $(( -contract_max_ahead )) ] || echo "the contract was written $(( -age )) s ahead of this host's clock"
}

main() {
    [[ $node_id =~ ^[0-9a-f]{4}$ ]] && [ -n "$api" ] && [ -n "$key" ] && [ -n "$contract" ] && [ -n "$result" ] \
        || { echo "usage: handoff.sh <node id> <node root> <api url> <api key> <contract file> <result file>" >&2; exit 2; }
    root_real=$(realpath -e -- "$root" 2> /dev/null) && [ -d "$root_real" ] || refuse_whole "the node's root $root does not exist"
    [ -d "$root_real/.storage" ] && [ ! -L "$root_real/.storage" ] || refuse_whole "the node's root has no .storage folder"
    exec 9<> "$root_real/.storage/handoff.lock" || refuse_whole "the lock file cannot be opened"
    flock -n 9 || { log "another hand-off run holds the lock; this run does nothing"; exit 0; }
    printf '%s %s\n' "$$" "$(date -u +%FT%TZ)" > "$root_real/.storage/handoff.lock"
    [ "$(node_value id)" = "$node_id" ] || refuse_whole "the node file is not node $node_id's"
    [ "$(node_value apply)" = true ] || refuse_whole "the node file does not say apply = true"
    [ "$(node_value kind)" != array ] || refuse_whole "an array never hands off"
    [ "$node_id" != "$cluster_id" ] || refuse_whole "the cluster never hands off"
    local problem
    problem=$(contract_problem)
    [ -z "$problem" ] || refuse_whole "$problem"
    trash_root=$root_real/.storage/handoff-trash
    mkdir -p -- "$trash_root" && [ ! -L "$trash_root" ] || refuse_whole "the trash folder cannot be made"
    local folder
    while IFS= read -r folder; do
        [ -n "$folder" ] && hand_off_folder "$folder"
    done < <(jq -r '[.entries[].folderId] | unique | .[]' "$contract")
    purge_trash
    write_result
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main; fi
