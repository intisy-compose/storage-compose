#!/bin/bash
# tests/failure/run.sh [scenario...]: the fault-injection tests of the drive failure handling
# (docs specs/2026-10-12-drive-failure-handling.md, "How it is proven"). Builds the stack's images
# under test tags, runs them in Docker on loop and device-mapper drives labelled c24t-*, injects each
# failure and checks what the array does. Never touches a real drive and publishes nothing.
# Runs from Git Bash on Windows (Docker Desktop) or from Linux. Without arguments it runs them all:
#   baseline drop-return gone-for-good two-at-once data1 io-errors smart parity-during-sync bit-rot
set -u
export MSYS_NO_PATHCONV=1

# Git Bash's own paths mean nothing to docker.exe once path conversion is off; pwd -W gives F:/...
native_path() { (cd "$1" && { pwd -W 2> /dev/null || pwd; }); }
here=$(native_path "$(dirname "$0")")
repo=$(native_path "$here/../..")
compose=(docker compose -p storage-c24test --project-directory "$repo" --env-file "$here/test.env"
    -f "$repo/docker-compose.yml" -f "$here/docker-compose.test.yml")
grace=$(sed -n 's/^DROP_GRACE_SECONDS=//p' "$here/test.env")
passed=0
failed=0
baseline_counts=

lab() { docker exec c24t-lab lab.sh "$@"; }
say() { printf '\n\033[36m%s\033[0m\n' "$*"; }
note() { echo "  $*"; }

pass() { echo "  PASS $1"; passed=$((passed + 1)); }
fail() { echo "  FAIL $1"; failed=$((failed + 1)); }

expect() {   # <what> <expected> <actual>
    if [ "$2" = "$3" ]; then pass "$1: $3"; else fail "$1: expected '$2', got '$3'"; fi
}

expect_match() {   # <what> <extended regex> <actual>
    if grep -qE -- "$2" <<< "$3"; then pass "$1"; else fail "$1: '$3' does not match /$2/"; fi
}

expect_no_match() {   # <what> <extended regex> <actual>
    if grep -qE -- "$2" <<< "$3"; then fail "$1: '$3' matches /$2/"; else pass "$1"; fi
}

eventually() {   # <what> <expected> <timeout seconds> <command...>: until the command prints the expected
    local what=$1 expected=$2 timeout=$3 started=$SECONDS actual
    shift 3
    while true; do
        actual=$("$@" 2> /dev/null)
        [ "$actual" = "$expected" ] && { pass "$what: $actual (after $((SECONDS - started)) s)"; return 0; }
        [ $((SECONDS - started)) -ge "$timeout" ] && { fail "$what: expected '$expected', still '$actual' after $timeout s"; return 1; }
        sleep 1
    done
}

wait_state() {   # <what> <jq condition> <timeout>: the seconds it took
    local seconds
    seconds=$(lab wait "$2" "$3")
    if [ "$seconds" = timeout ]; then fail "$1: not within $3 s ($(lab state))"; else pass "$1 after $seconds s"; fi
}

condition_of() { lab query ".drives[] | select(.label == \"c24t-$1\") | .condition"; }
array_state() { lab query '"\(.state) \(.complete)"'; }
wanted_paused() { lab query '.pausedFolders | sort | join(" ")'; }
started_at() { docker inspect -f '{{.State.StartedAt}}' "$1"; }
sync_now() { docker exec c24t-snapraid snapraid.sh run sync; }
peer_counts() { lab peer-counts; }

notifications_since() {   # <mark>: what reached the capture endpoint, once the outbox has drained
    for _ in $(seq 30); do
        docker exec c24t-lab sh -c '[ -z "$(ls /status/outbox 2> /dev/null)" ]' && break
        sleep 1
    done
    lab notifications-since "$1"
}

until_job_free() {   # <job command...>: retries while another job holds the lock
    local output status
    for _ in $(seq 60); do
        output=$("$@" 2>&1); status=$?
        grep -q "another job is running" <<< "$output" || { echo "$output"; return "$status"; }
        sleep 5
    done
    echo "$output"; return 1
}

start_stack() {
    say "Building the images and starting the test stack"
    "${compose[@]}" build --quiet lab mounter pool snapraid dashboard kopia || exit 1
    [ -z "$(docker ps -aq -f name=^c24t-lab$)" ] || stop_stack
    "${compose[@]}" up -d lab || exit 1
    lab remove-drives > /dev/null
    lab create-drives
    "${compose[@]}" up -d mounter pool snapraid dashboard kopia syncthing peer || exit 1
    wait_state "the new array is healthy" '.state == "healthy" and .complete' 120
    lab content
    eventually "the array's Syncthing answers" ok 120 sh -c 'docker exec c24t-lab lab.sh storage-paused > /dev/null && echo ok'
    lab setup-syncthing
    note "peer synced after $(lab wait-synced 180) s"
    note "first sync: $(until_job_free sync_now | tail -n 1)"
}

stop_stack() {
    say "Stopping the test stack and removing its drives"
    "${compose[@]}" stop mounter pool snapraid dashboard kopia syncthing peer > /dev/null 2>&1
    lab remove-drives
    lab clean-mount-points
    "${compose[@]}" down -v > /dev/null 2>&1
}

check_peer_kept_everything() {
    expect "the peer still holds every file, nothing deleted" "$baseline_counts" "$(peer_counts)"
}

scenario_baseline() {
    say "baseline: four drives, Syncthing folders in the pool, one of them split"
    expect "state" "healthy true" "$(array_state)"
    eventually "split folders" music 60 lab query '[.splitFolders[].id] | join(" ")'
    expect "Kopia" running "$(lab kopia)"
    expect "dashboard" healthy "$(lab dashboard-state)"
    eventually "notification for the split folder" yes 30 sh -c "docker exec c24t-lab lab.sh notifications-since 0 | grep -q 'folder music is split' && echo yes"
    baseline_counts=$(peer_counts)
    note "peer: $(echo "$baseline_counts" | tr '\n' ';')"
}

# F1 and F2: a drive drops off during a write and is back within a minute, which is a drop.
scenario_drop_return() {
    local mark started writer
    say "drop-return: data2 (Documents, GitHub, half of Music) drops off mid-write and is back after 55 s"
    mark=$(lab now)
    docker exec -d c24t-lab sh -c 'for chunk in $(seq 600); do head -c 65536 /dev/urandom || exit 1; sleep 0.1; done > /mnt/storage/pool/Scratch/stream.bin 2> /tmp/writer.log; echo "exit $?" >> /tmp/writer.log'
    sleep 2
    started=$SECONDS
    lab drop data2 > /dev/null
    wait_state "data2 seen as dropped" '.drives[] | select(.label == "c24t-data2") | .condition == "dropped"' 30
    expect "state during the drop" "healthy false" "$(array_state)"
    eventually "folders the mounter pauses" "documents github music" 30 wanted_paused
    eventually "folders Syncthing has paused" "documents github music" 30 lab storage-paused
    eventually "Kopia" paused 30 lab kopia
    writer=$(docker exec c24t-lab cat /tmp/writer.log)
    expect_match "the write in progress failed" "Input/output error|Read-only file system" "$writer"
    note "scans during the drop: $(lab scan-all | tr '\n' ';')"
    expect "the share takes writes" ok "$(lab try-write /mnt/storage/pool/Backups)"
    expect_match "sync waits" "sync waits" "$(sync_now)"
    sleep $((55 - (SECONDS - started)))
    lab return data2 > /dev/null
    note "returned after $((SECONDS - started)) s"
    wait_state "the array is complete again" '.complete' 60
    expect "state" "healthy true" "$(array_state)"
    eventually "Syncthing resumed" "" 30 lab storage-paused
    eventually "Kopia" running 40 lab kopia
    lab wait-synced 120 > /dev/null
    check_peer_kept_everything
    local sent; sent=$(notifications_since "$mark")
    note "notified: $(echo "$sent" | cut -d'|' -f1 | tr '\n' ';')"
    expect_match "notified the drop" "c24t-data2 dropped" "$sent"
    expect_match "notified the return" "c24t-data2 is back" "$sent"
    expect_no_match "no state change notified" "storage is (degraded|stopped)" "$sent"
}

# F1: a drive that stays away is a failure; with one parity drive the array is degraded.
scenario_gone_for_good() {
    local mark
    say "gone-for-good: data3 (Videos, half of Music) drops off and stays away past the grace of $grace s"
    mark=$(lab now)
    lab drop data3 > /dev/null
    wait_state "data3 seen as dropped" '.drives[] | select(.label == "c24t-data3") | .condition == "dropped"' 30
    wait_state "the array is degraded" '.state == "degraded"' $((grace + 30))
    expect "data3" missing "$(condition_of data3)"
    expect "folders paused" "music videos" "$(wanted_paused)"
    eventually "folders Syncthing has paused" "music videos" 30 lab storage-paused
    expect "Kopia" paused "$(lab kopia)"
    expect "the share takes writes" ok "$(lab try-write /mnt/storage/pool/Backups)"
    expect_match "sync waits" "sync waits" "$(sync_now)"
    eventually "dashboard" degraded 20 lab dashboard-state
    lab return data3 > /dev/null
    wait_state "the array is healthy again" '.state == "healthy" and .complete' 60
    eventually "Syncthing resumed" "" 30 lab storage-paused
    lab wait-synced 120 > /dev/null
    check_peer_kept_everything
    local sent; sent=$(notifications_since "$mark")
    note "notified: $(echo "$sent" | cut -d'|' -f1 | tr '\n' ';')"
    expect_match "notified the drop" "c24t-data3 dropped" "$sent"
    expect_match "notified the loss" "c24t-data3 is missing \| c24t-data3 is missing: the share keeps working" "$sent"
    expect_match "notified degraded" "storage is degraded" "$sent"
    expect_match "notified the return" "c24t-data3 is back" "$sent"
    expect_match "notified healthy" "storage is healthy" "$sent"
}

# F6: more drives gone than parity can rebuild.
scenario_two_at_once() {
    local mark
    say "two-at-once: data2 and data3 drop off together (one bridge) and stay away"
    mark=$(lab now)
    lab drop data2 > /dev/null
    lab drop data3 > /dev/null
    wait_state "the array has stopped" '.state == "stopped"' $((grace + 30))
    eventually "the share is read-only" "Read-only file system" 20 lab try-write /mnt/storage/pool/Backups
    expect "existing files cannot be changed" "Read-only file system" "$(lab try-append /mnt/storage/pool/Backups/backup1.bin)"
    expect "folders paused" "documents github music videos" "$(wanted_paused)"
    eventually "folders Syncthing has paused" "documents github music videos" 30 lab storage-paused
    expect "Kopia" paused "$(lab kopia)"
    lab return data2 > /dev/null
    lab return data3 > /dev/null
    wait_state "the array is healthy again" '.state == "healthy" and .complete' 60
    eventually "the share takes writes" ok 20 lab try-write /mnt/storage/pool/Backups
    eventually "Syncthing resumed" "" 30 lab storage-paused
    lab wait-synced 120 > /dev/null
    check_peer_kept_everything
    local sent; sent=$(notifications_since "$mark")
    note "notified: $(echo "$sent" | cut -d'|' -f1 | tr '\n' ';')"
    expect_match "notified stopped" "p5 storage is stopped" "$sent"
    expect_match "notified healthy" "storage is healthy" "$sent"
}

# F8: data1 holds the stack state; Syncthing and Kopia restart onto the remounted one.
scenario_data1() {
    local mark syncthing_started kopia_started
    say "data1: the drive with the stack state drops off and stays away"
    mark=$(lab now)
    syncthing_started=$(started_at c24t-syncthing)
    kopia_started=$(started_at c24t-kopia)
    lab drop data1 > /dev/null
    wait_state "the array has stopped" '.state == "stopped"' $((grace + 30))
    eventually "the share is read-only" "Read-only file system" 20 lab try-write /mnt/storage/pool/Documents
    lab return data1 > /dev/null
    wait_state "the array is healthy again" '.state == "healthy" and .complete' 60
    eventually "Syncthing restarted onto the new data1" yes 60 sh -c "[ \"\$(docker inspect -f '{{.State.StartedAt}}' c24t-syncthing)\" != '$syncthing_started' ] && echo yes"
    eventually "Kopia restarted onto the new data1" yes 60 sh -c "[ \"\$(docker inspect -f '{{.State.StartedAt}}' c24t-kopia)\" != '$kopia_started' ] && echo yes"
    eventually "Syncthing answers and runs every folder" "" 90 lab storage-paused
    eventually "Kopia" running 60 lab kopia
    lab wait-synced 120 > /dev/null
    check_peer_kept_everything
    local sent; sent=$(notifications_since "$mark")
    note "notified: $(echo "$sent" | cut -d'|' -f1 | tr '\n' ';')"
    expect_match "notified data1 missing" "c24t-data1 is missing: it holds the stack state" "$sent"
    expect_match "notified stopped" "storage is stopped" "$sent"
}

# F3: a drive that stays connected but returns I/O errors goes read-only and counts as lost.
scenario_io_errors() {
    local mark
    say "io-errors: data3 stays attached but every read and write fails"
    mark=$(lab now)
    lab error data3 > /dev/null
    note "write onto data3: $(lab try-write /mnt/storage/pool/Spare)"
    wait_state "data3 is failing" '.drives[] | select(.label == "c24t-data3") | .condition == "failing"' 40
    expect "why" "read-only after a filesystem error" "$(lab query '.drives[] | select(.label == "c24t-data3") | .detail')"
    expect "state" "degraded false" "$(array_state)"
    expect "the other drives take writes" ok "$(lab try-write /mnt/storage/pool/Backups)"
    expect "folders paused" "music videos" "$(wanted_paused)"
    note "replugging data3"
    lab drop data3 > /dev/null
    sleep 15
    lab return data3 > /dev/null
    wait_state "the array is healthy again" '.state == "healthy" and .complete' 90
    eventually "Syncthing resumed" "" 30 lab storage-paused
    lab wait-synced 120 > /dev/null
    check_peer_kept_everything
    local sent; sent=$(notifications_since "$mark")
    note "notified: $(echo "$sent" | cut -d'|' -f1 | tr '\n' ';')"
    expect_match "notified failing" "c24t-data3 is failing \| .*read-only after a filesystem error" "$sent"
}

# F4: SMART judged by change against the first check.
scenario_smart() {
    local mark
    say "smart: data2's pending and reallocated counts rise"
    mark=$(lab now)
    lab fake-smart data2 0 0 > /dev/null
    eventually "first check taken as the baseline" yes 40 sh -c "docker exec c24t-mounter test -s /mnt/storage/c24t-data1/.storage/smart/FAKE-data2.json && echo yes"
    expect "a drive with baseline counts is present" present "$(condition_of data2)"
    lab fake-smart data2 8 0 > /dev/null
    wait_state "data2 is failing" '.drives[] | select(.label == "c24t-data2") | .condition == "failing"' 40
    expect "why" "SMART pending 0 to 8" "$(lab query '.drives[] | select(.label == "c24t-data2") | .detail')"
    expect "state" "degraded false" "$(array_state)"
    eventually "data2 takes no new files" "Read-only file system" 20 lab try-write /mnt/storage/pool/Documents
    expect "data2's files cannot be changed" "Read-only file system" "$(lab try-append /mnt/storage/pool/Documents/doc1.bin)"
    expect "its files stay readable" yes "$(docker exec c24t-lab sh -c 'cat /mnt/storage/pool/Documents/doc1.bin > /dev/null && echo yes')"
    lab fake-smart data2 8 3 > /dev/null
    wait_state "a further rise is seen" '.drives[] | select(.label == "c24t-data2") | .detail | test("reallocated 0 to 3")' 40
    note "$(docker exec c24t-mounter mounter.sh accept-smart data2)"
    wait_state "accepted counts: healthy again" '.state == "healthy" and .complete' 40
    eventually "data2 takes writes again" ok 20 lab try-write /mnt/storage/pool/Scratch
    lab clear-fake-smart > /dev/null
    local sent; sent=$(notifications_since "$mark")
    note "notified: $(echo "$sent" | cut -d'|' -f1 | tr '\n' ';')"
    expect_match "notified failing" "c24t-data2 is failing \| .*SMART pending 0 to 8" "$sent"
    expect_match "notified the further rise" "c24t-data2 changed \| .*reallocated 0 to 3" "$sent"
    expect_match "notified healthy" "c24t-data2 is healthy" "$sent"
}

# F5 and F2: the parity drive leaves during a sync; parity must be resumable.
scenario_parity_during_sync() {
    local mark result
    say "parity-during-sync: parity1 drops off while a sync writes it, and stays away"
    mark=$(lab now)
    docker exec c24t-lab sh -c 'head -c 200000000 /dev/urandom > /mnt/storage/c24t-data1/Backups/big.bin'
    lab delay parity1 20 > /dev/null
    docker exec -d c24t-snapraid sh -c 'snapraid.sh run sync > /tmp/sync.log 2>&1'
    eventually "the sync is running" "sync" 30 sh -c "docker exec c24t-snapraid cat /status/snapraid.json | grep -o '\"running\":\"sync' | cut -d'\"' -f4"
    sleep 3
    lab drop parity1 > /dev/null
    eventually "the sync failed" failed 180 sh -c "docker exec c24t-snapraid cat /status/snapraid.json | grep -o '\"lastSyncResult\":\"[a-z]*' | cut -d'\"' -f4"
    wait_state "the array is degraded" '.state == "degraded"' $((grace + 30))
    lab return parity1 > /dev/null
    wait_state "the array is healthy again" '.state == "healthy" and .complete' 60
    result=$(until_job_free sync_now)
    expect_match "the next sync completes" "sync done" "$result"
    result=$(docker exec c24t-snapraid sh -c 'snapraid.sh config > /dev/null && snapraid -c /etc/snapraid.conf check 2>&1 | tail -n 3')
    expect_match "snapraid check is clean" "No error detected|Everything OK" "$result"
    local sent; sent=$(notifications_since "$mark")
    note "notified: $(echo "$sent" | cut -d'|' -f1 | tr '\n' ';')"
    expect_match "notified the failed sync" "sync failed" "$sent"
    expect_match "notified parity missing" "c24t-parity1 is missing: the share keeps working, parity syncs wait" "$sent"
}

# F7: silent corruption is found by the scrub and repaired from parity.
scenario_bit_rot() {
    local mark original result
    say "bit-rot: a block of a file on data2 changes under the filesystem"
    mark=$(lab now)
    original=$(lab checksum /mnt/storage/c24t-data2/Scratch/rot.bin)
    lab corrupt data2 Scratch/rot.bin
    expect_no_match "the file reads differently now" "^$original$" "$(lab checksum /mnt/storage/c24t-data2/Scratch/rot.bin)"
    result=$(until_job_free docker exec c24t-snapraid snapraid.sh run scrub)
    expect_match "the scrub fails" "scrub FAILED" "$result"
    result=$(docker exec c24t-snapraid sh -c 'snapraid.sh config > /dev/null && snapraid -c /etc/snapraid.conf -e fix 2>&1 | tail -n 3')
    note "fix: $(echo "$result" | tr '\n' ';')"
    expect "the file is repaired" "$original" "$(lab checksum /mnt/storage/c24t-data2/Scratch/rot.bin)"
    result=$(until_job_free docker exec c24t-snapraid snapraid.sh run scrub)
    expect_match "the next scrub is clean" "scrub done" "$result"
    local sent; sent=$(notifications_since "$mark")
    note "notified: $(echo "$sent" | cut -d'|' -f1 | tr '\n' ';')"
    expect_match "notified the failed scrub" "scrub failed" "$sent"
}

all_scenarios=(baseline drop-return gone-for-good two-at-once data1 io-errors smart parity-during-sync bit-rot)
scenarios=("$@")
[ ${#scenarios[@]} -gt 0 ] || scenarios=("${all_scenarios[@]}")
[[ " ${scenarios[*]} " == *" baseline "* ]] || scenarios=(baseline "${scenarios[@]}")

started=$SECONDS
start_stack
for scenario in "${scenarios[@]}"; do
    scenario_started=$SECONDS
    "scenario_${scenario//-/_}"
    note "($((SECONDS - scenario_started)) s)"
done
[ -n "${KEEP_STACK:-}" ] || stop_stack
say "$passed passed, $failed failed, $(( (SECONDS - started) / 60 )) min"
[ "$failed" -eq 0 ]
