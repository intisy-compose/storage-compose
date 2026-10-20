# A block rule for a Syncthing binary the tests run as this user. The tests only use loopback, which the
# firewall does not filter, and Windows asks "allow access?" (and adds a rule open to every address)
# for a program no rule names; with this rule it never asks. The sweep at the end of a run removes it.
# Dot-sourced by the test runners; defines functions only.

function Add-TestFirewallGuard([string]$Program) {
    foreach ($protocol in @("TCP", "UDP")) {
        $name = "storage-compose test guard $protocol $([guid]::NewGuid())"
        New-NetFirewallRule -Name $name -DisplayName $name -Group "storage-compose test guard" -Direction Inbound -Action Block `
            -Protocol $protocol -Program $Program -Profile Any | Out-Null
    }
}
