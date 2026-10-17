#!/bin/bash
# mounter-probe.sh <blank disk size in bytes>: run inside the mounter image by vhdx.ps1. Prints which
# SMART report the mounter takes for each test disk, and its disk-labels answer.
set -u
prefix=${ARRAY_PREFIX:?}
label_pattern="^${prefix}-(data|parity)[0-9]+$"
wsl_disks_file=/status/wsl-disks.json
# shellcheck source=../../images/mounter/lib/drives.sh
source /usr/local/lib/storage/drives.sh
# shellcheck source=../../images/mounter/lib/health.sh
source /usr/local/lib/storage/health.sh

labelled_partition=$(blkid -c /dev/null -t "LABEL=$prefix-data1" -o device | head -n 1)
labelled_disk=$(whole_disk_node "$labelled_partition")
blank_disk=$(lsblk -bdnpo NAME,SIZE | awk -v size="$1" '$2 == size {print $1; exit}')
echo "labelled_partition=$labelled_partition"
echo "labelled_disk=$labelled_disk"
echo "labelled_serial=$(smart_report "$labelled_disk" | jq -r '.serial_number // empty')"
echo "blank_disk=$blank_disk"
echo "blank_serial=$(smart_report "$blank_disk" | jq -r '.serial_number // empty')"
echo "disk_labels=$(mounter.sh disk-labels | tr '\n' ';')"
