#Requires -Version 5.1
<#
.SYNOPSIS
The start step of a node's Syncthing on a device joined without the host agent: the join's logon task
runs it before Syncthing. Fetches the node's entry from the dashboard's GET
/api/connections/node/<NodeId>, keeps it as connections.json in the Syncthing home, and writes its
options and listen addresses into config.xml before Syncthing starts, each tcp:// and quic:// listen
address on the device's own -ListenPort.

.DESCRIPTION
A dashboard that does not answer within 10 s leaves the kept copy in use; without a copy nothing
changes. An option of the wrong type is left out, and a listen list with any address of an unknown
scheme is left out whole while the valid options are still applied; the host agent
(windows\syncthing.ps1) instead ignores the whole entry on such a listen list. Always exits 0, so it
never keeps Syncthing from starting.
#>
param(
    [string]$Dashboard,
    [string]$NodeId,
    [string]$SyncthingHome,
    [string]$ListenPort
)

$ErrorActionPreference = "Stop"
. (Join-Path (Split-Path $PSScriptRoot) "windows\syncthing.ps1")

$fetchTimeoutSeconds = 10

function Get-KeptConnectionsPath { return [System.IO.Path]::Combine($SyncthingHome, "connections.json") }

function ConvertFrom-ConnectionsText([string]$Text) {
    try { $entry = $Text | ConvertFrom-Json } catch { return $null }
    if ($entry -isnot [System.Management.Automation.PSCustomObject]) { return $null }
    return $entry
}

function Save-DashboardEntry {
    try {
        $text = (Invoke-WebRequest -Uri "$($Dashboard.TrimEnd('/'))/api/connections/node/$NodeId" -TimeoutSec $fetchTimeoutSeconds -UseBasicParsing).Content
    } catch {
        Write-Host "storage-connections: the dashboard at $Dashboard gave no entry; using the kept copy, if any"
        return
    }
    if (-not (ConvertFrom-ConnectionsText $text)) { return }
    $kept = Get-KeptConnectionsPath
    [System.IO.File]::WriteAllText("$kept.partial", $text)
    Move-Item -Force -LiteralPath "$kept.partial" -Destination $kept
}

<#
.NOTES
The dashboard assumes 22000 for every joined device and leaves the device's own port to this step.
#>
function ConvertTo-OwnListenPort($Address) {
    if ($Address -isnot [string] -or $ListenPort -notmatch '^\d+$' -or $Address -notmatch '^(tcp|quic)://') { return $Address }
    return $Address -replace ':\d+((?:[/?].*)?)$', ":$ListenPort`$1"
}

function Set-KeptConnections {
    $kept = Get-KeptConnectionsPath
    $configPath = [System.IO.Path]::Combine($SyncthingHome, "config.xml")
    if (-not ((Test-Path -LiteralPath $kept) -and (Test-Path -LiteralPath $configPath))) { return }
    $entry = ConvertFrom-ConnectionsText ([System.IO.File]::ReadAllText($kept))
    if (-not $entry) { return }
    if ($entry.PSObject.Properties["listenAddresses"] -and $entry.listenAddresses -is [array]) {
        $entry.listenAddresses = @($entry.listenAddresses | ForEach-Object { ConvertTo-OwnListenPort $_ })
    }
    $document = New-Object System.Xml.XmlDocument
    $document.Load($configPath)
    $options = $document.DocumentElement.SelectSingleNode("options")
    $changed = $false
    if (Test-IsConnectionsEntry $entry) { $changed = (Set-ListenAddresses $options @($entry.listenAddresses)) -or $changed }
    $changed = (Set-ProfileAnnounceServers $options $entry) -or $changed
    $values = Get-ProfileOptionValues $entry
    foreach ($name in @($values.Keys)) { $changed = (Set-XmlChildText $options $name $values[$name]) -or $changed }
    if ($changed) { Save-XmlDocument $document $configPath }
}

try {
    Save-DashboardEntry
    Set-KeptConnections
} catch {
    Write-Host "storage-connections: $_"
}
exit 0
