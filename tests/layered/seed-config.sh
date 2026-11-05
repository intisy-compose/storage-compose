#!/bin/sh
# seed-config.sh: run once as root in a container with no network that shares a scratch peer's /var/syncthing,
# before the peer's first start. Writes its keys and a config that never announces, relays, maps
# ports or reports, so the peer's first start already reaches nothing outside the layered-test network.
set -eu
home=/var/syncthing/config
syncthing generate --home "$home" --no-port-probing >/dev/null
sed -i \
    -e 's|<listenAddress>default</listenAddress>|<listenAddress>tcp://0.0.0.0:22000</listenAddress>|' \
    -e 's|<globalAnnounceEnabled>true<|<globalAnnounceEnabled>false<|' \
    -e 's|<localAnnounceEnabled>true<|<localAnnounceEnabled>false<|' \
    -e 's|<relaysEnabled>true<|<relaysEnabled>false<|' \
    -e 's|<natEnabled>true<|<natEnabled>false<|' \
    -e 's|<urAccepted>0<|<urAccepted>-1<|' \
    -e 's|<crashReportingEnabled>true<|<crashReportingEnabled>false<|' \
    -e 's|<autoUpgradeIntervalH>12<|<autoUpgradeIntervalH>0<|' \
    "$home/config.xml"
for expected in \
    '<listenAddress>tcp://0.0.0.0:22000</listenAddress>' \
    '<globalAnnounceEnabled>false</globalAnnounceEnabled>' \
    '<localAnnounceEnabled>false</localAnnounceEnabled>' \
    '<relaysEnabled>false</relaysEnabled>' \
    '<natEnabled>false</natEnabled>' \
    '<urAccepted>-1</urAccepted>' \
    '<crashReportingEnabled>false</crashReportingEnabled>' \
    '<autoUpgradeIntervalH>0</autoUpgradeIntervalH>'; do
    grep -qF "$expected" "$home/config.xml" || { echo "seed-config: missing $expected" >&2; exit 1; }
done
chown -R 1000:1000 /var/syncthing
