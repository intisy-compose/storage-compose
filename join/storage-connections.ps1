#Requires -Version 5.1
<#
.SYNOPSIS
The start step of a node's Syncthing on a device joined without the host agent: the join's logon task
runs it before Syncthing. Fetches the node's entry from the dashboard's GET
/api/connections/node/<NodeId>, keeps it as connections.json in the Syncthing home, and writes its
options and listen addresses into config.xml before Syncthing starts, each tcp and quic listen
address on the device's own -ListenPort.

.DESCRIPTION
A dashboard that does not answer within 10 s leaves the kept copy in use; without a copy nothing
changes. An option of the wrong type is left out, and a listen list with any address of an unknown
scheme is left out whole while the valid options are still applied, the rule every keeper follows.
Always exits 0, so it never keeps Syncthing from starting.
#>
param(
    [string]$Dashboard,
    [string]$NodeId,
    [string]$SyncthingHome,
    [string]$ListenPort
)

$ErrorActionPreference = "Stop"
. (Join-Path (Split-Path $PSScriptRoot) "windows\syncthing.ps1")
. (Join-Path (Split-Path $PSScriptRoot) "windows\dashboard-entry.ps1")

function Get-KeptConnectionsPath { return [System.IO.Path]::Combine($SyncthingHome, "connections.json") }

function Save-DashboardEntry {
    try {
        $text = Get-DashboardEntryText $Dashboard $NodeId
    } catch {
        Write-Host "storage-connections: the dashboard at $Dashboard gave no entry; using the kept copy, if any"
        return
    }
    if (-not (ConvertFrom-ConnectionsText $text)) { return }
    $kept = Get-KeptConnectionsPath
    [System.IO.File]::WriteAllText("$kept.partial", $text)
    Move-Item -Force -LiteralPath "$kept.partial" -Destination $kept
}

function Set-KeptConnections {
    $kept = Get-KeptConnectionsPath
    $configPath = [System.IO.Path]::Combine($SyncthingHome, "config.xml")
    if (-not ((Test-Path -LiteralPath $kept) -and (Test-Path -LiteralPath $configPath))) { return }
    $entry = ConvertFrom-ConnectionsText ([System.IO.File]::ReadAllText($kept))
    if (-not $entry) { return }
    Set-OwnListenPort $entry $ListenPort
    $document = New-Object System.Xml.XmlDocument
    $document.Load($configPath)
    $options = $document.DocumentElement.SelectSingleNode("options")
    $changed = $false
    if (Test-HasProfileListenAddresses $entry) { $changed = (Set-ListenAddresses $options @($entry.listenAddresses)) -or $changed }
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
