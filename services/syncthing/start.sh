#!/bin/sh
# Sets the GUI login once, from the secret on the array, points new folders at the pool, starts the
# guard that pauses the folders the mounter names and the keeper that applies the cluster's connection
# profile once the API answers (it must start before the exec), then runs the image's own entrypoint.
# The GUI listens on the namespace's Docker address, never on 127.0.0.1, where tailscale hands it
# tailnet connections.
set -eu
STGUIADDRESS="$(sh /namespace-address.sh --single):${STGUIPORT:?}"
export STGUIADDRESS
config="$STHOMEDIR/config.xml"
if [ ! -f "$config" ]; then
    /bin/entrypoint.sh /bin/syncthing generate --no-port-probing --gui-user=storage --gui-password=- < /secrets/syncthing-gui
fi
sed -i -e 's#<folder id="" label="" path=""#<folder id="" label="" path="/mnt/storage/pool/"#' \
    -e 's#<folder id="" label="" path="/mnt/storage/pool/sync/"#<folder id="" label="" path="/mnt/storage/pool/"#' "$config"
api_key=$(sed -n 's:.*<apikey>\(.*\)</apikey>.*:\1:p' "$config")
/bin/sh /guard.sh &
/bin/sh /apply-connections.sh "$ARRAY_PREFIX" "http://$STGUIADDRESS" "$api_key" &
exec /bin/entrypoint.sh /bin/syncthing serve --no-port-probing
