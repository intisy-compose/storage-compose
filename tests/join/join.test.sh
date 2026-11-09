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

device_patch() { curl -fsS -X PATCH -H "X-API-Key: $(api_key_of /data/.storage/syncthing)" -H "Content-Type: application/json" -d "$2" "http://127.0.0.1:8384$1"; }

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
    dashboard_pid=$!
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
step=/usr/local/lib/storage-join/storage-connections
node_id="device-$(printf '%s' "${device_id:0:7}" | tr '[:upper:]' '[:lower:]')"
check "the unit runs the connections step before syncthing" "-$step http://127.0.0.1:$dashboard_port $node_id /data/.storage/syncthing 22000" "$(sed -n 's/^ExecStartPre=//p' /etc/systemd/system/storage-syncthing.service | head -n 1)"
check "the step is the join's own, installed beside the unit" "$(sha256sum < /join/storage-connections.sh)" "$(sha256sum < "$step")"
check "with the nodes image's profile checks beside it, one source for both" "$(sha256sum < /images/nodes/connection-profile.jq)" "$(sha256sum < "${step%/*}/connection-profile.jq")"

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

echo "The layered sync on the joined device:"
file_node_id="$(sed -n 's/^id *= *"\(.*\)"/\1/p' /data/.storage/node.toml)"
tick() { bash /usr/local/lib/storage-join/storage-layout tick "http://127.0.0.1:$dashboard_port" "$file_node_id" /data/.storage/syncthing /data 8384 > /tmp/tick.out 2>&1; echo $?; }
answer_with() { mkdir -p /tmp/dashboard/layered; echo "$1" > "/tmp/dashboard/layered/$file_node_id.json"; }
config_of() { device_api "/rest/config/folders/$1"; }
check "the unit runs the layout step before syncthing" "-/usr/local/lib/storage-join/storage-layout start /data/.storage/syncthing /data $file_node_id" "$(sed -n 's/^ExecStartPre=//p' /etc/systemd/system/storage-syncthing.service | tail -n 1)"
check "the timer is installed" "true" "$([[ -f /etc/systemd/system/storage-layout.timer && -f /etc/systemd/system/storage-layout.service ]] && echo true || echo false)"
check_match "the timer is enabled" "enable --now storage-layout.timer" "$(cat /run/fake-systemd/calls)"
check "the steps are installed" "true" "$([[ -x /usr/local/lib/storage-join/storage-layout && -x /usr/local/lib/storage-join/handoff.sh && -x /usr/local/lib/storage-join/handoff-probe.sh ]] && echo true || echo false)"

printf '[node]\nid        = "%s"\nname      = "p53"\nkind      = "drive"\nthreshold = 50\nassigned  = []\napply     = true\n' "$file_node_id" > /data/.storage/node.toml
chown finn:finn /data/.storage/node.toml
check "a dashboard with nothing to say: exit code" 0 "$(tick)"
check "and takes apply out on any doubt" "" "$(sed -n '/^apply/p' /data/.storage/node.toml)"
report_lines="$(wc -l < /tmp/dashboard/layered.jsonl)"
check_match "the report names the device" '"deviceId": "[A-Z0-9-]+"' "$(tail -n 1 /tmp/dashboard/layered.jsonl)"
check_match "the report lists its folders" '"id": "documents"' "$(tail -n 1 /tmp/dashboard/layered.jsonl)"
check_match "the report carries the disk" '"totalBytes": [0-9]+' "$(tail -n 1 /tmp/dashboard/layered.jsonl)"

answer_with '{"schema":1,"nodeId":"'"$file_node_id"'","apply":false,"nodeFile":{"action":"withdraw","reason":"report only"},"ops":[{"op":"type","folderId":"documents","type":"sendonly"}],"contract":{"schema":1,"nodeId":"'"$file_node_id"'","apply":false,"cluster":false,"entries":[]}}'
check "a report-mode answer: exit code" 0 "$(tick)"
check "changes nothing in Syncthing" "sendreceive" "$(config_of documents | jq -r .type)"
check "and writes no kept change" "false" "$([[ -f /data/.storage/syncthing/layered-ops.json ]] && echo true || echo false)"
check "and keeps the contract" "$file_node_id" "$(jq -r .nodeId "/data/.storage/syncthing/handoff/$file_node_id.json")"
check "and the executor refused it" "the contract is not in apply mode" "$(jq -r .refused "/data/.storage/syncthing/handoff/$file_node_id.result.json")"

syncthing generate --home=/tmp/other-device --no-port-probing > /dev/null
other="$(syncthing device-id --home=/tmp/other-device)"
applying='{"schema":1,"nodeId":"'"$file_node_id"'","apply":true,"nodeFile":{"action":"follow","policy":{"threshold":60,"assigned":["Pictures"],"access":"open"}},"contract":{"schema":1,"nodeId":"'"$file_node_id"'","writtenAt":"'"$(date -u +%FT%TZ)"'","apply":true,"cluster":false,"quietMinutes":10,"entries":[],"waiting":[],"notes":[]},"ops":[
{"op":"addDevice","deviceId":"'"$other"'","name":"other"},
{"op":"addFolder","id":"newone","label":"New one","path":"/data/New","type":"sendonly","devices":["'"$(device_api /rest/system/status | jq -r .myID)"'"],"versioning":null,"ignores":["// layered sync begin","#include .stignore-handoff","/.stignore-handoff","// layered sync end"]},
{"op":"addFolder","id":"outside","label":"x","path":"/elsewhere","type":"sendonly","devices":[],"ignores":[]},
{"op":"type","folderId":"documents","type":"sendonly"}]}'
answer_with "$applying"
check "an applying answer that stops at a bad change: exit code" 0 "$(tick)"
check "the node file followed" "threshold = 60" "$(sed -n '/^threshold/p' /data/.storage/node.toml)"
check_match "assigned written" 'assigned = \["Pictures"\]' "$(cat /data/.storage/node.toml)"
check_match "apply written" 'apply = true' "$(cat /data/.storage/node.toml)"
check_match "identity kept" "name      = \"p53\"" "$(cat /data/.storage/node.toml)"
check_match "syncthing was restarted" "restart storage-syncthing.service" "$(tail -n 3 /run/fake-systemd/calls)"
wait_api() { for _ in $(seq 1 60); do device_api /rest/system/status > /dev/null 2>&1 && return; sleep 1; done; }
wait_api
check "the new folder arrived send-only" "sendonly" "$(config_of newone | jq -r .type)"
check "at the path inside the root" "/data/New" "$(config_of newone | jq -r .path)"
check_match "with its ignores before the first scan" "#include .stignore-handoff" "$(cat /data/New/.stignore)"
check "and its hand-off list" "true" "$([[ -f /data/New/.stignore-handoff ]] && echo true || echo false)"
check "and Syncthing reads them" "" "$(device_api "/rest/db/ignores?folder=newone" | jq -r '.error // empty')"
check "the device was added" "other" "$(device_api "/rest/config/devices/$other" | jq -r .name)"
check_match "a change outside the root stops the list" "outside the node's root|not inside the node's root" "$(cat /run/fake-systemd/storage-syncthing.service.pre.log)"
check "so the later change was not made" "sendreceive" "$(config_of documents | jq -r .type)"
check "the kept changes are gone" "false" "$([[ -f /data/.storage/syncthing/layered-ops.json ]] && echo true || echo false)"
check "and the contract ran under apply" "null" "$(jq -r .refused "/data/.storage/syncthing/handoff/$file_node_id.result.json")"

applying='{"schema":1,"nodeId":"'"$file_node_id"'","apply":true,"nodeFile":{"action":"follow","policy":{"threshold":60,"assigned":["Pictures"],"access":"open"}},"contract":null,"ops":[
{"op":"paused","folderId":"documents","paused":true},
{"op":"ignores","folderId":"documents","lines":["// layered sync begin","/.stignore-handoff","// layered sync end","#kept"]},
{"op":"ensureList","folderId":"documents"},
{"op":"ignores","folderId":"documents","lines":["// layered sync begin","#include .stignore-handoff","/.stignore-handoff","// layered sync end","#kept"]},
{"op":"versioning","folderId":"documents","versioning":{"type":"staggered","params":{"maxAge":"7776000"},"cleanupIntervalS":3600,"fsPath":"","fsType":"basic"}},
{"op":"devices","folderId":"documents","devices":["'"$(device_api /rest/system/status | jq -r .myID)"'","'"$other"'"]},
{"op":"type","folderId":"documents","type":"sendonly"}]}'
answer_with "$applying"
check "the next round's changes: exit code" 0 "$(tick)"
wait_api
config="$(config_of documents)"
check "the folder was paused" "true" "$(jq -r .paused <<< "$config")"
check "and turned send-only" "sendonly" "$(jq -r .type <<< "$config")"
check "versioning written" "staggered 7776000" "$(jq -r '"\(.versioning.type) \(.versioning.params.maxAge)"' <<< "$config")"
check_match "shared with the planned device" "$other" "$(jq -r '[.devices[].deviceID] | join(" ")' <<< "$config")"
check_match "the ignores written" "#include .stignore-handoff" "$(device_api "/rest/db/ignores?folder=documents" | jq -r '.ignore | join(" ")')"
check_match "with the node's own line kept below" "#kept" "$(cat /data/Documents/.stignore)"
check "the list made in order" "true" "$([[ -f /data/Documents/.stignore-handoff ]] && echo true || echo false)"

printf '{"keptAt":1,"ops":[{"op":"type","folderId":"documents","type":"sendreceive"}]}\n' > /data/.storage/syncthing/layered-ops.json
chown finn:finn /data/.storage/syncthing/layered-ops.json
bash /usr/local/lib/storage-join/storage-layout start /data/.storage/syncthing /data "$file_node_id" 2> /tmp/start.out
check_match "kept changes too old are dropped" "s old; dropped" "$(cat /tmp/start.out)"
sed -i '/^apply/d' /data/.storage/node.toml
printf '{"keptAt":%s,"ops":[{"op":"type","folderId":"documents","type":"sendreceive"}]}\n' "$(date +%s)" > /data/.storage/syncthing/layered-ops.json
bash /usr/local/lib/storage-join/storage-layout start /data/.storage/syncthing /data "$file_node_id" 2> /tmp/start.out
check_match "kept changes without the node file's apply are dropped" "does not say apply = true" "$(cat /tmp/start.out)"
check "and leave config.xml as it was" "sendonly" "$(grep -o '<folder id="documents"[^>]*' /data/.storage/syncthing/config.xml | sed -n 's/.* type="\([a-z]*\)".*/\1/p')"



echo "The layered sync's bounds and escapes:"
layout_script=/usr/local/lib/storage-join/storage-layout
restarts() { grep -c "restart storage-syncthing.service" /run/fake-systemd/calls; }
my_id="$(device_api /rest/system/status | jq -r .myID)"
failing='{"schema":1,"nodeId":"'"$file_node_id"'","apply":true,"nodeFile":{"action":"follow","policy":{"threshold":60,"assigned":[],"access":"open"}},"contract":null,"ops":[{"op":"addFolder","id":"never","label":"x","path":"/elsewhere/again","type":"sendonly","devices":[],"ignores":[]}]}'
answer_with "$failing"
before=$(restarts)
check "a failing change restarts once: exit code" 0 "$(tick)"
wait_api
first=$(restarts)
check "and the restart was made" $((before + 1)) "$first"
check "the same change does not restart again: exit code" 0 "$(tick)"
second=$(restarts)
check "no second restart for the same change" "$first" "$second"
check_match "says so once" "already tried" "$(cat /tmp/tick.out)"
check "a third round: exit code" 0 "$(tick)"
check "still no restart" "$second" "$(restarts)"
check "and says nothing more" "0" "$(grep -c 'already tried' /tmp/tick.out)"
STORAGE_LAYOUT_NOW=$(( $(date +%s) + 2000 )) tick > /dev/null
check "after the back-off it is tried again" $((second + 1)) "$(restarts)"
wait_api

mkdir -p /tmp/stubs
printf '#!/bin/sh\ncp /data/.storage/syncthing/layered-ops.json /tmp/kept.json\n' > /tmp/stubs/systemctl
chmod +x /tmp/stubs/systemctl
cp "/usr/local/lib/storage-join/handoff.sh" /tmp/handoff.keep
printf '#!/bin/bash\nsleep 60\n' > /usr/local/lib/storage-join/handoff.sh
slow='{"schema":1,"nodeId":"'"$file_node_id"'","apply":true,"nodeFile":{"action":"follow","policy":{"threshold":60,"assigned":[],"access":"open"}},"contract":{"schema":1,"nodeId":"'"$file_node_id"'","apply":false,"cluster":false,"entries":[]},"ops":[{"op":"paused","folderId":"documents","paused":false}]}'
answer_with "$slow"
started=$(date +%s)
PATH=/tmp/stubs:$PATH STORAGE_LAYOUT_HANDOFF_SECONDS=2 tick > /dev/null
ended=$(date +%s)
cp /tmp/handoff.keep /usr/local/lib/storage-join/handoff.sh
check "a hand-off past its limit is cut off" true "$([[ $((ended - started)) -lt 20 ]] && echo true || echo false)"
kept_at=$(jq -r .keptAt /tmp/kept.json)
check "the kept changes carry the time the dashboard answered, not the end of the run" true "$([[ $((kept_at - started)) -le 1 ]] && echo true || echo false)"

answer_with '{"schema":1,"nodeId":"'"$file_node_id"'","apply":false,"nodeFile":{"action":"withdraw","reason":"x"},"ops":[],"contract":null}'
echo '{"schema":1}' > "/data/.storage/syncthing/handoff/$file_node_id.json"
check "an answer with no contract: exit code" 0 "$(tick)"
check "deletes the kept one" false "$([[ -f "/data/.storage/syncthing/handoff/$file_node_id.json" ]] && echo true || echo false)"

mkdir -p /tmp/fake/.storage/syncthing
printf '[node]\nid = "abcd"\nname = "x"\nkind = "drive"\nthreshold = 5\n' > /tmp/fake/.storage/node.toml
printf '<configuration>\n<options></options>\n</configuration>\n' > /tmp/fake/.storage/syncthing/config.xml
sourced() { bash -c "source $layout_script; syncthing_home=/tmp/fake/.storage/syncthing; root=/tmp/fake; gui=http://x; $1"; }
sourced 'follow_policy "$(cat /tmp/policy.json)"' < /dev/null 2> /dev/null; true
printf '%s' '{"threshold":10,"assigned":["a\"b"],"access":"o\"pen"}' > /tmp/policy.json
sourced 'follow_policy "$(cat /tmp/policy.json)"'
check 'an access value is escaped into TOML' 'access = "o\"pen"' "$(sed -n '/^access/p' /tmp/fake/.storage/node.toml)"
printf '%s' '{"threshold":"not a number","assigned":[],"access":"open"}' > /tmp/policy.json
sourced 'follow_policy "$(cat /tmp/policy.json)"'
check 'a threshold that is no number changes nothing' 'threshold = 10' "$(sed -n '/^threshold/p' /tmp/fake/.storage/node.toml)"
printf '%s' '{"op":"addDevice","deviceId":"X\"Y&Z","name":"a<b"}' > /tmp/op.json
sourced 'work_dir=$(mktemp -d); write_programs; apply_op "$(cat /tmp/op.json)"'
check_match 'an id and a name are escaped into config.xml' 'id="X&quot;Y&amp;Z" name="a&lt;b"' "$(cat /tmp/fake/.storage/syncthing/config.xml)"
printf '%s' '{"op":"type","folderId":"documents","type":"some\"thing"}' > /tmp/op.json
check 'a type it does not know is refused' 1 "$(sourced 'work_dir=$(mktemp -d); write_programs; apply_op "$(cat /tmp/op.json)"' > /dev/null 2>&1; echo $?)"
report_stub='api() { case $1 in */db/browse*) printf "%s" "$BROWSE_ANSWER";; */db/file*) printf "{\"local\":{\"type\":\"FILE_INFO_TYPE_FILE\"}}";; esac; }; listing_problems=/tmp/listing.txt; : > "$listing_problems"'
BROWSE_ANSWER='[{"name":"a","type":"FILE_INFO_TYPE_FILE","modTime":"not a date"}]' check "a modification time that does not parse counts as not settled" "" "$(BROWSE_ANSWER='[{"name":"a","type":"FILE_INFO_TYPE_FILE","modTime":"not a date"}]' sourced "$report_stub; report_files docs 5")"
check "a listing that failed is said" "docs: it could not be listed" "$(BROWSE_ANSWER='not json' sourced "$report_stub; report_files docs 5"; cat /tmp/listing.txt)"


echo "Restarts, order and the report's listing:"
printf '#!/bin/sh\nexit 1\n' > /tmp/stubs/systemctl
failing2='{"schema":1,"nodeId":"'"$file_node_id"'","apply":true,"nodeFile":{"action":"follow","policy":{"threshold":60,"assigned":[],"access":"open"}},"contract":null,"ops":[{"op":"paused","folderId":"documents-github","paused":false}]}'
rm -f /data/.storage/syncthing/layered-restart.json
answer_with "$failing2"
printf '#!/bin/sh\necho attempt >> /tmp/attempts\nexit 1\n' > /tmp/stubs/systemctl
: > /tmp/attempts
attempts() { wc -l < /tmp/attempts | tr -d ' '; }
PATH=/tmp/stubs:$PATH tick > /dev/null
check "a failed restart is tried" 1 "$(attempts)"
check "and recorded as failed" true "$(jq -r .failed /data/.storage/syncthing/layered-restart.json)"
PATH=/tmp/stubs:$PATH tick > /dev/null
check "it is not tried again every minute" 1 "$(attempts)"
PATH=/tmp/stubs:$PATH STORAGE_LAYOUT_NOW=$(( $(date +%s) + 301 )) tick > /dev/null
check "but soon after the short back-off, not the long one" 2 "$(attempts)"
rm -f /data/.storage/syncthing/layered-restart.json /data/.storage/syncthing/layered-ops.json
printf '#!/bin/sh\necho attempt >> /tmp/attempts\nexit 0\n' > /tmp/stubs/systemctl
: > /tmp/attempts
PATH=/tmp/stubs:$PATH tick > /dev/null
PATH=/tmp/stubs:$PATH tick > /dev/null
check "a restart that consumed nothing backs off the same way" 1 "$(attempts)"
rm -f /data/.storage/syncthing/layered-restart.json /data/.storage/syncthing/layered-ops.json
printf '#!/bin/sh\necho restart >> /tmp/order\nrm -f /data/.storage/syncthing/layered-ops.json\n' > /tmp/stubs/systemctl
cp /usr/local/lib/storage-join/handoff.sh /tmp/handoff.keep
printf '#!/bin/bash\necho handoff >> /tmp/order\n' > /usr/local/lib/storage-join/handoff.sh
: > /tmp/order
chmod 666 /tmp/order
contract_order='{"schema":1,"nodeId":"'"$file_node_id"'","apply":true,"nodeFile":{"action":"follow","policy":{"threshold":60,"assigned":[],"access":"open"}},"contract":{"schema":1,"nodeId":"'"$file_node_id"'","apply":false,"cluster":false,"entries":[]},"ops":[{"op":"paused","folderId":"documents","paused":false}]}'
answer_with "$contract_order"
PATH=/tmp/stubs:$PATH tick > /dev/null
cp /tmp/handoff.keep /usr/local/lib/storage-join/handoff.sh
check "the restart comes before the hand-off run" "restart handoff" "$(tr '\n' ' ' < /tmp/order | sed 's/ $//')"
check "and only then the back-off is recorded" true "$([[ -f /data/.storage/syncthing/layered-restart.json ]] && echo true || echo false)"
PATH=/tmp/stubs:$PATH tick > /dev/null
PATH=/tmp/stubs:$PATH tick > /dev/null
check_match "a suppressed restart is a problem of the node" '"listingProblems": \["[^]]*already tried' "$(tail -n 1 /tmp/dashboard/layered.jsonl)"
rm -f /data/.storage/syncthing/layered-restart.json

walk_stub='api() { case $1 in *prefix=sub*) printf "[{\"name\":\"b\",\"type\":\"FILE_INFO_TYPE_FILE\",\"modTime\":\"2026-01-01T00:00:00Z\"},{\"name\":\"c\",\"type\":\"FILE_INFO_TYPE_FILE\",\"modTime\":\"2026-01-01T00:00:00Z\"}]";; */db/browse*levels=0*) printf "[{\"name\":\"sub\",\"type\":\"FILE_INFO_TYPE_DIRECTORY\"}]";; */db/browse*) printf "[]";; */db/file*) printf "{\"local\":{\"type\":\"FILE_INFO_TYPE_FILE\"}}";; esac; }; listing_problems=/tmp/listing.txt; : > "$listing_problems"'
rm -f /tmp/fake/.storage/syncthing/layered-cursor-*
check "a listing walks one level at a time" "sub/b" "$(sourced "$walk_stub; report_files docs 1" | jq -r .path)"
check "and the next report goes on from there" "sub/c" "$(sourced "$walk_stub; report_files docs 1" | jq -r .path)"
check "a report past the end has nothing" "" "$(sourced "$walk_stub; report_files docs 1" | jq -r .path)"
check "and the one after starts over" "sub/b" "$(sourced "$walk_stub; report_files docs 1" | jq -r .path)"
ignores_stub='api() { case $1 in */db/ignores*) printf "{\"error\":\"could not be read\",\"ignore\":null}";; */db/status*) printf "{}";; esac; }'
check "a list Syncthing says it could not read is unknown" "null" "$(sourced "$ignores_stub; report_folder '{\"id\":\"x\",\"path\":\"/p\",\"type\":\"sendonly\",\"label\":\"\",\"paused\":false,\"devices\":[],\"versioning\":{}}'" | jq -c .ignores)"

echo "The connections step at every start:"
entry="/tmp/dashboard/connections/$node_id.json"
mkdir -p /tmp/dashboard/connections
restart_device() {
    systemctl restart storage-syncthing.service
    for _ in $(seq 1 60); do device_api /rest/system/status > /dev/null 2>&1 && return; sleep 1; done
}
options_now() { device_api /rest/config/options | jq -c '{listen: .listenAddresses, global: .globalAnnounceEnabled, relays: .relaysEnabled, nat: .natEnabled, send: .maxSendKbps}'; }
tailnet_only='{"listen":["tcp://127.0.0.1:22000"],"global":false,"relays":false,"nat":false,"send":0}'
on_profile='{"listen":["tcp://0.0.0.0:22000","quic://0.0.0.0:22000"],"global":true,"relays":false,"nat":false,"send":100}'
printf '{"options": {"natEnabled": true}, "listenAddresses": ["tcp://0.0.0.0:22000", "udp://0.0.0.0:22000"], "deviceAddresses": {}}' > "$entry"
restart_device
check "a listen list with one invalid address keeps the current addresses" '{"listen":["tcp://127.0.0.1:22000"],"global":false,"relays":false,"nat":true,"send":0}' "$(options_now)"
printf '{"options": {"globalAnnounceEnabled": true, "natEnabled": false, "maxSendKbps": 100, "relaysEnabled": "yes"}, "listenAddresses": ["tcp://0.0.0.0:22000", "quic://0.0.0.0:22000"], "deviceAddresses": {}}' > "$entry"
restart_device
check "the dashboard's entry is applied before syncthing starts, a wrongly typed option left out" "$on_profile" "$(options_now)"
check "and kept in the node's home" "$(jq -c . "$entry")" "$(jq -c . /data/.storage/syncthing/connections.json 2> /dev/null)"
check "owned by the node's owner" finn "$(stat -c %U /data/.storage/syncthing/connections.json 2> /dev/null)"
cp -a /data/.storage/syncthing /tmp/port-home && rm -f /tmp/port-home/connections.json
printf '{"options": {}, "listenAddresses": ["tcp://0.0.0.0:22000", "quic://[::]:22000", "tcp4://0.0.0.0:22000", "tcp6://[::]:22000", "quic4://0.0.0.0:22000", "quic6://[::]:22000", "relay://10.0.0.1:22100/?id=RELAY", "dynamic+https://relays.syncthing.net/endpoint"], "deviceAddresses": {}}' > /tmp/dashboard/connections/device-porttst.json
su-exec finn "$step" "http://127.0.0.1:$dashboard_port" device-porttst /tmp/port-home 22001 > /dev/null 2>&1
check "a device joined on 22001 keeps 22001 after the step, relay and pool addresses untouched" \
    "tcp://0.0.0.0:22001,quic://[::]:22001,tcp4://0.0.0.0:22001,tcp6://[::]:22001,quic4://0.0.0.0:22001,quic6://[::]:22001,relay://10.0.0.1:22100/?id=RELAY,dynamic+https://relays.syncthing.net/endpoint" \
    "$(sed -n 's:.*<listenAddress>\(.*\)</listenAddress>.*:\1:p' /tmp/port-home/config.xml | sed 's/&amp;/\&/g' | paste -sd, -)"
kill "$dashboard_pid" && wait "$dashboard_pid" 2> /dev/null
device_patch /rest/config/options "$(jq -n '{listenAddresses: ["tcp://127.0.0.1:22000"], globalAnnounceEnabled: false, maxSendKbps: 0}')" > /dev/null
restart_device
check "an unreachable dashboard uses the kept copy" "$on_profile" "$(options_now)"
start_dashboard
check "the join run again: exit code" 0 "$(run_join)"
check "and keeps the profile, never back to the tailnet only" "$on_profile" "$(options_now)"
kill "$dashboard_pid" && wait "$dashboard_pid" 2> /dev/null
rm -f /data/.storage/syncthing/connections.json
device_patch /rest/config/options "$(jq -n '{listenAddresses: ["tcp://127.0.0.1:22000"], globalAnnounceEnabled: false, maxSendKbps: 0}')" > /dev/null
config_before="$(sha256sum < /data/.storage/syncthing/config.xml)"
restart_device
check "with no copy and no dashboard syncthing starts unchanged" "$tailnet_only" "$(options_now)"
check "its config untouched by the step" "$config_before" "$(sha256sum < /data/.storage/syncthing/config.xml)"
check "and no copy is made up" false "$([[ -e /data/.storage/syncthing/connections.json ]] && echo true || echo false)"
check "the step itself exits 0 without a dashboard" 0 "$(su-exec finn "$step" http://127.0.0.1:1 "$node_id" /data/.storage/syncthing > /dev/null 2>&1; echo $?)"
mkdir -p /tmp/lone-step && cp "$step" /tmp/lone-step/storage-connections
cp -a /tmp/port-home /tmp/lone-home
config_before="$(sha256sum < /tmp/lone-home/config.xml)"
lone_status="$(/tmp/lone-step/storage-connections http://127.0.0.1:1 device-porttst /tmp/lone-home 22002 2> /tmp/lone-step.err; echo $?)"
check "a step without its profile checks applies nothing, says so and still exits 0" \
    "0 1 $config_before" "$lone_status $(grep -c 'connection-profile.jq is missing beside the script; nothing applied' /tmp/lone-step.err) $(sha256sum < /tmp/lone-home/config.xml)"
mkdir -p /tmp/lone-join/join && cp "$join" /join/storage-connections.sh /tmp/lone-join/join/
lone_install="$(STORAGE_JOIN_STEP_DIR=/tmp/lone-join/lib bash -c "source /tmp/lone-join/join/storage-join.sh; install_step" 2>&1; echo "exit $?")"
check_match "a checkout without the profile checks installs the step without them, says so and goes on" \
    "connection-profile.jq is missing from this checkout.*installed /tmp/lone-join/lib/storage-connections.*exit 0" "$(tr '\n' ' ' <<< "$lone_install")"
check "and makes up no profile checks" "true false" "$([[ -x /tmp/lone-join/lib/storage-connections ]] && echo true || echo false) $([[ -e /tmp/lone-join/lib/connection-profile.jq ]] && echo true || echo false)"
start_dashboard
mkdir -p /data5/.storage/syncthing && echo '{"listenAddresses": ["tcp://0.0.0.0:22000"]}' > /data5/.storage/syncthing/connections.json && chown -R finn:finn /data5
bash -c "source $join; use_root /data5; generate_keys" > /dev/null
check "new keys drop the copy kept for the old device ID" false "$([[ -e /data5/.storage/syncthing/connections.json ]] && echo true || echo false)"

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


echo "Leaving:"
check "leaving: exit code" 0 "$(bash "$join" --leave > /tmp/leave.out 2>&1; echo $?)"
check_match "says what it did" "left; the timer, the unit and the steps are gone" "$(cat /tmp/leave.out)"
check_match "it stopped the tick service too" "stop storage-layout.service" "$(cat /run/fake-systemd/calls)"
check "the node file is gone" "false" "$([[ -f /data/.storage/node.toml ]] && echo true || echo false)"
check "the units are gone" "false" "$([[ -f /etc/systemd/system/storage-layout.timer || -f /etc/systemd/system/storage-layout.service || -f /etc/systemd/system/storage-syncthing.service ]] && echo true || echo false)"
check "the steps are gone" "false" "$([[ -e /usr/local/lib/storage-join ]] && echo true || echo false)"
check "the data stays" "kept" "$(cat /data/Documents/letter.txt 2> /dev/null || cat /home/finn/Documents/letter.txt)"
check "leaving twice is fine: exit code" 0 "$(bash "$join" --leave > /tmp/leave.out 2>&1; echo $?)"
check_match "and says so" "nothing to leave" "$(cat /tmp/leave.out)"

echo ""
echo "join (linux): $passed passed, $failed failed"
[[ "$failed" -eq 0 ]]
