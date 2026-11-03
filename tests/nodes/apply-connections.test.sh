#!/bin/bash
# tests/nodes/apply-connections.test.sh: the Docker nodes' connection keeper (images/nodes/apply-connections.sh)
# against a stub curl, and the rules nodes.sh keeps for sync ports and listen addresses. Needs jq; where it
# is missing (Git Bash) it runs itself in a throwaway container with no network. Prints PASS or FAIL per
# check and exits non-zero on any failure.
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
    exec docker run --rm --network none -v "$native_repo:/repo:ro" storage-nodes-tests:local bash /repo/tests/nodes/apply-connections.test.sh
fi

apply=$repo/images/nodes/apply-connections.sh
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
passed=0
failed=0

check() {
    local what="$1" expected="$2" actual="$3"
    if [[ "$expected" == "$actual" ]]; then echo "  PASS $what"; passed=$((passed + 1))
    else echo "  FAIL $what: expected '$expected', got '$actual'"; failed=$((failed + 1)); fi
}

mkdir -p "$scratch/stubs"
cat > "$scratch/stubs/curl" << 'EOF'
#!/bin/sh
method=GET key= body= url=
while [ $# -gt 0 ]; do
    case $1 in
        -X) method=$2; shift ;;
        -H) case $2 in "X-API-Key: "*) key=${2#X-API-Key: } ;; esac; shift ;;
        -d | --data) body=$2; shift ;;
        -m) shift ;;
        -*) ;;
        *) url=$1 ;;
    esac
    shift
done
echo "$method $url key=$key $body" >> "$CURL_LOG"
case $url in */rest/system/ping) [ -n "${CURL_PING_FAILS:-}" ] && exit 7; echo '{"ping":"pong"}' ;; esac
EOF
chmod +x "$scratch/stubs/curl"

run_apply() {   # <connections file> <node id>: prints the requests the keeper made, then its exit code
    export CURL_LOG="$scratch/curl.log"
    : > "$CURL_LOG"
    PATH="$scratch/stubs:$PATH" CONNECTIONS_FILE="$1" APPLY_WAIT_SECONDS=2 sh "$apply" "$2" http://127.0.0.1:8411 secret-key > "$scratch/apply.out" 2>&1
    local status=$?
    grep -v '/rest/system/ping' "$CURL_LOG"
    echo "exit $status"
}

profile=$scratch/connections.json
cat > "$profile" << 'EOF'
{
  "a1b2": {
    "options": {
      "localAnnounceEnabled": true,
      "natEnabled": false,
      "globalAnnounceEnabled": false,
      "globalAnnounceServers": [],
      "relaysEnabled": true,
      "maxSendKbps": 0,
      "maxRecvKbps": 500,
      "limitBandwidthInLan": false
    },
    "listenAddresses": [
      "tcp://0.0.0.0:22021",
      "quic://0.0.0.0:22021",
      "relay://100.64.0.1:22100/?id=RELAY",
      "dynamic+https://relays.syncthing.net/endpoint"
    ],
    "deviceAddresses": { "PEERID": ["tcp://100.64.0.2:22001", "dynamic"] }
  },
  "c3d4": "not an entry",
  "e5f6": {
    "options": { "natEnabled": "no", "maxSendKbps": -1, "maxRecvKbps": 1.5, "deviceName": "renamed", "globalAnnounceServers": "default" },
    "listenAddresses": ["ftp://0.0.0.0:22023", 22023, "default", "tcp://0.0.0.0:22023 extra"],
    "deviceAddresses": {}
  },
  "a7b8": {
    "options": { "relaysEnabled": false, "maxSendKbps": "fast" },
    "listenAddresses": ["tcp://0.0.0.0:22024", "udp://0.0.0.0:22024"]
  },
  "c9d0": {
    "options": { "natEnabled": true },
    "listenAddresses": ["tcp://0.0.0.0:22025", "dynamic+http://relays.example/endpoint"]
  }
}
EOF

echo "apply-connections.sh"
check "apply-connections without a file changes nothing" "exit 0" "$(run_apply "$scratch/missing.json" a1b2)"
check "a node without an entry changes nothing" "exit 0" "$(run_apply "$profile" ffff)"
check "it sends the node's options and listen addresses" \
    'PATCH http://127.0.0.1:8411/rest/config/options key=secret-key {"localAnnounceEnabled":true,"natEnabled":false,"globalAnnounceEnabled":false,"globalAnnounceServers":[],"relaysEnabled":true,"maxSendKbps":0,"maxRecvKbps":500,"limitBandwidthInLan":false,"listenAddresses":["tcp://0.0.0.0:22021","quic://0.0.0.0:22021","relay://100.64.0.1:22100/?id=RELAY","dynamic+https://relays.syncthing.net/endpoint"]}
exit 0' "$(run_apply "$profile" a1b2)"
check "an invalid entry changes nothing" "exit 0" "$(run_apply "$profile" c3d4)"
check "an entry of nothing but invalid values changes nothing" "exit 0" "$(run_apply "$profile" e5f6)"
check "a list with one invalid address leaves the listen addresses unchanged while a valid option is still sent" \
    'PATCH http://127.0.0.1:8411/rest/config/options key=secret-key {"relaysEnabled":false}
exit 0' "$(run_apply "$profile" a7b8)"
check "a listen list takes the host agent's schemes, dynamic+http included" \
    'PATCH http://127.0.0.1:8411/rest/config/options key=secret-key {"natEnabled":true,"listenAddresses":["tcp://0.0.0.0:22025","dynamic+http://relays.example/endpoint"]}
exit 0' "$(run_apply "$profile" c9d0)"
echo '{"a1b2": ' > "$scratch/broken.json"
check "an unreadable file changes nothing" "exit 0" "$(run_apply "$scratch/broken.json" a1b2)"
check "a Syncthing that never answers is sent nothing" "exit 1" "$(CURL_PING_FAILS=1 run_apply "$profile" a1b2)"

echo "one listen rule"
checks=$repo/images/nodes/connection-profile.jq
check "the keepers carry no checks of their own" "0 0" \
    "$(grep -c 'def is_listen_address' "$apply") $(grep -c 'def is_listen_address' "$repo/join/storage-connections.sh")"
check "the profile checks use the host agent's scheme pattern" \
    "$(sed -n "s/^\$profileListenAddressPattern = '\(.*\)'\$/\1/p" "$repo/windows/syncthing.ps1")" \
    "$(sed -n 's/^def is_listen_address: .*test("\(.*\)");$/\1/p' "$checks" | sed 's/\\\\/\\/g')"

echo "nodes.sh"
# shellcheck source=../../images/nodes/nodes.sh
source "$repo/images/nodes/nodes.sh"
registry=$scratch/registry
ports_file=$registry/ports
connections_file=$profile
service_user=$(id -u)
mkdir -p "$registry"

check "a new node gets port 22021 when 1-20 are free" 21 "$(port_index a1b2)"
printf 'c3d4 3\na1b2 21\n' > "$ports_file"
check "an existing assignment keeps its port" 3 "$(port_index c3d4)"
check "the next new node takes the next free port" 22 "$(port_index e5f6)"
check "the assignments are kept" "c3d4 3
a1b2 21
e5f6 22" "$(cat "$ports_file")"
for index in $(seq 21 99); do echo "n$index $index"; done > "$ports_file"
port_index f0f0 > /dev/null 2>&1
check "with 21-99 all taken a new node gets no port" "1 79" "$? $(wc -l < "$ports_file")"

write_config() {   # <home> <listen address>...
    mkdir -p "$1"
    local home=$1
    shift
    {
        echo '<configuration version="51">'
        echo '    <options>'
        for address in "$@"; do echo "        <listenAddress>$address</listenAddress>"; done
        echo '        <globalAnnounceServer>default</globalAnnounceServer>'
        echo '    </options>'
        echo '</configuration>'
    } > "$home/config.xml"
}
listen_of() { grep -o '<listenAddress>[^<]*</listenAddress>' "$1/config.xml" | sed 's/<[^>]*>//g' | tr '\n' ' ' | sed 's/ $//'; }

write_config "$scratch/ffff" tcp://:22009 quic://:22009 dynamic+https://relays.syncthing.net/endpoint
prepare_home ffff "$scratch/ffff" 22021
check "a node without an entry gets one listen address, never a duplicated list" "tcp://:22021" "$(listen_of "$scratch/ffff")"
check "the rest of its config is kept" 1 "$(grep -c '<globalAnnounceServer>default</globalAnnounceServer>' "$scratch/ffff/config.xml")"
write_config "$scratch/a1b2" tcp://0.0.0.0:22021 quic://0.0.0.0:22021
prepare_home a1b2 "$scratch/a1b2" 22021
check "a node with an entry keeps the listen addresses the profile set" "tcp://0.0.0.0:22021 quic://0.0.0.0:22021" "$(listen_of "$scratch/a1b2")"
write_config "$scratch/a1b2" default
prepare_home a1b2 "$scratch/a1b2" 22021
check "a fresh home with an entry is moved off Syncthing's default port" "tcp://:22021" "$(listen_of "$scratch/a1b2")"

echo "$passed passed, $failed failed"
[ "$failed" -eq 0 ]
