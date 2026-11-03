#!/bin/sh
# storage-connections <dashboard> <node id> <syncthing home> [<listen port>]: the start step
# (ExecStartPre) of a joined Linux device's Syncthing unit, which storage-join.sh installs. Fetches the
# node's entry from the dashboard's GET /api/connections/node/<node id>, keeps it as connections.json
# in the home, and writes its options and listen addresses into config.xml before Syncthing starts,
# each tcp and quic listen address on the device's own port (the dashboard assumes 22000 for every
# joined device and leaves the real one to this step). A dashboard that does not answer within 10 s
# leaves the kept copy in use; without a copy nothing changes. Validated by
# the same connection-profile.jq as images/nodes/apply-connections.sh, which the join installs beside
# this step. Always exits 0, so it never stops the start.
set -u

dashboard=${1%/}
node=$2
syncthing_home=$3
listen_port=${4:-}
step_folder=$(dirname "$0")
kept="$syncthing_home/connections.json"
config="$syncthing_home/config.xml"

log() { echo "storage-connections $node: $*" >&2; }

has_profile_checks() { [ -f "$step_folder/connection-profile.jq" ] || [ -f "$step_folder/../images/nodes/connection-profile.jq" ]; }

fetch_entry() {
    fetched=$(mktemp "$syncthing_home/.connections.XXXXXX") || return 0
    if curl -fsS -m 10 -o "$fetched" "$dashboard/api/connections/node/$node" 2> /dev/null && jq -e 'type == "object"' "$fetched" > /dev/null 2>&1; then
        mv -f "$fetched" "$kept"
    else
        rm -f "$fetched"
        log "the dashboard at $dashboard gave no entry; using the kept copy, if any"
    fi
}

# One line per setting: "scalar<TAB>name<TAB>value", or "list<TAB>name" followed by its
# "item<TAB>name<TAB>value" lines; values are XML-escaped.
wanted_settings() {
    jq -r -L "$step_folder" -L "$step_folder/../images/nodes" --arg port "$listen_port" '
        include "connection-profile";
        def escaped: tostring | gsub("&"; "&amp;") | gsub("<"; "&lt;") | gsub(">"; "&gt;") | gsub("\t"; "&#9;") | gsub("\n"; "&#10;") | gsub("\r"; "&#13;");
        def list($name; $values): "list\t\($name)", ($values[] | "item\t\($name)\t\(escaped)");
        def on_own_port: if type == "string" and ($port | test("^[0-9]+$")) and test("^(tcp|quic)[46]?://")
            then sub(":[0-9]+(?<tail>([/?].*)?)$"; ":\($port)\(.tail)") else . end;
        select(type == "object")
        | if .listenAddresses | type == "array" then .listenAddresses |= map(on_own_port) else . end
        | profile_settings | to_entries[]
        | if .key == "listenAddresses" then list("listenAddress"; .value)
          elif .key == "globalAnnounceServers" then list("globalAnnounceServer"; .value)
          else "scalar\t\(.key)\t\(.value | escaped)" end' "$kept"
}

# Syncthing writes one element per line, so <options> is edited line by line: a listed name's
# elements are replaced where the first one stood, a scalar's value in place, and anything missing
# is added before </options>.
edit_options() {
    awk -F '\t' '
        FNR == NR {
            if ($1 == "scalar") { scalar[$2] = $3; scalars[++scalar_count] = $2 }
            else if ($1 == "list") { listed[$2] = 1; lists[++list_count] = $2; items[$2] = 0 }
            else if ($1 == "item") { items[$2]++; item[$2, items[$2]] = $3 }
            next
        }
        function emit_list(name, indent,    index_) {
            for (index_ = 1; index_ <= items[name]; index_++) print indent "<" name ">" item[name, index_] "</" name ">"
            emitted[name] = 1
        }
        /^[ \t]*<options>[ \t]*$/ { in_options = 1; options_indent = $0; sub(/<.*/, "", options_indent); child_indent = options_indent "    "; print; next }
        in_options && /^[ \t]*<\/options>/ {
            for (i = 1; i <= list_count; i++) if (!(lists[i] in emitted)) emit_list(lists[i], child_indent)
            for (i = 1; i <= scalar_count; i++) if (!(scalars[i] in seen)) print child_indent "<" scalars[i] ">" scalar[scalars[i]] "</" scalars[i] ">"
            in_options = 0; print; next
        }
        in_options && match($0, /^[ \t]*<[A-Za-z]+[ \/>]/) {
            indent = $0; sub(/<.*/, "", indent)
            name = substr($0, length(indent) + 2); sub(/[ \/>].*/, "", name)
            if (name in listed) { if (!(name in emitted)) emit_list(name, indent); next }
            if (name in scalar) { print indent "<" name ">" scalar[name] "</" name ">"; seen[name] = 1; next }
        }
        { print }' "$1" "$config"
}

apply_kept() {
    [ -f "$kept" ] && [ -f "$config" ] || return 0
    settings=$(mktemp) || return 0
    edited=$(mktemp "$syncthing_home/.config.XXXXXX") || { rm -f "$settings"; return 0; }
    if wanted_settings > "$settings" 2> /dev/null && [ -s "$settings" ] && edit_options "$settings" > "$edited" && grep -q '</configuration>' "$edited"; then
        if [ "$(cksum < "$edited")" = "$(cksum < "$config")" ]; then rm -f "$edited"
        else mv -f "$edited" "$config" && log "applied the connection profile"; fi
    else
        rm -f "$edited"
    fi
    rm -f "$settings"
}

fetch_entry
if has_profile_checks; then apply_kept; else log "connection-profile.jq is missing beside the script; nothing applied"; fi
exit 0
