#Requires -Version 5.1
<#
.SYNOPSIS
The start step of a node's Syncthing on a device joined without the host agent: the join's logon task
runs it before Syncthing. Fetches the node's entry from the dashboard's GET
/api/connections/node/<NodeId>, keeps it as connections.json in the Syncthing home, and writes its
options and listen addresses into config.xml before Syncthing starts.

.DESCRIPTION
A dashboard that does not answer within 10 s leaves the kept copy in use; without a copy nothing
changes. Validated as the host agent does (windows\syncthing.ps1): an option of the wrong type is left
out, a listen list with any address of an unknown scheme is left out whole. Always exits 0, so it
never keeps Syncthing from starting.
#>
param(
    [string]$Dashboard,
    [string]$NodeId,
    [string]$SyncthingHome
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

function Set-KeptConnections {
    $kept = Get-KeptConnectionsPath
    $configPath = [System.IO.Path]::Combine($SyncthingHome, "config.xml")
    if (-not ((Test-Path -LiteralPath $kept) -and (Test-Path -LiteralPath $configPath))) { return }
    $entry = ConvertFrom-ConnectionsText ([System.IO.File]::ReadAllText($kept))
    if (-not $entry) { return }
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
