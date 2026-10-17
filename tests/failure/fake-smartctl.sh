#!/bin/sh
# Stands in for smartctl in the test's mounter: answers for a device only once the lab has written
# /status/fake-smart/<kernel name>.json, and like a device without SMART otherwise.
for argument; do device=$argument; done
answer="/status/fake-smart/$(basename "$(readlink -f "$device")").json"
[ -f "$answer" ] || { echo '{}'; exit 2; }
cat "$answer"
