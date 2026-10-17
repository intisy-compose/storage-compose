# shellcheck shell=bash
# Which data drives hold each Syncthing folder, so the folders a lost drive touches can be paused
# before Syncthing could read the loss as deletions. Folders live anywhere under the pool, nested too.

folder_locations_file() { echo "$state_dir/syncthing-folder-drives"; }

syncthing_config() {
    local directory
    for directory in "$state_dir" "$mirror_dir"; do
        [ -f "$directory/syncthing/config.xml" ] && { echo "$directory/syncthing/config.xml"; return 0; }
    done
    return 1
}

xml_unescape() { sed -e 's/&lt;/</g' -e 's/&gt;/>/g' -e 's/&quot;/"/g' -e "s/&apos;/'/g" -e "s/&#39;/'/g" -e 's/&amp;/\&/g'; }

xml_attribute() { sed -n "s/.* $1=\"\\([^\"]*\\)\".*/\\1/p" <<< "$2" | xml_unescape; }

syncthing_folders() {   # "<id><tab><path>" for every configured folder
    local config element id
    config=$(syncthing_config) || return 0
    grep -o '<folder [^>]*>' "$config" | while read -r element; do
        id=$(xml_attribute id "$element")
        [ -n "$id" ] && printf '%s\t%s\n' "$id" "$(xml_attribute path "$element")"
    done
}

pool_relative() {   # <folder path>: the path inside the pool, or nothing for a folder outside it
    local path=${1%/}
    case $path in
        "$root/pool") echo . ;;
        "$root/pool/"*) echo "${path#"$root/pool/"}" ;;
    esac
}

drives_holding() {   # <path inside the pool>: the mounted data drives on which it exists
    local label
    for label in $(mounted_labels); do
        is_data_label "$label" && [ -e "$root/$label/$1" ] && echo "$label"
    done
}

recorded_drives() { awk -F'\t' -v id="$1" '$1 == id {print $2}' "$(folder_locations_file)" 2>/dev/null; }

observe_folder_drives() {   # "<id><tab><drives>" for every folder in the pool
    local id path relative
    while IFS=$'\t' read -r id path; do
        relative=$(pool_relative "$path")
        [ -n "$relative" ] || continue
        printf '%s\t%s\n' "$id" "$(drives_holding "$relative" | tr '\n' ' ' | sed 's/ $//')"
    done < <(syncthing_folders)
}

# While a drive is away the pool cannot show what it held, so the record only ever grows then; it is
# replaced by what the pool shows once every drive is back.
update_folder_locations() {   # <complete: yes or no>
    local file observed id drives
    state_dir_is_writable || return 0
    file=$(folder_locations_file)
    observed=$(observe_folder_drives)
    if [ "$1" = yes ]; then
        echo "$observed" > "$file.new"
    else
        while IFS=$'\t' read -r id drives; do
            [ -n "$id" ] || continue
            printf '%s\t%s\n' "$id" "$(echo "$drives $(recorded_drives "$id")" | tr ' ' '\n' | sed '/^$/d' | sort -uV | tr '\n' ' ' | sed 's/ $//')"
        done <<< "$observed" > "$file.new"
    fi
    mv "$file.new" "$file"
}

split_folders() {   # "<id><tab><drives>" for every folder that lies on more than one drive
    awk -F'\t' 'split($2, drives, " ") > 1' "$(folder_locations_file)" 2>/dev/null
}

touches_any() {   # <drives> <absent drives>
    local drive
    for drive in $1; do [[ " $2 " == *" $drive "* ]] && return 0; done
    return 1
}

folders_to_pause() {   # <state> <drives that are not present>
    local id path drives
    while IFS=$'\t' read -r id path; do
        if [ "$1" = stopped ]; then echo "$id"; continue; fi
        [ -n "$2" ] && [ -n "$(pool_relative "$path")" ] || continue
        drives=$(recorded_drives "$id")
        if [ -z "$drives" ] || touches_any "$drives" "$2"; then echo "$id"; fi
    done < <(syncthing_folders)
}
