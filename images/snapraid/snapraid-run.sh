#!/bin/bash
# Installed as /usr/local/bin/snapraid in front of the real one, so every run that changes or reads
# a whole array is seen by the dashboard, whoever started it: the scheduler, the dashboard, or someone
# by hand through `docker-compose.sh snapraid`. The run and its start go to snapraid.run.json and its
# latest percentage to snapraid.progress, both in the status folder that holds the run's config.
real=/usr/bin/snapraid
recorded_commands=" sync scrub fix check "

config_of() {
    local previous=
    for argument; do
        case $previous in -c | --conf) echo "$argument"; return ;; esac
        case $argument in --conf=*) echo "${argument#--conf=}"; return ;; -c?*) echo "${argument#-c}"; return ;; esac
        previous=$argument
    done
}

command_of() {
    local argument
    for argument; do [[ $recorded_commands == *" $argument "* ]] && { echo "$argument"; return; }; done
}

status_folder_of() {   # <config>
    local folder
    folder=$(dirname "$(readlink -f "$1" 2> /dev/null)")
    [[ $folder == /status/arrays/* ]] && echo "$folder"
}

record_progress() {   # <status folder>
    local percent
    stdbuf -o0 tr '\r' '\n' | grep --line-buffered -oE '^ *[0-9]{1,3}%' | while read -r percent; do
        echo "${percent%\%}" > "$1/snapraid.progress.tmp" && mv "$1/snapraid.progress.tmp" "$1/snapraid.progress"
    done
}

command=$(command_of "$@")
config=$(config_of "$@")
folder=
[ -n "$command" ] && [ -n "$config" ] && folder=$(status_folder_of "$config")
[ -n "$folder" ] || exec "$real" "$@"

printf '{"kind":"%s","startedAt":"%s"}\n' "$command" "$(date -u +%FT%TZ)" > "$folder/snapraid.run.json"
rm -f "$folder/snapraid.progress"
# Locks are not visible across containers, so the run file is kept fresh while SnapRAID runs; one
# left behind by a killed run goes stale.
( while sleep 10; do touch "$folder/snapraid.run.json"; done ) &
heartbeat=$!
"$real" "$@" | tee >(record_progress "$folder")
result=${PIPESTATUS[0]}
kill "$heartbeat" 2> /dev/null
rm -f "$folder/snapraid.run.json" "$folder/snapraid.progress"
exit "$result"
