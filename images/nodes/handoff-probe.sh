#!/bin/bash
# handoff-probe.sh <directory> [--once]: the hand-off executor's open-file probe. Every
# HANDOFF_PROBE_INTERVAL_SECONDS it writes <directory>/open.txt: a first line `at <epoch> processes <n>
# unreadable <n>`, then one `<device>:<inode> <mount namespace>` line per file some process has open. The
# executor reads it instead of walking /proc itself, so only this sidecar holds the host's PID namespace and
# the capabilities to read other processes' descriptors.
set -u

directory=${1:?usage: handoff-probe.sh <directory> [--once]}
interval=${HANDOFF_PROBE_INTERVAL_SECONDS:-5}
proc_root=${HANDOFF_PROC_ROOT:-/proc}
export TMPDIR=$directory

# A process whose descriptors cannot be listed or followed counts as unreadable, so the executor knows
# the snapshot may miss a holder.
snapshot() {
    local process namespace processes=0 unreadable=0 answer
    : > "$directory/open.txt.entries"
    for process in "$proc_root"/[0-9]*; do
        [ -d "$process/fd" ] || continue
        processes=$((processes + 1))
        if ! namespace=$(readlink "$process/ns/mnt" 2> /dev/null) || ! ls "$process/fd" > /dev/null 2>&1; then
            [ -d "$process" ] && unreadable=$((unreadable + 1))
            continue
        fi
        answer=$(stat -L -c %d:%i -- "$process"/fd/* 2>&1)
        case $answer in *'Permission denied'*) unreadable=$((unreadable + 1)) ;; esac
        printf '%s\n' "$answer" | awk -v namespace="$namespace" '/^[0-9]+:[0-9]+$/ { print $0 " " namespace }' >> "$directory/open.txt.entries"
    done
    { printf 'at %s processes %s unreadable %s\n' "${HANDOFF_NOW:-$(date +%s)}" "$processes" "$unreadable"; sort -u "$directory/open.txt.entries"; } > "$directory/open.txt.new" \
        && mv -f "$directory/open.txt.new" "$directory/open.txt"
    rm -f "$directory/open.txt.entries"
}

if [ "${2:-}" = --once ]; then snapshot; exit; fi
trap 'exit 0' TERM INT
while true; do
    snapshot
    sleep "$interval" & wait $!
done
