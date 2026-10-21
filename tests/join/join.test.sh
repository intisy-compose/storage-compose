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
sed 's/^/    | /' /tmp/join.out
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
check_match "says 403 with the dashboard's reason" "\(403\): not in this tailnet$" "$(cat /tmp/join.out)"

echo "The device's name:"
cat > /tmp/layout.toml << 'LAYOUT'
[devices.pc]
id         = "PBMD2SH-RS3UNJU-L77BP7K-X7VFKHE-73FF74D-RRCUVRY-XNUNII3-WWU53Q6"
root       = 'F:\'
not_synced = ["$RECYCLE.BIN", "Saved Games"]

[devices.pc.paths]
Desktop = 'C:\Users\finn\Desktop'

[folders.Documents]
ignore = [
    "/GitHub",
]
id = "NOT-A-DEVICE"
LAYOUT
name_of() { env -u STORAGE_JOIN_NAME STORAGE_JOIN_LAYOUT="${2:-/tmp/layout.toml}" bash -c "source $join; device_name '$1'"; }
expected_host="$(hostname | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-' | sed 's/^-*//; s/-*$//')"
check "the device list's entry for the ID" pc "$(name_of PBMD2SH-RS3UNJU-L77BP7K-X7VFKHE-73FF74D-RRCUVRY-XNUNII3-WWU53Q6)"
check "the host name for an ID the list does not hold" "$expected_host" "$(name_of ZZZZZZZ-RS3UNJU-L77BP7K-X7VFKHE-73FF74D-RRCUVRY-XNUNII3-WWU53Q6)"
check "never an id outside a device's table" "$expected_host" "$(name_of NOT-A-DEVICE)"
check "the host name without a device list" "$expected_host" "$(name_of PBMD2SH-RS3UNJU-L77BP7K-X7VFKHE-73FF74D-RRCUVRY-XNUNII3-WWU53Q6 /nowhere.toml)"
check "never the user's name" "$expected_host" "$(USER=someone-else LOGNAME=someone-else name_of '')"
check "STORAGE_JOIN_NAME first" given "$(STORAGE_JOIN_NAME=given STORAGE_JOIN_LAYOUT=/tmp/layout.toml bash -c "source $join; device_name PBMD2SH-RS3UNJU-L77BP7K-X7VFKHE-73FF74D-RRCUVRY-XNUNII3-WWU53Q6")"
mkdir -p /data4 && chown finn:finn /data4
runuser -u finn -- syncthing generate --home=/data4/.storage/syncthing --no-port-probing > /dev/null
listed_id="$(syncthing device-id --home=/data4/.storage/syncthing | head -n 1)"
printf '[devices.laptop]\nid = "%s"\n' "$listed_id" > /tmp/listed.toml
check "a listed device: exit code" 0 "$(unset STORAGE_JOIN_NAME; STORAGE_JOIN_LAYOUT=/tmp/listed.toml STORAGE_JOIN_ROOT=/data4 run_join)"
check_match "its node is named after the entry" 'name *= "laptop"' "$(cat /data4/.storage/node.toml)"
check "the dashboard is asked under that name" laptop "$(tail -n 1 /tmp/dashboard/requests.jsonl | jq -r .name)"
check "it keeps the keys it found" "$listed_id" "$(syncthing device-id --home=/data4/.storage/syncthing | head -n 1)"

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

echo "When it asks:"
check "not with stdin a pipe" no "$(echo | env -u STORAGE_JOIN_NAME bash -c "source $join; is_interactive && echo yes || echo no")"
check "on a terminal with no STORAGE_JOIN_* set" yes "$(env -u STORAGE_JOIN_NAME bash -c "source $join; stdin_is_terminal() { return 0; }; is_interactive && echo yes || echo no")"
check "not with a STORAGE_JOIN_* set" no "$(env -u STORAGE_JOIN_NAME STORAGE_JOIN_THRESHOLD=50 bash -c "source $join; stdin_is_terminal() { return 0; }; is_interactive && echo yes || echo no")"
requests_before="$(wc -l < /tmp/dashboard/requests.jsonl)"
none_exit="$(printf '3\n' | env -u STORAGE_JOIN_NAME bash -c "source $join; stdin_is_terminal() { return 0; }; main" > /tmp/join.out 2>&1; echo $?)"
check "answering none: exit code" 0 "$none_exit"
check_match "answering none: says so" "does not join the storage network" "$(cat /tmp/join.out)"
check "answering none: the dashboard is not asked" "$requests_before" "$(wc -l < /tmp/dashboard/requests.jsonl)"

echo "The three questions, answered from scripted input:"
echo Running > /run/fake-tailscale/state
mkdir -p /vol/files /vol/more && chown finn:finn /vol/files
choices() {
    printf '%s' "$1" | env -u STORAGE_JOIN_NAME bash -c "source $join
        if ask_choices; then echo \"chose \$join_kind \$join_root \$join_threshold keep_all=\$allow_keep_all\"; else echo 'chose nothing'; fi" > /tmp/choices.out 2>&1
    tail -n 1 /tmp/choices.out
}
check "a drive root at 70, joining" "chose drive /vol 70 keep_all=" "$(choices $'1\n/vol\n70\ny\n')"
check_match "the node question lists the three kinds" "1\) a drive root.*2\) a folder.*3\) none: this device does not join the storage network" "$(tr '\n' ' ' < /tmp/choices.out)"
check_match "the threshold question names the bands" "threshold, 0 to 100 \(essential 80\+, working 50\+, archive 1\+, 0 keeps everything\) \[50\]" "$(cat /tmp/choices.out)"
check_match "and the chosen one is named" "threshold 70, keeps essential and working" "$(cat /tmp/choices.out)"
check "none is the default when the data root is no drive root" "chose nothing" "$(choices $'\n')"
check "a drive root that is not one is asked again" "chose drive /vol 50 keep_all=" "$(choices $'1\n/data\n/vol\n\n\n')"
check_match "saying why" "/data is not a drive root.*choose it as a folder" "$(cat /tmp/choices.out)"
check "a folder at 0, confirmed on the second try" "chose folder /vol/files 0 keep_all=1" "$(choices $'2\n/vol/files\n0\nn\n0\ny\n\n')"
check_match "0 asks to confirm keeping everything" "threshold 0 keeps EVERYTHING the storage network holds, backups and archives included. Keep everything\? \[y/N\]" "$(cat /tmp/choices.out)"
check_match "and a no keeps the threshold unchanged" "the threshold was not changed" "$(cat /tmp/choices.out)"
check_match "and a yes names what it keeps" "threshold 0, keeps EVERYTHING, backups included" "$(cat /tmp/choices.out)"
check "a threshold outside 0 to 100 is asked again" "chose folder /vol/files 80 keep_all=" "$(choices $'2\n/vol/files\n101\nhigh\n80\n\n')"
check_match "saying why" "a whole number from 0 to 100, not '101'.*not 'high'" "$(tr '\n' ' ' < /tmp/choices.out)"
check "a folder that is relative, missing or a drive root is asked again" "chose folder /vol/files 50 keep_all=" "$(choices $'2\nfiles\n/vol/nothing\n/vol\n/vol/files/\n\n\n')"
check_match "saying why" "an absolute path below /.*/vol/nothing does not exist.*/vol is a drive root" "$(tr '\n' ' ' < /tmp/choices.out)"
check "join answered no" "chose nothing" "$(choices $'1\n/vol\n\nn\n')"
check_match "says how to join later" "not joining; run this again to join" "$(cat /tmp/choices.out)"
echo NeedsLogin > /run/fake-tailscale/state
check "join defaults to no without a key or the tailnet" "chose nothing" "$(choices $'1\n/vol\n\n\n')"
check_match "saying why" "no Tailscale key" "$(cat /tmp/choices.out)"
echo Running > /run/fake-tailscale/state
mkdir -p /vol2/.storage && printf '[node]\nid = "beef"\nname = "old"\nkind = "drive"\nthreshold = 80\n' > /vol2/.storage/node.toml
check "an existing node keeps its threshold, unasked" "chose drive /vol2 50 keep_all=" "$(choices $'1\n/vol2\n\n')"
check_match "and says so" "/vol2/.storage/node.toml keeps its threshold, 80" "$(cat /tmp/choices.out)"
check "input that ends: exit code" 1 "$(printf '2\n' | env -u STORAGE_JOIN_NAME bash -c "source $join; ask_choices" > /tmp/choices.out 2>&1; echo $?)"
check_match "says what it waited for" "no answer to: the folder that becomes the storage node" "$(cat /tmp/choices.out)"

echo "A folder node is listed in its volume's index:"
register() { env -u STORAGE_JOIN_NAME bash -c "source $join; join_kind=folder; use_root $1; register_folder_node"; }
check_match "listed" "listed files in /vol/.storage/nodes.toml" "$(register /vol/files)"
check "the index" 'paths = ["files"]' "$(cat /vol/.storage/nodes.toml)"
check "listing it again changes nothing" "" "$(register /vol/files)"
register /vol/more > /dev/null
check "a second folder is added to it" 'paths = ["files", "more"]' "$(cat /vol/.storage/nodes.toml)"

echo "Nested nodes are refused, and nothing is written:"
mkdir -p /vol/files/inner /vol2/sub && chown finn:finn /vol/files/inner /vol2/sub
check "a folder inside a listed folder node: exit code" 1 "$(STORAGE_JOIN_ROOT=/vol/files/inner STORAGE_JOIN_KIND=folder run_join)"
check_match "says why" "/vol/files/inner and /vol/files are nested; a folder node cannot hold another" "$(cat /tmp/join.out)"
check "and writes nothing" false "$([[ -e /vol/files/inner/.storage ]] && echo true || echo false)"
check "a folder node at a drive root: exit code" 1 "$(STORAGE_JOIN_ROOT=/vol STORAGE_JOIN_KIND=folder run_join)"
check_match "says a drive root is no folder" "/vol is a drive root" "$(cat /tmp/join.out)"
mkdir -p /vol/outer/in && register /vol/outer/in > /dev/null
check "a folder holding a listed folder node: exit code" 1 "$(STORAGE_JOIN_ROOT=/vol/outer STORAGE_JOIN_KIND=folder run_join)"
check_match "says why" "/vol/outer and /vol/outer/in are nested" "$(cat /tmp/join.out)"
check "a folder on a drive node's volume: exit code" 1 "$(STORAGE_JOIN_ROOT=/vol2/sub STORAGE_JOIN_KIND=folder run_join)"
check_match "says why" "the volume at /vol2 is a drive node" "$(cat /tmp/join.out)"
check "a drive node over listed folder nodes: exit code" 1 "$(STORAGE_JOIN_ROOT=/vol run_join)"
check_match "says why" "/vol/.storage/nodes.toml lists folder nodes.*cannot be a drive node" "$(cat /tmp/join.out)"
check "and writes no node file" false "$([[ -e /vol/.storage/node.toml ]] && echo true || echo false)"

echo "Joining a folder node end to end:"
mkdir -p /vol/node2 && chown finn:finn /vol/node2
check "exit code" 0 "$(STORAGE_JOIN_ROOT=/vol/node2 STORAGE_JOIN_KIND=folder STORAGE_JOIN_NAME=p53-files run_join)"
sed 's/^/    | /' /tmp/join.out
check_match "node file" 'kind *= "folder"' "$(cat /vol/node2/.storage/node.toml)"
check "listed in the index" 'paths = ["files", "more", "outer/in", "node2"]' "$(cat /vol/.storage/nodes.toml)"
check "the second run: exit code" 0 "$(STORAGE_JOIN_ROOT=/vol/node2 STORAGE_JOIN_KIND=folder STORAGE_JOIN_NAME=p53-files run_join)"
check_match "changes nothing" "already joined; nothing changed" "$(cat /tmp/join.out)"
check "and lists it once" 'paths = ["files", "more", "outer/in", "node2"]' "$(cat /vol/.storage/nodes.toml)"

echo ""
echo "join (linux): $passed passed, $failed failed"
[[ "$failed" -eq 0 ]]
