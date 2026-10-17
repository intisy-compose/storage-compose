#!/bin/sh
# make-test-disk.sh <vhdx> <size MB> <label|blank> [GPT id]: a dynamic VHDX test disk, either blank or
# with one GPT "Linux filesystem" partition holding ext4 under <label>, as the stack's format writes.
# Builds the image file without a loop device, so it needs no privileges.
set -eu
output=$1 size_mb=$2 label=$3 table_id=${4:-}
raw=$(mktemp)
truncate -s "${size_mb}M" "$raw"
if [ "$label" != blank ]; then
    printf 'label: gpt\nlabel-id: %s\nstart=2048, type=linux\n' "$table_id" | sfdisk -q "$raw"
    mkfs.ext4 -q -F -L "$label" -E offset=1048576 "$raw" "$((size_mb - 2))M"
fi
qemu-img convert -f raw -O vhdx -o subformat=dynamic "$raw" "$output"
rm -f "$raw"
