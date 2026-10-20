#!/usr/bin/env bash
# The Linux join script's tests: builds the bench image and runs join.test.sh in a fresh container,
# so nothing on the host is touched. Needs Docker.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repository="$(cd "$here/../.." && pwd)"
image=storage-join-test:local

host_path() { if command -v cygpath > /dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }

docker build --quiet -t "$image" "$(host_path "$here")" > /dev/null
MSYS_NO_PATHCONV=1 docker run --rm \
    -v "$(host_path "$here"):/tests:ro" -v "$(host_path "$repository/join"):/join:ro" \
    "$image" bash /tests/join.test.sh
