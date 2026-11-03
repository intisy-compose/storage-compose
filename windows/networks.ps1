# The networks this host is reached on, for the heartbeat. Dot-sourced by the agent; defines functions only.

$networkCategoryNames = @{ Public = "Public"; Private = "Private"; DomainAuthenticated = "Domain" }

function Test-AddressInRange([string]$Address, [string]$Network, [int]$PrefixLength) {
    $addressBytes = [System.Net.IPAddress]::Parse($Address).GetAddressBytes()
    $networkBytes = [System.Net.IPAddress]::Parse($Network).GetAddressBytes()
    [array]::Reverse($addressBytes)
    [array]::Reverse($networkBytes)
    $mask = [uint32]([math]::Pow(2, 32) - [math]::Pow(2, 32 - $PrefixLength))
    return ([BitConverter]::ToUInt32($addressBytes, 0) -band $mask) -eq ([BitConverter]::ToUInt32($networkBytes, 0) -band $mask)
}

function Test-IsPrivateAddress([string]$Address) {
    return (Test-AddressInRange $Address "10.0.0.0" 8) -or (Test-AddressInRange $Address "172.16.0.0" 12) -or (Test-AddressInRange $Address "192.168.0.0" 16)
}

function Test-IsUnroutableAddress([string]$Address) {
    return (Test-AddressInRange $Address "127.0.0.0" 8) -or (Test-AddressInRange $Address "169.254.0.0" 16) -or (Test-AddressInRange $Address "0.0.0.0" 8)
}

function Get-AddressKind([string]$Address) {
    if (Test-IsUnroutableAddress $Address) { return $null }
    if (Test-AddressInRange $Address "100.64.0.0" 10) { return "tailnet" }
    if (Test-IsPrivateAddress $Address) { return "lan" }
    return "public"
}

<#
.NOTES
Only an adapter Windows holds a connection profile for counts as `lan` or `public`: the Hyper-V switches of WSL and Docker
carry private addresses no other host can reach, and they have none. The tailnet adapter is told by
its 100.64.0.0/10 address; a `public` entry appears only for a public address assigned to this host
directly, never one learned from outside, which a NAT router would hide.
#>
function Get-HostNetworks {
    $categories = @{}
    $names = @{}
    foreach ($connection in @(Get-NetConnectionProfile -ErrorAction SilentlyContinue)) {
        $categories[[int]$connection.InterfaceIndex] = "$($connection.NetworkCategory)"
        if ($connection.PSObject.Properties["Name"] -and $connection.Name) { $names[[int]$connection.InterfaceIndex] = "$($connection.Name)" }
    }
    $networks = @()
    foreach ($entry in @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue)) {
        $address = "$($entry.IPAddress)"
        $kind = Get-AddressKind $address
        if (-not $kind -or ($kind -ne "tailnet" -and -not $categories.ContainsKey([int]$entry.InterfaceIndex))) { continue }
        $network = [ordered]@{ kind = $kind; address = $address }
        $category = "$($categories[[int]$entry.InterfaceIndex])"
        if ($kind -ne "tailnet" -and $networkCategoryNames.ContainsKey($category)) { $network.category = $networkCategoryNames[$category] }
        if ($kind -ne "tailnet" -and $names.ContainsKey([int]$entry.InterfaceIndex)) { $network.name = $names[[int]$entry.InterfaceIndex] }
        $networks += [pscustomobject]$network
    }
    return $networks
}
