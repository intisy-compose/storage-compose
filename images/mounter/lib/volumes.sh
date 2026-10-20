# shellcheck shell=bash
# Drive and folder nodes on the volumes the host mounts at or below /mnt/nodes (NODE_VOLUMES on the
# host). A drive node carries .storage/node.toml at its volume root; a volume holding folder nodes
# lists them in .storage/nodes.toml at its root (paths = ["files"]). Nothing below a root is ever
# searched. Every node found is written to /status/nodes/<id>.json, the registry the dashboard and
# the node Syncthing instances read; a node that went away stays there with present = false.

registry_dir="$status_root/nodes"
registry_warnings="$registry_dir/warnings"

# findmnt -r escapes blanks and the like as \xNN.
volume_roots() {
    [ -d "$node_volumes" ] || return 0
    { echo "$node_volumes"; findmnt -rn -o TARGET | grep "^$node_volumes/" | while read -r target; do printf '%b\n' "$target"; done; } | sort -u
}

volume_warning() { echo "$1" >> "$registry_warnings.new"; }

folder_paths_of() {   # <volume root>: the folder nodes its index lists, one relative path per line
    local index="$1/.storage/nodes.toml" json
    [ -f "$index" ] || return 0
    json=$(node_file_json "$index") || { volume_warning "$index cannot be read"; return 0; }
    jq -r '.paths[]? | select(type == "string")' <<< "$json"
}

is_inside() { [[ $1 == "$2"/* ]]; }   # <path> <other path>

node_space() {   # <path>: {size, used}
    local size='' used=''
    read -r size used < <(df -B1 --output=size,used "$1" 2> /dev/null | tail -n 1)
    jq -nc --arg size "$size" --arg used "$used" '{size: ($size | tonumber? // null), used: ($used | tonumber? // null)}'
}

register_node() {   # <node root> <kind it must have>
    local root=$1 kind=$2 json id
    json=$(node_file_json "$(node_file_of "$root")") || { volume_warning "$(node_file_of "$root") cannot be read"; return 1; }
    id=$(jq -r '.node.id // empty' <<< "$json")
    is_node_id "$id" || { volume_warning "$root: the node file has no valid id (4 lowercase hex)"; return 1; }
    [ "$(jq -r '.node.kind // empty' <<< "$json")" = "$kind" ] ||
        { volume_warning "$root: a node file of kind $(jq -r '.node.kind' <<< "$json") here must be of kind $kind"; return 1; }
    is_node_name "$(jq -r '.node.name // empty' <<< "$json")" || { volume_warning "$root: the node's name must match [a-z0-9-]"; return 1; }
    if grep -qxF "$id" "$registry_dir/seen.new" 2> /dev/null; then volume_warning "$root: node id $id is used twice on this host"; return 1; fi
    echo "$id" >> "$registry_dir/seen.new"
    jq -n --argjson file "$json" --arg root "$root" --arg kind "$kind" --arg updated "$(date -u +%FT%TZ)" --argjson space "$(node_space "$root")" '
        $file.node as $node
        | {id: $node.id, name: $node.name, kind: $kind, threshold: ($node.threshold // 0), assigned: ($node.assigned // []),
           root: $root, present: true, space: $space, syncthing: null, updated: $updated}' |
        write_atomically "$registry_dir/$id.json"
}

register_volume() {   # <volume root>
    local volume=$1 path accepted=()
    if [ -f "$(node_file_of "$volume")" ] && [ -f "$volume/.storage/nodes.toml" ]; then
        volume_warning "$volume is a drive node and lists folder nodes; a node cannot hold another, so the folder nodes are left out"
    fi
    if [ -f "$(node_file_of "$volume")" ]; then register_node "$volume" drive; return; fi
    while IFS= read -r path; do
        [ -n "$path" ] || continue
        case "/$path/" in */../* | */./* | //*) volume_warning "$volume: '$path' in nodes.toml is not a plain relative path"; continue ;; esac
        local inside=
        for other in "${accepted[@]}"; do
            if is_inside "$volume/$path" "$other" || is_inside "$other" "$volume/$path"; then inside=$other; fi
        done
        [ -n "$inside" ] && { volume_warning "$volume/$path and $inside are nested; a folder node cannot hold another"; continue; }
        [ -f "$(node_file_of "$volume/$path")" ] || { volume_warning "$volume/$path is listed in nodes.toml but has no node file"; continue; }
        register_node "$volume/$path" folder && accepted+=("$volume/$path")
    done < <(folder_paths_of "$volume")
}

mark_absent_nodes() {
    local entry id
    for entry in "$registry_dir"/*.json; do
        [ -f "$entry" ] || continue
        id=${entry##*/}; id=${id%.json}
        grep -qxF "$id" "$registry_dir/seen.new" 2> /dev/null && continue
        [[ $(jq -r '.root' "$entry") == "$node_volumes"* ]] || continue
        [ "$(jq -r '.present' "$entry")" = true ] || continue
        jq --arg updated "$(date -u +%FT%TZ)" '.present = false | .updated = $updated' "$entry" | write_atomically "$entry"
        log "node $(jq -r .name "$entry") ($id) is gone"
    done
}

discover_volume_nodes() {
    local volume
    mkdir -p "$registry_dir"
    : > "$registry_dir/seen.new"
    : > "$registry_warnings.new"
    while IFS= read -r volume; do register_volume "$volume"; done < <(volume_roots)
    mark_absent_nodes
    mv "$registry_warnings.new" "$registry_warnings"
    rm -f "$registry_dir/seen.new"
}
