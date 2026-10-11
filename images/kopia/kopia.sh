#!/bin/sh
# Opens (or creates, the first time) the repository on the pool and serves it to the clients.
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

if [ -f "$repository/kopia.repository.f" ]; then
    kopia repository connect filesystem --path="$repository"
else
    kopia repository create filesystem --path="$repository"
fi

# gRPC needs HTTP/2, which Kopia speaks only over TLS; Caddy terminates the real certificate in front.
tls_generation=""
[ -f "$certificate" ] || tls_generation="--tls-generate-cert"
exec kopia server start --address=0.0.0.0:51515 $tls_generation \
    --tls-cert-file="$certificate" --tls-key-file="$key" \
    --server-username=storage --server-password="$server_password" \
    --server-control-password="$server_password"
