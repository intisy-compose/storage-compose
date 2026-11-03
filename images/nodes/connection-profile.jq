# The checks every Linux keeper makes on a node's entry of the connection profile, included by
# images/nodes/apply-connections.sh and the Linux join's storage-connections.sh (beside which the join
# installs this file): an option of the wrong type is left out, and a listen list with any address of
# an unknown scheme is left out whole. The scheme pattern is the host agent's (windows/syncthing.ps1).

def is_count: type == "number" and . >= 0 and . == floor;

def is_valid_option($key):
    if $key == "maxSendKbps" or $key == "maxRecvKbps" then is_count
    elif $key == "globalAnnounceServers" then type == "array" and all(.[]; type == "string")
    elif $key == "limitBandwidthInLan" or $key == "natEnabled" or $key == "localAnnounceEnabled"
        or $key == "globalAnnounceEnabled" or $key == "relaysEnabled" then type == "boolean"
    else false end;

def is_listen_address: type == "string" and test("^((tcp|quic)[46]?|relay|dynamic\\+https?)://");

def is_listen_list: type == "array" and length > 0 and all(.[]; is_listen_address);

def valid_options: .options | if type == "object" then . else {} end | with_entries(select(.key as $key | .value | is_valid_option($key)));

def profile_settings: valid_options + (if .listenAddresses | is_listen_list then {listenAddresses: .listenAddresses} else {} end);
