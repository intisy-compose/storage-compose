# shellcheck shell=bash
# The node file, .storage/node.toml: a node's identity and policy, and for an array the whole
# membership on every member, the copy with the highest revision winning. Read and written as JSON
# through jq; the TOML is the subset the file uses (tables, arrays of tables, strings, integers,
# booleans and one-line arrays of strings).

node_file_of() { echo "$1/.storage/node.toml"; }   # <volume or folder root>

# Emits {"p": [path], "v": value} per key, which jq folds into one object.
toml_to_path_values() {
    awk '
        function trim(text) { sub(/^[ \t]+/, "", text); sub(/[ \t\r]+$/, "", text); return text }
        function quoted(path, count,    out, index_) {
            out = ""
            for (index_ = 1; index_ <= count; index_++) out = out (index_ > 1 ? "," : "") (path[index_] ~ /^[0-9]+$/ ? path[index_] : "\"" path[index_] "\"")
            return out
        }
        function literal_to_json(text) { gsub(/\\/, "\\\\", text); gsub(/"/, "\\\"", text); return "\"" text "\"" }
        function array_to_json(text,    out) {
            out = ""
            while (match(text, /\x27[^\x27]*\x27/)) {
                out = out substr(text, 1, RSTART - 1) literal_to_json(substr(text, RSTART + 1, RLENGTH - 2))
                text = substr(text, RSTART + RLENGTH)
            }
            out = out text
            gsub(/,[ \t]*\]$/, "]", out)
            return out
        }
        function value_of(text,    matched) {
            if (match(text, /^"([^"\\]|\\.)*"/)) return substr(text, 1, RLENGTH)
            if (match(text, /^\x27[^\x27]*\x27/)) return literal_to_json(substr(text, 2, RLENGTH - 2))
            if (match(text, /^\[[^]]*\]/)) return array_to_json(substr(text, 1, RLENGTH))
            if (match(text, /^(true|false|[-+]?[0-9][0-9_]*)/)) { matched = substr(text, 1, RLENGTH); gsub(/_/, "", matched); sub(/^\+/, "", matched); return matched }
            return ""
        }
        { line = trim($0) }
        line == "" || line ~ /^#/ { next }
        line ~ /^\[\[[A-Za-z0-9_.-]+\]\]/ {
            name = line; sub(/^\[\[/, "", name); sub(/\]\].*/, "", name)
            count = split(name, table, ".")
            position = tables[name]++
            table[++count] = position
            next
        }
        line ~ /^\[[A-Za-z0-9_.-]+\]/ {
            name = line; sub(/^\[/, "", name); sub(/\].*/, "", name)
            count = split(name, table, ".")
            next
        }
        line ~ /^[A-Za-z0-9_-]+[ \t]*=/ {
            key = line; sub(/[ \t]*=.*/, "", key)
            rest = line; sub(/^[^=]*=[ \t]*/, "", rest)
            value = value_of(rest)
            if (value == "") { print "unreadable value for " key > "/dev/stderr"; failed = 1; next }
            prefix = quoted(table, count)
            printf "{\"p\":[%s%s\"%s\"],\"v\":%s}\n", prefix, (prefix == "" ? "" : ","), key, value
        }
        END { exit failed }
    '
}

node_file_json() {   # <node.toml>: the file as JSON, or fails
    local file=$1 lines
    [ -r "$file" ] || return 1
    lines=$(toml_to_path_values < "$file") || return 1
    jq -nc 'reduce inputs as $entry ({}; setpath($entry.p; $entry.v))' <<< "$lines"
}

# shellcheck disable=SC2016
node_toml_program='
    def toml_value: if type == "string" then @json elif type == "array" then "[" + (map(@json) | join(", ")) + "]" else tostring end;
    def pairs($keys): . as $table | [$keys[] | select($table[.] != null) | "\(.) = \($table[.] | toml_value)"];
    def padded: (map(sub(" = .*"; "") | length) | max // 0) as $width
        | map(capture("^(?<key>[^ ]+) = (?<value>.*)$") | .key + (" " * ($width - (.key | length))) + " = " + .value);
    (["[node]"] + (.node | pairs(["id", "name", "kind", "threshold", "assigned", "open"]) | padded))
    + (if .array then ["", "[array]", "revision = \(.array.revision)"]
        + ([.array.members[]? | ["", "[[array.members]]"] + (pairs(["role", "label", "serial", "size", "asset"]) | padded)] | add // [])
       else [] end)
    | join("\n")
'

node_file_write() {   # <node.toml> <json>: written whole, then renamed into place
    local file=$1 text
    text=$(jq -r "$node_toml_program" <<< "$2") || return 1
    mkdir -p "${file%/*}" && printf '%s\n' "$text" > "$file.new" && mv "$file.new" "$file"
}

new_node_id() { od -An -N2 -tx1 /dev/urandom | tr -d ' \n'; }

is_node_id() { [[ $1 =~ ^[0-9a-f]{4}$ ]]; }

is_node_name() { [[ $1 =~ ^[a-z0-9][a-z0-9-]*$ ]]; }

# The description with the highest revision among the given node files; files that do not parse,
# or describe another array, are passed over.
newest_array_description() {   # <array id> <node.toml>...
    local id=$1 file best='' best_revision=-1 json revision
    shift
    for file in "$@"; do
        json=$(node_file_json "$file" 2> /dev/null) || continue
        [ "$(jq -r '.node.id // empty' <<< "$json")" = "$id" ] || continue
        revision=$(jq -r '.array.revision // 0' <<< "$json")
        [[ $revision =~ ^[0-9]+$ ]] || continue
        [ "$revision" -gt "$best_revision" ] && { best=$json; best_revision=$revision; }
    done
    [ -n "$best" ] && echo "$best"
}
