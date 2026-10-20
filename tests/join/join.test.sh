#!/usr/bin/env bash
# Runs inside the test bench (run.sh): the Linux join script against a fake dashboard that admits the
# device into a real Syncthing peer, with the device's own real Syncthing; Tailscale and systemd are
# faked. Prints PASS or FAIL per check and exits non-zero on any failure.
# shellcheck disable=SC2088 # "~/name" in a check name is text, never a path
set -uo pipefail

join=/join/storage-join.sh
peer_home=/peer/.syncthing
peer_gui=127.0.0.1:8385
dashboard_port=8099
passed=0
failed=0

check() {
    local what="$1" expected="$2" actual="$3"
    if [[ "$expected" == "$actual" ]]; then echo "  PASS $what: $actual"; passed=$((passed + 1))
    else echo "  FAIL $what: expected '$expected', got '$actual'"; failed=$((failed + 1)); fi
}

check_match() {
    local what="$1" pattern="$2" actual="$3"
    if [[ "$actual" =~ $pattern ]]; then echo "  PASS $what"; passed=$((passed + 1))
    else echo "  FAIL $what: '$actual' does not match '$pattern'"; failed=$((failed + 1)); fi
}

api_key_of() { sed -n 's:.*<apikey>\(.*\)</apikey>.*:\1:p' "$1/config.xml" | head -n 1; }

device_api() { curl -fsS -H "X-API-Key: $(api_key_of /data/.storage/syncthing)" "http://127.0.0.1:8384$1"; }

peer_api() {
    local method="$1" path="$2"
    shift 2
    curl -fsS -X "$method" -H "X-API-Key: $(api_key_of "$peer_home")" -H "Content-Type: application/json" "$@" "http://$peer_gui$path"
}

start_peer() {
    mkdir -p /peer
    syncthing generate --home="$peer_home" --no-port-probing > /dev/null
    STNOUPGRADE=1 syncthing serve --home="$peer_home" --no-browser --gui-address="$peer_gui" > /tmp/peer.log 2>&1 &
    for _ in $(seq 1 60); do peer_api GET /rest/system/status > /dev/null 2>&1 && break; sleep 1; done
    peer_api PATCH /rest/config/options -d '{"listenAddresses": ["tcp://127.0.0.1:22100"], "globalAnnounceEnabled": false,
        "localAnnounceEnabled": false, "relaysEnabled": false, "natEnabled": false, "urAccepted": -1}' > /dev/null
}

start_dashboard() {
    python3 /tests/fake-dashboard.py "$dashboard_port" "http://$peer_gui" "$(api_key_of "$peer_home")" "tcp://127.0.0.1:22100" /tmp/dashboard &
    for _ in $(seq 1 30); do curl -s -o /dev/null "http://127.0.0.1:$dashboard_port/" && break; sleep 0.5; done
}

make_device() {
    adduser -D -u 1000 finn
    mkdir -p /data /home/finn/Documents
    echo "kept" > /home/finn/Documents/letter.txt
    chown -R finn:finn /data /home/finn
    export PATH="/tests/fakes:$PATH" STORAGE_DASHBOARD="http://127.0.0.1:$dashboard_port" STORAGE_JOIN_NAME=p53
}

run_join() { bash "$join" > /tmp/join.out 2>&1; echo $?; }

wait_for_connection() {
    local device_id="$1"
    for _ in $(seq 1 60); do
        [[ "$(peer_api GET /rest/system/connections | jq -r --arg id "$device_id" '.connections[$id].connected // false')" == "true" ]] && { echo true; return; }
        sleep 1
    done
    echo false
}

echo "Setting up the peer, the fake dashboard and the device..."
start_peer
start_dashboard
make_device

echo "The first run, with the auth key in STORAGE_JOIN_KEY:"
check "exit code" 0 "$(STORAGE_JOIN_KEY=tskey-test run_join)"
cat /tmp/join.out | sed 's/^/    | /'
check "tailscale up" "--auth-key=tskey-test --hostname=p53" "$(cat /run/fake-tailscale/up-calls)"
check_match "node file" '^\[node\] id *= "[0-9a-f]{4}" name *= "p53" kind *= "drive" threshold *= 50 assigned *= \[\]$' "$(tr '\n' ' ' < /data/.storage/node.toml | sed 's/ *$//')"
check "Syncthing runs as the data root's owner" finn "$(stat -c %U /data/.storage/syncthing/config.xml)"
check_match "Syncthing's home is on the node" '--home=/data/.storage/syncthing' "$(grep ExecStart /etc/systemd/system/storage-syncthing.service)"
options="$(device_api /rest/config/options)"
check "listens on the tailnet address only" '["tcp://127.0.0.1:22000"]' "$(jq -c .listenAddresses <<< "$options")"
check "discovery, relays and NAT off" "false false false false" "$(jq -r '[.globalAnnounceEnabled, .localAnnounceEnabled, .relaysEnabled, .natEnabled] | join(" ")' <<< "$options")"
peer_id="$(peer_api GET /rest/system/status | jq -r .myID)"
device_id="$(device_api /rest/system/status | jq -r .myID)"
check "the dashboard's peer is a device" "storage tcp://127.0.0.1:22100" "$(device_api "/rest/config/devices/$peer_id" | jq -r '.name + " " + (.addresses | join(","))')"
check "folder documents" "/data/Documents" "$(device_api /rest/config/folders/documents | jq -r .path)"
check "folder documents-github shared with the peer" "/data/Documents/GitHub $peer_id" "$(device_api /rest/config/folders/documents-github | jq -r --arg id "$peer_id" '.path + " " + ([.devices[].deviceID | select(. == $id)] | join(","))')"
check "~/Documents is linked" /data/Documents "$(readlink /home/finn/Documents)"
check "~/code is linked" /data/Documents/GitHub "$(readlink /home/finn/code)"
check "what ~/Documents held was moved, not lost" kept "$(cat /data/Documents/letter.txt)"
check "the request" "{\"name\":\"p53\",\"os\":\"linux\",\"syncthingDeviceId\":\"$device_id\",\"nodes\":[{\"kind\":\"drive\",\"path\":\"/data\",\"threshold\":50}]}" "$(head -n 1 /tmp/dashboard/requests.jsonl | jq -c .)"
check "the peer connects to the device over the tailnet address" true "$(wait_for_connection "$device_id")"

echo "The second run changes nothing:"
node_before="$(sha256sum /data/.storage/node.toml)"
config_before="$(sha256sum /data/.storage/syncthing/config.xml)"
unit_before="$(sha256sum /etc/systemd/system/storage-syncthing.service)"
check "exit code" 0 "$(run_join)"
check_match "says so" "already joined; nothing changed" "$(cat /tmp/join.out)"
check "node file unchanged" "$node_before" "$(sha256sum /data/.storage/node.toml)"
check "Syncthing's config unchanged" "$config_before" "$(sha256sum /data/.storage/syncthing/config.xml)"
check "unit unchanged" "$unit_before" "$(sha256sum /etc/systemd/system/storage-syncthing.service)"
check "tailscale up not called again" 1 "$(wc -l < /run/fake-tailscale/up-calls)"
check "the dashboard was asked again, harmlessly" 2 "$(wc -l < /tmp/dashboard/requests.jsonl)"

echo "The auth key from the stick's personal folder:"
echo NeedsLogin > /run/fake-tailscale/state
mkdir -p /stick/personal && echo "tskey-from-stick" > /stick/personal/tailscale.key
check "exit code" 0 "$(IMPRINT_PERSONAL=/stick/personal run_join)"
check "tailscale up" "--auth-key=tskey-from-stick --hostname=p53" "$(tail -n 1 /run/fake-tailscale/up-calls)"

echo "Refusals:"
echo NeedsLogin > /run/fake-tailscale/state
check "no key and not joined: exit code" 1 "$(run_join)"
check_match "says what to do" "STORAGE_JOIN_KEY" "$(cat /tmp/join.out)"
echo Running > /run/fake-tailscale/state
check "a name known with another ID: exit code" 1 "$(STORAGE_JOIN_NAME=taken run_join)"
check_match "says 409 and how to re-admit" "409.*re-admit" "$(cat /tmp/join.out)"
check "a caller outside the tailnet: exit code" 1 "$(STORAGE_JOIN_NAME=stranger run_join)"
check_match "says 403" "403" "$(cat /tmp/join.out)"

echo "Keeping everything is for the cluster only:"
mkdir -p /data2 && chown finn:finn /data2
check "threshold 0 for a new device node: exit code" 1 "$(STORAGE_JOIN_ROOT=/data2 STORAGE_JOIN_THRESHOLD=0 run_join)"
check_match "says why and what to use" "threshold 0 keeps everything.*use 50.*STORAGE_JOIN_ALLOW_KEEP_ALL=1" "$(cat /tmp/join.out)"
check "and writes nothing" false "$([[ -e /data2/.storage ]] && echo true || echo false)"
mkdir -p /data3/.storage && printf '[node]\nid = "abcd"\nname = "old"\nkind = "drive"\nthreshold = 0\n' > /data3/.storage/node.toml
check "an existing node file with threshold 0: exit code" 1 "$(STORAGE_JOIN_ROOT=/data3 run_join)"
allowed="$(STORAGE_JOIN_ROOT=/data2 STORAGE_JOIN_THRESHOLD=0 STORAGE_JOIN_ALLOW_KEEP_ALL=1 bash -c "source $join; join_root=/data2; node_file=/data2/.storage/node.toml; check_threshold && echo allowed")"
check "STORAGE_JOIN_ALLOW_KEEP_ALL=1 allows it" allowed "$allowed"
check "a threshold that is not a number: exit code" 1 "$(STORAGE_JOIN_ROOT=/data2 STORAGE_JOIN_THRESHOLD=high run_join)"

echo "Installing missing packages, the stick's repository first:"
mkdir -p /tmp/pacman-bin /tmp/offline-repo && echo "[options]" > /etc/pacman.conf
cat > /tmp/pacman-bin/pacman << 'EOF'
#!/usr/bin/env bash
config="$2"
{ echo "args: $*"; echo "config: $(head -n 3 "$config" | tr '\n' ' ')"; } > /tmp/pacman-call
EOF
chmod +x /tmp/pacman-bin/pacman
installed="$(PATH="/tmp/pacman-bin:/usr/bin:/bin" STORAGE_JOIN_OFFLINE_REPO=/tmp/offline-repo bash -c "source $join; command() { [[ \"\$2\" == pacman ]] && return 0; [[ \"\$2\" == jq || \"\$2\" == curl ]] && return 0; return 1; }; install_packages")"
check "pacman installs only what is missing" "args: --config $(sed -n 's/^args: --config \([^ ]*\).*/\1/p' /tmp/pacman-call) -Sy --needed --noconfirm tailscale syncthing" "$(head -n 1 /tmp/pacman-call)"
check "the offline repository comes first" "config: [offline] SigLevel = Optional TrustAll Server = file:///tmp/offline-repo " "$(sed -n 2p /tmp/pacman-call)"
check_match "and says so" "installed tailscale syncthing" "$installed"

echo ""
echo "join (linux): $passed passed, $failed failed"
[[ "$failed" -eq 0 ]]
