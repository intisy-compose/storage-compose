#!/bin/bash
# tests/nodes/migrate.sh: the label migration on a loop-device copy of the real array's layout (data1
# to data5, parity1 and parity2, labelled storage-*). Syncs it with SnapRAID, checks every refusal,
# migrates, migrates again as after an interruption, and proves with snapraid status, diff and check
# that parity is still valid. Runs from Git Bash (Docker Desktop) or Linux; never touches a real drive.
set -u
export MSYS_NO_PATHCONV=1

native_path() { (cd "$1" && { pwd -W 2> /dev/null || pwd; }); }
here=$(native_path "$(dirname "$0")")
repo=$(native_path "$here/../..")
image=storage-snapraid:nodetest
volume=storage-test-nodes-status
images_dir=/var/lib/storage-test-nodes
passed=0
failed=0

say() { printf '\n\033[36m%s\033[0m\n' "$*"; }
pass() { echo "  PASS $1"; passed=$((passed + 1)); }
fail() { echo "  FAIL $1"; failed=$((failed + 1)); }
expect_match() { if grep -qE -- "$2" <<< "$3"; then pass "$1"; else fail "$1: no /$2/ in: $3"; fi; }

container() {   # <entrypoint> <arguments...>: one privileged run of the SnapRAID image
    local entrypoint=$1; shift
    docker run --rm --privileged -v /dev:/dev -v "$images_dir:/images" -v "$volume:/status" \
        -v "$here/migrate-lab.sh:/lab.sh:ro" -e ARRAY_PREFIX=storage --entrypoint "$entrypoint" "$image" "$@"
}
lab() { container bash /lab.sh "$@"; }

holder=storage-test-nodes-hold
hold_drive() {   # <role>: mounted in another container until it is removed
    docker run -d --rm --name "$holder" --privileged -v /dev:/dev -v "$images_dir:/images" -v "$here/migrate-lab.sh:/lab.sh:ro"         --entrypoint bash "$image" /lab.sh hold "$1" 600 > /dev/null
    for _ in $(seq 60); do docker logs "$holder" 2> /dev/null | grep -q holding && return 0; sleep 1; done
    echo "the drive was not mounted"; return 1
}
migrate() { container migrate-labels.sh "$@" 2>&1; }

say "Building the SnapRAID image and the drives"
docker build -q -t "$image" -f "$repo/images/snapraid/Dockerfile" "$repo/images" > /dev/null || exit 1
docker volume create "$volume" > /dev/null
lab create || exit 1
lab fill || { lab remove; exit 1; }

say "Refusals"
lab detach parity2 > /dev/null
expect_match "refused with a member missing" "every member must be present; missing: parity2" "$(migrate --from storage)"
lab attach parity2 > /dev/null
hold_drive data3
expect_match "refused with a member mounted" "the array must be stopped; mounted or in use: data3" "$(migrate --from storage)"
docker rm -f "$holder" > /dev/null
expect_match "a dry run changes nothing" "dry run: nothing changed" "$(migrate --from storage --id a3f9 --dry-run)"

say "Migration"
output=$(migrate --from storage --id a3f9 --name private-array)
echo "$output" | sed 's/^/  | /'
expect_match "migrated" "^migrated a3f9$" "$output"
expect_match "status after relabelling" "snapraid status: No error detected" "$output"

say "Running it again, as after an interruption"
output=$(migrate --from storage --name private-array)
expect_match "a second run finds the same array and changes nothing" "^migrated a3f9$" "$output"

say "The array afterwards"
output=$(lab after a3f9)
echo "$output" | sed 's/^/  | /'
expect_match "every label carries the id" "^a3f9-data1 a3f9-data2 a3f9-data3 a3f9-data4 a3f9-data5 a3f9-parity1 a3f9-parity2 $" "$output"
expect_match "every member has the description" "parity2: \"private-array\" 1  members 7" "$output"
expect_match "array.toml's serial and asset moved into node.toml" 'serial = "SERIAL-data1"' "$output"
expect_match "the backups are kept" "array.toml.before-migration .*snapraid.drives.before-migration" "$output"
if grep -qE "(^| )array.toml( |$)" <<< "$output"; then fail "array.toml is gone"; else pass "array.toml is gone"; fi
expect_match "snapraid.drives names the new labels" "snapraid.drives: /mnt/storage/a3f9-data1 " "$output"
expect_match "the folder record names the new labels" "music.a3f9-data2 a3f9-data3" "$output"
expect_match "data2's mirror was changed too" "data2's copy matches data1's" "$output"
expect_match "every file reads as before" "every file reads as before \(20 files\)" "$output"
expect_match "same disk names" "data data5 /mnt/storage/a3f9-data5/" "$output"
expect_match "snapraid status is clean" "No error detected" "$output"
expect_match "snapraid diff finds no change" "No differences" "$output"
expect_match "snapraid check verifies every block" "Everything OK|No error detected" "$output"

say "Cleaning up"
lab remove
docker volume rm "$volume" > /dev/null
say "$passed passed, $failed failed"
[ "$failed" -eq 0 ]
