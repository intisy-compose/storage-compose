# Pester 3.4: reading a joined node's connections entry and moving its listen addresses to the node's
# own port. Nothing here reaches a dashboard.

$repository = Split-Path (Split-Path $PSScriptRoot)
. (Join-Path $repository "windows\dashboard-entry.ps1")

Describe "a joined node's entry" {
    It "is an object or nothing" {
        (ConvertFrom-ConnectionsText '{"options": {}}') -is [System.Management.Automation.PSCustomObject] | Should Be $true
        ConvertFrom-ConnectionsText '"tailnet"' | Should BeNullOrEmpty
        ConvertFrom-ConnectionsText '{"options": ' | Should BeNullOrEmpty
    }

    It "is asked for under the device's first seven ID characters" {
        Get-JoinedConnectionsNodeId "PBMD2SH-RS3UNJU-L77BP7K-X7VFKHE-73FF74D-RRCUVRY-XNUNII3-WWU53Q6" | Should Be "device-pbmd2sh"
    }

    It "moves tcp and quic addresses to the node's port, relay and pool addresses untouched" {
        $entry = ConvertFrom-ConnectionsText '{"listenAddresses": ["tcp://0.0.0.0:22000", "quic://[::]:22000", "relay://10.0.0.1:22100/?id=RELAY", "dynamic+https://relays.syncthing.net/endpoint"]}'
        Set-OwnListenPort $entry "22003"
        ($entry.listenAddresses -join ",") | Should Be "tcp://0.0.0.0:22003,quic://[::]:22003,relay://10.0.0.1:22100/?id=RELAY,dynamic+https://relays.syncthing.net/endpoint"
    }

    It "keeps a one-address list a list" {
        $entry = ConvertFrom-ConnectionsText '{"listenAddresses": ["tcp://0.0.0.0:22000"]}'
        Set-OwnListenPort $entry "22001"
        $entry.listenAddresses -is [array] | Should Be $true
        $entry.listenAddresses[0] | Should Be "tcp://0.0.0.0:22001"
    }

    It "leaves an entry without a listen list alone" {
        $entry = ConvertFrom-ConnectionsText '{"listenAddresses": "tcp://0.0.0.0:22000"}'
        Set-OwnListenPort $entry "22001"
        $entry.listenAddresses | Should Be "tcp://0.0.0.0:22000"
    }
}
