#!/bin/bash
# tests/nodes/run.sh: several nodes on one host. Two arrays (the cluster under a legacy prefix and one
# with an id), a drive node and a folder node on mounted volumes, each with its own Syncthing, read
# through GET /api/nodes; a third array attached while the stack runs; a parity sync started by hand
# shown with its progress; and a member that is missing named from the description on the others.
# Runs from Git Bash (Docker Desktop) or Linux under the project storage-test-nodes; never touches a
# real drive and publishes nothing.
set -u
export MSYS_NO_PATHCONV=1

native_path() { (cd "$1" && { pwd -W 2> /dev/null || pwd; }); }
here=$(native_path "$(dirname "$0")")
repo=$(native_path "$here/../..")
compose=(docker compose -p storage-test-nodes --project-directory "$repo" --env-file "$here/test.env"
    -f "$repo/docker-compose.yml" -f "$here/docker-compose.test.yml")
services=(mounter pool snapraid dashboard gateway syncthing nodes)
passed=0
failed=0

lab() { docker exec stn-lab lab.sh "$@"; }
nodes_json() { lab api /api/nodes; }
say() { printf '\n\033[36m%s\033[0m\n' "$*"; }
pass() { echo "  PASS $1"; passed=$((passed + 1)); }
fail() { echo "  FAIL $1"; failed=$((failed + 1)); }
expect() { if [ "$2" = "$3" ]; then pass "$1: $3"; else fail "$1: expected '$2', got '$3'"; fi; }

eventually() {   # <what> <expected> <timeout seconds> <command...>
    local what=$1 expected=$2 timeout=$3 started=$SECONDS actual
    shift 3
    while true; do
        actual=$("$@" 2> /dev/null)
        [ "$actual" = "$expected" ] && { pass "$what: $actual (after $((SECONDS - started)) s)"; return 0; }
        [ $((SECONDS - started)) -ge "$timeout" ] && { fail "$what: expected '$expected', still '$actual' after $timeout s"; return 1; }
        sleep 2
    done
}

node_query() { lab api /api/nodes "$1"; }   # <jq filter on the nodes response>

stop_stack() {
    "${compose[@]}" stop "${services[@]}" > /dev/null 2>&1
    "${compose[@]}" rm -f "${services[@]}" > /dev/null 2>&1
}

clean_up() {
    say "Stopping the test stack and removing its drives"
    stop_stack
    lab remove
    lab clean-mount-points
    "${compose[@]}" down -v > /dev/null 2>&1
}

say "Building the images and the drives"
"${compose[@]}" build --quiet lab mounter pool snapraid dashboard nodes || exit 1
[ -z "$(docker ps -aq -f name=^stn-lab$)" ] || clean_up
"${compose[@]}" up -d lab || exit 1
lab remove > /dev/null
lab array stnc 2 && lab array b00c 2 900M 1000M && lab volumes || { clean_up; exit 1; }
"${compose[@]}" up -d "${services[@]}" || { clean_up; exit 1; }

say "Arrays"
eventually "the cluster is healthy" "healthy true" 120 sh -c "docker exec stn-lab jq -r '\"\\(.state) \\(.complete)\"' /status/arrays/stnc/status.json"
eventually "the second array is healthy" "healthy true" 60 sh -c "docker exec stn-lab jq -r '\"\\(.state) \\(.complete)\"' /status/arrays/b00c/status.json"
eventually "its pool is mounted" yes 60 sh -c "docker exec stn-lab mountpoint -q /mnt/storage/pool-b00c && echo yes"
eventually "every member carries the description" "3 3 3" 60 sh -c "for role in data1 data2 parity1; do docker exec stn-lab grep -c '^\[\[array.members\]\]' /mnt/storage/b00c-\$role/.storage/node.toml; done | tr '\n' ' ' | sed 's/ \$//'"
expect "the cluster's status is still linked at /status" stnc "$(docker exec stn-lab jq -r .id /status/status.json)"
expect "each array has its own lock" "stntest stntest" "$(docker exec stn-lab sh -c 'cut -d" " -f1 /mnt/storage/stnc-data1/.storage/lock /mnt/storage/b00c-data1/.storage/lock' | tr '\n' ' ' | sed 's/ $//')"

say "Drive and folder nodes"
eventually "the registry holds both" "5c1c folder ventoy-files;d15c drive p53-data;" 60 lab registry
expect "nothing was searched below the stick's root" "" "$(docker exec stn-lab cat /status/nodes/warnings)"
eventually "each node and the second array have a Syncthing" "3" 90 sh -c "docker exec stn-lab sh -c 'ls /status/nodes/*.syncthing.json | wc -l'"

say "GET /api/nodes"
eventually "every node is listed and online" "b00c array true;d15c drive true;stnc array true;5c1c folder true;" 120 \
    lab api /api/nodes '[.nodes | sort_by(.name) | .[] | "\(.id) \(.kind) \(.online);"] | join("")'
eventually "every node's own Syncthing answers" "4" 120 lab api /api/nodes '[.nodes[] | select(.syncthing.deviceId != null)] | length'
expect "four different Syncthing identities" "4" "$(node_query '[.nodes[].syncthing.deviceId] | unique | length')"
expect "the folder node's threshold" "80" "$(node_query '.nodes[] | select(.id == "5c1c") | .threshold')"
expect "the second array's members" "data1 data2 parity1" "$(node_query '.nodes[] | select(.id == "b00c") | [.array.members[].role] | join(" ")')"
expect "the host's name" "stntest" "$(node_query '.host.name')"
echo "  /api/nodes answers in $(docker exec stn-lab sh -c 'curl -fsS -o /dev/null -w "%{time_total}" http://dashboard:8080/api/nodes') s"
expect "the response has the contract's keys" "array,assigned,folders,host,id,kind,local,name,online,space,sync,syncthing,threshold" \
    "$(node_query '.nodes[] | select(.id == "b00c") | keys | join(",")')"

say "A third array attached while the stack runs"
started=$SECONDS
lab array c0de 1 > /dev/null
eventually "it is found and healthy" "healthy true" 120 sh -c "docker exec stn-lab jq -r '\"\\(.state) \\(.complete)\"' /status/arrays/c0de/status.json"
echo "  found $((SECONDS - started)) s after its drives appeared"

say "A parity sync started by hand"
docker exec stn-lab sh -c 'mkdir -p /mnt/storage/b00c-data1/Files /mnt/storage/b00c-data2/Files && head -c 800000000 /dev/urandom > /mnt/storage/b00c-data1/Files/big.bin && head -c 800000000 /dev/urandom > /mnt/storage/b00c-data2/Files/big.bin'
docker exec stn-snapraid sh -c 'snapraid.sh --array b00c config > /dev/null'
docker exec stn-lab lab.sh watch-job b00c 60 > "$here/.watch-job" &
watcher=$!
sleep 1
docker exec -d stn-snapraid sh -c 'snapraid -c /status/arrays/b00c/snapraid.conf sync > /tmp/hand.log 2>&1'
wait "$watcher"
seen=$(cat "$here/.watch-job"); rm -f "$here/.watch-job"
expect "the dashboard shows the sync started by hand" sync "${seen%% *}"
echo "  first seen at ${seen#* }%"
eventually "the sync ends and the job goes" "" 300 lab api /api/nodes '.nodes[] | select(.id == "b00c") | .array.parity.job.kind // empty'

say "Actions"
expect "an unknown array" "404" "$(lab post /api/arrays/ffff/sync '{}' | cut -d' ' -f1)"
expect "remove refuses a mounted drive" "409" "$(lab post /api/arrays/b00c/remove '{"role":"data2","confirm":"data2"}' | cut -d' ' -f1)"
expect "a scrub of the second array starts" "202" "$(lab post /api/arrays/b00c/scrub '{}' | cut -d' ' -f1)"
expect "a join from outside the tailnet" "403" "$(lab post /api/join '{"name":"p53","os":"linux","syncthingDeviceId":"AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA","nodes":[{"kind":"drive","path":"/data","threshold":80}]}' | cut -d' ' -f1)"
eventually "the log shows the scrub" yes 60 sh -c "docker exec stn-lab lab.sh api /api/arrays/b00c/log '.lines[]' | grep -q 'scrub done' && echo yes"

say "A member missing from the start, named by the others"
stop_stack
lab detach b00c-data2
lab clean-mount-points
"${compose[@]}" up -d "${services[@]}" > /dev/null 2>&1
eventually "the second array is degraded" degraded 120 sh -c "docker exec stn-lab jq -r .state /status/arrays/b00c/status.json"
expect "the missing member is named" "b00c-data2 missing" "$(docker exec stn-lab jq -r '.drives[] | select(.condition != "present") | "\(.label) \(.condition)"' /status/arrays/b00c/status.json)"
eventually "the API names it too" "data2 false" 60 lab api /api/nodes '.nodes[] | select(.id == "b00c") | .array.members[] | select(.present | not) | "\(.role) \(.present)"'
expect "and warns" "true" "$(node_query '[.warnings[] | select(.nodeId == "b00c")] | length > 0')"

clean_up
say "$passed passed, $failed failed"
[ "$failed" -eq 0 ]
