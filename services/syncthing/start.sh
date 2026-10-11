#!/bin/sh
# Sets the GUI login once, from the secret on the array, points new folders at the pool, then runs
# the image's own entrypoint.
set -eu
config="$STHOMEDIR/config.xml"
if [ ! -f "$config" ]; then
    /bin/entrypoint.sh /bin/syncthing generate --no-port-probing --gui-user=storage --gui-password=- < /secrets/syncthing-gui
fi
sed -i 's|<folder id="" label="" path=""|<folder id="" label="" path="/mnt/storage/pool/sync/"|' "$config"
exec /bin/entrypoint.sh /bin/syncthing serve --no-port-probing
