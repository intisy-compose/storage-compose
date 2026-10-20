#!/bin/sh
# Opens (or creates, the first time) the repository on the pool and serves it to the clients while
# every drive of the array is present; it pauses while one is away, so no snapshot records a missing
# drive's files as deleted.
#   kopia.sh                   the server
#   kopia.sh user <user@host>  add or reset a client account and print its password
set -eu

export KOPIA_CONFIG_PATH=/state/repository.config
export KOPIA_LOG_DIR=/state/logs
export KOPIA_CACHE_DIRECTORY=/cache
export KOPIA_CHECK_FOR_UPDATES=false
KOPIA_PASSWORD=$(cat /secrets/kopia-repository)
export KOPIA_PASSWORD
server_password=$(cat /secrets/kopia-server)
repository=/repository
certificate=/state/server.crt
key=/state/server.key
array_env=/status/array.env
server_pid=

log() { echo "$(date -u +%FT%TZ) $*"; }

certificate_fingerprint() { sed '/-----/d' "$certificate" | base64 -d | sha256sum | cut -d' ' -f1; }

if [ "${1:-}" = user ]; then
    user_password=$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')
    kopia server user add "$2" --user-password="$user_password" >/dev/null 2>&1 \
        || kopia server user set "$2" --user-password="$user_password" >/dev/null 2>&1
    kopia server refresh --address=https://127.0.0.1:51515 --server-cert-fingerprint="$(certificate_fingerprint)" \
        --server-username=server-control --server-password="$server_password" >/dev/null
    echo "$2 can connect with password $user_password"
    exit 0
fi

array_value() { sed -n "s/^$1=//p" "$array_env" 2>/dev/null; }

# gRPC needs HTTP/2, which Kopia speaks only over TLS; Caddy terminates the real certificate in front.
start_server() {
    tls_generation=""
    [ -f "$certificate" ] || tls_generation="--tls-generate-cert"
    kopia server start --address=0.0.0.0:51515 $tls_generation \
        --tls-cert-file="$certificate" --tls-key-file="$key" \
        --server-username=storage --server-password="$server_password" \
        --server-control-password="$server_password" &
    server_pid=$!
    log "server started"
}

outlives() {   # <pid> <seconds>: true when the process is still there after that long
    waited=0
    while kill -0 "$1" 2>/dev/null && [ "$waited" -lt "$2" ]; do sleep 1; waited=$((waited + 1)); done
    kill -0 "$1" 2>/dev/null
}

# A server whose state went read-only with data1 can hang for minutes in its shutdown, past even a
# SIGKILL, which would hold the loop and so the restart onto the returned data1; it is left behind.
stop_server() {
    [ -n "$server_pid" ] || return 0
    kill "$server_pid" 2>/dev/null || true
    if outlives "$server_pid" 10; then
        kill -9 "$server_pid" 2>/dev/null || true
        outlives "$server_pid" 5 && log "the server does not stop; leaving it"
    fi
    kill -0 "$server_pid" 2>/dev/null || wait "$server_pid" 2>/dev/null || true
    server_pid=
}

# A read of a dead mount can hang as long as the server's shutdown, and hanging counts as gone.
repository_answers() {
    ls "$repository" > /dev/null 2>&1 &
    probe=$!
    if outlives "$probe" 5; then kill -9 "$probe" 2>/dev/null; return 1; fi
    wait "$probe"
}

server_is_running() { [ -n "$server_pid" ] && kill -0 "$server_pid" 2>/dev/null; }

trap 'stop_server; exit 0' TERM INT

if [ -f "$repository/kopia.repository.f" ]; then
    kopia repository connect filesystem --path="$repository"
else
    kopia repository create filesystem --path="$repository"
fi

# The state and the repository are bind mounts of one filesystem instance; once data1 is mounted anew
# or the pool is gone, only a fresh container sees the live ones, so it exits and Docker restarts it.
generation=$(array_value generation)
while true; do
    if [ "$(array_value complete)" = yes ]; then
        server_is_running || start_server
    elif server_is_running; then
        log "paused: not every drive of the array is present (the array is $(array_value state))"
        stop_server
    fi
    current=$(array_value generation)
    [ -n "$generation" ] || generation=$current
    if [ -n "$current" ] && [ "$current" != "$generation" ]; then log "data1 was mounted anew; restarting"; stop_server; exit 0; fi
    repository_answers || { log "the repository is gone; restarting"; stop_server; exit 1; }
    sleep 10 &
    wait $! || true
done
