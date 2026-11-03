#!/bin/sh
# tests/bridge/start.test.sh: the bridge's entrypoint (services/bridge/start.sh) against a stub
# strelaysrv and the real one, inside the image the compose file pins, with no network. Prints PASS or
# FAIL per check and exits non-zero on any failure.
set -u

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)

if [ ! -x /bin/strelaysrv ]; then
    export MSYS_NO_PATHCONV=1
    image=$(sed -n 's/^[[:space:]]*image:[[:space:]]*\(syncthing\/relaysrv:.*\)$/\1/p' "$repo/docker-compose.yml" | tr -d '\r')
    native_repo=$(cd "$repo" && { pwd -W 2>/dev/null || pwd; })
    exec docker run --rm --network none --entrypoint /bin/sh -v "$native_repo:/repo:ro" "$image" /repo/tests/bridge/start.test.sh
fi

start=$repo/services/bridge/start.sh
scratch=$(mktemp -d)
chmod 755 "$scratch"
trap 'rm -rf "$scratch"' EXIT
passed=0
failed=0
relay_id=P5H5HGN-NZDOI67-YCWL5MA-YDENBDV-OZTYJ75-C5PAIED-LWOGOBC-HQPMNA2

check() {
    if [ "$2" = "$3" ]; then
        echo "  PASS $1"
        passed=$((passed + 1))
    else
        echo "  FAIL $1: expected '$2', got '$3'"
        failed=$((failed + 1))
    fi
}

cat >"$scratch/strelaysrv" <<'EOF'
#!/bin/sh
echo "$*" >"$STUB_LOG/args"
id -u >"$STUB_LOG/uid"
trap 'echo stopped >"$STUB_LOG/stopped"; exit 0' TERM
echo "main.go:142: strelaysrv stub"
[ -n "${STUB_URI:-}" ] && echo "main.go:270: URI: $STUB_URI"
while :; do sleep 0.1; done
EOF
chmod 755 "$scratch/strelaysrv"

wait_for() {
    tries=0
    while [ "$tries" -lt 50 ]; do
        [ -e "$1" ] && return 0
        sleep 0.1
        tries=$((tries + 1))
    done
    return 1
}

# Runs the entrypoint in the background against a fresh case folder; sets case_dir and entry_pid.
run_case() {
    case_dir=$scratch/$1
    mkdir -p "$case_dir/keys" "$case_dir/status" "$case_dir/log"
    chmod 777 "$case_dir/log"
    [ -n "${2:-}" ] && echo stale >"$case_dir/status/bridge.json"
    BRIDGE_PORT=22100 BRIDGE_KEYS="$case_dir/keys" BRIDGE_STATUS="$case_dir/status/bridge.json" \
        STRELAYSRV="${RELAY:-$scratch/strelaysrv}" STUB_LOG="$case_dir/log" STUB_URI="${URI:-}" \
        sh "$start" >"$case_dir/output" 2>&1 &
    entry_pid=$!
}

stop_case() {
    kill -TERM "$entry_pid"
    wait "$entry_pid"
    entry_code=$?
}

echo "publishes the relay id and port"
URI="relay://0.0.0.0:22100/?id=$relay_id&networkTimeout=2m0s&pingInterval=1m0s" run_case published
wait_for "$case_dir/status/bridge.json"
check "bridge.json" "{ \"relayId\": \"$relay_id\", \"port\": 22100 }" "$(cat "$case_dir/status/bridge.json" 2>/dev/null)"
check "flags" "-pools= -status-srv= -listen=:22100 -keys=$case_dir/keys" "$(cat "$case_dir/log/args")"
check "runs unprivileged" 1000 "$(cat "$case_dir/log/uid")"
check "keys owned by the relay's user" 1000 "$(stat -c %u "$case_dir/keys")"
check "relay output passed through" yes "$(grep -q 'strelaysrv stub' "$case_dir/output" && echo yes)"
stop_case
check "stop reaches the relay" stopped "$(cat "$case_dir/log/stopped" 2>/dev/null)"
check "stop removes bridge.json" absent "$([ -e "$case_dir/status/bridge.json" ] && echo present || echo absent)"
check "exit code of a clean stop" 0 "$entry_code"

echo "a stale file goes before the relay reports an id"
URI= run_case stale with-stale-file
wait_for "$case_dir/log/args"
sleep 0.3
check "no bridge.json without a URI line" absent "$([ -e "$case_dir/status/bridge.json" ] && echo present || echo absent)"
stop_case

echo "an id that is not a device id is ignored"
URI="relay://0.0.0.0:22100/?id=bad\"id&x=1" run_case invalid
wait_for "$case_dir/log/args"
sleep 0.3
check "no bridge.json for a bad id" absent "$([ -e "$case_dir/status/bridge.json" ] && echo present || echo absent)"
stop_case

echo "the real strelaysrv"
RELAY=/bin/strelaysrv URI= run_case real
wait_for "$case_dir/status/bridge.json"
real_id=$(sed -n 's/.*URI: relay:\/\/[^?]*?id=\([^&]*\).*/\1/p' "$case_dir/output")
check "bridge.json carries the id it prints" "{ \"relayId\": \"$real_id\", \"port\": 22100 }" "$(cat "$case_dir/status/bridge.json" 2>/dev/null)"
check "keys written" yes "$([ -s "$case_dir/keys/cert.pem" ] && [ -s "$case_dir/keys/key.pem" ] && echo yes)"
stop_case
check "exit code after TERM" 0 "$entry_code"
check "stop removes bridge.json" absent "$([ -e "$case_dir/status/bridge.json" ] && echo present || echo absent)"

echo "the id survives a restart on the same keys"
first=$real_id
mkdir -p "$scratch/again/keys"
cp "$scratch/real/keys/cert.pem" "$scratch/real/keys/key.pem" "$scratch/again/keys/"
RELAY=/bin/strelaysrv URI= run_case again
wait_for "$case_dir/status/bridge.json"
check "same relay id" "{ \"relayId\": \"$first\", \"port\": 22100 }" "$(cat "$case_dir/status/bridge.json" 2>/dev/null)"
stop_case

echo "$passed passed, $failed failed"
[ "$failed" -eq 0 ]
