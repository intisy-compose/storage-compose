#!/bin/bash
# tests/nodes/handoff.test.sh: the Linux hand-off executor (images/nodes/handoff.sh) on scratch nodes
# against a fake Syncthing (a stub curl that keeps its index in files). Needs jq and GNU coreutils;
# where jq is missing (Git Bash) it runs itself in a throwaway container with no network. Prints PASS
# or FAIL per check and exits non-zero on any failure.
set -u

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)

if ! command -v jq > /dev/null 2>&1; then
    export MSYS_NO_PATHCONV=1
    native_repo=$(cd "$repo" && { pwd -W 2> /dev/null || pwd; })
    docker build --quiet -t storage-nodes-tests:local - > /dev/null << 'EOF' || exit 1
FROM debian:trixie-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends jq=1.7.1-6+deb13u4 curl=8.14.1-2+deb13u7 \
    && rm -rf /var/lib/apt/lists/*
EOF
    exec docker run --rm --network none --tmpfs /mnt/node --tmpfs /mnt/node/Videos -v "$native_repo:/repo:ro" storage-nodes-tests:local bash /repo/tests/nodes/handoff.test.sh
fi

handoff=$repo/images/nodes/handoff.sh
probe=$repo/images/nodes/handoff-probe.sh
scratch=$(mktemp -d)
trap 'kill $(jobs -p) 2> /dev/null; rm -rf "$scratch"' EXIT
passed=0
failed=0

check() {
    local what="$1" expected="$2" actual="$3"
    if [[ "$expected" == "$actual" ]]; then echo "  PASS $what"; passed=$((passed + 1))
    else echo "  FAIL $what: expected '$expected', got '$actual'"; failed=$((failed + 1)); fi
}

now=1793872800
hello_hash=lZXJ35AHUUjrBoYDZd8zWEt1v/eCpRDGzUiDpBmDPVA=
keeper_device=KEEPER-DEVICE
export FAKE=$scratch/fake CURL_LOG=$scratch/curl.log

mkdir -p "$scratch/stubs"
cat > "$scratch/stubs/curl" << 'EOF'
#!/bin/bash
method=GET url=
while [ $# -gt 0 ]; do
    case $1 in
        -X) method=$2; shift ;;
        -H | -m) shift ;;
        -*) ;;
        *) url=$1 ;;
    esac
    shift
done
request=${url#http://127.0.0.1:8411}
echo "$method $request" >> "$CURL_LOG"
if [ -n "${FAKE_REPLACE_CONTRACT:-}" ] && [ ! -e "$FAKE/replaced" ]; then cp "$FAKE_REPLACE_CONTRACT" "$FAKE_CONTRACT"; touch "$FAKE/replaced"; fi
decode() { printf '%b' "${1//%/\\x}"; }
parameter() { local value; value=$(sed -n "s/.*[?&]$1=\([^&]*\).*/\1/p" <<< "$request"); decode "$value"; }
key_of() { printf '%s' "$1" | sha256sum | cut -c1-16; }
case "$method ${request%%\?*}" in
    "GET /rest/config/folders/"*)
        cat "$FAKE/folders/$(decode "${request##*/}").json" 2> /dev/null || exit 22 ;;
    "GET /rest/db/file")
        folder=$(parameter folder) file=$(parameter file)
        record=$FAKE/files/$folder/$(key_of "$file").json
        [ -f "$record" ] || exit 22
        if grep -Fxq -- "/$file" "$FAKE/ignored/$folder" 2> /dev/null; then
            jq '.local += {ignored: true, invalid: true, size: 0, numBlocks: 0, blocksHash: null}' "$record"
        else cat "$record"; fi ;;
    "GET /rest/system/connections")
        cat "$FAKE/connections.json" 2> /dev/null || echo '{"connections": {"KEEPER-DEVICE": {"connected": true}}}' ;;
    "POST /rest/db/scan")
        folder=$(parameter folder)
        path=$(jq -r .path "$FAKE/folders/$folder.json")
        while IFS= read -r line; do
            [ -e "$path$line" ] && echo "scan $folder $line present" >> "$FAKE/scans" || echo "scan $folder $line absent" >> "$FAKE/scans"
        done < "$path/.stignore-handoff"
        if [ -z "${FAKE_NEVER_IGNORES:-}" ] && grep -Fxq '#include .stignore-handoff' "$path/.stignore"; then cp "$path/.stignore-handoff" "$FAKE/ignored/$folder"; fi
        [ -n "${FAKE_WRITE_ON_SCAN:-}" ] && printf ' written during the scan' >> "$path/$FAKE_WRITE_ON_SCAN" ;;
    *) exit 22 ;;
esac
EOF
chmod +x "$scratch/stubs/curl"

# mv as the executor sees it: MV_GROW appends to a file just renamed into the trash, as a writer still
# holding it would, and MV_FAIL_BACK makes the rename out of the trash fail.
cat > "$scratch/stubs/mv" << 'EOF'
#!/bin/bash
source=${@: -2:1} target=${@: -1}
case $source in */handoff-trash/*) [ -n "${MV_FAIL_BACK:-}" ] && exit 1 ;; esac
/usr/bin/mv "$@" || exit
case $target in */handoff-trash/*) [ -n "${MV_GROW:-}" ] && printf ' grown' >> "$target" && touch -d "@$MV_GROW" "$target" ;; esac
exit 0
EOF
chmod +x "$scratch/stubs/mv"

# A scratch drive node a001 with one send-only folder `videos` at <root>/Videos and `clip.mp4` in it.
new_node() {   # <name> [root]: sets root
    root=${2:-$scratch/$1}
    rm -rf "$FAKE"
    if [ -n "${2:-}" ]; then rm -rf "${root:?}"/Videos/* "${root:?}"/Videos/.st* "$root/.storage"; else rm -rf "$root"; fi
    mkdir -p "$root/.storage" "$root/Videos" "$FAKE/folders" "$FAKE/files/videos" "$FAKE/ignored"
    printf '[node]\nid = "a001"\nname = "stick"\nkind = "drive"\nthreshold = 50\napply = true\n' > "$root/.storage/node.toml"
    printf '// layered sync begin\n#include .stignore-handoff\n/.stignore-handoff\n// layered sync end\n' > "$root/Videos/.stignore"
    : > "$root/Videos/.stignore-handoff"
    jq -n --arg path "$root/Videos" '{id: "videos", label: "Videos", path: $path, type: "sendonly"}' > "$FAKE/folders/videos.json"
    : > "$CURL_LOG"
    : > "$FAKE/scans"
    add_file clip.mp4 hello
}

add_file() {   # <relative path> <content>: the file on disk, made an hour before now, and its index entry
    mkdir -p "$(dirname "$root/Videos/$1")"
    printf '%s' "$2" > "$root/Videos/$1"
    touch -d "@$((now - 3600))" "$root/Videos/$1"
    index_entry "$1" "$(printf '%s' "$2" | wc -c)"
}

held_by_keeper=$(jq -cn --arg id "$keeper_device" '[{id: $id, fromTemporary: false}]')

index_entry() {   # <relative path> <size> [version] [availability json]
    jq -n --argjson size "$2" --arg hash "$hello_hash" --arg version "${3:-STICK:1}" --argjson availability "${4:-$held_by_keeper}" \
        '{local: {name: "x", size: $size, numBlocks: 1, blocksHash: $hash, version: [$version], deleted: false, ignored: false, invalid: false},
          global: {size: $size, version: [$version]}, availability: $availability}' \
        > "$FAKE/files/videos/$(printf '%s' "$1" | sha256sum | cut -c1-16).json"
}

entry() {   # <relative path> [size] [hash] [folder path]
    jq -cn --arg path "$1" --argjson size "${2:-5}" --arg hash "${3:-$hello_hash}" --arg folder "${4:-$root/Videos}" --argjson modified "$((now - 3600))" --arg device "$keeper_device" \
        '{folderId: "videos", folderPath: $folder, path: $path, type: "FILE_INFO_TYPE_FILE", version: ["STICK:1"], size: $size, numBlocks: 1,
          blocksHash: $hash, modified: "x", modifiedSeconds: $modified, keeper: "b002", keeperDevice: $device}'
}

contract() {   # [entry json]...: written ten seconds before $written_now (now) for a001, apply on
    jq -n --arg written "$(date -u -d "@$((${written_now:-$now} - 10))" +%FT%TZ)" --slurpfile entries <(printf '%s\n' "$@") \
        '{schema: 1, nodeId: "a001", writtenAt: $written, apply: true, cluster: false, quietMinutes: 10, entries: $entries, waiting: [], notes: []}' > "$scratch/contract.json"
}

# The probe's snapshot as of the run's clock, taken in this container, unless a test placed its own.
fresh_snapshot() {
    mkdir -p "$scratch/probe"
    HANDOFF_NOW=${run_now:-$now} bash "$probe" "$scratch/probe" --once
}

run_handoff() {   # [node id]: runs the executor on the scratch node, its log in $scratch/handoff.out
    [ -n "${keep_snapshot:-}" ] || fresh_snapshot
    HANDOFF_OPEN_SNAPSHOT=$scratch/probe/open.txt HANDOFF_SNAPSHOT_WAIT_SECONDS=0 \
    PATH="$scratch/stubs:$PATH" HANDOFF_NOW=${run_now:-$now} HANDOFF_IGNORE_WAIT_SECONDS=${ignore_wait:-2} HANDOFF_CLUSTER_ID=${cluster_id:-c1c1} \
        HANDOFF_OWN_MOUNT_NAMESPACE=${own_namespace:-$(readlink /proc/self/ns/mnt)} FAKE_CONTRACT=$scratch/contract.json \
        bash "$handoff" "${1:-a001}" "$root" http://127.0.0.1:8411 secret-key "$scratch/contract.json" "$scratch/result.json" > "$scratch/handoff.out" 2>&1
}

outcome_of() { jq -r --arg path "$1" '[.results[] | select(.path == $path) | .outcome] | join(",")' "$scratch/result.json"; }
reason_of() { jq -r --arg path "$1" '[.results[] | select(.path == $path) | .reason] | join(",")' "$scratch/result.json"; }
refusal() { jq -r '.refused // "none"' "$scratch/result.json"; }
present() { [ -e "$root/Videos/$1" ] && echo yes || echo no; }
listed() { grep -Fxc -- "/$1" "$root/Videos/.stignore-handoff"; }
trash_day=$(date -u -d "@$now" +%F)
in_trash() { [ -f "$root/.storage/handoff-trash/$trash_day/videos/$1" ] && echo yes || echo no; }
pending_record_attempts() { jq -r .attempts "$root/.storage/handoff-pending.jsonl"; }
pending_paths() { jq -r .path "$root/.storage/handoff-pending.jsonl" 2> /dev/null | paste -sd ' ' -; }
trash_kept() { jq -r '[.trash[] | "\(.trash): \(.reason)"] | join("|")' "$scratch/result.json"; }
destructive_requests() { grep -Eic 'override|revert|DELETE|PUT |PATCH |/rest/system' "$CURL_LOG"; }

echo "a confirmed file"
new_node confirmed
contract "$(entry clip.mp4)"
run_handoff
check "is moved into the node's trash" "no yes moved" "$(present clip.mp4) $(in_trash clip.mp4) $(outcome_of clip.mp4)"
check "with its content" hello "$(cat "$root/.storage/handoff-trash/$trash_day/videos/clip.mp4")"
check "after its ignore line was written and the folder rescanned while it was still there" "1 scan videos /clip.mp4 present" "$(listed clip.mp4) $(cat "$FAKE/scans")"
check "and the manifest records what was moved" "$trash_day/videos/clip.mp4 5 $((now - 3600))" "$(jq -r '"\(.trash) \(.size) \(.modifiedSeconds)"' "$root/.storage/handoff-trash/manifest.jsonl")"
check "the only write it sends is the rescan of its path" "POST /rest/db/scan?folder=videos&sub=clip.mp4" "$(grep -v '^GET ' "$CURL_LOG")"
check "the lock is an owner file, not a directory" "file" "$([ -f "$root/.storage/handoff.lock" ] && echo file || echo other)"

echo "a file that is not the confirmed one is left untouched, and the others go on"
new_node changed
add_file grown.mp4 hello
printf ' and more' >> "$root/Videos/grown.mp4"
touch -d "@$((now - 3600))" "$root/Videos/grown.mp4"
add_file touched.mp4 hello
touch -d "@$((now - 1800))" "$root/Videos/touched.mp4"
add_file rewritten.mp4 hello
printf 'world' > "$root/Videos/rewritten.mp4"
touch -d "@$((now - 3600))" "$root/Videos/rewritten.mp4"
add_file fresh.mp4 hello
touch -d "@$((now - 60))" "$root/Videos/fresh.mp4"
contract "$(entry grown.mp4)" "$(entry touched.mp4)" "$(entry rewritten.mp4)" "$(jq -c --argjson modified "$((now - 60))" '.modifiedSeconds = $modified' <<< "$(entry fresh.mp4)")" "$(entry clip.mp4)"
run_handoff
for name in grown.mp4 touched.mp4 fresh.mp4; do
    check "$name stays, unlisted" "yes 0 refused" "$(present "$name") $(listed "$name") $(outcome_of "$name")"
done
check "the reasons name the difference" "its size is 14, not the confirmed 5|it was modified at $((now - 1800)), not at the confirmed $((now - 3600))|it changed within the last 10 minutes" \
    "$(reason_of grown.mp4)|$(reason_of touched.mp4)|$(reason_of fresh.mp4)"
check "content hashed only once ignored: a different one is released again, its line removed" "yes 0 released" "$(present rewritten.mp4) $(listed rewritten.mp4) $(outcome_of rewritten.mp4)"
check "with the reason" "its content is not the confirmed content after its ignore was written; its ignore line was removed, so it syncs again" "$(reason_of rewritten.mp4)"
check "and a rescan of its path" 1 "$(grep -c '^POST /rest/db/scan?folder=videos&sub=rewritten.mp4$' "$CURL_LOG")"
check "the confirmed one beside them is still moved" "no moved" "$(present clip.mp4) $(outcome_of clip.mp4)"

echo "the node's own index must show the confirmed version held by the keeper"
new_node index
add_file newer.mp4 hello
index_entry newer.mp4 5 STICK:2
add_file unheld.mp4 hello
index_entry unheld.mp4 5 STICK:1 '[{"id": "KEEPER-DEVICE", "fromTemporary": true}]'
add_file elsewhere.mp4 hello
index_entry elsewhere.mp4 5 STICK:1 '[{"id": "OTHER-DEVICE", "fromTemporary": false}]'
contract "$(entry newer.mp4)" "$(entry unheld.mp4)" "$(entry elsewhere.mp4)"
run_handoff
check "a newer version, a keeper copy still downloading and another keeper refuse" "yes yes yes 0 0 0" \
    "$(present newer.mp4) $(present unheld.mp4) $(present elsewhere.mp4) $(listed newer.mp4) $(listed unheld.mp4) $(listed elsewhere.mp4)"
check "with the reason" "its index entry is not the confirmed version|the keeper does not hold the confirmed version, as this node sees it" "$(reason_of newer.mp4)|$(reason_of unheld.mp4)"

echo "an open file waits"
new_node open
( exec 7< "$root/Videos/clip.mp4"; sleep 30 ) &
holder=$!
sleep 0.5
contract "$(entry clip.mp4)"
own_namespace=another-container run_handoff
check "when another container's process has it open, it stays, unlisted" "yes 0 it is open" "$(present clip.mp4) $(listed clip.mp4) $(reason_of clip.mp4)"
run_handoff
check "a process of the nodes container itself (its Syncthing) does not hold it" "no moved" "$(present clip.mp4) $(outcome_of clip.mp4)"
fresh_snapshot
check "the probe's snapshot names the held file with its mount namespace, under a header of its time" \
    "at $now 1" "$(head -1 "$scratch/probe/open.txt" | cut -d' ' -f1,2) $(grep -Fxc "$(stat -L -c %d:%i "$root/.storage/handoff-trash/$trash_day/videos/clip.mp4") $(readlink /proc/self/ns/mnt)" "$scratch/probe/open.txt")"
kill "$holder" 2> /dev/null; wait "$holder" 2> /dev/null

echo "an open-file snapshot that is stale or missing"
new_node stalesnapshot
contract "$(entry clip.mp4)"
fresh_snapshot
run_now=$((now + 5)) keep_snapshot=1 run_handoff
check "a snapshot older than the run moves nothing and writes no line" "yes 0 refused" "$(present clip.mp4) $(listed clip.mp4) $(outcome_of clip.mp4)"
check "with the reason" "whether it is open cannot be told: the open-file snapshot is 5 s older than this run" "$(reason_of clip.mp4)"
rm -f "$scratch/probe/open.txt"
keep_snapshot=1 run_handoff
check "nor does a missing one" "yes 0 whether it is open cannot be told: the open-file snapshot is missing" "$(present clip.mp4) $(listed clip.mp4) $(reason_of clip.mp4)"
run_handoff
check "a fresh one lets it go" "no moved" "$(present clip.mp4) $(outcome_of clip.mp4)"

echo "Syncthing that never reports the path ignored"
new_node never
contract "$(entry clip.mp4)"
FAKE_NEVER_IGNORES=1 run_handoff
check "the file stays, its line is kept and it is pending" "yes 1 ignored-not-moved clip.mp4" "$(present clip.mp4) $(listed clip.mp4) $(outcome_of clip.mp4) $(pending_paths)"
contract
run_handoff
check "the next run retries it from the pending record, without a contract entry, and moves it" "no yes 1 moved " "$(present clip.mp4) $(in_trash clip.mp4) $(listed clip.mp4) $(outcome_of clip.mp4) $(pending_paths)"

new_node abandoned
contract "$(entry clip.mp4)"
FAKE_NEVER_IGNORES=1 run_handoff
contract
FAKE_NEVER_IGNORES=1 HANDOFF_PENDING_ATTEMPTS=2 run_handoff
check "a retry counts" "yes 1 ignored-not-moved" "$(present clip.mp4) $(listed clip.mp4) $(outcome_of clip.mp4)"
FAKE_NEVER_IGNORES=1 HANDOFF_PENDING_ATTEMPTS=2 run_handoff
check "and once they run out, the line of the file still there is removed and it syncs again" "yes 0 released " "$(present clip.mp4) $(listed clip.mp4) $(outcome_of clip.mp4) $(pending_paths)"

new_node retrychanged
contract "$(entry clip.mp4)"
FAKE_NEVER_IGNORES=1 run_handoff
printf 'hello again' > "$root/Videos/clip.mp4"
contract
run_handoff
check "a pending file changed before its retry is released so its edits reach the keepers" "yes 0 released " "$(present clip.mp4) $(listed clip.mp4) $(outcome_of clip.mp4) $(pending_paths)"

new_node movedline
contract "$(entry clip.mp4)"
run_handoff
add_file clip.mp4 "new content"
touch -d "@$((now + 60))" "$root/Videos/clip.mp4"
jq -cn --arg path "$root/Videos" --argjson entry "$(entry clip.mp4)" '{folderId: "videos", folderPath: $path, path: "clip.mp4", entry: $entry, since: 0, attempts: 0}' > "$root/.storage/handoff-pending.jsonl"
written_now=$((now + 700)) contract
run_now=$((now + 700)) run_handoff
check "a moved path's line is never removed, even with a pending record and a file there again" "1 ignored-not-moved" "$(listed clip.mp4) $(jq -r '[.results[] | select(.path == "clip.mp4") | .outcome][0]' "$scratch/result.json")"
: > "$root/.storage/handoff-pending.jsonl"
run_now=$((now + 700)) run_handoff
check "a new file at a handed-off path, not pending and newer than the hand-off, is reported" "unsynced-at-handed-off-path 1" "$(outcome_of clip.mp4) $(listed clip.mp4)"

echo "a run that ended between the rename and the manifest line"
new_node crashed
contract "$(entry clip.mp4)"
FAKE_NEVER_IGNORES=1 run_handoff
mkdir -p "$root/.storage/handoff-trash/$trash_day/videos"
mv "$root/Videos/clip.mp4" "$root/.storage/handoff-trash/$trash_day/videos/clip.mp4"
jq -c --arg trash "$trash_day/videos/clip.mp4" '. + {moving: true, trash: $trash}' "$root/.storage/handoff-pending.jsonl" > "$scratch/p.new" && mv "$scratch/p.new" "$root/.storage/handoff-pending.jsonl"
contract
run_handoff
check "is completed: the manifest line is written, the record goes, the line stays" "moved 1 $trash_day/videos/clip.mp4 1 " \
    "$(outcome_of clip.mp4) $(listed clip.mp4) $(jq -r .trash "$root/.storage/handoff-trash/manifest.jsonl") $(grep -c . "$root/.storage/handoff-trash/manifest.jsonl") $(pending_paths)"

new_node crashedearly
contract "$(entry clip.mp4)"
FAKE_NEVER_IGNORES=1 run_handoff
jq -c --arg trash "$trash_day/videos/clip.mp4" '. + {moving: true, trash: $trash}' "$root/.storage/handoff-pending.jsonl" > "$scratch/p.new" && mv "$scratch/p.new" "$root/.storage/handoff-pending.jsonl"
contract
run_handoff
check "one that ended before the rename has its mark cleared and is moved as usual" "no yes moved" "$(present clip.mp4) $(in_trash clip.mp4) $(outcome_of clip.mp4)"

new_node crashedunclear
contract "$(entry clip.mp4)"
FAKE_NEVER_IGNORES=1 run_handoff
mkdir -p "$root/.storage/handoff-trash/$trash_day/videos"
cp -p "$root/Videos/clip.mp4" "$root/.storage/handoff-trash/$trash_day/videos/clip.mp4"
printf 'changed' >> "$root/Videos/clip.mp4"
jq -c --arg trash "$trash_day/videos/clip.mp4" '. + {moving: true, trash: $trash}' "$root/.storage/handoff-pending.jsonl" > "$scratch/p.new" && mv "$scratch/p.new" "$root/.storage/handoff-pending.jsonl"
contract
run_handoff
check "a mark that cannot be resolved counts as moved: its line is never removed" "yes 1 ignored-not-moved clip.mp4" "$(present clip.mp4) $(listed clip.mp4) $(outcome_of clip.mp4) $(pending_paths)"

echo "a torn pending file"
new_node torn
add_file second.mp4 hello
contract "$(entry clip.mp4)"
FAKE_NEVER_IGNORES=1 run_handoff
printf '{"folderId": "videos", "pa' >> "$root/.storage/handoff-pending.jsonl"
contract "$(entry second.mp4)"
run_handoff
check "its torn line is set aside and the rest still works" "moved moved 1" "$(outcome_of clip.mp4) $(outcome_of second.mp4) $(grep -c 'folderId": "videos", "pa' "$root/.storage/handoff-pending.jsonl.bad")"
check "and every line of the pending file reads" 0 "$(jq -R 'fromjson? // "bad"' "$root/.storage/handoff-pending.jsonl" | grep -c '"bad"')"
printf '/clip.mp4' > "$root/Videos/.stignore-handoff"
add_file third.mp4 hello
contract "$(entry third.mp4)"
run_handoff
check "a list whose last line has no newline gets its own line for the next path" "/clip.mp4 /third.mp4" "$(paste -sd ' ' "$root/Videos/.stignore-handoff")"

echo "a pending path in a folder refused on its turn"
new_node refusedfolder
contract "$(entry clip.mp4)"
FAKE_NEVER_IGNORES=1 run_handoff
jq '.type = "sendreceive"' "$FAKE/folders/videos.json" > "$FAKE/folders/videos.new" && mv "$FAKE/folders/videos.new" "$FAKE/folders/videos.json"
contract
HANDOFF_PENDING_ATTEMPTS=2 run_handoff
check "counts an attempt" "ignored-not-moved 1" "$(outcome_of clip.mp4) $(pending_record_attempts)"
HANDOFF_PENDING_ATTEMPTS=2 run_handoff
check "and is released once they run out" "released 0" "$(outcome_of clip.mp4) $(listed clip.mp4)"

echo "strays are looked at a bounded number per run"
new_node strays
printf '/a.mp4\n/b.mp4\n' > "$root/Videos/.stignore-handoff"
add_file a.mp4 hello
add_file b.mp4 hello
contract "$(entry clip.mp4)"
HANDOFF_STRAY_LIMIT=1 run_handoff
contract
first=$(jq -r '[.results[] | select(.outcome == "unsynced-at-handed-off-path") | .path] | join(" ")' "$scratch/result.json")
HANDOFF_STRAY_LIMIT=1 run_handoff
second=$(jq -r '[.results[] | select(.outcome == "unsynced-at-handed-off-path") | .path] | join(" ")' "$scratch/result.json")
check "one per run, the next run going on from there" "a.mp4|b.mp4" "$first|$second"

echo "a file written to after its ignore line"
new_node late
contract "$(entry clip.mp4)"
FAKE_WRITE_ON_SCAN=clip.mp4 run_handoff
check "stays on the node, and its line is removed again so the edit reaches the keepers" "yes 0 released " "$(present clip.mp4) $(listed clip.mp4) $(outcome_of clip.mp4) $(pending_paths)"
check "with what was found" "its size is 29, not the confirmed 5 after its ignore was written; its ignore line was removed, so it syncs again" "$(reason_of clip.mp4)"

echo "a file that changes while it is renamed"
new_node putback
contract "$(entry clip.mp4)"
MV_GROW=$((now - 3600)) run_handoff
check "is put back and released" "yes no 0 released" "$(present clip.mp4) $(in_trash clip.mp4) $(listed clip.mp4) $(outcome_of clip.mp4)"
new_node stuck
contract "$(entry clip.mp4)"
MV_GROW=$((now - 3600)) MV_FAIL_BACK=1 run_handoff
check "and when it cannot be put back it is reported in the trash, outside the manifest" "no yes in-trash-unlisted $trash_day/videos/clip.mp4" "$(present clip.mp4) $(in_trash clip.mp4) $(outcome_of clip.mp4) $(jq -r '.results[0].trash' "$scratch/result.json")"
check "in its own record, every run" "$trash_day/videos/clip.mp4 1" "$(jq -r .trash "$root/.storage/handoff-trash/unlisted.jsonl") $(jq '.trash | length' "$scratch/result.json")"
written_now=$((now + 8 * 86400)) contract
run_now=$((now + 8 * 86400)) run_handoff
check "and never emptied" "yes 0" "$(in_trash clip.mp4) $(jq .purged "$scratch/result.json")"

echo "a trash on another filesystem"
new_node otherfs /mnt/node
check "the folder is its own filesystem here" yes "$([ "$(stat -c %d /mnt/node)" != "$(stat -c %d /mnt/node/Videos)" ] && echo yes)"
contract "$(entry clip.mp4)"
run_handoff
check "is never copied to: the file stays, pending" "yes no ignored-not-moved clip.mp4" "$(present clip.mp4) $(in_trash clip.mp4) $(outcome_of clip.mp4) $(pending_paths)"
check "with the reason" "the trash is on another filesystem; it is retried next run" "$(reason_of clip.mp4)"

echo "a contract replaced while the run goes on"
new_node replaced
add_file other.mp4 hello
contract "$(entry other.mp4)"
cp "$scratch/contract.json" "$scratch/replacement.json"
contract "$(entry clip.mp4)"
FAKE_REPLACE_CONTRACT=$scratch/replacement.json run_handoff
check "the run acts on the copy it checked, never the new file" "no yes moved " "$(present clip.mp4) $(present other.mp4) $(outcome_of clip.mp4) $(outcome_of other.mp4)"

echo "a node that vanished"
new_node vanished
contract "$(entry clip.mp4)"
rm -rf "$root"
run_handoff
check "moves nothing and sends nothing" "0 the node's root $root does not exist" "$(grep -c . "$CURL_LOG") $(refusal)"

echo "only inside the node's own root, never through a link"
new_node paths
mkdir -p "$scratch/outside"
printf hello > "$scratch/outside/secret.mp4"
touch -d "@$((now - 3600))" "$scratch/outside/secret.mp4"
ln -s "$scratch/outside" "$root/Videos/linked"
ln -s "$scratch/outside/secret.mp4" "$root/Videos/link.mp4"
index_entry linked/secret.mp4 5
index_entry link.mp4 5
index_entry ../outside/secret.mp4 5
add_file 'trail.mp4 ' hello
contract "$(entry linked/secret.mp4)" "$(entry link.mp4)" "$(entry ../../outside/secret.mp4)" "$(entry 'star*.mp4')" "$(entry 'trail.mp4 ')" "$(entry ' lead/x.mp4')"
run_handoff
check "a linked directory, a linked file, a .. path, a glob and a segment with outer whitespace are refused" "refused refused refused refused refused refused" \
    "$(outcome_of linked/secret.mp4) $(outcome_of link.mp4) $(outcome_of ../../outside/secret.mp4) $(outcome_of 'star*.mp4') $(outcome_of 'trail.mp4 ') $(outcome_of ' lead/x.mp4')"
check "the outside file is where it was and nothing was listed" "yes 0" "$([ -f "$scratch/outside/secret.mp4" ] && echo yes) $(grep -c . "$root/Videos/.stignore-handoff")"

new_node folders
contract "$(entry clip.mp4 5 "$hello_hash" "$scratch/elsewhere")"
run_handoff
check "a folder at another path than the contract's is refused" "yes refused" "$(present clip.mp4) $(outcome_of clip.mp4)"
jq --arg path "$scratch/outside" '.path = $path' "$FAKE/folders/videos.json" > "$FAKE/folders/videos.new" && mv "$FAKE/folders/videos.new" "$FAKE/folders/videos.json"
contract "$(entry clip.mp4 5 "$hello_hash" "$scratch/outside")"
run_handoff
check "a folder outside the node's root is refused" "refused the folder is not inside the node's root" "$(outcome_of clip.mp4) $(reason_of clip.mp4)"
new_node sendreceive
jq '.type = "sendreceive"' "$FAKE/folders/videos.json" > "$FAKE/folders/videos.new" && mv "$FAKE/folders/videos.new" "$FAKE/folders/videos.json"
contract "$(entry clip.mp4)"
run_handoff
check "a folder that is not send-only here is refused" "yes refused" "$(present clip.mp4) $(outcome_of clip.mp4)"
new_node noinclude
printf '// layered sync begin\n// layered sync end\n' > "$root/Videos/.stignore"
contract "$(entry clip.mp4)"
run_handoff
check "a folder whose .stignore does not include the list is refused and its list left alone" "yes refused 0" "$(present clip.mp4) $(outcome_of clip.mp4) $(grep -c . "$root/Videos/.stignore-handoff")"

echo "apply = false in the node file means nothing at all for an applying contract"
new_node report
sed -i 's/^apply = true$/apply = false/' "$root/.storage/node.toml"
contract "$(entry clip.mp4)"
run_handoff
check "even with a contract present" "yes 0 0" "$(present clip.mp4) $(listed clip.mp4) $(grep -c . "$CURL_LOG")"
check "the result says why" "the node file does not say apply = true" "$(refusal)"
sed -i '/^apply = /d' "$root/.storage/node.toml"
run_handoff
check "nor without an apply line" "yes 0" "$(present clip.mp4) $(grep -c . "$CURL_LOG")"

echo "a contract is refused whole"
new_node stale
contract "$(entry clip.mp4)"
run_now=$((now + 400)) run_handoff
check "when older than its bound" "yes 0 the contract is 410 s old, more than 300 s" "$(present clip.mp4) $(grep -c . "$CURL_LOG") $(refusal)"
run_now=$((now - 100)) run_handoff
check "when written ahead of this host's clock" "yes the contract was written 90 s ahead of this host's clock" "$(present clip.mp4) $(refusal)"
jq '.nodeId = "a002"' "$scratch/contract.json" > "$scratch/other.json" && mv "$scratch/other.json" "$scratch/contract.json"
run_handoff
check "when it names another node" "yes the contract names another node" "$(present clip.mp4) $(refusal)"
contract "$(entry clip.mp4)"
jq '.apply = false' "$scratch/contract.json" > "$scratch/off.json" && mv "$scratch/off.json" "$scratch/contract.json"
run_handoff
check "when it is not in apply mode" "yes the contract is not in apply mode" "$(present clip.mp4) $(refusal)"
echo '{"schema": 1, "nodeId": ' > "$scratch/contract.json"
run_handoff
check "when it cannot be read" "yes the contract cannot be read" "$(present clip.mp4) $(refusal)"

echo "the cluster never hands off"
new_node cluster
contract "$(entry clip.mp4)"
cluster_id=a001 run_handoff
check "by its node ID" "yes 0 the cluster never hands off" "$(present clip.mp4) $(grep -c . "$CURL_LOG") $(refusal)"
sed -i 's/^kind = "drive"$/kind = "array"/' "$root/.storage/node.toml"
run_handoff
check "nor any array" "yes an array never hands off" "$(present clip.mp4) $(refusal)"
new_node othernode
sed -i 's/^id = "a001"$/id = "a002"/' "$root/.storage/node.toml"
contract "$(entry clip.mp4)"
run_handoff
check "a node file of another node refuses the run" "yes the node file is not node a001's" "$(present clip.mp4) $(refusal)"

echo "two runs never act on the same node at once"
new_node locked
contract "$(entry clip.mp4)"
flock "$root/.storage/handoff.lock" sleep 5 &
holder=$!
sleep 0.5
rm -f "$scratch/result.json"
run_handoff
check "the second run does nothing and leaves the first run's result alone" "yes 0 no" "$(present clip.mp4) $(grep -c . "$CURL_LOG") $([ -f "$scratch/result.json" ] && echo yes || echo no)"
check "and says so" 1 "$(grep -c 'another hand-off run holds the lock' "$scratch/handoff.out")"
kill "$holder" 2> /dev/null; wait "$holder" 2> /dev/null

echo "the trash"
new_node trash
contract "$(entry clip.mp4)"
run_handoff
trash=$root/.storage/handoff-trash
printf 'not ours' > "$trash/foreign.txt"
printf 'not ours either' > "$trash/$trash_day/videos/foreign.mp4"
mkdir -p "$trash/$trash_day/videos/kept"
add_file second.mp4 hello
contract "$(entry second.mp4)"
run_handoff
printf 'changed' >> "$trash/$trash_day/videos/second.mp4"
written_now=$((now + 6 * 86400)) contract
run_now=$((now + 6 * 86400)) run_handoff
check "keeps a moved file until it is 7 days old" "yes 0" "$(in_trash clip.mp4) $(jq .purged "$scratch/result.json")"
written_now=$((now + 8 * 86400)) contract
run_now=$((now + 8 * 86400)) run_handoff
check "then empties it" "no 1" "$(in_trash clip.mp4) $(jq .purged "$scratch/result.json")"
check "but never a file it did not move there, nor one changed since" "yes yes yes yes" \
    "$([ -f "$trash/foreign.txt" ] && echo yes) $([ -f "$trash/$trash_day/videos/foreign.mp4" ] && echo yes) $([ -d "$trash/$trash_day/videos/kept" ] && echo yes) $(in_trash second.mp4)"
check "and keeps the changed file in its manifest" "$trash_day/videos/second.mp4" "$(jq -r .trash "$trash/manifest.jsonl")"
HANDOFF_TRASH_DAYS=7 run_now=$((now + 8 * 86400)) run_handoff
check "a second purge deletes nothing more" "0 yes" "$(jq .purged "$scratch/result.json") $([ -f "$trash/foreign.txt" ] && echo yes)"

echo "a held contract empties only the trash"
held_contract() {   # [entry json]...: a contract the dashboard holds (a stop, an unknown space), written ten seconds before $written_now
    jq -n --arg written "$(date -u -d "@$((${written_now:-$now} - 10))" +%FT%TZ)" --slurpfile entries <(printf '%s\n' "$@") \
        '{schema: 1, nodeId: "a001", writtenAt: $written, apply: false, trashOnly: true, cluster: false, quietMinutes: 10, entries: $entries, waiting: [], notes: ["hand-offs are held: x"]}' > "$scratch/contract.json"
}
new_node held
contract "$(entry clip.mp4)"
run_handoff
check "the copy is in the trash, and the result says what the trash holds" "yes 5" "$(in_trash clip.mp4) $(jq .trashBytes "$scratch/result.json")"
add_file pending.mp4 hello
contract "$(entry pending.mp4)"
FAKE_NEVER_IGNORES=1 run_handoff
check "a path is left pending" "ignored-not-moved pending.mp4" "$(outcome_of pending.mp4) $(pending_paths)"
written_now=$((now + 8 * 86400)) held_contract
run_now=$((now + 8 * 86400)) run_handoff
check "a held contract is no refusal: the due copy is emptied and the trash holds nothing more" "none no 1 0" "$(refusal) $(in_trash clip.mp4) $(jq .purged "$scratch/result.json") $(jq .trashBytes "$scratch/result.json")"
check "the pending path is neither moved nor released, and nothing is listed" "yes pending.mp4 0" "$(present pending.mp4) $(pending_paths) $(jq '.results | length' "$scratch/result.json")"
check "the result says the contract only lets the trash empty" "the contract holds every hand-off: only the trash is emptied" "$(jq -r '.notes[0]' "$scratch/result.json")"
written_now=$((now + 8 * 86400)) held_contract "$(entry pending.mp4)"
run_now=$((now + 8 * 86400)) run_handoff
check "a held contract that names a file is refused whole" "the contract is not in apply mode yes" "$(refusal) $(present pending.mp4)"
check "and a refused run says nothing of the trash" null "$(jq .trashBytes "$scratch/result.json")"

echo "a trash-only contract needs no apply in the node file"
new_node heldoff
contract "$(entry clip.mp4)"
run_handoff
add_file second.mp4 hello
contract "$(entry second.mp4)"
run_handoff
check "both copies are in the trash and count as freeing" "yes yes 10" "$(in_trash clip.mp4) $(in_trash second.mp4) $(jq .trashBytes "$scratch/result.json")"
sed -i '/^apply = /d' "$root/.storage/node.toml"
index_entry second.mp4 5 STICK:1 '[{"id": "OTHER-DEVICE", "fromTemporary": false}]'
written_now=$((now + 8 * 86400)) held_contract
run_now=$((now + 8 * 86400)) run_handoff
check "it empties what is due under the keeper check, without the node file's apply" "none no 1" "$(refusal) $(in_trash clip.mp4) $(jq .purged "$scratch/result.json")"
check "a copy kept for a reason counts as freeing nothing" "yes 0" "$(in_trash second.mp4) $(jq .trashBytes "$scratch/result.json")"
written_now=$((now + 8 * 86400)) contract
run_now=$((now + 8 * 86400)) run_handoff
check "an applying contract still needs the node file's apply" "the node file does not say apply = true" "$(refusal)"

echo "the trash keeps what no keeper holds"
new_node keeperless
contract "$(entry clip.mp4)"
run_handoff
index_entry clip.mp4 5 STICK:1 '[{"id": "OTHER-DEVICE", "fromTemporary": false}]'
written_now=$((now + 8 * 86400)) contract
run_now=$((now + 8 * 86400)) run_handoff
check "a copy only another device holds stays: the purge binds to the recorded keeper" "yes 0 $trash_day/videos/clip.mp4: its keeper does not hold it, as this node sees it" "$(in_trash clip.mp4) $(jq .purged "$scratch/result.json") $(trash_kept)"
check "logged when its reason is new" 1 "$(grep -c "kept $trash_day/videos/clip.mp4 in the trash" "$scratch/handoff.out")"
run_now=$((now + 8 * 86400)) run_handoff
check "and not again the next run, while the result still lists it once" "0 1" "$(grep -c "kept $trash_day/videos/clip.mp4 in the trash" "$scratch/handoff.out") $(jq '.trash | length' "$scratch/result.json")"
index_entry clip.mp4 5
echo '{"connections": {"KEEPER-DEVICE": {"connected": false}}}' > "$FAKE/connections.json"
run_now=$((now + 8 * 86400)) run_handoff
check "nor one whose keeper is not connected now" "yes $trash_day/videos/clip.mp4: its keeper is not connected to this node" "$(in_trash clip.mp4) $(trash_kept)"
rm -f "$FAKE/connections.json"
index_entry clip.mp4 5 OTHER:7
run_now=$((now + 8 * 86400)) run_handoff
check "nor one whose global version does not descend from the recorded one" "yes $trash_day/videos/clip.mp4: the network no longer has its version or a later one" "$(in_trash clip.mp4) $(trash_kept)"
jq '.global.deleted = true' "$FAKE/files/videos/$(printf '%s' clip.mp4 | sha256sum | cut -c1-16).json" > "$scratch/d.json"
index_entry clip.mp4 5
mv "$scratch/d.json" "$FAKE/files/videos/$(printf '%s' clip.mp4 | sha256sum | cut -c1-16).json"
run_now=$((now + 8 * 86400)) run_handoff
check "nor one the network has deleted" "yes $trash_day/videos/clip.mp4: the network has its deletion" "$(in_trash clip.mp4) $(trash_kept)"
jq -n --arg device "$keeper_device" '{local: {size: 9, version: ["STICK:1", "KEEPER:1"]}, global: {size: 9, version: ["STICK:1", "KEEPER:1"]}, availability: [{id: $device, fromTemporary: false}]}' \
    > "$FAKE/files/videos/$(printf '%s' clip.mp4 | sha256sum | cut -c1-16).json"
run_now=$((now + 8 * 86400)) run_handoff
check "a keeper's later edit, descending from the recorded version, counts as held, so it is emptied" "no 1" "$(in_trash clip.mp4) $(jq .purged "$scratch/result.json")"

echo "a manifest line never reaches outside the trash"
new_node manifest
mkdir -p "$scratch/beyond" "$root/.storage/handoff-trash"
printf hello > "$scratch/beyond/secret.mp4"
touch -d "@$((now - 3600))" "$scratch/beyond/secret.mp4"
ln -s "$scratch/beyond" "$root/.storage/handoff-trash/linked"
{ jq -cn --argjson modified "$((now - 3600))" '{movedAt: 0, trash: "../../Videos/clip.mp4", folderId: "videos", path: "clip.mp4", version: ["STICK:1"], size: 5, modifiedSeconds: $modified}'
  jq -cn --argjson modified "$((now - 3600))" '{movedAt: 0, trash: "linked/secret.mp4", folderId: "videos", path: "clip.mp4", version: ["STICK:1"], size: 5, modifiedSeconds: $modified}'
} > "$root/.storage/handoff-trash/manifest.jsonl"
contract
run_handoff
check "neither a .. line nor one through a link deletes anything" "yes yes 0 2" "$(present clip.mp4) $([ -f "$scratch/beyond/secret.mp4" ] && echo yes) $(jq .purged "$scratch/result.json") $(jq '.trash | length' "$scratch/result.json")"

echo "never prunes, never deletes on other devices"
new_node prune
printf '/kept-from-before.mp4\n/another.mp4\n' > "$root/Videos/.stignore-handoff"
contract "$(entry clip.mp4)"
run_handoff
check "every line already in the list stays, in order, and the new one follows" "/kept-from-before.mp4 /another.mp4 /clip.mp4" "$(paste -sd ' ' "$root/Videos/.stignore-handoff")"
check "no request asks Syncthing to override, revert, delete or reconfigure" 0 "$(destructive_requests)"

echo "nodes.sh runs the executor"
(
    # shellcheck source=../../images/nodes/nodes.sh
    source "$repo/images/nodes/nodes.sh"
    handoff_directory=$scratch/status-handoff
    handoff_executor=$scratch/stubs/executor
    cluster=c1c1
    mkdir -p "$handoff_directory" "$scratch/homes/a001/.storage/syncthing" "$scratch/homes/b0b0/.storage/syncthing"
    printf '<apikey>node-key</apikey>\n' > "$scratch/homes/a001/.storage/syncthing/config.xml"
    printf '#!/bin/bash\necho "$HANDOFF_CLUSTER_ID $*" >> %s/executor.log\nsleep 3\n' "$scratch" > "$handoff_executor"
    echo '{}' > "$handoff_directory/a001.json"
    echo '{}' > "$handoff_directory/b0b0.json"
    sleep 30 & instance_pid[a001]=$!
    sleep 30 & instance_pid[b0b0]=$!
    sleep 30 & instance_pid[c0c0]=$!
    instance_kind=([a001]=node [b0b0]=array [c0c0]=node)
    instance_home=([a001]=$scratch/homes/a001/.storage/syncthing [b0b0]=$scratch/homes/b0b0/.storage/syncthing [c0c0]=$scratch/homes/c0c0/.storage/syncthing)
    instance_gui=([a001]=10.0.0.2:8411 [b0b0]=10.0.0.2:8412 [c0c0]=10.0.0.2:8413)
    run_handoffs
    sleep 0.5
    check "only a drive or folder node with a contract runs it, with its root, API and files" \
        "c1c1 a001 $scratch/homes/a001 http://10.0.0.2:8411 node-key $handoff_directory/a001.json $handoff_directory/a001.result.json" "$(cat "$scratch/executor.log")"
    run_handoffs
    last_handoff_round=-60
    run_handoffs
    sleep 0.5
    check "once a minute, and never while its last run is still going" 1 "$(grep -c . "$scratch/executor.log")"
    kill "${instance_pid[@]}" "${handoff_pid[@]}" 2> /dev/null
    echo "$passed $failed" > "$scratch/counts"
)
read -r passed failed < "$scratch/counts"

echo "$passed passed, $failed failed"
[ "$failed" -eq 0 ]
